import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withSerializingTransport } from '@scheduler/plugin-sdk'
import type { DeviceContext, DeviceInstance, NodeState } from '@scheduler/plugin-sdk'
import { vmixPlugin } from './index.js'
import { parseStatus, VmixApiError, type VmixApi } from './api.js'

/**
 * vMix, driven through a fake that answers with the real thing.
 *
 * The status side renders actual `<vmix>` XML and hands it to the adapter's
 * own parser, rather than handing over a tidy object the adapter already
 * agrees with. That is the difference that matters: a fake that returns
 * `{ recording: true }` agrees with an adapter reading the wrong element,
 * and the flat FTP fake that did exactly that is why the file listing
 * shipped broken.
 *
 * So the XML here carries what real vMix XML carries, including an input
 * whose title contains the word this adapter is looking for.
 */

const NOW = Date.parse('2026-03-08T14:00:00Z')

interface FakeOptions {
  unreachable?: boolean
  /** A Web Controller with a password set, which this adapter cannot pass. */
  passworded?: boolean
  /** Older vMix: `<recording>` is bare text, with no attributes at all. */
  noRecordingAttributes?: boolean
  /** vMix set up to write a second file in a second format. */
  secondFormat?: boolean
}

function fakeVmix(options: FakeOptions = {}) {
  const calls: { fn: string; params: Record<string, string> }[] = []
  let passworded = options.passworded === true
  const channels = [false, false, false, false, false]
  let recording = false
  let recordingSeconds = 0

  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function xml(): string {
    const recordingTag = options.noRecordingAttributes
      ? `<recording>${recording ? 'True' : 'False'}</recording>`
      : `<recording filename1="${escape('C:\\Users\\booth\\Videos\\Sunday Service 0954.mp4')}"` +
        (options.secondFormat
          ? ` filename2="${escape('D:\\Archive\\Sunday Service 0954.mov')}"`
          : '') +
        ` duration="${recordingSeconds}">${recording ? 'True' : 'False'}</recording>`

    const streamingAttributes = channels
      .map((live, index) => ` channel${index + 1}="${live ? 'True' : 'False'}"`)
      .join('')

    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<vmix>',
      '<version>27.0.0.74</version>',
      '<edition>4K</edition>',
      '<preset>C:\\Users\\booth\\Documents\\vMixStorage\\sunday.vmix</preset>',
      '<inputs>',
      // A decoy. Real presets are full of inputs named after what they show,
      // and a reader scanning the document for text rather than parsing it
      // would find this one first.
      `<input key="a1" number="1" type="Colour" title="${escape('<recording>True</recording> lower third')}" state="Running">Lower third</input>`,
      '</inputs>',
      '<overlays><overlay number="1" /></overlays>',
      '<preview>2</preview>',
      '<active>1</active>',
      '<fadeToBlack>False</fadeToBlack>',
      recordingTag,
      '<external>False</external>',
      `<streaming${streamingAttributes}>${channels.some(Boolean) ? 'True' : 'False'}</streaming>`,
      '<playList>False</playList>',
      '<multiCorder>False</multiCorder>',
      '<fullscreen>False</fullscreen>',
      '</vmix>',
    ].join('\n')
  }

  const api: VmixApi = {
    async call(fn, params = {}) {
      if (options.unreachable) throw new Error('connect ECONNREFUSED')
      if (passworded) throw new VmixApiError(401, 'vMix answered 401')
      calls.push({ fn, params })

      // vMix's own numbering: Value is the 0-based destination, and an
      // absent Value means all five of them.
      const value = params.Value
      const channelFrom = (raw: string | undefined) =>
        raw === undefined ? undefined : Number(raw.split(',')[0])

      if (fn === 'StartStreaming' || fn === 'StopStreaming') {
        const live = fn === 'StartStreaming'
        const only = channelFrom(value)
        channels.forEach((_, index) => {
          if (only === undefined || only === index) channels[index] = live
        })
        return
      }
      if (fn === 'StartRecording') {
        recording = true
        recordingSeconds = 42 * 60 + 27
        return
      }
      if (fn === 'StopRecording') {
        recording = false
        recordingSeconds = 0
        return
      }
      if (fn === 'StreamingSetURL' || fn === 'StreamingSetKey') return
      throw new VmixApiError(500, `vMix does not know ${fn}`)
    },
    async status() {
      if (options.unreachable) throw new Error('connect ECONNREFUSED')
      if (passworded) throw new VmixApiError(401, 'vMix answered 401')
      return parseStatus(xml())
    },
  }

  return {
    api,
    calls,
    xml,
    of: (fn: string) => calls.filter((call) => call.fn === fn),
    live: () => channels.map((value) => value),
    /** Somebody sets a Web Controller password while this is connected. */
    setPassword: () => {
      passworded = true
    },
  }
}

const emitted: { nodeId: string; state: NodeState }[] = []

function context(config: Record<string, unknown> = {}): DeviceContext {
  return {
    deviceId: 'vmix-1',
    config: { host: '10.0.0.8', port: 8088, ...config },
    log: () => {},
    emitState: (nodeId, state) => emitted.push({ nodeId, state }),
    emitHealth: () => {},
  }
}

let device: DeviceInstance | undefined

async function connect(
  fake: ReturnType<typeof fakeVmix>,
  config: Record<string, unknown> = {},
): Promise<DeviceInstance> {
  const plugin = vmixPlugin({ now: () => NOW, createApi: () => fake.api })
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
  it('reports the version and edition it found', async () => {
    const vmix = await connect(fakeVmix())
    const capabilities = await vmix.probe()
    expect(capabilities.model).toBe('vMix 4K')
    expect(capabilities.firmware).toBe('27.0.0.74')
    expect(capabilities.features).toEqual(expect.arrayContaining(['streaming', 'recording']))
  })

  it('explains itself when vMix is not there', async () => {
    const plugin = vmixPlugin({
      now: () => NOW,
      createApi: () => fakeVmix({ unreachable: true }).api,
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/Could not reach vMix/)
  })

  it('names the Web Controller password rather than failing vaguely', async () => {
    // The one misconfiguration somebody will actually hit, and a bare 401
    // tells them nothing about which of vMix's several settings is at fault.
    const plugin = vmixPlugin({
      now: () => NOW,
      createApi: () => fakeVmix({ passworded: true }).api,
    })
    await expect(plugin.createDevice(context())).rejects.toThrow(/password/i)
  })

  it('says the same thing when the password appears mid-service', async () => {
    const fake = fakeVmix()
    const vmix = await connect(fake)
    fake.setPassword()
    await expect(vmix.invoke('record', 'startRecording', { filename: 'x' })).rejects.toThrow(
      /password/i,
    )
  })
})

describe('the nodes it offers', () => {
  it('offers one stream destination and a recorder by default', async () => {
    const vmix = await connect(fakeVmix())
    const nodes = await vmix.listNodes()
    expect(nodes.map((node) => node.id)).toEqual(['stream1', 'record'])
  })

  it('offers as many destinations as are actually in use', async () => {
    // vMix can do five. Showing five to somebody who uses one is clutter
    // they have to read past every time they build an event.
    const vmix = await connect(fakeVmix(), { streamChannels: 3 })
    const nodes = await vmix.listNodes()
    expect(nodes.map((node) => node.id)).toEqual(['stream1', 'stream2', 'stream3', 'record'])
  })

  it('never claims more than the five vMix has', async () => {
    const vmix = await connect(fakeVmix(), { streamChannels: 9 })
    const nodes = await vmix.listNodes()
    expect(nodes.filter((node) => node.id.startsWith('stream'))).toHaveLength(5)
  })

  it('does not claim it can tidy up recordings', async () => {
    // vMix has no file API at all: the recordings are on a Windows PC and
    // nothing here can list them, let alone delete one.
    const vmix = await connect(fakeVmix())
    const nodes = await vmix.listNodes()
    const recorder = nodes.find((node) => node.id === 'record')!
    expect(recorder.supports).toEqual(['startRecording', 'stopRecording'])
  })
})

describe('pointing a destination somewhere', () => {
  it('prefixes the channel, so the second destination is the one that moves', async () => {
    // Without the prefix vMix applies the value to the first destination.
    // On a machine streaming to two places that silently sends both to
    // the same one.
    const fake = fakeVmix()
    const vmix = await connect(fake, { streamChannels: 2 })
    await vmix.invoke('stream2', 'applyStreamTarget', {
      url: 'rtmp://a.rtmp.youtube.com/live2',
      key: 'live_abcd-1234',
    })

    expect(fake.of('StreamingSetURL')[0]!.params.Value).toBe('1,rtmp://a.rtmp.youtube.com/live2')
    expect(fake.of('StreamingSetKey')[0]!.params.Value).toBe('1,live_abcd-1234')
  })

  it('starts only the destination it was asked for', async () => {
    // A bare StartStreaming starts all five. On a machine with a second
    // destination configured that puts an unannounced stream on air.
    const fake = fakeVmix()
    const vmix = await connect(fake, { streamChannels: 2 })
    await vmix.invoke('stream1', 'startStreaming')

    expect(fake.of('StartStreaming')[0]!.params.Value).toBe('0')
    expect(fake.live()).toEqual([true, false, false, false, false])
  })

  it('counts from zero on the wire and from one in the UI', async () => {
    const fake = fakeVmix()
    const vmix = await connect(fake, { streamChannels: 3 })
    await vmix.invoke('stream3', 'startStreaming')
    expect(fake.of('StartStreaming')[0]!.params.Value).toBe('2')
    expect(fake.live()[2]).toBe(true)
  })

  it('stops one destination without touching the others', async () => {
    const fake = fakeVmix()
    const vmix = await connect(fake, { streamChannels: 2 })
    await vmix.invoke('stream1', 'startStreaming')
    await vmix.invoke('stream2', 'startStreaming')
    await vmix.invoke('stream2', 'stopStreaming')

    expect(fake.live()).toEqual([true, false, false, false, false])
  })

  it('reports each destination on its own node', async () => {
    const fake = fakeVmix()
    const vmix = await connect(fake, { streamChannels: 2 })
    await vmix.invoke('stream2', 'applyStreamTarget', { url: 'rtmp://example/live', key: 'k' })
    await vmix.invoke('stream2', 'startStreaming')

    const second = await vmix.invoke('stream2', 'readState')
    const first = await vmix.invoke('stream1', 'readState')
    expect(second?.streaming?.active).toBe(true)
    expect(second?.streaming?.targetUrl).toBe('rtmp://example/live')
    expect(first?.streaming?.active).toBe(false)
  })

  it('never lets the key back out, only a fingerprint of it', async () => {
    const vmix = await connect(fakeVmix())
    await vmix.invoke('stream1', 'applyStreamTarget', {
      url: 'rtmp://example/live',
      key: 'live_super-secret',
    })
    const state = await vmix.invoke('stream1', 'readState')
    expect(state?.streaming?.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(state)).not.toContain('live_super-secret')
  })

  it('keeps the key out of the error when the command fails', async () => {
    // An error message is the easiest place in the world to leak a key:
    // this one is built from the request that just failed, and the request
    // is the key.
    const fake = fakeVmix()
    const vmix = await connect(fake)
    fake.setPassword()

    const failure = await vmix
      .invoke('stream1', 'applyStreamTarget', {
        url: 'rtmp://example/live',
        key: 'live_super-secret',
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      )
    expect(failure).toBeDefined()
    expect(String(failure?.message)).not.toContain('live_super-secret')
  })
})

describe('the recorder', () => {
  it('reports the name vMix chose, not the one it was handed', async () => {
    // There is no function to set a recording filename: vMix builds it from
    // its own Recording Settings. Pretending otherwise would put a name in
    // the ledger that matches no file on disk.
    const fake = fakeVmix()
    const vmix = await connect(fake)
    await vmix.invoke('record', 'startRecording', { filename: 'sunday-service' })

    const state = await vmix.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBe('C:\\Users\\booth\\Videos\\Sunday Service 0954.mp4')
    // And nothing was sent pretending to set it.
    expect(fake.of('StartRecording')[0]!.params).toEqual({})
  })

  it('surfaces the second file rather than losing it', async () => {
    // vMix writes two files at once when a second format is set up. The
    // state contract holds one name, so the other is reported alongside:
    // somebody looking for their archive copy needs to know there are two.
    const vmix = await connect(fakeVmix({ secondFormat: true }))
    await vmix.invoke('record', 'startRecording', { filename: 'sunday' })

    const state = await vmix.invoke('record', 'readState')
    expect(state?.recording?.filename).toBe('C:\\Users\\booth\\Videos\\Sunday Service 0954.mp4')
    expect(state?.raw?.secondFile).toBe('D:\\Archive\\Sunday Service 0954.mov')
  })

  it('reads the duration as seconds, which is what vMix means by it', async () => {
    // Off by a thousand here is a 42-minute recording showing as 2 seconds.
    const vmix = await connect(fakeVmix())
    await vmix.invoke('record', 'startRecording', { filename: 'sunday' })
    const state = await vmix.invoke('record', 'readState')
    expect(state?.recording?.durationMs).toBe(2_547_000)
  })

  it('still works on a vMix whose recording element has no attributes', async () => {
    // Older versions report the bare word and nothing else. Losing the
    // filename is a real loss; crashing over it would be worse.
    const vmix = await connect(fakeVmix({ noRecordingAttributes: true }))
    await vmix.invoke('record', 'startRecording', { filename: 'sunday' })

    const state = await vmix.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(true)
    expect(state?.recording?.filename).toBeUndefined()
  })

  it('stops', async () => {
    const fake = fakeVmix()
    const vmix = await connect(fake)
    await vmix.invoke('record', 'startRecording', { filename: 'sunday' })
    await vmix.invoke('record', 'stopRecording')

    const state = await vmix.invoke('record', 'readState')
    expect(state?.recording?.active).toBe(false)
  })
})

describe('reading the status XML', () => {
  it('parses the elements and not the text that happens to look like them', async () => {
    // The fake's preset holds an input titled with the very markup this
    // parser is looking for. A reader scanning the document would find it.
    const fake = fakeVmix()
    expect(fake.xml()).toContain('&lt;recording&gt;True&lt;/recording&gt;')
    const status = parseStatus(fake.xml())
    expect(status.recording).toBe(false)
    expect(status.version).toBe('27.0.0.74')
  })

  it('says so when the answer is not vMix at all', async () => {
    // Pointing this at the TCP port, or at some other web server on 8088,
    // is a normal mistake and deserves better than a parse error.
    expect(() => parseStatus('<html><body>Not vMix</body></html>')).toThrow(/status XML/i)
  })

  it('reads a channel that is live and the four that are not', async () => {
    const status = parseStatus(
      '<vmix><version>27</version><edition>HD</edition>' +
        '<recording>False</recording><external>False</external>' +
        '<streaming channel1="False" channel2="True">True</streaming></vmix>',
    )
    expect(status.streaming).toBe(true)
    expect(status.channels).toEqual([false, true, false, false, false])
  })
})
