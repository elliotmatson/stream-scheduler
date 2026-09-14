import { describe, expect, it } from 'vitest'
import { Enums } from 'atem-connection'
import type { AtemState } from 'atem-connection'
import { fingerprint, withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { atemPlugin, formatQuality, parseQuality } from './index.js'
import { AtemConnectionStatus, type AtemClient } from './client.js'

/**
 * The ATEM protocol has no emulator to point at — unlike the HyperDeck — and
 * it is reverse-engineered rather than published, so these exercise the
 * adapter against a fake client holding a real `AtemState` shape. That covers
 * where the complexity actually is: capability derivation, state mapping and
 * the operations the run engine calls.
 */

type Handler = (...args: never[]) => void

class FakeAtem implements AtemClient {
  status: AtemConnectionStatus = AtemConnectionStatus.CLOSED
  state: AtemState | undefined
  readonly calls: string[] = []
  connectRejectsWith: string | undefined
  actionRejectsWith: string | undefined

  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(initial: Partial<AtemState> = {}) {
    this.state = buildState(initial)
  }

  async connect(): Promise<void> {
    if (this.connectRejectsWith) {
      this.emit('error', this.connectRejectsWith)
      return
    }
    this.status = AtemConnectionStatus.CONNECTED
    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    this.status = AtemConnectionStatus.CLOSED
  }

  async destroy(): Promise<void> {
    this.status = AtemConnectionStatus.CLOSED
  }

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
  }

  async setStreamingService(props: {
    serviceName?: string
    url?: string
    key?: string
    bitrates?: [number, number]
  }): Promise<void> {
    this.record('setStreamingService')
    const streaming = this.state?.streaming
    if (!streaming) return
    streaming.service = { ...streaming.service, ...props }
  }

  async startStreaming(): Promise<void> {
    this.record('startStreaming')
    this.setStreamingStatus(Enums.StreamingStatus.Streaming)
  }

  async stopStreaming(): Promise<void> {
    this.record('stopStreaming')
    this.setStreamingStatus(Enums.StreamingStatus.Idle)
  }

  async setRecordingSettings(props: { filename?: string }): Promise<void> {
    this.record('setRecordingSettings')
    if (this.state?.recording && props.filename !== undefined) {
      this.state.recording.properties.filename = props.filename
    }
  }

  async startRecording(): Promise<void> {
    this.record('startRecording')
    this.setRecordingStatus(Enums.RecordingStatus.Recording)
  }

  async stopRecording(): Promise<void> {
    this.record('stopRecording')
    this.setRecordingStatus(Enums.RecordingStatus.Idle)
  }

  async setAuxSource(source: number, bus = 0): Promise<void> {
    this.record('setAuxSource')
    if (this.state) this.state.video.auxilliaries[bus] = source
  }

  private record(name: string): void {
    this.calls.push(name)
    if (this.actionRejectsWith) throw new Error(this.actionRejectsWith)
  }

  private setStreamingStatus(state: Enums.StreamingStatus): void {
    if (this.state?.streaming?.status) {
      this.state.streaming.status = { state, error: Enums.StreamingError.None }
    }
  }

  private setRecordingStatus(state: Enums.RecordingStatus): void {
    if (this.state?.recording?.status) {
      this.state.recording.status = { ...this.state.recording.status, state, error: Enums.RecordingError.None }
    }
  }
}

function buildState(overrides: Partial<AtemState>): AtemState {
  const base = {
    info: {
      apiVersion: Enums.ProtocolVersion.V8_1_1,
      model: Enums.Model.MiniPro,
      productIdentifier: 'ATEM Mini Pro',
      capabilities: { auxilliaries: 1 },
      superSources: [],
      mixEffects: [],
      power: [true],
    },
    video: { auxilliaries: [] as (number | undefined)[] },
    media: {},
    inputs: {},
    macro: {},
    settings: {},
  } as unknown as AtemState

  return { ...base, ...overrides } as AtemState
}

function streamingBlock() {
  return {
    status: { state: Enums.StreamingStatus.Idle, error: Enums.StreamingError.None },
    stats: { cacheUsed: 0, encodingBitrate: 6_000_000 },
    service: { serviceName: '', url: '', key: '', bitrates: [6_000_000, 3_000_000] as [number, number] },
  }
}

function recordingBlock() {
  return {
    status: {
      state: Enums.RecordingStatus.Idle,
      error: Enums.RecordingError.None,
      recordingTimeAvailable: 7200,
    },
    properties: { filename: '', workingSet1DiskId: 0, workingSet2DiskId: 0, recordInAllCameras: false },
    disks: {},
  }
}

const emitted: { nodeId: string; state: NodeState }[] = []

function context(config: Record<string, unknown> = {}): DeviceContext {
  return {
    deviceId: 'atem-1',
    config: { host: '10.0.0.5', ...config },
    log: () => {},
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

async function connect(
  client: FakeAtem,
  config: Record<string, unknown> = {},
): Promise<DeviceInstance> {
  const plugin = atemPlugin({ now: () => 1_700_000_000_000, createClient: () => client })
  // Wrapped exactly as the host wraps plugins in CI.
  return withSerializingTransport(await plugin.createDevice(context(config)))
}

describe('capability probing', () => {
  it('derives capabilities from what the switcher reports, not a model table', async () => {
    const client = new FakeAtem({ streaming: streamingBlock(), recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    const capabilities = await atem.probe()
    expect(capabilities.model).toBe('ATEM Mini Pro')
    expect(capabilities.features).toEqual(expect.arrayContaining(['streaming', 'recording', 'aux:1']))
  })

  it('offers no streaming node on a switcher that does not stream', async () => {
    // A plain ATEM Mini reports no streaming block at all.
    const client = new FakeAtem({})
    const atem = await connect(client)

    const nodes = await atem.listNodes()
    expect(nodes.map((n) => n.id)).toEqual(['aux'])
    expect((await atem.probe()).features).not.toContain('streaming')
  })

  it('offers a recorder only when the switcher reports one', async () => {
    const client = new FakeAtem({ recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    expect((await atem.listNodes()).map((n) => n.id)).toEqual(['record', 'aux'])
  })

  it('declares the stream output as single-link, so fan-out needs a relay', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    const stream = (await atem.listNodes()).find((n) => n.id === 'stream')
    expect(stream?.ports[0]).toMatchObject({ maxLinks: 1, requiresCredential: 'stream-key' })
  })
})

describe('encoder quality', () => {
  // One H.264 encoder feeds the stream and the recording, so the bitrate is
  // one setting with two users. The named qualities an operator knows from
  // ATEM Software Control are a file on that computer, not something the
  // switcher can be asked for, so this speaks in Mb/s.
  it('reports what the switcher is on, in the vocabulary it takes back', async () => {
    const client = new FakeAtem({ streaming: streamingBlock(), recording: recordingBlock() } as Partial<AtemState>)
    client.state!.streaming!.service.bitrates = [7_000_000, 9_000_000]
    const atem = await connect(client)

    const stream = await atem.invoke('stream', 'readState')
    expect(stream?.options?.quality).toMatchObject({ current: '7-9', choices: [] })
    expect(stream?.options?.quality?.bitrate).toMatchObject({ minMbps: 3, maxMbps: 70 })

    // Reported on the recorder too, because it is the recorder's quality
    // as much as the streamer's.
    const record = await atem.invoke('record', 'readState')
    expect(record?.options?.quality?.current).toBe('7-9')
  })

  it('sets the bitrate with the stream target, and leaves it alone when none is asked for', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    await atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_k', quality: '9' })
    expect(client.state?.streaming?.service.bitrates).toEqual([9_000_000, 9_000_000])
    expect((await atem.invoke('stream', 'readState'))?.options?.quality?.current).toBe('9')

    await atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_k' })
    expect(client.state?.streaming?.service.bitrates).toEqual([9_000_000, 9_000_000])
  })

  it('sets the bitrate for a recording, which has no stream target to carry it', async () => {
    const client = new FakeAtem({ streaming: streamingBlock(), recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    await atem.invoke('record', 'startRecording', { filename: 'service', quality: '20-25' })
    expect(client.state?.streaming?.service.bitrates).toEqual([20_000_000, 25_000_000])
    expect(client.calls).toContain('startRecording')
    expect((await atem.invoke('record', 'readState'))?.options?.quality?.current).toBe('20-25')
  })

  it('refuses a bitrate the switcher will not take, before touching it', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    await expect(
      atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_k', quality: '200' }),
    ).rejects.toMatchObject({ code: 'quality-out-of-range' })
    await expect(
      atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_k', quality: 'High' }),
    ).rejects.toMatchObject({ code: 'bad-quality' })
    expect(client.calls).not.toContain('setStreamingService')
  })

  it('reads back exactly what was asked for, so a write can be verified', () => {
    // The round trip is the contract: `current` has to be comparable to the
    // string a caller passed, or verify-after-write cannot check a setting
    // whose spelling belongs to the device.
    for (const quality of ['9', '7-9', '3', '70']) {
      expect(formatQuality(parseQuality(quality))).toBe(quality)
    }
    expect(parseQuality(' 9 Mb/s ')).toEqual([9_000_000, 9_000_000])
    expect(parseQuality('7 – 9')).toEqual([7_000_000, 9_000_000])
  })
})

describe('streaming', () => {
  it('pushes the target and reports back a fingerprint, never the key', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    const key = 'live_abcd-1234-efgh'
    await atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://a.rtmp.youtube.com/live2', key })

    const state = await atem.invoke('stream', 'readState')
    expect(state?.streaming?.targetUrl).toBe('rtmps://a.rtmp.youtube.com/live2')
    expect(state?.streaming?.keyFingerprint).toBe(fingerprint(key))
    expect(JSON.stringify(state)).not.toContain(key)
  })

  it('uses the configured service name so the front panel matches', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client, { serviceName: 'Church Stream' })
    await atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_key-value' })
    expect(client.state?.streaming?.service.serviceName).toBe('Church Stream')
  })

  it('starts and stops, and the read-back confirms it', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    await atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x/live2', key: 'live_key-value' })
    await atem.invoke('stream', 'startStreaming')
    expect((await atem.invoke('stream', 'readState'))?.streaming?.active).toBe(true)

    await atem.invoke('stream', 'stopStreaming')
    expect((await atem.invoke('stream', 'readState'))?.streaming?.active).toBe(false)
  })

  it('refuses to start before a target has been pushed', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    await expect(atem.invoke('stream', 'startStreaming')).rejects.toMatchObject({ code: 'no-stream-target' })
    expect(client.calls).not.toContain('startStreaming')
  })

  it('reports the encoding bitrate for the live dashboard', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    expect((await atem.invoke('stream', 'readState'))?.streaming?.bitrateBps).toBe(6_000_000)
  })
})

describe('recording', () => {
  it('sets the filename before starting, which the ATEM requires', async () => {
    const client = new FakeAtem({ recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)

    await atem.invoke('record', 'startRecording', { filename: '2026-03-08 Sunday Service' })
    expect(client.calls).toEqual(['setRecordingSettings', 'startRecording'])
    expect(client.state?.recording?.properties.filename).toBe('2026-03-08 Sunday Service')

    const state = await atem.invoke('record', 'readState')
    expect(state?.recording).toMatchObject({ active: true, filename: '2026-03-08 Sunday Service' })
  })

  it('reports remaining media time', async () => {
    const client = new FakeAtem({ recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    expect((await atem.invoke('record', 'readState'))?.recording?.remainingMs).toBe(7_200_000)
  })

  it('stops recording', async () => {
    const client = new FakeAtem({ recording: recordingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    await atem.invoke('record', 'startRecording', { filename: 'service' })
    await atem.invoke('record', 'stopRecording')
    expect((await atem.invoke('record', 'readState'))?.recording?.active).toBe(false)
  })
})

describe('aux routing', () => {
  it('routes a source to an aux bus and reports the mapping', async () => {
    const client = new FakeAtem({})
    const atem = await connect(client)

    await atem.invoke('aux', 'route', { input: '3', output: '0' })
    expect(client.state?.video.auxilliaries[0]).toBe(3)
    expect((await atem.invoke('aux', 'readState'))?.routing).toEqual({ '0': '3' })
  })

  it('rejects non-numeric routing arguments rather than sending nonsense', async () => {
    const client = new FakeAtem({})
    const atem = await connect(client)
    await expect(atem.invoke('aux', 'route', { input: 'camera one', output: '0' })).rejects.toMatchObject({
      code: 'bad-argument',
    })
  })
})

describe('failure handling', () => {
  it('reports an unreachable switcher with UDP-aware advice', async () => {
    const client = new FakeAtem({})
    client.connectRejectsWith = 'no route to host'
    const plugin = atemPlugin({ createClient: () => client })
    await expect(plugin.createDevice(context())).rejects.toMatchObject({
      code: 'connect-failed',
      retryable: true,
    })
  })

  it('keeps a failed command retryable', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    client.actionRejectsWith = 'switcher busy'
    await expect(atem.invoke('stream', 'applyStreamTarget', { url: 'rtmps://x', key: 'k' })).rejects.toMatchObject({
      code: 'atem-error',
      retryable: true,
    })
  })

  it('refuses commands while disconnected instead of pretending they landed', async () => {
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    const atem = await connect(client)
    client.status = AtemConnectionStatus.CLOSED

    await expect(atem.invoke('stream', 'stopStreaming')).rejects.toMatchObject({ code: 'not-connected' })
    expect(client.calls).not.toContain('stopStreaming')
  })

  it('reports health from the connection, including the reconnecting state', async () => {
    const client = new FakeAtem({})
    const atem = await connect(client)
    expect((await atem.health()).state).toBe('connected')

    client.status = AtemConnectionStatus.CONNECTING
    expect((await atem.health()).state).toBe('degraded')

    await atem.dispose()
    expect((await atem.health()).state).toBe('disconnected')
  })
})

describe('telemetry', () => {
  it('pushes state when the switcher reports a change, without polling', async () => {
    emitted.length = 0
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    await connect(client)

    client.emit('stateChanged', client.state, ['streaming.status'])
    expect(emitted.at(-1)).toMatchObject({ nodeId: 'stream' })
  })

  it('ignores changes to parts of the state it does not model', async () => {
    emitted.length = 0
    const client = new FakeAtem({ streaming: streamingBlock() } as Partial<AtemState>)
    await connect(client)

    client.emit('stateChanged', client.state, ['audio.channels.1.gain'])
    expect(emitted).toHaveLength(0)
  })
})
