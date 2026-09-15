import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { obsPlugin } from './index.js'
import type { ObsClient } from './client.js'

/**
 * OBS, driven through a fake that speaks obs-websocket.
 *
 * The fake holds state and answers requests the way the program does —
 * `StartRecord` flips `GetRecordStatus`, and the path only ever appears on
 * the state-change event and the `StopRecord` reply, because that is where
 * the real protocol puts it. A fake that volunteered the path everywhere
 * would agree with an adapter that looked in the wrong place, which is
 * exactly how the FTP directory bug shipped.
 */

const NOW = Date.parse('2026-03-08T14:00:00Z')

interface FakeOptions {
  /** Refuses the connection, for the unreachable path. */
  unreachable?: boolean
  /** Accepts commands and does nothing, like a program mid-freeze. */
  ignoresWrites?: boolean
  /** Never answers, for the deadline. */
  hangs?: boolean
}

function fakeObs(options: FakeOptions = {}) {
  const handlers = new Map<string, ((data: Record<string, unknown>) => void)[]>()
  const calls: { request: string; args?: Record<string, unknown> }[] = []
  let recording = false
  let streaming = false
  let recordingPath: string | undefined
  let service = {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: {} as { server?: string; key?: string },
  }
  let connected = false
  let recordCount = 0

  const fire = (event: string, data: Record<string, unknown>): void => {
    for (const handler of handlers.get(event) ?? []) handler(data)
  }

  const client: ObsClient = {
    connect: async (address) => {
      if (options.unreachable) throw new Error(`connect ECONNREFUSED ${address}`)
      connected = true
      return { obsWebSocketVersion: '5.5.0' }
    },
    disconnect: async () => {
      connected = false
    },
    call: async <T>(request: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ request, ...(args === undefined ? {} : { args }) })
      if (options.hangs) return new Promise<T>(() => {})
      if (!connected) throw new Error('not connected')

      switch (request) {
        case 'GetVersion':
          return { obsVersion: '31.0.2', obsWebSocketVersion: '5.5.0' } as T
        case 'GetRecordStatus':
          return { outputActive: recording, outputDuration: recording ? 1000 : 0 } as T
        case 'GetStreamStatus':
          return {
            outputActive: streaming,
            outputDuration: streaming ? 2000 : 0,
            outputCongestion: 0.25,
          } as T
        case 'GetStreamServiceSettings':
          return service as T
        case 'SetStreamServiceSettings':
          if (!options.ignoresWrites) {
            service = {
              streamServiceType: String(args?.streamServiceType ?? 'rtmp_custom'),
              streamServiceSettings: (args?.streamServiceSettings ?? {}) as {
                server?: string
                key?: string
              },
            }
          }
          return {} as T
        case 'StartRecord':
          if (!options.ignoresWrites) {
            recording = true
            // OBS picks the name itself, from the profile's filename
            // formatting. It is never the one anybody asked for.
            recordingPath = `C:\\Videos\\2026-03-08 09-00-0${++recordCount}.mkv`
            fire('RecordStateChanged', {
              outputActive: true,
              outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
              outputPath: recordingPath,
            })
          }
          return {} as T
        case 'StopRecord': {
          if (options.ignoresWrites) return {} as T
          recording = false
          const path = recordingPath
          fire('RecordStateChanged', {
            outputActive: false,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
            outputPath: path,
          })
          return { outputPath: path } as T
        }
        case 'StartStream':
          if (!options.ignoresWrites) {
            streaming = true
            fire('StreamStateChanged', {
              outputActive: true,
              outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
            })
          }
          return {} as T
        case 'StopStream':
          if (!options.ignoresWrites) {
            streaming = false
            fire('StreamStateChanged', {
              outputActive: false,
              outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
            })
          }
          return {} as T
        default:
          throw new Error(`unknown request ${request}`)
      }
    },
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    off: (event, handler) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler),
      )
    },
  }

  return {
    client,
    calls,
    connected: () => connected,
    listenerCount: (event: string) => (handlers.get(event) ?? []).length,
  }
}

const emitted: { nodeId: string; state: NodeState }[] = []
const logs: { level: string; message: string }[] = []

function context(config: Record<string, unknown> = {}): DeviceContext {
  return {
    deviceId: 'obs-1',
    config: { host: '10.0.0.5', port: 4455, password: 'secret-pw', ...config },
    log: (level, message) => logs.push({ level, message }),
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

let device: DeviceInstance | undefined

async function connect(
  fake: ReturnType<typeof fakeObs>,
  config: Record<string, unknown> = {},
): Promise<DeviceInstance> {
  const plugin = obsPlugin({ now: () => NOW, createClient: () => fake.client })
  // Wrapped exactly as the host wraps it in CI, so anything that would not
  // survive moving plugins into child processes fails here.
  device = withSerializingTransport(await plugin.createDevice(context(config)))
  return device
}

beforeEach(() => {
  emitted.length = 0
  logs.length = 0
})

afterEach(async () => {
  await device?.dispose()
  device = undefined
})

describe('connecting', () => {
  it('reports what OBS says it is', async () => {
    const obs = await connect(fakeObs())
    const capabilities = await obs.probe()
    expect(capabilities.model).toBe('OBS Studio 31.0.2')
    expect(capabilities.firmware).toBe('websocket 5.5.0')
    expect(capabilities.features).toEqual(expect.arrayContaining(['streaming', 'recording']))
  })

  it('explains itself when OBS is not there', async () => {
    const plugin = obsPlugin({
      now: () => NOW,
      createClient: () => fakeObs({ unreachable: true }).client,
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/Could not reach OBS/)
  })

  it('refuses a device with no address rather than guessing', async () => {
    const plugin = obsPlugin({ now: () => NOW, createClient: () => fakeObs().client })
    await expect(plugin.createDevice(context({ host: '  ' }))).rejects.toThrow(/needs an address/)
  })

  it('offers a stream node and a record node', async () => {
    const obs = await connect(fakeObs())
    const nodes = await obs.listNodes()
    expect(nodes.map((node) => node.id)).toEqual(['stream', 'record'])
    expect(nodes[0]?.supports).toEqual(
      expect.arrayContaining(['applyStreamTarget', 'startStreaming', 'stopStreaming']),
    )
    // Deliberately absent: OBS writes to a folder on somebody's machine
    // and the protocol cannot enumerate or remove what is in it. Claiming
    // otherwise would have retention believe it can tidy up.
    expect(nodes[1]?.supports).not.toContain('listMedia')
    expect(nodes[1]?.supports).not.toContain('deleteMedia')
  })
})

describe('streaming', () => {
  it('points OBS at a URL and key as a custom server', async () => {
    // Never one of OBS's named services: this app is handed a URL and a
    // key, and guessing which built-in service was meant can only be wrong.
    const obs = await connect(fakeObs())
    await obs.invoke('stream', 'applyStreamTarget', {
      url: 'rtmps://a.rtmp.youtube.com/live2',
      key: 'live_abcd-1234',
    })

    const state = await obs.invoke('stream', 'readState')
    expect(state?.streaming?.targetUrl).toBe('rtmps://a.rtmp.youtube.com/live2')
    // The key never comes back, only a fingerprint of it.
    expect(state?.streaming?.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(state)).not.toContain('live_abcd-1234')
  })

  it('starts and stops, and says which it is doing', async () => {
    const obs = await connect(fakeObs())
    expect((await obs.invoke('stream', 'readState'))?.streaming?.active).toBe(false)

    await obs.invoke('stream', 'startStreaming')
    expect((await obs.invoke('stream', 'readState'))?.streaming?.active).toBe(true)

    await obs.invoke('stream', 'stopStreaming')
    expect((await obs.invoke('stream', 'readState'))?.streaming?.active).toBe(false)
  })

  it('reports congestion where a hardware encoder reports its cache', async () => {
    // The same question in a different unit: is the uplink keeping up, and
    // will anybody notice before the stream drops.
    const obs = await connect(fakeObs())
    const state = await obs.invoke('stream', 'readState')
    expect(state?.cache?.percent).toBe(25)
  })

  it('does not pretend a write took when OBS ignored it', async () => {
    // The failure verify-after-write exists for. The command is accepted
    // and the state never changes, so the host's poll fails rather than a
    // stream silently not happening.
    const obs = await connect(fakeObs({ ignoresWrites: true }))
    await obs.invoke('stream', 'startStreaming')
    expect((await obs.invoke('stream', 'readState'))?.streaming?.active).toBe(false)
  })
})

describe('recording', () => {
  it('reports the name OBS chose, not the one it was given', async () => {
    // OBS has no filename argument: the name comes from its own profile
    // formatting and it says afterwards what it used. The host stores that,
    // which is the only way the file stays matchable.
    const obs = await connect(fakeObs())
    await obs.invoke('record', 'startRecording', { filename: 'sunday-service' })

    const state = await obs.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBe('2026-03-08 09-00-01.mkv')
    expect(state?.recording?.filename).not.toBe('sunday-service')
  })

  it('takes the name off a Windows path, which is what OBS reports', async () => {
    const obs = await connect(fakeObs())
    await obs.invoke('record', 'startRecording', { filename: 'ignored' })
    const state = await obs.invoke('record', 'readState')
    expect(state?.recording?.filename).not.toContain('\\')
    expect(state?.recording?.filename).not.toContain('C:')
  })

  it('keeps the name from the stop reply, where the protocol also puts it', async () => {
    const obs = await connect(fakeObs())
    await obs.invoke('record', 'startRecording', { filename: 'ignored' })
    await obs.invoke('record', 'stopRecording')

    const state = await obs.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(false)
    expect(state?.recording?.filename).toBe('2026-03-08 09-00-01.mkv')
  })

  it('forgets the last name when a new recording starts', async () => {
    // Otherwise a second service would be filed under the first one's
    // name, and the first one's file would look like it had been recorded
    // twice.
    const obs = await connect(fakeObs())
    await obs.invoke('record', 'startRecording', { filename: 'first' })
    await obs.invoke('record', 'stopRecording')
    await obs.invoke('record', 'startRecording', { filename: 'second' })

    expect((await obs.invoke('record', 'readState'))?.recording?.filename).toBe(
      '2026-03-08 09-00-02.mkv',
    )
  })

  it('does not pretend a recording started when OBS ignored it', async () => {
    const obs = await connect(fakeObs({ ignoresWrites: true }))
    await obs.invoke('record', 'startRecording', { filename: 'sunday' })
    expect((await obs.invoke('record', 'readState'))?.recording?.active).toBe(false)
  })
})

describe('what OBS volunteers', () => {
  it('pushes state when a recording starts, without being asked', async () => {
    // The reason OBS is a good fit here. A recording that stops because the
    // disk filled says so at once rather than at the next poll.
    const obs = await connect(fakeObs())
    emitted.length = 0
    await obs.invoke('record', 'startRecording', { filename: 'sunday' })

    const pushed = emitted.filter((entry) => entry.nodeId === 'record')
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)?.state.recording?.active).toBe(true)
  })

  it('pushes state when a stream starts', async () => {
    const obs = await connect(fakeObs())
    emitted.length = 0
    await obs.invoke('stream', 'startStreaming')

    const pushed = emitted.filter((entry) => entry.nodeId === 'stream')
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)?.state.streaming?.active).toBe(true)
  })

  it('stops listening when the device is disposed', async () => {
    // A subscription left behind on a socket nobody owns is a leak that
    // surfaces as state arriving for a device the host has let go.
    const fake = fakeObs()
    const obs = await connect(fake)
    expect(fake.listenerCount('RecordStateChanged')).toBe(1)

    await obs.dispose()
    device = undefined
    expect(fake.listenerCount('RecordStateChanged')).toBe(0)
    expect(fake.connected()).toBe(false)
  })
})

describe('an OBS that stops answering', () => {
  it('gives up rather than hanging the scheduler', async () => {
    // The failure this app has already had once, from a deck that accepted
    // a socket and went quiet. One program must not be able to stop the
    // whole loop.
    const fake = fakeObs()
    const obs = await connect(fake)

    const hanging = fakeObs({ hangs: true })
    const plugin = obsPlugin({ now: () => NOW, createClient: () => hanging.client })
    // Connect succeeds; the first request after it never answers.
    await expect(plugin.createDevice(context())).rejects.toThrow(/did not answer/)
    await obs.dispose()
    device = undefined
  }, 20_000)
})
