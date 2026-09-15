import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { magewellPlugin } from './index.js'
import { createMagewellApi, passwordHash, RESULT, takesUrlAndKey, type HttpRequest } from './api.js'

/**
 * A Magewell encoder, driven through a fake that behaves like one.
 *
 * The behaviour that matters is not the JSON shape, it is the device's
 * arrangement: `start-live` is global, `enable-server` picks who takes
 * part, and a destination that is enabled is not yet a destination that is
 * up. So the fake models all three. An adapter that assumed `start-live`
 * started only the destination it was asked about would pass against a
 * fake that returned a tidy object and would put an unannounced stream on
 * air against the real thing.
 *
 * It also refuses without a session, because the session expiring quietly
 * over a week is a real failure mode and the retry belongs in the adapter.
 *
 * The fake sits at the HTTP round trip, not at the API object, so signing
 * in, carrying the `sid` cookie and noticing it has gone stale are all the
 * adapter's real code running against it rather than something a fake
 * agreed with.
 */

const NOW = Date.parse('2026-03-08T14:00:00Z')

interface FakeOptions {
  unreachable?: boolean
  /** Wrong user name or password. */
  badPassword?: boolean
  /** Only a non-RTMP destination configured, so nothing takes a key. */
  ndiOnly?: boolean
  /** No input plugged in: the device refuses to start. */
  noSignal?: boolean
  /** The session has gone stale, as it does over a quiet week. */
  sessionExpired?: boolean
}

function fakeMagewell(options: FakeOptions = {}) {
  const calls: { method: string; params: Record<string, string> }[] = []
  let sessions = 0
  let signedIn = false
  let expired = options.sessionExpired === true

  const servers = options.ndiOnly
    ? [{ id: 0, type: 130, name: 'NDI HX', 'is-use': 0 }]
    : [
        { id: 0, type: 0, name: 'Custom RTMP', 'is-use': 0, url: '', key: '' },
        { id: 1, type: 0, name: 'Archive RTMP', 'is-use': 0, url: '', key: '' },
      ]
  const channels = [{ id: 0, type: 1, 'is-use': 0, 'dir-name': 'REC_Folder', 'prefix-name': 'VID' }]

  /** What the device is actually doing, as opposed to what is enabled. */
  const liveResult = new Map<number, number>()
  const recResult = new Map<number, number>()
  let liveRunning = false
  let recRunning = false

  const files = [
    {
      name: 'VID_7.mp4',
      status: 1,
      'create-time': '2026-03-01 09:31:02',
      'size-bytes': 4025670,
      duration: 3600,
    },
    {
      name: 'VID_8.mp4',
      status: 1,
      'create-time': '2026-03-08 09:30:41',
      'size-bytes': 5025670,
      duration: 3540,
    },
  ]

  function recompute(): void {
    for (const server of servers) {
      // Enabled and the encoder running is what gets a destination up. The
      // device reports the stages on the way, and this jumps to the end —
      // except where there is nowhere to go, which is its own answer.
      if (server['is-use'] === 1 && liveRunning) {
        liveResult.set(server.id, server.url ? RESULT.livingConnected : RESULT.livingNotSet)
      } else {
        liveResult.set(server.id, RESULT.init)
      }
    }
    for (const channel of channels) {
      recResult.set(
        channel.id,
        channel['is-use'] === 1 && recRunning ? RESULT.running : RESULT.init,
      )
    }
    const recordingNow = files.find((file) => file.status === 0)
    if (recRunning && !recordingNow)
      files.push({
        name: 'VID_9.mp4',
        status: 0,
        'create-time': '2026-03-08 14:00:00',
        'size-bytes': 120,
        duration: 0,
      })
    if (!recRunning && recordingNow) recordingNow.status = 1
  }

  const SID = 'e0f6b33dd2b575eff40733b3778beaab'

  function answer(
    method: string,
    params: Record<string, string>,
    body: unknown,
  ): Record<string, unknown> {
    if (method === 'login') {
      if (options.badPassword) return { result: -1 }
      // The device wants the hash, never the password itself.
      if (params.pass !== passwordHash('device-password')) return { result: -1 }
      sessions += 1
      signedIn = true
      expired = false
      return { result: 0, __setCookie: `sid=${SID}; path=/` }
    }

    if (!signedIn || expired) return { result: -17 }
    calls.push({ method, params })

    if (method === 'del-media-files') {
      const payload = body as { 'media-files': string[] }
      for (const name of payload['media-files']) {
        const at = files.findIndex((file) => file.name === name)
        // The device does not refuse to delete the file it is writing
        // to; that guard is the adapter's, which is the point of the
        // test that covers it.
        if (at >= 0) files.splice(at, 1)
      }
      return { result: 0 }
    }

    switch (method) {
      case 'get-info':
        return {
          result: 0,
          'product-name': 'Ultra Encode AIO',
          'firmware-ver': '2.4.320',
          'box-name': 'Sanctuary encoder',
        }
      case 'get-settings':
        return { result: 0, name: 'Sanctuary encoder', 'stream-server': structuredClone(servers) }
      case 'get-rec-channels':
        return { result: 0, 'rec-channels': structuredClone(channels) }
      case 'get-status':
        recompute()
        return {
          result: 0,
          'box-name': 'Sanctuary encoder',
          'live-status': {
            live: servers.map((server) => ({
              id: server.id,
              type: server.type,
              'is-use': server['is-use'],
              name: server.name,
              result: liveResult.get(server.id) ?? RESULT.init,
              'run-ms': liveResult.get(server.id) === RESULT.livingConnected ? 2_547_000 : 0,
              'main-inst-bps': liveResult.get(server.id) === RESULT.livingConnected ? 4_500_000 : 0,
            })),
          },
          'rec-status': {
            rec: channels.map((channel) => ({
              id: channel.id,
              type: channel.type,
              'is-use': channel['is-use'],
              result: recResult.get(channel.id) ?? RESULT.init,
              'run-ms': recResult.get(channel.id) === RESULT.running ? 1_700 : 0,
            })),
          },
        }
      case 'set-server': {
        const server = servers.find((entry) => entry.id === Number(params.id))
        if (!server) return { result: -14 }
        server.url = params.url ?? ''
        server.key = params.key ?? ''
        return { result: 0 }
      }
      case 'enable-server': {
        const server = servers.find((entry) => entry.id === Number(params.id))
        if (!server) return { result: -14 }
        server['is-use'] = Number(params['is-use'])
        recompute()
        return { result: 0 }
      }
      case 'start-live':
        if (options.noSignal) return { result: -35 }
        // The device's own answer to being asked twice.
        if (liveRunning) return { result: RESULT.repeat }
        liveRunning = true
        recompute()
        return { result: 0 }
      case 'stop-live':
        liveRunning = false
        recompute()
        return { result: 0 }
      case 'enable-rec-channel': {
        const channel = channels.find((entry) => entry.id === Number(params.id))
        if (!channel) return { result: -14 }
        channel['is-use'] = Number(params['is-use'])
        recompute()
        return { result: 0 }
      }
      case 'start-rec':
        if (options.noSignal) return { result: -35 }
        if (recRunning) return { result: RESULT.repeat }
        recRunning = true
        recompute()
        return { result: 0 }
      case 'stop-rec':
        recRunning = false
        recompute()
        return { result: 0 }
      case 'get-media-files':
        return {
          result: 0,
          path: '/media/disk1/REC_Folder',
          'media-files': structuredClone(files).slice(
            Number(params.start ?? 0),
            Number(params.start ?? 0) + Number(params.count ?? 50),
          ),
        }
      default:
        return { result: -10 }
    }
  }

  const http: HttpRequest = async (url, init) => {
    if (options.unreachable) throw new Error('connect ECONNREFUSED')
    const query = new URL(url).searchParams
    const params: Record<string, string> = {}
    for (const [name, value] of query) params[name] = value
    const method = params.method ?? ''
    delete params.method

    // The device only honours a request that carries the session it issued.
    // Presenting the wrong one, or none, gets the same -17 as an expired
    // one — which is what makes the adapter's re-login worth having.
    const presented = init?.headers?.cookie?.match(/sid=([^;]+)/)?.[1]
    if (method !== 'login' && presented !== SID) return json({ result: -17 })

    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    const reply = answer(method, params, body)
    const cookie = reply.__setCookie as string | undefined
    delete reply.__setCookie
    return json(reply, cookie)
  }

  function json(value: Record<string, unknown>, setCookie?: string) {
    return {
      ok: true,
      status: 200,
      text: JSON.stringify(value),
      ...(setCookie === undefined ? {} : { setCookie }),
    }
  }

  return {
    http,
    calls,
    of: (method: string) => calls.filter((call) => call.method === method),
    servers: () => structuredClone(servers),
    files: () => structuredClone(files),
    sessions: () => sessions,
    live: () => liveRunning,
    rec: () => recRunning,
    /** The session goes stale, as it does when nobody touches the encoder
     *  between one Sunday and the next. */
    expireSession: () => {
      expired = true
    },
  }
}

const emitted: { nodeId: string; state: NodeState }[] = []

function context(config: Record<string, unknown> = {}): DeviceContext {
  return {
    deviceId: 'mw-1',
    config: { host: '10.0.0.7', port: 80, user: 'Admin', password: 'device-password', ...config },
    log: () => {},
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

let device: DeviceInstance | undefined

async function connect(
  fake: ReturnType<typeof fakeMagewell>,
  config: Record<string, unknown> = {},
): Promise<DeviceInstance> {
  const plugin = magewellPlugin({
    now: () => NOW,
    createApi: (opts) => createMagewellApi({ ...opts, http: fake.http }),
  })
  device = withSerializingTransport(await plugin.createDevice(context(config)))
  return device
}

beforeEach(() => {
  emitted.length = 0
})

afterEach(async () => {
  await device?.dispose()
  device = undefined
})

describe('connecting', () => {
  it('reports the model and firmware it found', async () => {
    const mw = await connect(fakeMagewell())
    const capabilities = await mw.probe()
    expect(capabilities.model).toBe('Ultra Encode AIO')
    expect(capabilities.firmware).toBe('2.4.320')
  })

  it('never sends the password itself, only the hash the device asks for', async () => {
    // The device's own scheme. Sending the plain password would work on
    // nothing and leak it on the way.
    const fake = fakeMagewell()
    await connect(fake)
    expect(fake.sessions()).toBe(1)
  })

  it('says the password is wrong rather than blaming the network', async () => {
    const plugin = magewellPlugin({
      now: () => NOW,
      createApi: (opts) =>
        createMagewellApi({ ...opts, http: fakeMagewell({ badPassword: true }).http }),
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/user name or password/i)
  })

  it('explains itself when the encoder is not there', async () => {
    const plugin = magewellPlugin({
      now: () => NOW,
      createApi: (opts) =>
        createMagewellApi({ ...opts, http: fakeMagewell({ unreachable: true }).http }),
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/Could not reach the encoder/)
  })
})

describe('the nodes it offers', () => {
  it('takes them from what the device is set up with, not from a model name', async () => {
    const mw = await connect(fakeMagewell())
    const nodes = await mw.listNodes()
    expect(nodes.map((node) => node.id)).toEqual(['stream0', 'stream1', 'rec0'])
  })

  it('does not claim it can point an NDI destination at a URL and key', async () => {
    // Most of the device's destination types are configured by port and
    // name. Offering applyStreamTarget on one would be a lie that only
    // shows up on a Sunday morning.
    const mw = await connect(fakeMagewell({ ndiOnly: true }))
    const nodes = await mw.listNodes()
    const ndi = nodes.find((node) => node.id === 'stream0')!
    expect(ndi.supports).toEqual(['startStreaming', 'stopStreaming'])
    expect(takesUrlAndKey(130)).toBe(false)
  })

  it('says the recorder can tidy up after itself, because it can', async () => {
    const mw = await connect(fakeMagewell())
    const nodes = await mw.listNodes()
    const recorder = nodes.find((node) => node.id === 'rec0')!
    expect(recorder.supports).toEqual(
      expect.arrayContaining(['startRecording', 'listMedia', 'deleteMedia']),
    )
  })
})

describe('streaming', () => {
  it('enables the one destination and then starts the encoder', async () => {
    // Two calls because the device separates them: start-live takes no
    // arguments and acts on the whole box.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('stream0', 'applyStreamTarget', {
      url: 'rtmp://a.rtmp.youtube.com/live2',
      key: 'live_abcd-1234',
    })
    await mw.invoke('stream0', 'startStreaming')

    expect(fake.of('enable-server')[0]!.params).toMatchObject({ id: '0', 'is-use': '1' })
    expect(fake.of('start-live')).toHaveLength(1)
    expect(fake.servers()[0]!.url).toBe('rtmp://a.rtmp.youtube.com/live2')
  })

  it('leaves the other destination alone when one output starts', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('stream0', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await mw.invoke('stream0', 'startStreaming')

    const second = await mw.invoke('stream1', 'readState')
    expect(second?.streaming?.active).toBe(false)
  })

  it('runs two destinations at once, which is the whole point', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    for (const node of ['stream0', 'stream1']) {
      await mw.invoke(node, 'applyStreamTarget', { url: `rtmp://example/${node}`, key: 'k' })
      await mw.invoke(node, 'startStreaming')
    }
    expect((await mw.invoke('stream0', 'readState'))?.streaming?.active).toBe(true)
    expect((await mw.invoke('stream1', 'readState'))?.streaming?.active).toBe(true)
  })

  it('does not take the other stream off air when one output ends', async () => {
    // The trap this device sets: stop-live stops everything. Stopping one
    // output has to disable that destination and leave the encoder running.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    for (const node of ['stream0', 'stream1']) {
      await mw.invoke(node, 'applyStreamTarget', { url: `rtmp://example/${node}`, key: 'k' })
      await mw.invoke(node, 'startStreaming')
    }
    await mw.invoke('stream0', 'stopStreaming')

    expect(fake.of('stop-live')).toHaveLength(0)
    expect(fake.live()).toBe(true)
    expect((await mw.invoke('stream1', 'readState'))?.streaming?.active).toBe(true)
    expect((await mw.invoke('stream0', 'readState'))?.streaming?.active).toBe(false)
  })

  it('stops the encoder once the last destination goes', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('stream0', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await mw.invoke('stream0', 'startStreaming')
    await mw.invoke('stream0', 'stopStreaming')

    expect(fake.of('stop-live')).toHaveLength(1)
    expect(fake.live()).toBe(false)
  })

  it('does not call an enabled destination live until it is actually up', async () => {
    // The device reports a stage, not a boolean. A destination with no
    // address set is enabled and going nowhere, and calling that
    // "streaming" is how a green light ends up over a dead stream.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('stream0', 'startStreaming')

    const state = await mw.invoke('stream0', 'readState')
    expect(state?.streaming?.active).toBe(false)
    expect(String(state?.raw?.stage)).toMatch(/no address is set/i)
  })

  it('reports the bitrate and how long it has been up', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('stream0', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await mw.invoke('stream0', 'startStreaming')

    const state = await mw.invoke('stream0', 'readState')
    expect(state?.streaming?.bitrateBps).toBe(4_500_000)
    expect(state?.streaming?.durationMs).toBe(2_547_000)
  })

  it('never lets the key back out, only a fingerprint of it', async () => {
    const mw = await connect(fakeMagewell())
    await mw.invoke('stream0', 'applyStreamTarget', {
      url: 'rtmp://example/live',
      key: 'live_super-secret',
    })
    const state = await mw.invoke('stream0', 'readState')
    expect(state?.streaming?.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(state)).not.toContain('live_super-secret')
  })

  it('refuses to point a destination that is not a URL and a key', async () => {
    const mw = await connect(fakeMagewell({ ndiOnly: true }))
    await expect(
      mw.invoke('stream0', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' }),
    ).rejects.toThrow(/not set by a URL and key/i)
  })

  it('names a missing input rather than failing vaguely', async () => {
    const mw = await connect(fakeMagewell({ noSignal: true }))
    await expect(mw.invoke('stream0', 'startStreaming')).rejects.toThrow(/no input signal/i)
  })
})

describe('recording', () => {
  it('starts, and reports the name the device chose', async () => {
    // There is no call that sets a recording filename: the device builds
    // it from the channel's own prefix. The requested name goes nowhere,
    // and what it actually used comes back.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('rec0', 'startRecording', { filename: 'sunday-service' })

    const state = await mw.invoke('rec0', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBe('VID_9.mp4')
    // And nothing was sent pretending to set it.
    expect(fake.of('start-rec')[0]!.params).toEqual({})
  })

  it('stops', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('rec0', 'startRecording', { filename: 'sunday' })
    await mw.invoke('rec0', 'stopRecording')

    expect(fake.rec()).toBe(false)
    expect((await mw.invoke('rec0', 'readState'))?.recording?.active).toBe(false)
  })
})

describe('the files on the card', () => {
  it('lists them with the sizes and dates the device reports', async () => {
    const mw = await connect(fakeMagewell())
    const media = await mw.invoke('rec0', 'listMedia', {})
    const files = media?.raw?.media as { name: string; bytes?: number; durationMs?: number }[]
    expect(files.map((file) => file.name)).toEqual(['VID_7.mp4', 'VID_8.mp4'])
    expect(files[0]!.bytes).toBe(4025670)
    // The device counts in seconds and everything here is milliseconds.
    expect(files[0]!.durationMs).toBe(3_600_000)
  })

  it('leaves the file being recorded out of the list', async () => {
    // It is on the card and it is nobody's recording yet. Putting it in a
    // list with a tick box beside it is how somebody deletes a service
    // while it is still going.
    const mw = await connect(fakeMagewell())
    await mw.invoke('rec0', 'startRecording', { filename: 'sunday' })

    const media = await mw.invoke('rec0', 'listMedia', {})
    const names = (media?.raw?.media as { name: string }[]).map((file) => file.name)
    expect(names).not.toContain('VID_9.mp4')
  })

  it('refuses to delete the file being recorded into', async () => {
    // The device will happily do it. This is the adapter's guard, and it
    // is the one that matters: the file is a service in progress.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('rec0', 'startRecording', { filename: 'sunday' })

    await expect(mw.invoke('rec0', 'deleteMedia', { name: 'VID_9.mp4' })).rejects.toThrow(
      /recording into right now/i,
    )
    expect(fake.files().some((file) => file.name === 'VID_9.mp4')).toBe(true)
  })

  it('removes one, and checks it actually went', async () => {
    const fake = fakeMagewell()
    const mw = await connect(fake)
    await mw.invoke('rec0', 'deleteMedia', { name: 'VID_7.mp4' })
    expect(fake.files().map((file) => file.name)).toEqual(['VID_8.mp4'])
  })
})

describe('the session', () => {
  it('signs in again when it has gone stale, rather than failing the command', async () => {
    // A week between services is long enough for the encoder to forget.
    // Sunday morning is the wrong time to find that out.
    const fake = fakeMagewell()
    const mw = await connect(fake)
    expect(fake.sessions()).toBe(1)

    fake.expireSession()
    const state = await mw.invoke('rec0', 'readState')

    expect(state?.recording?.active).toBe(false)
    expect(fake.sessions()).toBe(2)
  })
})
