import { defineDevice, DeviceError, fingerprint, SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type {
  ConfigField,
  DeviceCapabilities,
  DeviceContext,
  DeviceInstance,
  HealthReport,
  MediaItem,
  NodeActions,
  NodeDefinition,
  NodeState,
  PluginDefinition,
} from '@scheduler/plugin-sdk'
import {
  createMagewellApi,
  describeDisk,
  describeResult,
  describeServerType,
  MagewellError,
  redact,
  RESULT,
  takesUrlAndKey,
  type CreateMagewellApi,
  type MagewellApi,
  type MagewellInfo,
  type MagewellMedia,
  type MagewellRecChannels,
  type MagewellSettings,
  type MagewellStatus,
  type RecChannel,
  type StreamServer,
} from './api.js'

/**
 * Magewell's Ultra Encode family, over `usapi`.
 *
 * Written against the Ultra Encode AIO API reference (V2.4) and intended
 * for the family: Ultra Encode, Ultra Encode Plus, Ultra Encode AIO and the
 * older Ultra Stream all speak the same method names over the same
 * transport. What differs between them is how many destinations and record
 * channels they have, and this adapter asks rather than assumes — the nodes
 * come from what the device reports it is configured with.
 *
 * **Starting is global; choosing is per destination.** `start-live` and
 * `start-rec` take no arguments and act on the whole device; which
 * destinations take part is `enable-server`, and which record channels is
 * `enable-rec-channel`. So starting one output here enables that
 * destination and then starts the device, and stopping one disables that
 * destination and stops the device only once nothing else is left running.
 * It is the only arrangement that lets two outputs of one event run
 * independently on this hardware, and it is why this adapter re-sends
 * `start-live` freely: the device answers `repeat` rather than failing.
 *
 * **A destination that is enabled is not a destination that is up.** The
 * device reports a live task's `result` as a stage — connecting, resolving
 * DNS, authorising, connected — and only `connected` is streaming. A wrong
 * stream key shows up here, as an authentication error on a task that is
 * enabled and going nowhere, which is exactly the failure worth seeing
 * before a service rather than after it.
 *
 * **It can tidy up after itself.** Unlike every other software encoder
 * here, this one lists and deletes its own recordings, so retention works
 * properly. The device names the files, reports the names, and marks the
 * one it is writing to — which never gets offered for deletion.
 */

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip: 'The encoder. Its address is on the device’s own screen, or in Magewell’s finder.',
  },
  {
    type: 'number',
    id: 'port',
    label: 'Port',
    default: 80,
    min: 1,
    max: 65535,
    tooltip: 'The web interface port, 80 unless it was changed in the device’s web settings.',
  },
  {
    type: 'textinput',
    id: 'user',
    label: 'User name',
    default: 'Admin',
    tooltip: 'The account this app signs in as. Admin by default on a new device.',
  },
  {
    type: 'secret',
    id: 'password',
    label: 'Password',
    required: true,
    tooltip:
      'The password for that account. Stored in this app’s vault and sent to the device hashed, ' +
      'the way the device asks for it.',
  },
  {
    type: 'static-text',
    id: 'keyNotice',
    label: 'About stream keys',
    value:
      'This encoder takes stream keys over plain HTTP, in the address of the request — that is ' +
      'its own interface and not something this app can change. Keep it on a trusted network ' +
      'rather than exposing its web interface.',
  },
]

/** How many files to ask for in one go. Big enough for a card nobody has
 *  cleared in a year, small enough not to haul a novel over the wire. */
const MEDIA_PAGE = 200

class MagewellDevice {
  private connectedAt = 0
  private connected = false
  private disposed = false
  private lastError: string | undefined
  private info: MagewellInfo | undefined
  private servers: StreamServer[] = []
  private channels: RecChannel[] = []

  constructor(
    private readonly ctx: DeviceContext,
    private readonly api: MagewellApi,
    private readonly host: string,
    private readonly port: number,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    try {
      this.info = await this.api.call<MagewellInfo>('get-info')
      await this.reloadLayout()
    } catch (error) {
      if (error instanceof MagewellError && error.result === -1) {
        throw new DeviceError('auth-failed', 'The encoder refused the user name or password.', {
          remediation:
            'Check the account and password on the device’s own web page. A new device is ' +
            'usually Admin with the password set during first setup.',
        })
      }
      throw new DeviceError(
        'unreachable',
        `Could not reach the encoder at ${this.host}:${this.port}: ${describe(error)}`,
        {
          retryable: true,
          remediation:
            'Check the encoder is powered up and on the network, and that the port matches its ' +
            'web interface.',
        },
      )
    }
    this.connected = true
    this.connectedAt = this.now()
    this.lastError = undefined
  }

  /**
   * Re-reads what this device is configured with.
   *
   * The nodes are the device's own destinations and record channels, so
   * they are read rather than assumed: an Ultra Encode with one RTMP
   * destination and an AIO with six should not present the same list, and
   * neither should be a guess based on a model name.
   */
  private async reloadLayout(): Promise<void> {
    const settings = await this.api.call<MagewellSettings>('get-settings')
    this.servers = settings['stream-server'] ?? []
    const channels = await this.api.call<MagewellRecChannels>('get-rec-channels')
    this.channels = channels['rec-channels'] ?? []
  }

  async probe(): Promise<DeviceCapabilities> {
    const info = this.info
    return {
      model: info?.['product-name'] ?? info?.['box-name'] ?? 'Magewell encoder',
      firmware: info?.['firmware-ver'] ?? '',
      features: ['streaming', 'recording'],
      links: [
        {
          label: 'Encoder web interface',
          url: `http://${this.host}:${this.port}/`,
          note: 'The device’s own page, where destinations and recording are set up.',
        },
      ],
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
    const streams: NodeDefinition[] = this.servers.map((server) => ({
      id: serverNodeId(server.id),
      label: server.name ?? `${describeServerType(server.type)} ${server.id + 1}`,
      roles: ['source'],
      ports: [
        {
          id: 'out',
          direction: 'out',
          label: describeServerType(server.type),
          transport: ['rtmp'],
          maxLinks: 1,
        },
      ],
      // Only where the destination is actually a URL and a key. An NDI or
      // SRT listener is configured by name and port, and claiming this app
      // could point one at a YouTube ingest would be a lie that only shows
      // up on a Sunday morning.
      supports: takesUrlAndKey(server.type)
        ? ['applyStreamTarget', 'startStreaming', 'stopStreaming']
        : ['startStreaming', 'stopStreaming'],
    }))

    const recorders: NodeDefinition[] = this.channels.map((channel) => ({
      id: recNodeId(channel.id),
      label: `Recorder — ${describeDisk(channel.type)}`,
      roles: ['sink'],
      ports: [{ id: 'in', direction: 'in', label: 'Recorder', transport: ['rtmp'], maxLinks: 1 }],
      // The device lists and deletes its own files, so retention can do
      // its job here rather than being told to leave well alone.
      supports: ['startRecording', 'stopRecording', 'listMedia', 'deleteMedia'],
    }))

    return [...streams, ...recorders]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    const server = serverIdOf(nodeId)
    if (server !== undefined) {
      return this.servers.some((entry) => entry.id === server)
        ? this.streamActions(server)
        : undefined
    }
    const channel = recIdOf(nodeId)
    if (channel !== undefined) {
      const found = this.channels.find((entry) => entry.id === channel)
      return found ? this.recorderActions(found) : undefined
    }
    return undefined
  }

  private streamActions(id: number): NodeActions {
    return {
      applyStreamTarget: async ({ url, key, quality }) => {
        const server = this.servers.find((entry) => entry.id === id)
        if (server && !takesUrlAndKey(server.type)) {
          throw new DeviceError(
            'unsupported',
            `“${server.name ?? describeServerType(server.type)}” is a ` +
              `${describeServerType(server.type)} destination, which is not set by a URL and key.`,
            {
              remediation:
                'Point this output at one of the encoder’s RTMP destinations, or set this one up ' +
                'on the device’s own page.',
            },
          )
        }
        await this.send('set-server', {
          id: String(id),
          ...(server === undefined ? {} : { type: String(server.type) }),
          url,
          key,
          ...(quality === undefined ? {} : { 'stream-index': quality === 'sub' ? '1' : '0' }),
        })
        await this.reloadLayout()
      },

      /**
       * Brings one destination up.
       *
       * Two calls because the device separates them: the first says this
       * destination takes part, the second starts the encoder. The second
       * is harmless when something else already started it — the device
       * answers `repeat`, which is not a failure.
       */
      startStreaming: async () => {
        await this.send('enable-server', { id: String(id), 'is-use': '1' })
        await this.send('start-live')
      },

      /**
       * Takes one destination down, and the encoder with it only if that
       * was the last one. Stopping the whole device because one output
       * ended would take the others off air with it.
       */
      stopStreaming: async () => {
        await this.send('enable-server', { id: String(id), 'is-use': '0' })
        const status = await this.status()
        const others = (status['live-status']?.live ?? []).filter(
          (entry) => entry.id !== id && entry['is-use'] === 1,
        )
        if (others.length === 0) await this.send('stop-live')
      },

      readState: async () => this.streamState(id),
    }
  }

  private recorderActions(channel: RecChannel): NodeActions {
    const id = channel.id
    return {
      /**
       * Starts recording on this channel.
       *
       * The requested filename goes nowhere, because there is nowhere for
       * it to go: the device builds the name from the channel's own prefix
       * and numbering, and has no call to set one per recording. What it
       * chose is read back in `readState`, which is the name that ends up
       * in the ledger and the name retention will match later.
       */
      startRecording: async () => {
        await this.send('enable-rec-channel', { id: String(id), 'is-use': '1' })
        await this.send('start-rec')
      },
      stopRecording: async () => {
        await this.send('enable-rec-channel', { id: String(id), 'is-use': '0' })
        const status = await this.status()
        const others = (status['rec-status']?.rec ?? []).filter(
          (entry) => entry.id !== id && entry['is-use'] === 1,
        )
        if (others.length === 0) await this.send('stop-rec')
      },

      listMedia: async () => {
        const files = await this.mediaOn(channel.type)
        // The file being written is deliberately absent. It is on the card
        // and it is not a recording anybody can have yet, and offering it
        // in a list with tick boxes beside it is how somebody deletes a
        // service while it is still going.
        return files
          .filter((file) => file.status !== 0)
          .map((file): MediaItem => ({
            name: file.name,
            slot: channel.type,
            ...(file['size-bytes'] === undefined ? {} : { bytes: file['size-bytes'] }),
            ...(file.duration === undefined ? {} : { durationMs: file.duration * 1000 }),
            ...(recordedAt(file['create-time']) === undefined
              ? {}
              : { recordedAt: recordedAt(file['create-time']) }),
          }))
      },

      deleteMedia: async ({ name }) => {
        const before = await this.mediaOn(channel.type)
        const target = before.find((file) => file.name === name)
        if (target?.status === 0) {
          throw new DeviceError(
            'conflict',
            `“${name}” is the file the encoder is recording into right now.`,
            { remediation: 'Stop the recording first, then remove it.' },
          )
        }

        await this.postTo('del-media-files', {
          'disk-type': channel.type,
          'media-files': [name],
        })

        // Checked rather than assumed. A sweep that reports success on a
        // file still sitting on the card is worse than one that fails
        // loudly, and this device answers 0 for the request being accepted
        // rather than for the file being gone.
        const after = await this.mediaOn(channel.type)
        if (after.some((file) => file.name === name)) {
          throw new DeviceError(
            'command-failed',
            `The encoder still has “${name}” after deleting it.`,
            {
              retryable: true,
            },
          )
        }
      },

      readState: async () => this.recorderState(channel),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.connected = false
    this.api.forget()
  }

  // -- state ----------------------------------------------------------------

  private async streamState(id: number): Promise<NodeState> {
    const status = await this.status()
    const live = (status['live-status']?.live ?? []).find((entry) => entry.id === id)
    const server = this.servers.find((entry) => entry.id === id)

    // Enabled is not up. Only `livingConnected` is a stream that is
    // actually going out; everything between is on its way, and 30 is a
    // key the destination would not take.
    const active = live?.result === RESULT.livingConnected

    return {
      streaming: {
        active,
        ...(server?.url ? { targetUrl: server.url } : {}),
        ...(server?.key ? { keyFingerprint: fingerprint(server.key) } : {}),
        ...(live?.['main-inst-bps'] === undefined ? {} : { bitrateBps: live['main-inst-bps'] }),
        ...(active && live?.['run-ms'] !== undefined ? { durationMs: live['run-ms'] } : {}),
      },
      // What the device says about a destination that is enabled and not
      // up. Without this a wrong key reads as "not streaming yet" forever.
      ...(live === undefined || active || live['is-use'] !== 1
        ? {}
        : { raw: { stage: stageOf(live.result) } }),
    }
  }

  private async recorderState(channel: RecChannel): Promise<NodeState> {
    const status = await this.status()
    const rec = (status['rec-status']?.rec ?? []).find((entry) => entry.id === channel.id)
    const active = rec?.['is-use'] === 1 && rec.result === RESULT.running

    // Only while it is recording. The file being written is the one marked
    // status 0, and asking for the whole listing on every poll of an idle
    // recorder would be a lot of card reading for nothing.
    const filename = active
      ? (await this.mediaOn(channel.type).catch(() => [])).find((file) => file.status === 0)?.name
      : undefined

    return {
      recording: {
        active,
        // Whatever the device called it. Nothing asked it to use this name
        // and there is no call that could have.
        ...(filename === undefined ? {} : { filename }),
        ...(active && rec?.['run-ms'] !== undefined ? { durationMs: rec['run-ms'] } : {}),
        slots: this.channels.map((entry) => ({
          id: entry.type,
          status: describeDisk(entry.type),
          active: entry.id === channel.id,
        })),
      },
    }
  }

  private async mediaOn(diskType: number) {
    const answer = await this.call<MagewellMedia>('get-media-files', {
      'disk-type': String(diskType),
      start: '0',
      count: String(MEDIA_PAGE),
    })
    return answer['media-files'] ?? []
  }

  private async status(): Promise<MagewellStatus> {
    return this.call<MagewellStatus>('get-status')
  }

  // -- talking to it --------------------------------------------------------

  /** A command. `repeat` and `running` are answers, not failures: this
   *  adapter re-sends `start-live` whenever a second destination joins. */
  private async send(method: string, params: Record<string, string> = {}): Promise<void> {
    const answer = await this.call<{ result: number }>(method, params)
    if (
      answer.result !== RESULT.succeeded &&
      answer.result !== RESULT.repeat &&
      answer.result !== RESULT.running
    ) {
      throw this.explain(method, params, answer.result)
    }
  }

  private async call<T extends { result: number }>(
    method: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    try {
      const answer = await this.api.call<T>(method, params)
      this.lastError = undefined
      return answer
    } catch (error) {
      this.lastError = describe(error)
      if (error instanceof DeviceError) throw error
      // The method name only. The parameters may be carrying a stream key.
      throw new DeviceError(
        'command-failed',
        `The encoder would not run ${redact(method, params)}: ${describe(error)}`,
        { retryable: true },
      )
    }
  }

  private async postTo(method: string, body: unknown): Promise<void> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    const answer = await this.api.post<{ result: number }>(method, body)
    if (answer.result !== RESULT.succeeded) throw this.explain(method, {}, answer.result)
  }

  private explain(method: string, params: Record<string, string>, result: number): DeviceError {
    const why = describeResult(result)
    if (result === -35) {
      return new DeviceError('no-signal', `The encoder has no input signal, so ${method} failed.`, {
        retryable: true,
        remediation: 'Check what is plugged into the encoder’s HDMI or SDI input.',
      })
    }
    return new DeviceError(
      'command-failed',
      `The encoder refused ${redact(method, params)}: ${why}.`,
      {
        retryable: result === RESULT.running || result === -9,
      },
    )
  }
}

/** The stage a destination is stuck at, in words somebody can act on. */
function stageOf(result: number): string {
  if (result === RESULT.livingAuthError) return 'the destination refused the stream key'
  if (result === RESULT.livingNotSet) return 'no address is set for this destination'
  if (result === RESULT.livingDns) return 'looking up the address'
  if (result === RESULT.livingConnecting) return 'connecting'
  if (result === RESULT.livingWaiting) return 'waiting for the destination'
  if (result === RESULT.livingAuthing) return 'signing in to the destination'
  if (result === RESULT.init) return 'idle'
  return describeResult(result)
}

/** `2019-09-25 06:35:21`, in the device's own local time. Without a zone
 *  there is nothing better to do than read it as the host's, which is the
 *  same room in every install this is for. */
function recordedAt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function serverNodeId(id: number): string {
  return `stream${id}`
}

function serverIdOf(nodeId: string): number | undefined {
  const match = /^stream(\d+)$/.exec(nodeId)
  return match ? Number(match[1]) : undefined
}

function recNodeId(id: number): string {
  return `rec${id}`
}

function recIdOf(nodeId: string): number | undefined {
  const match = /^rec(\d+)$/.exec(nodeId)
  return match ? Number(match[1]) : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface MagewellPluginOptions {
  now?: () => number
  /** Injected in tests, which have no encoder to talk to. */
  createApi?: CreateMagewellApi
}

export function magewellPlugin(options: MagewellPluginOptions = {}): PluginDefinition {
  const now = options.now ?? (() => Date.now())
  const createApi = options.createApi ?? createMagewellApi

  return {
    id: 'magewell',
    displayName: 'Magewell Ultra Encode',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '').trim()
      if (!host) throw new DeviceError('bad-config', 'The encoder needs an address.')
      const port = Number(ctx.config.port ?? 80)
      const user = String(ctx.config.user ?? 'Admin').trim() || 'Admin'
      const password = String(ctx.config.password ?? '')

      const device = new MagewellDevice(
        ctx,
        createApi({ host, port, user, password }),
        host,
        port,
        now,
      )
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
