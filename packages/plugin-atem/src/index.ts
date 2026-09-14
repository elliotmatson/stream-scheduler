import { defineDevice, DeviceError, fingerprint, SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type {
  ConfigField,
  DeviceCapabilities,
  DeviceContext,
  DeviceInstance,
  HealthReport,
  NodeActions,
  NodeDefinition,
  NodeState,
  PluginDefinition,
} from '@scheduler/plugin-sdk'
import { Enums } from 'atem-connection'
import type { AtemState } from 'atem-connection'
import { AtemConnectionStatus, createAtemClient, type AtemClient } from './client.js'

/**
 * Blackmagic ATEM switchers.
 *
 * Capabilities are read from the state the switcher actually reports rather
 * than from a hardcoded model table. Streaming and recording support varies
 * across the family and with firmware — a Mini Pro streams and records to
 * USB, a plain Mini does neither, a Television Studio HD8 differs again — and
 * a table of models goes stale the first time Blackmagic ships an update. If
 * the switcher reports a streaming block, it streams.
 *
 * The protocol is reverse-engineered, not published. A firmware update can
 * break it, so a version the library cannot speak surfaces as a named error
 * at probe time rather than a silent failure at showtime.
 */

export const DEFAULT_PORT = 9910

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip: 'The ATEM must be reachable on the control network.',
  },
  { type: 'number', id: 'port', label: 'Port', default: DEFAULT_PORT, min: 1, max: 65535 },
]

/**
 * What the switcher calls the stream it is pointed at.
 *
 * The ATEM shows this on its front panel and in ATEM Software Control, and
 * it is a label rather than a setting — nothing about the stream depends on
 * it. Whoever is looking at the box wants to know what put it there, so it
 * names this app rather than a service that may not be the one in use by the
 * time anybody reads it.
 */
const SERVICE_NAME = 'Stream Scheduler'

const CONNECT_TIMEOUT_MS = 10_000

class AtemDevice {
  private connectedAt = 0
  private lastError: string | undefined
  private disposed = false

  constructor(
    private readonly ctx: DeviceContext,
    private readonly client: AtemClient,
    private readonly host: string,
    private readonly port: number,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new DeviceError('connect-timeout', `${this.host}:${this.port} did not answer within 10 seconds.`, {
            retryable: true,
            remediation:
              'Check the address and that the ATEM is on the control network. ' +
              'The ATEM protocol is UDP, so a firewall that allows TCP may still block it.',
          }),
        )
      }, CONNECT_TIMEOUT_MS)

      const onConnected = (): void => {
        cleanup()
        this.connectedAt = this.now()
        resolve()
      }
      const onError = (message: string): void => {
        cleanup()
        reject(
          new DeviceError('connect-failed', `Could not reach ${this.host}:${this.port}: ${message}`, {
            retryable: true,
          }),
        )
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.client.off('connected', onConnected)
        this.client.off('error', onError as (...args: never[]) => void)
      }

      this.client.on('connected', onConnected)
      this.client.on('error', onError)
      this.client.connect(this.host, this.port).catch(onError as unknown as (reason: unknown) => void)
    })

    this.client.on('error', (message: string) => {
      this.lastError = message
      this.ctx.log('warn', 'atem reported an error', { message })
    })
    this.client.on('disconnected', () => {
      this.lastError = 'The switcher closed the connection.'
      this.ctx.emitHealth(this.health())
    })

    // The library maintains a full state mirror and tells us which paths
    // changed, so telemetry costs nothing extra: no polling, and bitrate and
    // transport changes reach the UI as they happen.
    this.client.on('stateChanged', (_state, paths) => {
      if (paths.some((path) => path.startsWith('streaming'))) void this.emit('stream')
      if (paths.some((path) => path.startsWith('recording'))) void this.emit('record')
    })
  }

  probe(): DeviceCapabilities {
    const state = this.requireState()
    const features: string[] = []
    if (state.streaming) features.push('streaming')
    if (state.recording) features.push('recording')
    const auxes = state.info.capabilities?.auxilliaries ?? 0
    if (auxes > 0) features.push(`aux:${auxes}`)

    return {
      model: state.info.productIdentifier ?? Enums.Model[state.info.model] ?? 'ATEM',
      firmware: `protocol ${protocolName(state.info.apiVersion)}`,
      features,
    }
  }

  health(): HealthReport {
    if (this.disposed || this.client.status !== AtemConnectionStatus.CONNECTED) {
      return {
        state: this.client.status === AtemConnectionStatus.CONNECTING ? 'degraded' : 'disconnected',
        ...(this.lastError === undefined ? {} : { message: this.lastError }),
        since: this.connectedAt,
      }
    }
    return { state: 'connected', since: this.connectedAt }
  }

  nodes(): NodeDefinition[] {
    const state = this.requireState()
    const label = state.info.productIdentifier ?? 'ATEM'
    const nodes: NodeDefinition[] = []

    if (state.streaming) {
      nodes.push({
        id: 'stream',
        label: `${label} stream output`,
        roles: ['source'],
        ports: [
          {
            id: 'out',
            direction: 'out',
            label: 'Stream output',
            transport: ['rtmp', 'rtmps'],
            // The hardware encoder has exactly one output. Fanning out to a
            // second destination needs a relay, and the link negotiation in
            // the core says so rather than failing on the day.
            maxLinks: 1,
            requiresCredential: 'stream-key',
          },
        ],
        supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming'],
      })
    }

    if (state.recording) {
      nodes.push({
        id: 'record',
        label: `${label} recorder`,
        roles: ['sink'],
        ports: [{ id: 'in', direction: 'in', label: 'Record input', transport: ['sdi', 'hdmi'], maxLinks: 1 }],
        supports: ['startRecording', 'stopRecording'],
      })
    }

    const auxes = state.info.capabilities?.auxilliaries ?? 0
    if (auxes > 0) {
      nodes.push({
        id: 'aux',
        label: `${label} aux routing`,
        roles: ['router'],
        ports: [
          { id: 'in', direction: 'in', label: 'Any source', transport: ['sdi', 'hdmi'], maxLinks: auxes },
          { id: 'out', direction: 'out', label: 'Aux outputs', transport: ['sdi', 'hdmi'], maxLinks: auxes },
        ],
        supports: ['route'],
      })
    }

    return nodes
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId === 'stream') {
      return {
        applyStreamTarget: async ({ url, key, quality }) => {
          // Parsed before anything is sent: a bitrate the switcher would
          // refuse should be an argument error, not a device error, and
          // should leave the switcher as it was.
          const bitrates = quality === undefined ? undefined : parseQuality(quality)
          await this.guard(() =>
            this.client.setStreamingService({
              serviceName: SERVICE_NAME,
              url,
              key,
              // Absent leaves the switcher on the bitrate it is set to.
              ...(bitrates ? { bitrates } : {}),
            }),
          )
        },
        startStreaming: async () => {
          const streaming = this.requireState().streaming
          if (!streaming?.service.url) {
            throw new DeviceError('no-stream-target', 'The ATEM has no streaming URL set.', {
              remediation: 'Push the ingest URL and key before starting the stream.',
            })
          }
          await this.guard(() => this.client.startStreaming())
        },
        stopStreaming: async () => {
          await this.guard(() => this.client.stopStreaming())
        },
        readState: async () => this.readState('stream'),
      }
    }

    if (nodeId === 'record') {
      return {
        startRecording: async ({ filename, quality }) => {
          // The ATEM records to its own media with a filename it is given
          // beforehand, unlike the HyperDeck where the name rides along with
          // the record command.
          //
          // Quality goes through the streaming service because that is where
          // the switcher keeps it: one H.264 encoder feeds both the stream
          // and the recording, so the bitrate set here is the bitrate a
          // stream on this box gets too. That is why two outputs on one ATEM
          // asking for different qualities is reported as a clash rather
          // than quietly resolved.
          const bitrates = quality === undefined ? undefined : parseQuality(quality)
          if (bitrates) {
            await this.guard(() => this.client.setStreamingService({ bitrates }))
          }
          await this.guard(() => this.client.setRecordingSettings({ filename }))
          await this.guard(() => this.client.startRecording())
        },
        stopRecording: async () => {
          await this.guard(() => this.client.stopRecording())
        },
        readState: async () => this.readState('record'),
      }
    }

    if (nodeId === 'aux') {
      return {
        route: async ({ input, output }) => {
          const source = Number(input)
          const bus = Number(output)
          if (!Number.isInteger(source) || !Number.isInteger(bus)) {
            throw new DeviceError('bad-argument', 'ATEM routing takes numeric source and aux bus ids.')
          }
          await this.guard(() => this.client.setAuxSource(source, bus))
        },
        readState: async () => this.readState('aux'),
      }
    }

    return undefined
  }

  readState(nodeId: string): NodeState {
    const state = this.requireState()

    if (nodeId === 'record') {
      const recording = state.recording
      const disks = Object.values(recording?.disks ?? {}).filter(
        (disk): disk is NonNullable<typeof disk> => disk !== undefined,
      )
      return {
        recording: {
          active: recording?.status?.state === Enums.RecordingStatus.Recording,
          ...(recording?.properties.filename ? { filename: recording.properties.filename } : {}),
          ...(recording?.status === undefined
            ? {}
            : { remainingMs: recording.status.recordingTimeAvailable * 1000 }),
          // The media plugged into the switcher. An ATEM calls them disks
          // and a deck calls them slots; they are the same thing to an
          // operator asking whether there is room for this morning.
          ...(disks.length === 0
            ? {}
            : {
                slots: disks
                  .map((disk) => ({
                    id: disk.diskId,
                    status: diskStatusName(disk.status),
                    ...(disk.volumeName ? { volumeName: disk.volumeName } : {}),
                    remainingMs: disk.recordingTimeAvailable * 1000,
                    ...(disk.diskId === recording?.properties.workingSet1DiskId ? { active: true } : {}),
                  }))
                  .sort((a, b) => a.id - b.id),
              }),
          // The switcher moves to the next disk in its working set when one
          // fills, if there is one there.
          rollover: disks.length > 1,
        },
        // Reported on the recorder as well as the streamer, because it is
        // one setting: the recording's quality is the streaming bitrate.
        ...this.qualityOption(state),
        raw: { recordingError: recordingErrorName(recording?.status?.error) },
      }
    }

    if (nodeId === 'aux') {
      const routing: Record<string, string> = {}
      state.video.auxilliaries.forEach((source, bus) => {
        if (source !== undefined) routing[String(bus)] = String(source)
      })
      return { routing }
    }

    const streaming = state.streaming
    return {
      streaming: {
        active: streaming?.status?.state === Enums.StreamingStatus.Streaming,
        ...(streaming?.service.url ? { targetUrl: streaming.service.url } : {}),
        // The fingerprint, never the key: verify-after-write compares hashes
        // so the secret does not travel back across the plugin boundary.
        ...(streaming?.service.key ? { keyFingerprint: fingerprint(streaming.service.key) } : {}),
        ...(streaming?.stats === undefined ? {} : { bitrateBps: streaming.stats.encodingBitrate }),
      },
      ...this.qualityOption(state),
      raw: {
        streamingState: streamingStatusName(streaming?.status?.state),
        streamingError: streamingErrorName(streaming?.status?.error),
      },
    }
  }

  /**
   * What this switcher will take for quality, and what it is on now.
   *
   * Only offered where the switcher has an encoder at all: a plain Mini
   * neither streams nor records, and a quality box on it would be a control
   * for nothing.
   */
  private qualityOption(state: Readonly<AtemState>): Pick<NodeState, 'options'> {
    if (!state.streaming && !state.recording) return {}
    const current = formatQuality(state.streaming?.service.bitrates)
    return {
      options: {
        quality: {
          ...(current === undefined ? {} : { current }),
          choices: [],
          bitrate: {
            minMbps: MIN_MBPS,
            maxMbps: MAX_MBPS,
            note: 'One encoder serves streaming and recording, so this is the quality of both.',
          },
        },
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.race([
      this.client.destroy().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])
  }

  private requireState(): Readonly<AtemState> {
    const state = this.client.state
    if (!state) {
      throw new DeviceError('no-state', 'The ATEM has not sent its state yet.', {
        retryable: true,
        remediation: 'Wait for the connection to settle, then retry.',
      })
    }
    return state
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    if (this.client.status !== AtemConnectionStatus.CONNECTED) {
      throw new DeviceError('not-connected', 'The ATEM is not connected.', { retryable: true })
    }
    try {
      await action()
    } catch (error) {
      throw new DeviceError('atem-error', describe(error), { retryable: true, cause: error })
    }
  }

  private async emit(nodeId: string): Promise<void> {
    if (this.disposed) return
    try {
      this.ctx.emitState(nodeId, this.readState(nodeId))
    } catch {
      // A state change that arrives before the mirror is complete is normal
      // during connection; the next one will carry it.
    }
  }
}

function protocolName(version: number): string {
  return Enums.ProtocolVersion[version] ?? String(version)
}

function streamingStatusName(status: number | undefined): string {
  return status === undefined ? 'unknown' : (Enums.StreamingStatus[status] ?? String(status))
}

function streamingErrorName(error: number | undefined): string {
  return error === undefined ? 'none' : (Enums.StreamingError[error] ?? String(error))
}

/**
 * A disk's state in words.
 *
 * The switcher reports a bitfield, so a disk that is both in the working set
 * and being written to reads as two things at once; the recording one is the
 * one worth showing.
 */
function diskStatusName(status: number | undefined): string {
  if (status === undefined) return 'unknown'
  if (status & Enums.RecordingDiskStatus.Removed) return 'removed'
  if (status & Enums.RecordingDiskStatus.Unformatted) return 'unformatted'
  if (status & Enums.RecordingDiskStatus.Recording) return 'recording'
  if (status & Enums.RecordingDiskStatus.Active) return 'mounted'
  if (status & Enums.RecordingDiskStatus.Idle) return 'mounted'
  return String(status)
}

function recordingErrorName(error: number | undefined): string {
  return error === undefined ? 'none' : (Enums.RecordingError[error] ?? String(error))
}

/**
 * The switcher's encoder quality, as a bitrate.
 *
 * An ATEM has no named quality profiles to offer. The names in ATEM Software
 * Control ("Streaming High", "HyperDeck 1080p50") come out of a Streaming.xml
 * on the computer running it, not out of the switcher — over the wire there is
 * only a pair of numbers. So this adapter speaks in Mb/s and says so, rather
 * than inventing profile names the box would not recognise and could not
 * report back.
 *
 * The pair is a range: Blackmagic's own files use a low and a high figure for
 * variable bitrate, and a single number here means both.
 */
const MIN_MBPS = 3
const MAX_MBPS = 70

export function parseQuality(quality: string): [number, number] {
  const cleaned = quality.trim().replace(/mb\/?s$/i, '').trim()
  const parts = cleaned.split(/\s*[-–]\s*/)
  if (parts.length > 2) throw badQuality(quality)

  const numbers = parts.map((part) => {
    const value = Number(part)
    if (!Number.isFinite(value) || value <= 0) throw badQuality(quality)
    return value
  })
  const low = numbers[0]!
  const high = numbers[1] ?? low
  if (high < low) throw badQuality(quality)
  if (low < MIN_MBPS || high > MAX_MBPS) {
    throw new DeviceError(
      'quality-out-of-range',
      `An ATEM takes ${MIN_MBPS} to ${MAX_MBPS} Mb/s, and "${quality}" is outside that.`,
      { remediation: `Pick a bitrate between ${MIN_MBPS} and ${MAX_MBPS} Mb/s.` },
    )
  }
  return [Math.round(low * 1_000_000), Math.round(high * 1_000_000)]
}

/** The inverse, in the same vocabulary, so a caller can compare the two. */
export function formatQuality(bitrates: readonly [number, number] | undefined): string | undefined {
  if (!bitrates) return undefined
  const [low, high] = bitrates.map((bps) => Math.round(bps / 10_000) / 100) as [number, number]
  if (!low && !high) return undefined
  return low === high ? String(low) : `${low}-${high}`
}

function badQuality(quality: string): DeviceError {
  return new DeviceError(
    'bad-quality',
    `"${quality}" is not a bitrate. An ATEM takes a figure in Mb/s, such as "9" or "7-9".`,
    { remediation: 'Give a number of Mb/s, or a low-high range.' },
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface AtemPluginOptions {
  now?: () => number
  /** Injected by tests; production uses the real `atem-connection` client. */
  createClient?: () => AtemClient
}

export function atemPlugin(options: AtemPluginOptions = {}): PluginDefinition {
  const now = options.now ?? Date.now
  const createClient = options.createClient ?? createAtemClient

  return {
    id: 'atem',
    displayName: 'Blackmagic ATEM',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '')
      if (!host) throw new DeviceError('no-host', 'This ATEM has no address configured.')
      const port = typeof ctx.config.port === 'number' ? ctx.config.port : DEFAULT_PORT
      const device = new AtemDevice(ctx, createClient(), host, port, now)
      await device.connect()

      return defineDevice({
        probe: async () => device.probe(),
        health: async () => device.health(),
        listNodes: async () => device.nodes(),
        actionsFor: (nodeId) => device.actionsFor(nodeId),
        dispose: () => device.dispose(),
      })
    },
  }
}

export type { AtemClient }
