import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { propresenterPlugin } from './index.js'
import { ProApiError, type ProApi, type ProCaptureSettings } from './api.js'

/**
 * ProPresenter, driven through a fake that answers like the API does.
 *
 * Modelled on the published 7.9 specification: one capture whose settings
 * decide where it goes, `start` and `stop` as bare GETs answering 204, and
 * a settings body that refuses without a source. A fake that accepted
 * anything would agree with an adapter that invented a source screen,
 * which is the mistake most worth not making here.
 */

const NOW = Date.parse('2026-03-08T14:00:00Z')

interface FakeOptions {
  unreachable?: boolean
  /** An older ProPresenter: the capture API did not exist before 7.9. */
  tooOld?: boolean
  /** How this install spells the RTMP destination. The spec disagrees with
   *  itself, so both are real. */
  targetKey?: 'url' | 'server'
  /** Nobody has chosen a screen to capture. */
  noSource?: boolean
  /** No folder set in ProPresenter's own settings. */
  noFolder?: boolean
  /** Firmware that reports which of the three the capture goes to. Plenty
   *  does not, which is the whole reason the adapter keeps its own note. */
  destination?: 'disk' | 'rtmp' | 'resi'
  /** An RTMP server left over from the last time somebody streamed. Every
   *  idle ProPresenter that has ever streamed looks like this. */
  staleTarget?: string
}

function fakePro(options: FakeOptions = {}) {
  const key = options.targetKey ?? 'server'
  let capturing = false
  let captureSeconds = 0
  const settings: ProCaptureSettings = {
    ...(options.noSource ? {} : { source: '3C39C433-5C18-4F51-B357-55BB870227C4' }),
    audio_routing: [[1], [2]],
    disk: options.noFolder ? {} : { file_location: '/Users/booth/Movies' },
    rtmp: {
      [key]: options.staleTarget ?? '',
      key: options.staleTarget ? 'left-over-key' : '',
      encoding: '720p30_2_5',
      save_local: false,
    },
    ...(options.destination ? { destination: options.destination } : {}),
  }
  const puts: ProCaptureSettings[] = []

  const api: ProApi = {
    async request<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T | undefined> {
      if (options.unreachable) throw new Error('connect ECONNREFUSED')
      if (options.tooOld && path.startsWith('/v1/capture')) {
        throw new ProApiError(404, `${method} ${path} answered 404`)
      }

      if (path === '/version') {
        return {
          name: 'Main sanctuary Pro7 machine',
          platform: 'mac',
          os_version: '14.5',
          host_description: 'Mac Studio',
          api_version: 'v1',
        } as T
      }
      if (path === '/v1/capture/status') {
        return {
          capturing,
          capture_time: clock(captureSeconds),
        } as T
      }
      if (path === '/v1/capture/settings') {
        if (method === 'GET') return structuredClone(settings) as T
        const next = body as ProCaptureSettings
        // The API requires these; an adapter that invented them would be
        // silently reconfiguring somebody's machine.
        if (!next.source) throw new ProApiError(400, 'PUT /v1/capture/settings answered 400')
        puts.push(structuredClone(next))
        Object.assign(settings, next)
        return undefined
      }
      if (path === '/v1/capture/start') {
        capturing = true
        captureSeconds = 42 * 60 + 27
        return undefined
      }
      if (path === '/v1/capture/stop') {
        capturing = false
        captureSeconds = 0
        return undefined
      }
      throw new ProApiError(404, `${method} ${path} answered 404`)
    },
  }

  return {
    api,
    puts,
    settings: () => structuredClone(settings),
    capturing: () => capturing,
    /** Somebody walks up to the machine and changes the dropdown. */
    operatorPoints: (destination: 'disk' | 'rtmp' | 'resi') => {
      settings.destination = destination
    },
  }
}

function clock(seconds: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

const emitted: { nodeId: string; state: NodeState }[] = []

function context(config: Record<string, unknown> = {}): DeviceContext {
  return {
    deviceId: 'pro-1',
    config: { host: '10.0.0.9', port: 1025, ...config },
    log: () => {},
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

let device: DeviceInstance | undefined

async function connect(
  fake: ReturnType<typeof fakePro>,
  config: Record<string, unknown> = {},
): Promise<DeviceInstance> {
  const plugin = propresenterPlugin({ now: () => NOW, createApi: () => fake.api })
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
  it('reports the machine by the name its operator gave it', async () => {
    const pro = await connect(fakePro())
    const capabilities = await pro.probe()
    // What somebody will recognise in a list of devices.
    expect(capabilities.model).toBe('Main sanctuary Pro7 machine')
    expect(capabilities.firmware).toContain('v1')
    expect(capabilities.features).toEqual(expect.arrayContaining(['streaming', 'recording']))
  })

  it('explains itself when ProPresenter is not there', async () => {
    const plugin = propresenterPlugin({
      now: () => NOW,
      createApi: () => fakePro({ unreachable: true }).api,
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/Could not reach ProPresenter/)
  })

  it('names the version when the capture API is missing', async () => {
    // A 404 from an older ProPresenter explains nothing on its own, and
    // "needs 7.9" is the only useful thing anybody can do about it.
    const pro = await connect(fakePro({ tooOld: true }))
    await expect(pro.invoke('capture', 'readState')).rejects.toThrow(/7\.9 or newer/)
  })

  it('offers one capture node, not a stream and a recording', async () => {
    // The shape of the product: a single pipeline whose settings decide
    // where it goes. Two nodes would let one event's second output stop
    // the first one's capture.
    const pro = await connect(fakePro())
    const nodes = await pro.listNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.id).toBe('capture')
    expect(nodes[0]?.supports).toEqual(
      expect.arrayContaining(['startStreaming', 'startRecording', 'applyStreamTarget']),
    )
    // ProPresenter takes a folder and names the file itself, and never
    // says what it called it, so there is nothing retention could match.
    expect(nodes[0]?.supports).not.toContain('listMedia')
    expect(nodes[0]?.supports).not.toContain('deleteMedia')
  })
})

describe('pointing the capture at a stream', () => {
  it('keeps the source and routing it was given, and changes only the target', async () => {
    // This app decides where a capture goes. What ProPresenter captures,
    // and how its audio is routed, belongs to whoever set the machine up.
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'applyStreamTarget', {
      url: 'rtmps://a.rtmp.youtube.com/live2',
      key: 'live_abcd-1234',
    })

    const written = fake.puts.at(-1)!
    expect(written.source).toBe('3C39C433-5C18-4F51-B357-55BB870227C4')
    expect(written.audio_routing).toEqual([[1], [2]])
  })

  it('writes the destination under the name this install already uses', async () => {
    // The spec names the field `url` in its schema and `server` in every
    // example. The app itself is the authority on which it understands.
    for (const field of ['url', 'server'] as const) {
      const fake = fakePro({ targetKey: field })
      const pro = await connect(fake)
      await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })

      const rtmp = fake.puts.at(-1)!.rtmp!
      expect(rtmp[field]).toBe('rtmp://example/live')
      // And exactly one of them, not both.
      expect(Object.keys(rtmp).filter((name) => name === 'url' || name === 'server')).toEqual([
        field,
      ])
      await pro.dispose()
      device = undefined
    }
  })

  it('never lets the key back out, only a fingerprint of it', async () => {
    const pro = await connect(fakePro())
    await pro.invoke('capture', 'applyStreamTarget', {
      url: 'rtmp://example/live',
      key: 'live_super-secret',
    })
    const state = await pro.invoke('capture', 'readState')
    expect(state?.streaming?.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(state)).not.toContain('live_super-secret')
  })

  it('passes a quality through as the encoding', async () => {
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'applyStreamTarget', {
      url: 'rtmp://example/live',
      key: 'k',
      quality: '1080p30_6',
    })
    expect(fake.puts.at(-1)!.rtmp!.encoding).toBe('1080p30_6')
  })

  it('refuses rather than inventing a screen nobody chose', async () => {
    // The settings body requires a source. Making one up would silently
    // reconfigure what the machine is capturing.
    const pro = await connect(fakePro({ noSource: true }))
    await expect(
      pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' }),
    ).rejects.toThrow(/no capture source/i)
  })
})

describe('keeping a local copy', () => {
  it('is off unless it was asked for', async () => {
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    expect(fake.puts.at(-1)!.rtmp!.save_local).toBe(false)
  })

  it('streams and writes a copy at once when it was', async () => {
    // The only way to get both out of ProPresenter: one capture cannot be
    // two outputs, so this is the option rather than a second node.
    const fake = fakePro()
    const pro = await connect(fake, { saveLocal: true, fileLocation: '/Volumes/Archive' })
    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })

    const rtmp = fake.puts.at(-1)!.rtmp!
    expect(rtmp.save_local).toBe(true)
    expect(rtmp.file_location).toBe('/Volumes/Archive')
  })

  it('falls back to the folder ProPresenter already has', async () => {
    const fake = fakePro()
    const pro = await connect(fake, { saveLocal: true })
    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    expect(fake.puts.at(-1)!.rtmp!.file_location).toBe('/Users/booth/Movies')
  })

  it('says so rather than streaming with the copy quietly not happening', async () => {
    const pro = await connect(fakePro({ noFolder: true }), { saveLocal: true })
    await expect(
      pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' }),
    ).rejects.toThrow(/no folder is configured/i)
  })

  it('reports both halves as running, because both are', async () => {
    const fake = fakePro()
    const pro = await connect(fake, { saveLocal: true, fileLocation: '/Volumes/Archive' })
    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await pro.invoke('capture', 'startStreaming')

    const state = await pro.invoke('capture', 'readState')
    expect(state?.streaming?.active).toBe(true)
    // A screen showing only the stream would be hiding the recording.
    expect(state?.recording?.active).toBe(true)
  })
})

describe('recording to disk', () => {
  it('points the capture at a folder and starts', async () => {
    const fake = fakePro()
    const pro = await connect(fake, { fileLocation: '/Volumes/Archive' })
    await pro.invoke('capture', 'startRecording', { filename: 'sunday-service' })

    expect(fake.puts.at(-1)!.disk!.file_location).toBe('/Volumes/Archive')
    expect(fake.capturing()).toBe(true)
  })

  it('uses ProPresenter’s own folder when none was set here', async () => {
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday' })
    expect(fake.puts.at(-1)!.disk!.file_location).toBe('/Users/booth/Movies')
  })

  it('refuses when there is nowhere to capture to', async () => {
    const pro = await connect(fakePro({ noFolder: true }))
    await expect(pro.invoke('capture', 'startRecording', { filename: 'sunday' })).rejects.toThrow(
      /no folder set/i,
    )
  })

  it('reports no filename, because ProPresenter never says what it used', async () => {
    // Deliberate. A folder goes in, a file appears, and the API never
    // names it — so there is nothing the ledger could match, and nothing
    // that could be swept later. Claiming a name would be worse.
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday-service' })

    const state = await pro.invoke('capture', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBeUndefined()
  })
})

describe('where the capture is going', () => {
  it('does not call a disk capture a stream because an old URL is lying about', async () => {
    // The bug this guards: ProPresenter keeps the last stream's server and
    // key forever, so "there is a URL configured" says nothing about what
    // is happening now. Reading it as a live stream puts a green streaming
    // light on a machine that is recording to a hard disk.
    const fake = fakePro({ staleTarget: 'rtmp://last-week/live' })
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday' })

    const state = await pro.invoke('capture', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.streaming?.active).toBe(false)
    // And nothing about last week's stream on a recording, either.
    expect(state?.streaming?.targetUrl).toBeUndefined()
    expect(state?.streaming?.keyFingerprint).toBeUndefined()
  })

  it('believes the app over its own notes when the app says', async () => {
    // Somebody can always walk up to the machine and change the dropdown
    // after this app pointed it. On firmware that reports where the
    // capture goes, the machine wins over the adapter's memory.
    const fake = fakePro({ destination: 'disk', staleTarget: 'rtmp://example/live' })
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday' })
    fake.operatorPoints('rtmp')

    const state = await pro.invoke('capture', 'readState')
    expect(state?.streaming?.active).toBe(true)
    expect(state?.streaming?.targetUrl).toBe('rtmp://example/live')
    expect(state?.recording?.active).toBe(false)
  })

  it('tells that firmware which way to point', async () => {
    const fake = fakePro({ destination: 'rtmp' })
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday' })
    expect(fake.puts.at(-1)!.destination).toBe('disk')

    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    expect(fake.puts.at(-1)!.destination).toBe('rtmp')
  })

  it('does not invent the field on firmware that has no such thing', async () => {
    // Sending a key this body does not know is how a settings PUT gets
    // rejected whole, taking the source screen with it.
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'startRecording', { filename: 'sunday' })
    expect(Object.keys(fake.puts.at(-1)!)).not.toContain('destination')
  })

  it('counts a Resi capture as streaming', async () => {
    const fake = fakePro({ destination: 'resi' })
    const pro = await connect(fake)
    await pro.invoke('capture', 'startStreaming')

    const state = await pro.invoke('capture', 'readState')
    expect(state?.streaming?.active).toBe(true)
    expect(state?.recording?.active).toBe(false)
  })
})

describe('starting and stopping', () => {
  it('starts and stops the one capture', async () => {
    const fake = fakePro()
    const pro = await connect(fake)
    expect((await pro.invoke('capture', 'readState'))?.recording?.active).toBe(false)

    await pro.invoke('capture', 'startStreaming')
    expect(fake.capturing()).toBe(true)

    await pro.invoke('capture', 'stopStreaming')
    expect(fake.capturing()).toBe(false)
  })

  it('reads the elapsed time ProPresenter reports as a clock', async () => {
    const pro = await connect(fakePro())
    await pro.invoke('capture', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await pro.invoke('capture', 'startStreaming')

    // 00:42:27 as milliseconds. Nothing else in the app speaks clocks.
    expect((await pro.invoke('capture', 'readState'))?.streaming?.durationMs).toBe(2_547_000)
  })

  it('stops the same capture whichever half asked', async () => {
    // One pipeline: stopping "the recording" stops the stream too, which
    // is why this is one node and not two.
    const fake = fakePro()
    const pro = await connect(fake)
    await pro.invoke('capture', 'startStreaming')
    await pro.invoke('capture', 'stopRecording')
    expect(fake.capturing()).toBe(false)
  })
})
