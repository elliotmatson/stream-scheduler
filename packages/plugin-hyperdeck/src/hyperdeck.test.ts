import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HyperdeckServer } from 'hyperdeck-server-connection'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { withSerializingTransport } from '@scheduler/plugin-sdk'
import { hyperdeckPlugin } from './index.js'

/**
 * These run against `hyperdeck-server-connection`, which emulates a HyperDeck
 * at the protocol level over a real TCP socket. So the adapter is exercised
 * through the actual wire format — command serialisation, response codes,
 * async notifications — with no hardware.
 */

/**
 * A fresh port per test. `HyperdeckServer.close()` only calls `unref()` on
 * the listener — it neither stops listening nor drops open sockets — so
 * reusing one port silently leaves the previous test's deck answering.
 */
let nextPort = 9940
let PORT = nextPort

interface FakeDeck {
  server: HyperdeckServer
  state: {
    recording: boolean
    filename: string | undefined
    selectedSlot: number
    recordingTimeSeconds: number
    slotStatus: string
    failRecordWith?: number
  }
}

let deck: FakeDeck
let device: DeviceInstance | undefined
const logs: { level: string; message: string }[] = []
const emitted: { nodeId: string; state: NodeState }[] = []

function makeDeck(): FakeDeck {
  const state: FakeDeck['state'] = {
    recording: false,
    filename: undefined,
    selectedSlot: 1,
    recordingTimeSeconds: 7200,
    slotStatus: 'mounted',
  }
  const server = new HyperdeckServer('127.0.0.1', PORT)

  server.onDeviceInfo = async () => ({
    'protocol version': '1.11',
    model: 'HyperDeck Studio HD Mini',
    'unique id': 'test-deck',
    'slot count': '2',
  })
  server.onRecord = async (command) => {
    if (state.failRecordWith !== undefined) {
      // The emulator turns a thrown code into the matching protocol error.
      throw { code: state.failRecordWith, name: 'record failed' }
    }
    state.recording = true
    state.filename = command.parameters.name
  }
  server.onStop = async () => {
    state.recording = false
  }
  server.onSlotSelect = async (command) => {
    state.selectedSlot = Number(command.parameters['slot id'] ?? state.selectedSlot)
  }
  server.onTransportInfo = async () => ({
    status: state.recording ? 'record' : 'stopped',
    speed: '0',
    'slot id': String(state.selectedSlot),
    'clip id': state.recording ? '1' : 'none',
    'single clip': 'true',
    'display timecode': '00:00:10:00',
    timecode: '00:00:10:00',
    'video format': '1080p50',
    loop: 'false',
  })
  server.onSlotInfo = async (command) => ({
    'slot id': String(command.parameters['slot id'] ?? state.selectedSlot),
    status: state.slotStatus,
    'volume name': 'Sunday',
    'recording time': String(state.recordingTimeSeconds),
    'video format': '1080p50',
  })

  return { server, state }
}

function context(): DeviceContext {
  return {
    deviceId: 'deck-1',
    config: { host: '127.0.0.1', port: PORT },
    log: (level, message) => logs.push({ level, message }),
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

async function connect(config: Record<string, unknown> = {}): Promise<DeviceInstance> {
  const plugin = hyperdeckPlugin({ now: () => 1_700_000_000_000 })
  const created = await plugin.createDevice({ ...context(), config: { ...context().config, ...config } })
  // Wrapped exactly as the host wraps it in CI, so anything that would not
  // survive moving plugins into child processes fails here.
  device = withSerializingTransport(created)
  return device
}

beforeEach(() => {
  logs.length = 0
  emitted.length = 0
  PORT = ++nextPort
  deck = makeDeck()
})

afterEach(async () => {
  await device?.dispose()
  device = undefined
  deck.server.close()
})

describe('connecting', () => {
  it('probes the model off the wire rather than trusting configuration', async () => {
    const hyperdeck = await connect()
    const capabilities = await hyperdeck.probe()
    expect(capabilities.model).toBe('HyperDeck Studio HD Mini')
    expect(capabilities.features).toContain('recording')
    expect(capabilities.features).toContain('slots:2')
  })

  it('reports a named, actionable error when nothing is listening', async () => {
    await expect(connect({ port: 9 })).rejects.toMatchObject({
      name: 'DeviceError',
      retryable: true,
    })
  })

  it('exposes exactly one recorder node', async () => {
    const hyperdeck = await connect()
    await hyperdeck.probe()
    const nodes = await hyperdeck.listNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ id: 'record', roles: ['sink'] })
    expect(nodes[0]?.supports).toEqual(['startRecording', 'stopRecording'])
  })
})

describe('recording', () => {
  it('records with the filename it was given, and the deck confirms it', async () => {
    const hyperdeck = await connect()
    await hyperdeck.invoke('record', 'startRecording', { filename: '2026-03-08 Sunday Service' })

    expect(deck.state.recording).toBe(true)
    expect(deck.state.filename).toBe('2026-03-08 Sunday Service')

    const state = await hyperdeck.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(true)
  })

  it('stops recording', async () => {
    const hyperdeck = await connect()
    await hyperdeck.invoke('record', 'startRecording', { filename: 'service' })
    await hyperdeck.invoke('record', 'stopRecording')

    expect(deck.state.recording).toBe(false)
    expect((await hyperdeck.invoke('record', 'readState'))?.recording?.active).toBe(false)
  })

  it('selects the configured slot before recording', async () => {
    const hyperdeck = await connect({ slot: 2 })
    await hyperdeck.invoke('record', 'startRecording', { filename: 'service' })
    expect(deck.state.selectedSlot).toBe(2)
  })

  it('reports remaining media time, which is what an operator checks', async () => {
    deck.state.recordingTimeSeconds = 5400
    const hyperdeck = await connect()
    const state = await hyperdeck.invoke('record', 'readState')
    expect(state?.recording?.remainingMs).toBe(5_400_000)
  })
})

describe('protocol errors', () => {
  it('translates a full disk into something worth reading on a Sunday morning', async () => {
    deck.state.failRecordWith = 104
    const hyperdeck = await connect()
    await expect(hyperdeck.invoke('record', 'startRecording', { filename: 'service' })).rejects.toMatchObject({
      code: 'disk-full',
      remediation: expect.stringContaining('Swap or format'),
    })
  })

  it('translates no media', async () => {
    deck.state.failRecordWith = 105
    const hyperdeck = await connect()
    await expect(hyperdeck.invoke('record', 'startRecording', { filename: 'service' })).rejects.toMatchObject({
      code: 'no-disk',
    })
  })

  it('translates remote control being switched off on the front panel', async () => {
    deck.state.failRecordWith = 111
    const hyperdeck = await connect()
    await expect(hyperdeck.invoke('record', 'startRecording', { filename: 'service' })).rejects.toMatchObject({
      code: 'remote-disabled',
      remediation: expect.stringContaining('REM'),
    })
  })

  it('keeps an unknown error retryable rather than failing the run outright', async () => {
    deck.state.failRecordWith = 108
    const hyperdeck = await connect()
    await expect(hyperdeck.invoke('record', 'startRecording', { filename: 'service' })).rejects.toMatchObject({
      code: 'hyperdeck-error',
      retryable: true,
    })
  })
})

describe('state reporting', () => {
  it('survives a slot that answers with an error instead of failing readState', async () => {
    const hyperdeck = await connect()
    deck.server.onSlotInfo = async () => {
      throw { code: 105, name: 'no disk' }
    }
    const state = await hyperdeck.invoke('record', 'readState')
    // The transport half is still true and useful; only the headroom is gone.
    expect(state?.recording?.active).toBe(false)
    expect(state?.recording?.remainingMs).toBeUndefined()
  })

  it('reports disconnected health once the connection is gone', async () => {
    // The emulator cannot drop a client (its close() only unrefs the
    // listener), so this closes from our side. It still exercises the thing
    // that matters: health reflects the socket, not a cached flag.
    const hyperdeck = await connect()
    expect((await hyperdeck.health()).state).toBe('connected')

    await hyperdeck.dispose()
    expect((await hyperdeck.health()).state).toBe('disconnected')
  })
})
