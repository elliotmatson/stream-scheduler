import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprint, withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance } from '@scheduler/plugin-sdk'
import { FakeStreamingEncoder, type FakeOptions } from './fake-device.js'
import { streamingEncoderPlugin } from './index.js'

/**
 * Run against a fake serving the documented REST API over a real HTTP
 * socket, so paths, verbs, status codes and JSON shapes are all exercised.
 * What this cannot prove is that the document matches the firmware.
 */

const YOUTUBE_PRIMARY = 'rtmp://a.rtmp.youtube.com/live2'
const KEY = 'live_abcd-1234-efgh'

let encoder: FakeStreamingEncoder
let device: DeviceInstance | undefined

async function connect(
  config: Record<string, unknown> = {},
  options: FakeOptions = {},
): Promise<DeviceInstance> {
  encoder.options = { ...encoder.options, ...options }
  const plugin = streamingEncoderPlugin({ now: () => 1_700_000_000_000, timeoutMs: 2_000 })
  const ctx: DeviceContext = {
    deviceId: 'enc-1',
    config: { host: encoder.host, port: encoder.boundPort, ...config },
    log: () => {},
    emitState: () => {},
    emitHealth: () => {},
  }
  // Wrapped exactly as the host wraps plugins in CI.
  device = withSerializingTransport(await plugin.createDevice(ctx))
  await device.probe()
  return device
}

beforeEach(async () => {
  encoder = new FakeStreamingEncoder()
  await encoder.listen()
})

afterEach(async () => {
  await device?.dispose()
  device = undefined
  await encoder.close()
})

describe('connecting', () => {
  it('identifies the model and firmware off the device', async () => {
    const enc = await connect()
    const capabilities = await enc.probe()
    expect(capabilities.model).toBe('Blackmagic Streaming Encoder HD')
    expect(capabilities.firmware).toBe('3.4')
  })

  it('reports what the encoder can actually do, from its platform list', async () => {
    const capabilities = await (await connect()).probe()
    expect(capabilities.features).toContain('streaming')
    // It offers a platform that takes an arbitrary URL, which is what a
    // scheduled event needs.
    expect(capabilities.features).toContain('custom-url')
    expect(capabilities.features).toContain('platforms:2')
  })

  it('still works when the device declines to identify itself', async () => {
    // The document says /system/product can answer 501. The fallback name
    // must not claim a model, because this adapter drives Web Presenters
    // too and a silent unit could be either.
    const capabilities = await (await connect({}, { productUnimplemented: true })).probe()
    expect(capabilities.model).toBe('Blackmagic encoder')
  })

  it('reports a reachable, actionable error when nothing is listening', async () => {
    await encoder.close()
    const plugin = streamingEncoderPlugin({ timeoutMs: 1_000 })
    await expect(
      plugin.createDevice({
        deviceId: 'enc-1',
        config: { host: '127.0.0.1', port: encoder.boundPort },
        log: () => {},
        emitState: () => {},
        emitHealth: () => {},
      }),
    ).rejects.toMatchObject({ code: 'unreachable', retryable: true })
  })

  it('exposes one stream output that cannot be fanned out', async () => {
    const nodes = await (await connect()).listNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.supports).toEqual(['applyStreamTarget', 'startStreaming', 'stopStreaming'])
    expect(nodes[0]?.ports[0]).toMatchObject({ maxLinks: 1, requiresCredential: 'stream-key' })
  })
})

describe('pointing the encoder at a destination', () => {
  it('uses the customizable platform so a run can choose the URL', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })

    // This is the whole reason the customizable platform is preferred: the
    // ingest YouTube issues this morning is not in any built-in preset.
    expect(encoder.active).toMatchObject({
      platform: 'Custom RTMP',
      server: 'Custom',
      quality: 'Streaming High',
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
  })

  it('reads back a fingerprint, never the key', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })

    const state = await enc.invoke('stream', 'readState')
    expect(state?.streaming?.targetUrl).toBe('rtmps://live.example.com/app')
    expect(state?.streaming?.keyFingerprint).toBe(fingerprint(KEY))
    expect(JSON.stringify(state)).not.toContain(KEY)
  })

  it("uses a platform's own server when it already points there", async () => {
    // No platform is named anywhere any more, so this is the encoder's own
    // preset being matched by address rather than chosen by configuration.
    const enc = await connect({}, { noCustomizablePlatform: true })
    await enc.invoke('stream', 'applyStreamTarget', { url: YOUTUBE_PRIMARY, key: KEY })

    expect(encoder.active).toMatchObject({ platform: 'YouTube', server: 'Primary', key: KEY })
    // Not a custom URL: the device's own preset was matched.
    expect(encoder.active?.url).toBeUndefined()
  })

  it('reports the destination for a named platform, which the device omits', async () => {
    // The API only returns `url` for customizable platforms, so without
    // this the verify-after-write check would have nothing to compare.
    const enc = await connect({}, { noCustomizablePlatform: true })
    await enc.invoke('stream', 'applyStreamTarget', { url: YOUTUBE_PRIMARY, key: KEY })

    const state = await enc.invoke('stream', 'readState')
    expect(state?.streaming?.targetUrl).toBe(YOUTUBE_PRIMARY)
  })

  it('tolerates a trailing slash between the service and the preset', async () => {
    const enc = await connect({}, { noCustomizablePlatform: true })
    await enc.invoke('stream', 'applyStreamTarget', { url: `${YOUTUBE_PRIMARY}/`, key: KEY })
    expect(encoder.active).toMatchObject({ server: 'Primary' })
  })

  it('takes the quality the event asked for', async () => {
    const enc = await connect({}, { noCustomizablePlatform: true })
    await enc.invoke('stream', 'applyStreamTarget', {
      url: YOUTUBE_PRIMARY,
      key: KEY,
      quality: 'Streaming Medium',
    })
    expect(encoder.active?.quality).toBe('Streaming Medium')
  })

  it('leaves the encoder on its own profile when nothing asks for one', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
    expect(encoder.active?.quality).toBe('Streaming High')
  })

  it('names the profiles it has when asked for one it does not', async () => {
    const enc = await connect()
    await expect(
      enc.invoke('stream', 'applyStreamTarget', {
        url: 'rtmps://live.example.com/app',
        key: KEY,
        quality: 'Ludicrous',
      }),
    ).rejects.toMatchObject({
      code: 'unknown-quality',
      remediation: expect.stringContaining('Streaming High'),
    })
  })

  it('explains itself when no platform can reach the requested URL', async () => {
    const enc = await connect({}, { noCustomizablePlatform: true })
    await expect(
      enc.invoke('stream', 'applyStreamTarget', {
        url: 'rtmps://nowhere.example.com/app',
        key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'no-usable-platform' })
  })

  it('still finds a matching preset when no platform takes a custom URL', async () => {
    const enc = await connect({}, { noCustomizablePlatform: true })
    await enc.invoke('stream', 'applyStreamTarget', { url: YOUTUBE_PRIMARY, key: KEY })
    expect(encoder.active).toMatchObject({ platform: 'YouTube', server: 'Primary' })
  })
})

describe('starting and stopping', () => {
  it('starts, and the read-back confirms it', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
    await enc.invoke('stream', 'startStreaming')

    const state = await enc.invoke('stream', 'readState')
    expect(state?.streaming?.active).toBe(true)
    expect(state?.streaming?.bitrateBps).toBe(6_000_000)
  })

  it('refuses to start before a destination is set', async () => {
    const enc = await connect()
    await expect(enc.invoke('stream', 'startStreaming')).rejects.toMatchObject({
      code: 'no-stream-target',
    })
    expect(encoder.requests).not.toContain('PUT /livestreams/0/start')
  })

  it('counts a stop as done once the cache starts draining', async () => {
    // The device goes Streaming -> Flushing -> Idle. Treating Flushing as
    // still-active would make the stop step retry while the encoder drains,
    // which can take a while on a large cache.
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
    await enc.invoke('stream', 'startStreaming')
    await enc.invoke('stream', 'stopStreaming')

    expect(encoder.status).toBe('Flushing')
    expect((await enc.invoke('stream', 'readState'))?.streaming?.active).toBe(false)
  })

  it('counts connecting as active, so a start verifies immediately', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
    encoder.status = 'Connecting'
    expect((await enc.invoke('stream', 'readState'))?.streaming?.active).toBe(true)
  })

  it('surfaces cache usage and the effective format for the dashboard', async () => {
    const enc = await connect()
    encoder.cache = 12
    const state = await enc.invoke('stream', 'readState')
    expect(state?.raw).toMatchObject({ cachePercent: 12, effectiveVideoFormat: '1920x1080p30' })
  })
})

describe('health', () => {
  it('is connected while the device answers', async () => {
    const enc = await connect()
    expect((await enc.health()).state).toBe('connected')
  })

  it('is degraded, not disconnected, when the livestream is interrupted', async () => {
    // On air but broken. An operator needs to tell this apart from a device
    // that has vanished.
    const enc = await connect()
    encoder.status = 'Interrupted'
    const health = await enc.health()
    expect(health.state).toBe('degraded')
    expect(health.message).toMatch(/interrupted/i)
  })

  it('is disconnected once the device stops answering', async () => {
    const enc = await connect()
    await encoder.close()
    expect((await enc.health()).state).toBe('disconnected')
  })
})

describe('API errors', () => {
  it('catches a platform with no quality profiles before sending anything', async () => {
    encoder.platforms = encoder.platforms.map((p) =>
      p.platform === 'Custom RTMP' ? { ...p, profiles: [], defaultProfile: undefined } : p,
    )
    const enc = await connect()

    await expect(
      enc.invoke('stream', 'applyStreamTarget', { url: 'rtmps://live.example.com/app', key: KEY }),
    ).rejects.toMatchObject({ code: 'no-quality' })
    expect(encoder.requests).not.toContain('PUT /livestreams/0/activePlatform')
  })

  it('turns a rejected request into advice rather than a status code', async () => {
    // The adapter reads the platform list once, on connect. A firmware
    // update that drops a profile underneath it shows up as a 400, and the
    // message has to point somewhere useful.
    const enc = await connect()
    encoder.platforms = encoder.platforms.map((p) =>
      p.platform === 'Custom RTMP' ? { ...p, profiles: [] } : p,
    )

    await expect(
      enc.invoke('stream', 'applyStreamTarget', { url: 'rtmps://live.example.com/app', key: KEY }),
    ).rejects.toMatchObject({
      code: 'rejected',
      remediation: expect.stringContaining('Devices page'),
    })
  })

  it('marks a server error retryable', async () => {
    const enc = await connect()
    encoder.options = { failWith: 503 }
    await expect(enc.invoke('stream', 'readState')).rejects.toMatchObject({ retryable: true })
  })
})

describe('the wire', () => {
  it('talks to the documented paths under /control/api/v1', async () => {
    const enc = await connect()
    await enc.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://live.example.com/app',
      key: KEY,
    })
    await enc.invoke('stream', 'startStreaming')
    await enc.invoke('stream', 'stopStreaming')

    expect(encoder.requests).toEqual(
      expect.arrayContaining([
        'GET /livestreams/0',
        'GET /system/product',
        'GET /livestreams/platforms',
        'GET /livestreams/platforms/YouTube',
        'PUT /livestreams/0/activePlatform',
        'PUT /livestreams/0/start',
        'PUT /livestreams/0/stop',
      ]),
    )
  })
})
