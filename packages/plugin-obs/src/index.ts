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
import {
  createObsClient,
  type CreateObsClient,
  type ObsClient,
  type ObsRecordStatus,
  type ObsStreamService,
  type ObsStreamStatus,
  type ObsVersion,
} from './client.js'

/**
 * OBS Studio, over obs-websocket v5.
 *
 * The first source in this app that is software rather than a box, and the
 * best protocol fit of anything on the list: OBS pushes `RecordStateChanged`
 * and `StreamStateChanged` as they happen, so verify-after-write reads a
 * state the program has already volunteered rather than polling something
 * into admitting what it did.
 *
 * Two things about it are genuinely different from a deck, and both are
 * design decisions rather than gaps:
 *
 * **OBS names its own recordings.** There is no filename argument on
 * `StartRecord`; the name comes from the profile's own filename formatting,
 * and OBS reports the path it chose afterwards. So an event's filename
 * template does not apply to this node, and the adapter reports what OBS
 * used in `recording.filename` — which the host stores in its ledger, so
 * the recording stays matchable and sweepable. (`SetProfileParameter` could
 * force the name, but it writes to the operator's saved profile to do it.
 * Not worth that, and not worth doing untested against real OBS.)
 *
 * **It is on somebody's machine.** No discovery: a laptop moves, sleeps and
 * changes address, so the address is typed in and a disappearing OBS is a
 * disconnect like any other.
 */

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip:
      'The machine OBS is running on. In OBS: Tools → WebSocket Server Settings, with the server enabled.',
  },
  {
    type: 'number',
    id: 'port',
    label: 'Port',
    default: 4455,
    min: 1,
    max: 65535,
    tooltip: 'The WebSocket server port from the same OBS settings screen. 4455 by default.',
  },
  {
    type: 'secret',
    id: 'password',
    label: 'Password',
    tooltip:
      'From OBS → Tools → WebSocket Server Settings → Show Connect Info. Leave blank only if ' +
      'authentication is switched off there, which is worth avoiding on any machine others can reach.',
  },
]

/** Long enough for a busy machine, short enough that a wedged OBS is not
 *  mistaken for a slow one — the same bound every adapter here carries. */
export const REQUEST_TIMEOUT_MS = 10_000

class ObsDevice {
  private connectedAt = 0
  private connected = false
  private disposed = false
  private lastError: string | undefined
  private version: ObsVersion = { obsVersion: 'OBS Studio', obsWebSocketVersion: '' }
  /**
   * The path of the most recent recording, as OBS reported it.
   *
   * Kept because the protocol only volunteers it on the state-change event
   * and on the reply to `StopRecord`; `GetRecordStatus` does not carry it.
   * Without holding on to it there would be nothing to put in the ledger,
   * and the file would be unmatchable the moment it existed.
   */
  private recordingPath: string | undefined

  private readonly onRecordState = (data: Record<string, unknown>): void => {
    if (typeof data.outputPath === 'string' && data.outputPath) this.recordingPath = data.outputPath
    void this.emit('record')
  }

  private readonly onStreamState = (): void => {
    void this.emit('stream')
  }

  private readonly onClosed = (): void => {
    this.connected = false
    this.lastError = 'OBS closed the connection.'
    this.ctx.emitHealth(this.health())
  }

  constructor(
    private readonly ctx: DeviceContext,
    private readonly client: ObsClient,
    private readonly host: string,
    private readonly port: number,
    private readonly password: string | undefined,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    const address = `ws://${this.host}:${this.port}`
    try {
      const hello = await this.client.connect(
        address,
        this.password && this.password.length > 0 ? this.password : undefined,
      )
      this.version.obsWebSocketVersion = hello.obsWebSocketVersion
    } catch (error) {
      throw new DeviceError(
        'unreachable',
        `Could not reach OBS at ${address}: ${describe(error)}`,
        {
          retryable: true,
          remediation:
            'Check OBS is running with Tools → WebSocket Server Settings → Enable WebSocket server, ' +
            'that the port matches, and that the password is the one under Show Connect Info.',
        },
      )
    }

    this.connected = true
    this.connectedAt = this.now()
    this.lastError = undefined

    // Subscribed rather than polled: this is the whole reason OBS is a good
    // fit here. A recording that stops because the disk filled says so at
    // once instead of at the next read.
    this.client.on('RecordStateChanged', this.onRecordState)
    this.client.on('StreamStateChanged', this.onStreamState)
    this.client.on('ConnectionClosed', this.onClosed)

    this.version = await this.send<ObsVersion>('GetVersion')
  }

  async probe(): Promise<DeviceCapabilities> {
    const features = ['streaming', 'recording']
    return {
      model: `OBS Studio ${this.version.obsVersion}`.trim(),
      firmware: `websocket ${this.version.obsWebSocketVersion}`,
      features,
    }
  }

  health(): HealthReport {
    if (this.disposed || !this.connected) {
      return {
        state: 'disconnected',
        ...(this.lastError === undefined ? {} : { message: this.lastError }),
        since: this.connectedAt,
      }
    }
    return { state: 'connected', since: this.connectedAt }
  }

  nodes(): NodeDefinition[] {
    return [
      {
        id: 'stream',
        label: 'OBS stream',
        roles: ['source'],
        ports: [{ id: 'out', direction: 'out', label: 'Stream', transport: ['rtmp'], maxLinks: 1 }],
        supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming'],
      },
      {
        id: 'record',
        label: 'OBS recording',
        roles: ['sink'],
        ports: [{ id: 'in', direction: 'in', label: 'Record', transport: ['rtmp'], maxLinks: 1 }],
        // No listMedia or deleteMedia: OBS writes to a folder on somebody's
        // machine and the protocol offers no way to enumerate or remove
        // what is in it. Saying so here is better than half-implementing
        // either and having retention believe it can tidy up.
        supports: ['startRecording', 'stopRecording'],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId === 'stream') {
      return {
        /**
         * Points OBS at a URL and key.
         *
         * Always as a custom RTMP server, never as one of the named
         * services OBS knows: this scheduler is handed a URL and a key by
         * whatever issued them, and translating that back into "which of
         * OBS's built-in services did you mean" is a guess that can only
         * be wrong.
         */
        applyStreamTarget: async ({ url, key }) => {
          await this.send('SetStreamServiceSettings', {
            streamServiceType: 'rtmp_custom',
            streamServiceSettings: { server: url, key },
          })
        },
        startStreaming: async () => {
          await this.send('StartStream')
        },
        stopStreaming: async () => {
          await this.send('StopStream')
        },
        readState: async () => this.stateOf('stream'),
      }
    }

    if (nodeId === 'record') {
      return {
        /**
         * Starts recording. The filename is OBS's to choose.
         *
         * The argument is accepted and deliberately unused — the host
         * always supplies one and there is nowhere to put it. What matters
         * is that `readState` afterwards reports the name OBS *did* use, so
         * the ledger holds something that matches the file on disk.
         */
        startRecording: async () => {
          this.recordingPath = undefined
          await this.send('StartRecord')
        },
        stopRecording: async () => {
          // The reply carries the finished file's path, which is the most
          // reliable place the protocol offers it.
          const result = await this.send<{ outputPath?: string }>('StopRecord')
          if (typeof result?.outputPath === 'string' && result.outputPath) {
            this.recordingPath = result.outputPath
          }
        },
        readState: async () => this.stateOf('record'),
      }
    }

    return undefined
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.client.off('RecordStateChanged', this.onRecordState)
    this.client.off('StreamStateChanged', this.onStreamState)
    this.client.off('ConnectionClosed', this.onClosed)
    await this.client.disconnect().catch(() => {})
    this.connected = false
  }

  // -- state ---------------------------------------------------------------

  private async stateOf(nodeId: string): Promise<NodeState> {
    if (nodeId === 'record') {
      const status = await this.send<ObsRecordStatus>('GetRecordStatus')
      return {
        recording: {
          active: status.outputActive,
          // What OBS called it, which is not what anybody asked for. The
          // host stores this rather than its own request, so the recording
          // can still be found later.
          ...(this.recordingPath === undefined ? {} : { filename: basename(this.recordingPath) }),
          ...(status.outputDuration === undefined ? {} : { durationMs: status.outputDuration }),
        },
      }
    }

    const [status, service] = await Promise.all([
      this.send<ObsStreamStatus>('GetStreamStatus'),
      this.send<ObsStreamService>('GetStreamServiceSettings'),
    ])
    const target = service.streamServiceSettings ?? {}

    return {
      streaming: {
        active: status.outputActive,
        ...(target.server === undefined ? {} : { targetUrl: target.server }),
        ...(target.key ? { keyFingerprint: fingerprint(target.key) } : {}),
        ...(status.outputDuration === undefined ? {} : { durationMs: status.outputDuration }),
      },
      // OBS counts dropped frames rather than a send buffer, and reports
      // congestion from zero to one. Read as a percentage it is the same
      // question the cache answers on a hardware encoder: is the uplink
      // keeping up, and is anybody going to notice before it drops.
      ...(status.outputCongestion === undefined
        ? {}
        : { cache: { percent: Math.round(status.outputCongestion * 100), status: 'congestion' } }),
    }
  }

  private async emit(nodeId: string): Promise<void> {
    if (this.disposed || !this.connected) return
    try {
      this.ctx.emitState(nodeId, await this.stateOf(nodeId))
    } catch (error) {
      this.ctx.log('warn', 'could not read OBS state after a change', { error: describe(error) })
    }
  }

  /**
   * One request, with a deadline.
   *
   * Bounded because an unbounded wait on one device is how a whole
   * scheduler tick wedges — the failure this app has already had once,
   * from a deck that accepted a socket and stopped answering.
   */
  private async send<T>(request: string, args?: Record<string, unknown>): Promise<T> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.client.call<T>(request, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DeviceError(
                  'timeout',
                  `OBS did not answer ${request} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
                  { retryable: true },
                ),
              ),
            REQUEST_TIMEOUT_MS,
          )
        }),
      ])
    } catch (error) {
      if (error instanceof DeviceError) throw error
      throw new DeviceError('command-failed', `OBS refused ${request}: ${describe(error)}`, {
        retryable: true,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** The last path segment, on either platform's separator. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ObsPluginOptions {
  now?: () => number
  /** Injected in tests, which have no OBS to talk to. */
  createClient?: CreateObsClient
}

export function obsPlugin(options: ObsPluginOptions = {}): PluginDefinition {
  const now = options.now ?? (() => Date.now())
  const createClient = options.createClient ?? createObsClient

  return {
    id: 'obs',
    displayName: 'OBS Studio',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '').trim()
      if (!host) throw new DeviceError('bad-config', 'OBS needs an address.')
      const port = Number(ctx.config.port ?? 4455)
      const password = ctx.config.password === undefined ? undefined : String(ctx.config.password)

      const device = new ObsDevice(ctx, createClient(), host, port, password, now)
      await device.connect()

      return defineDevice({
        probe: () => device.probe(),
        health: () => Promise.resolve(device.health()),
        listNodes: () => Promise.resolve(device.nodes()),
        actionsFor: (nodeId) => device.actionsFor(nodeId),
        dispose: () => device.dispose(),
      })
    },
  }
}
