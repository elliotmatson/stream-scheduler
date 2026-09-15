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
    /** What the deck sees on the wire, as opposed to the clip it is on. */
    inputVideoFormat?: string
    videoInput: string
    fileFormat: string
    /** Codecs this fake deck will accept, as a real one has a subset. */
    formats: string[]
    configurationReads: number
    formatted: number[]
    formatPending?: { slot: number; token: string }
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
    inputVideoFormat: '1080p50',
    videoInput: 'SDI',
    fileFormat: 'QuickTimeProResHQ',
    formats: ['QuickTimeProResHQ', 'QuickTimeProResLT'],
    configurationReads: 0,
    formatted: [] as number[],
    // What `disk list` would answer with. A real deck names its clips and
    // says how long they are, and has no answer for when they were made.
    //
    // Dot-free codec names on purpose: hyperdeck-connection parses the
    // codec with `\w+`, so a name like "H.264High" makes it drop the clip
    // silently. Whether real decks report a dotted name for H.264 is a
    // question for the hardware (#3) — this fake must not paper over it by
    // pretending the parser is more forgiving than it is.
    clips: [
      { name: '2026-09-06 Sunday Service.mov', codec: 'ProRes422HQ', duration: '00:52:14:00' },
      { name: '2026-08-30 Sunday Service.mov', codec: 'ProRes422HQ', duration: '00:48:02:00' },
    ],
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
    ...(state.inputVideoFormat === undefined
      ? {}
      : { 'input video format': state.inputVideoFormat }),
  })
  server.onFormat = async (command) => {
    // The deck's format is a two-step handshake: `prepare` hands back a
    // token and erases nothing, and only quoting that token back on
    // `confirm` wipes the card.
    const params = command.parameters as Record<string, string | undefined>
    if (params.prepare !== undefined) {
      state.formatPending = {
        slot: Number(params['slot id'] ?? state.selectedSlot),
        token: 'f0rm4t',
      }
      // A real deck answers `216 format ready` with the token on a bare,
      // unlabelled line, which `hyperdeck-connection` surfaces as a `code`
      // parameter. This emulator can only write `name: value` lines, so the
      // token goes out under the name the client reads rather than the
      // `token` one the emulator's own types suggest.
      return { code: state.formatPending.token } as unknown as { token: string }
    }
    if (state.formatPending && params.confirm === state.formatPending.token) {
      state.formatted.push(state.formatPending.slot)
      state.formatPending = undefined
    }
    // Confirming earns a plain `200 ok`, which the emulator sends when the
    // handler resolves with nothing.
    return undefined as unknown as { token: string }
  }
  server.onConfiguration = async (command) => {
    const params = command.parameters as Record<string, string | undefined>
    // A write, not a read. The emulator answers `200 ok` when the handler
    // resolves with nothing, which is what the deck does.
    if (Object.keys(params).length > 0) {
      const wanted = params['file format']
      if (wanted !== undefined) {
        // A deck refuses a codec its model does not have.
        if (!state.formats.includes(wanted)) throw { code: 103, name: 'unsupported parameter' }
        state.fileFormat = wanted
      }
      if (params['video input'] !== undefined) state.videoInput = params['video input']
      return undefined as unknown as { 'video input': string }
    }
    state.configurationReads += 1
    return {
      'video input': state.videoInput,
      'audio input': 'embedded',
      'file format': state.fileFormat,
    }
  }
  server.onSlotInfo = async (command) => ({
    'slot id': String(command.parameters['slot id'] ?? state.selectedSlot),
    status: state.slotStatus,
    'volume name': 'Sunday',
    'recording time': String(state.recordingTimeSeconds),
    'video format': '1080p50',
  })
  server.onDiskList = async (command) => ({
    'slot id': String(command.parameters['slot id'] ?? state.selectedSlot),
    ...Object.fromEntries(
      state.clips.map((clip, index) => [
        String(index + 1),
        `${clip.name} ${clip.codec} 1080p50 ${clip.duration}`,
      ]),
    ),
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

/**
 * A card, and what an FTP client sees of it.
 *
 * The deck serves its media over FTP because its control protocol has no
 * delete verb, so a sweep is a second protocol this test has no server
 * for. The seam is injected instead, which is also how the
 * did-it-actually-go check gets exercised: a server that says "fine" and
 * keeps the file is the failure worth having a test for.
 */
function fakeFtp(files: string[], options: { ignoresDeletes?: boolean } = {}) {
  // Size and date are the two columns the control protocol cannot answer,
  // so the fake carries both: a listing that only had names would not
  // exercise the reason this path exists.
  const card = new Map(
    files
      .map((name, index) => ({
        name,
        size: 360_000_000 + index,
        modifiedAt: Date.parse('2026-09-06T11:00:00Z') + index * 86_400_000,
      }))
      .map((file) => [file.name, file]),
  )
  const removed: string[] = []
  let closed = 0

  return {
    card,
    removed,
    closed: () => closed,
    connect: async () => ({
      remove: async (path: string) => {
        removed.push(path)
        if (!options.ignoresDeletes) card.delete(path.split('/').pop() ?? path)
      },
      list: async () => [...card.values()],
      close: async () => {
        closed += 1
      },
    }),
  }
}

/** What `disk list` reports in the protocol fake, by name. */
const CLIPS_ON_CARD = ['2026-09-06 Sunday Service.mov', '2026-08-30 Sunday Service.mov']

async function connect(
  config: Record<string, unknown> = {},
  ftp: ReturnType<typeof fakeFtp> = fakeFtp(CLIPS_ON_CARD),
): Promise<DeviceInstance> {
  const plugin = hyperdeckPlugin({
    now: () => 1_700_000_000_000,
    connectFtp: ftp.connect,
  })
  const created = await plugin.createDevice({
    ...context(),
    config: { ...context().config, ...config },
  })
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

  it('offers the deck\u2019s own file share, since this app does not move media', async () => {
    const hyperdeck = await connect()
    const capabilities = await hyperdeck.probe()

    const ftp = capabilities.links?.find((link) => link.url.startsWith('ftp://'))
    expect(ftp?.url).toBe('ftp://127.0.0.1/')
    // The note carries the two things the address does not say.
    expect(ftp?.note).toMatch(/anonymous/i)
    expect(ftp?.note).toMatch(/browser/i)
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
    expect(nodes[0]?.supports).toEqual([
      'startRecording',
      'stopRecording',
      'selectSlot',
      'formatStorage',
      'listMedia',
      'deleteMedia',
    ])
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

  it('records onto the card the output named', async () => {
    const hyperdeck = await connect()
    await hyperdeck.invoke('record', 'startRecording', { filename: 'service', slot: 2 })
    expect(deck.state.selectedSlot).toBe(2)
  })

  it('leaves the deck on its own card when nothing names one', async () => {
    // There is no device-wide slot setting any more: an output that does not
    // care must not move a deck somebody set up by hand.
    deck.state.selectedSlot = 2
    const hyperdeck = await connect()
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
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'service' }),
    ).rejects.toMatchObject({
      code: 'disk-full',
      remediation: expect.stringContaining('Swap or format'),
    })
  })

  it('translates no media', async () => {
    deck.state.failRecordWith = 105
    const hyperdeck = await connect()
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'service' }),
    ).rejects.toMatchObject({
      code: 'no-disk',
    })
  })

  it('formats a card only after the confirmation handshake the deck requires', async () => {
    const hyperdeck = await connect()

    // The safety-critical half: preparing asks, and erases nothing.
    // The token comes back on the state's `raw`, where a one-shot capability
    // belongs: it is not a property of the deck.
    const prepared = await hyperdeck.invoke('record', 'formatStorage', { slot: 2 })
    const confirm = prepared?.raw?.confirm
    expect(confirm).toBe('f0rm4t')
    expect(deck.state.formatted).toEqual([])

    // Quoting the deck's own token back is what erases, and it erases the
    // slot that was prepared rather than whichever one happens to be selected.
    await hyperdeck.invoke('record', 'formatStorage', { slot: 2, confirm: String(confirm) })
    expect(deck.state.formatted).toEqual([2])
  })

  it('erases nothing when the token is not the one the deck handed out', async () => {
    const hyperdeck = await connect()

    await hyperdeck.invoke('record', 'formatStorage', { slot: 1 })
    await hyperdeck.invoke('record', 'formatStorage', { slot: 1, confirm: 'guessed' })
    expect(deck.state.formatted).toEqual([])
  })

  it('records in the codec an output asked for, and reports it back', async () => {
    const hyperdeck = await connect()

    const before = await hyperdeck.invoke('record', 'readState')
    expect(before?.options?.quality?.current).toBe('QuickTimeProResHQ')
    // Suggestions, not a contract: the deck will not say what it supports.
    expect(before?.options?.quality?.choices).toEqual([])
    expect(before?.options?.quality?.freeform?.examples).toContain('QuickTimeProResLT')

    await hyperdeck.invoke('record', 'startRecording', {
      filename: 'service',
      quality: 'QuickTimeProResLT',
    })
    expect(deck.state.fileFormat).toBe('QuickTimeProResLT')
    expect(deck.state.recording).toBe(true)

    // Read fresh rather than from the cache the connection holds, or the
    // planner would verify a setting against a stale answer.
    expect((await hyperdeck.invoke('record', 'readState'))?.options?.quality?.current).toBe(
      'QuickTimeProResLT',
    )
  })

  it('will not start recording in a codec the deck refused', async () => {
    const hyperdeck = await connect()

    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'service', quality: 'H.265High' }),
    ).rejects.toMatchObject({ code: 'unknown-quality' })

    // The refusal came before the record command: better no recording than
    // one in the wrong codec.
    expect(deck.state.recording).toBe(false)
    expect(deck.state.fileFormat).toBe('QuickTimeProResHQ')
  })

  it('refuses to format a node that cannot', async () => {
    const hyperdeck = await connect()
    await expect(hyperdeck.invoke('nope', 'formatStorage', { slot: 1 })).rejects.toMatchObject({
      code: 'unknown-node',
    })
  })

  it('reads the deck configuration once, not on every state read', async () => {
    // Reading state is on the notification path, and the deck pushes
    // notifications while recording. Every avoidable round trip there is
    // one the deck does during a service.
    const hyperdeck = await connect()
    await hyperdeck.invoke('record', 'readState')
    await hyperdeck.invoke('record', 'readState')
    await hyperdeck.invoke('record', 'readState')
    expect(deck.state.configurationReads).toBe(1)
  })

  it('explains a "no input" refusal with what the deck says it is looking at', async () => {
    deck.state.failRecordWith = 110
    const hyperdeck = await connect()
    // A deck that refuses for "no input" while reporting a format on that
    // input is the interesting case, and the one a bare code translation
    // sends somebody chasing cables for nothing.
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'take 1' }),
    ).rejects.toMatchObject({
      code: 'no-input',
      message: expect.stringContaining('1080p50'),
    })
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'take 1' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SDI'),
    })
  })

  it('says the deck sees nothing when it really sees nothing', async () => {
    deck.state.failRecordWith = 110
    deck.state.inputVideoFormat = undefined
    const hyperdeck = await connect()
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'take 1' }),
    ).rejects.toMatchObject({
      code: 'no-input',
      message: expect.stringContaining('no signal'),
    })
  })

  it('does not pass the deck\u2019s clip index off as a recording name', async () => {
    // `clip id` is an index into the deck's timeline. Showing "40" where an
    // operator expects "Sunday Service" reads as a bug in the scheduler.
    const hyperdeck = await connect()
    await hyperdeck.invoke('record', 'startRecording', { filename: 'service' })

    const state = await hyperdeck.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBeUndefined()
    expect(state?.raw?.clipId).toBe(1)
  })

  it('translates remote control being switched off on the front panel', async () => {
    deck.state.failRecordWith = 111
    const hyperdeck = await connect()
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'service' }),
    ).rejects.toMatchObject({
      code: 'remote-disabled',
      remediation: expect.stringContaining('REM'),
    })
  })

  it('keeps an unknown error retryable rather than failing the run outright', async () => {
    deck.state.failRecordWith = 108
    const hyperdeck = await connect()
    await expect(
      hyperdeck.invoke('record', 'startRecording', { filename: 'service' }),
    ).rejects.toMatchObject({
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

describe('what is on the card', () => {
  it('lists the clips the deck reports, with what it knows about each', async () => {
    const hyperdeck = await connect()
    const listed = await hyperdeck.invoke('record', 'listMedia', {})

    const media = (listed?.raw?.media ?? []) as { name: string; codec?: string; slot?: number }[]
    expect(media.map((item) => item.name)).toEqual([
      '2026-09-06 Sunday Service.mov',
      '2026-08-30 Sunday Service.mov',
    ])
    expect(media[0]?.codec).toBe('ProRes422HQ')
    expect(media[0]?.slot).toBe(1)
  })

  it('asks about one slot when told which', async () => {
    const hyperdeck = await connect()
    const asked: string[] = []
    deck.server.onDiskList = async (command) => {
      asked.push(String(command.parameters['slot id']))
      return { 'slot id': String(command.parameters['slot id']) }
    }
    await hyperdeck.invoke('record', 'listMedia', { slot: 2 })
    expect(asked).toEqual(['2'])
  })
})

describe('taking something off the card', () => {
  it('removes the named file over FTP, and hangs up after', async () => {
    const ftp = fakeFtp(['old.mov', 'keep.mov'])
    const hyperdeck = await connect({}, ftp)

    await hyperdeck.invoke('record', 'deleteMedia', { name: 'old.mov', slot: 1 })

    // Slot 1 is the card root, the way the deck's own file page lays it out.
    expect(ftp.removed).toEqual(['/old.mov'])
    expect([...ftp.card.keys()]).toEqual(['keep.mov'])
    // A sweep is several of these; a session left open each time is a deck
    // that stops answering by the fourth file.
    expect(ftp.closed()).toBe(1)
  })

  it('puts a second slot in its own directory', async () => {
    const ftp = fakeFtp(['old.mov'])
    const hyperdeck = await connect({}, ftp)

    await hyperdeck.invoke('record', 'deleteMedia', { name: 'old.mov', slot: 2 })
    expect(ftp.removed).toEqual(['/2/old.mov'])
  })

  it('fails loudly when the deck keeps the file anyway', async () => {
    // FTP servers vary in what they say about a delete that did not
    // happen. Reporting success on a file still sitting on the card is
    // worse than failing, because the ledger would then mark it gone.
    const ftp = fakeFtp(['stuck.mov'], { ignoresDeletes: true })
    const hyperdeck = await connect({}, ftp)

    await expect(
      hyperdeck.invoke('record', 'deleteMedia', { name: 'stuck.mov', slot: 1 }),
    ).rejects.toThrow(/still has "stuck.mov"/)
    // And it still hung up, rather than leaking the session on the way out.
    expect(ftp.closed()).toBe(1)
  })

  it('refuses a call with no name rather than guessing', async () => {
    const ftp = fakeFtp(['a.mov'])
    const hyperdeck = await connect({}, ftp)

    await expect(hyperdeck.invoke('record', 'deleteMedia', {})).rejects.toThrow(/"name"/)
    expect(ftp.removed).toEqual([])
  })

  it('says it can do it, so the host knows a sweep is possible here', async () => {
    const hyperdeck = await connect()
    const nodes = await hyperdeck.listNodes()
    expect(nodes[0]?.supports).toContain('deleteMedia')
  })
})
