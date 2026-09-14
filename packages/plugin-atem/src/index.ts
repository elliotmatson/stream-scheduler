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
  {
    type: 'textinput',
    id: 'serviceName',
    label: 'Streaming service name',
    default: 'YouTube',
    tooltip: 'Shown on the ATEM front panel and in ATEM Software Control.',
  },
]

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
    private readonly serviceName: string,
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
        applyStreamTarget: async ({ url, key }) => {
          await this.guard(() =>
            this.client.setStreamingService({ serviceName: this.serviceName, url, key }),
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
        startRecording: async ({ filename }) => {
          // The ATEM records to its own media with a filename it is given
          // beforehand, unlike the HyperDeck where the name rides along with
          // the record command.
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
      return {
        recording: {
          active: recording?.status?.state === Enums.RecordingStatus.Recording,
          ...(recording?.properties.filename ? { filename: recording.properties.filename } : {}),
          ...(recording?.status === undefined
            ? {}
            : { remainingMs: recording.status.recordingTimeAvailable * 1000 }),
        },
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
      raw: {
        streamingState: streamingStatusName(streaming?.status?.state),
        streamingError: streamingErrorName(streaming?.status?.error),
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

function recordingErrorName(error: number | undefined): string {
  return error === undefined ? 'none' : (Enums.RecordingError[error] ?? String(error))
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
      const serviceName = typeof ctx.config.serviceName === 'string' ? ctx.config.serviceName : 'YouTube'

      const device = new AtemDevice(ctx, createClient(), host, port, serviceName, now)
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
