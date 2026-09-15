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
  channelValue,
  createVmixApi,
  MAX_STREAM_CHANNELS,
  redact,
  VmixApiError,
  type CreateVmixApi,
  type VmixApi,
  type VmixStatus,
} from './api.js'

/**
 * vMix, over its Web Controller API.
 *
 * Unlike ProPresenter, vMix really does have independent outputs: five RTMP
 * destinations that start and stop separately, plus a recorder that runs
 * alongside any of them. So this is several nodes, and an event can point a
 * YouTube output and an archive recording at the same machine without one
 * stopping the other.
 *
 * **vMix names its own recordings.** There is no function to set the
 * filename — it comes from vMix's own Recording Settings, folder and
 * pattern and all. The status XML reports what it chose, so the node
 * returns that and the run ledger keeps the real name rather than the one
 * we would have liked. That is the whole point of the contract in
 * `docs/plan/04-plugin-sdk.md`: a recording is named by whoever names it.
 *
 * It also writes **two** files at once when a second format is configured,
 * and the state contract has room for one name. The first is reported and
 * the second is named in the node's own state rather than dropped silently.
 *
 * **Nothing here can delete a recording.** vMix has no file API: the files
 * are on a Windows PC and nothing in the Web Controller lists or removes
 * them. `listMedia` and `deleteMedia` are absent rather than
 * half-implemented, and retention leaves these alone.
 */

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip:
      'The Windows PC running vMix. Its Web Controller has to be switched on: vMix → Settings → ' +
      'Web Controller → Enable.',
  },
  {
    type: 'number',
    id: 'port',
    label: 'Web Controller port',
    default: 8088,
    min: 1,
    max: 65535,
    tooltip:
      'The port from the same Web Controller settings screen. 8088 by default. This is not the ' +
      'TCP API port (8099).',
  },
  {
    type: 'number',
    id: 'streamChannels',
    label: 'Stream destinations in use',
    default: 1,
    min: 1,
    max: MAX_STREAM_CHANNELS,
    tooltip:
      'vMix can stream to five destinations at once, and each is a separate output here. Set this ' +
      'to how many you actually use, so the rest do not clutter the list.',
  },
  {
    type: 'static-text',
    id: 'keyNotice',
    label: 'About stream keys',
    value:
      'vMix takes stream keys over plain HTTP, in the address of the request — that is its own ' +
      'interface and not something this app can change. Keep vMix on a trusted network rather ' +
      'than exposing its Web Controller.',
  },
]

/** `stream1`…`stream5` in the UI, 0-based on the wire. vMix's own numbering
 *  starts at 1 and its API's at 0, and getting that backwards points the
 *  wrong destination at the stream. */
function nodeIdFor(channel: number): string {
  return `stream${channel + 1}`
}

function channelOf(nodeId: string): number | undefined {
  const match = /^stream(\d+)$/.exec(nodeId)
  if (!match) return undefined
  const shown = Number(match[1])
  return shown >= 1 && shown <= MAX_STREAM_CHANNELS ? shown - 1 : undefined
}

class VmixDevice {
  private connectedAt = 0
  private connected = false
  private disposed = false
  private lastError: string | undefined
  private status: VmixStatus | undefined
  /** What we last pointed each destination at, so the state can say where a
   *  stream is going. vMix's status XML reports that a channel is live but
   *  not its URL, and there is no function to read the settings back. */
  private readonly targets = new Map<number, { url: string; key?: string }>()

  constructor(
    private readonly ctx: DeviceContext,
    private readonly api: VmixApi,
    private readonly host: string,
    private readonly port: number,
    private readonly streamChannels: number,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    try {
      this.status = await this.api.status()
    } catch (error) {
      // A password blocks the very first request, so this is where most
      // people meet it. "Could not reach vMix" would send them looking at
      // cables for a setting two screens away.
      if (error instanceof VmixApiError && error.status === 401) throw passwordError()
      throw new DeviceError(
        'unreachable',
        `Could not reach vMix at ${this.host}:${this.port}: ${describe(error)}`,
        {
          retryable: true,
          remediation:
            'Check vMix is running, that Settings → Web Controller is enabled, and that the port ' +
            'matches. 8088 is the Web Controller; 8099 is the TCP API and will not answer this.',
        },
      )
    }
    this.connected = true
    this.connectedAt = this.now()
    this.lastError = undefined
  }

  async probe(): Promise<DeviceCapabilities> {
    const status = this.status
    return {
      model: `vMix ${status?.edition ?? ''}`.trim(),
      firmware: status?.version ?? '',
      features: ['streaming', 'recording'],
      links: [
        {
          label: 'vMix Web Controller',
          url: `http://${this.host}:${this.port}/`,
          note: 'The machine’s own controller page, for checking it is answering at all.',
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
    const streams: NodeDefinition[] = Array.from({ length: this.streamChannels }, (_, channel) => ({
      id: nodeIdFor(channel),
      label: `Stream ${channel + 1}`,
      roles: ['source'],
      ports: [
        {
          id: 'out',
          direction: 'out',
          label: `Stream ${channel + 1}`,
          transport: ['rtmp'],
          maxLinks: 1,
        },
      ],
      supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming'],
    }))

    return [
      ...streams,
      {
        id: 'record',
        label: 'Recorder',
        roles: ['sink'],
        ports: [{ id: 'in', direction: 'in', label: 'Recorder', transport: ['rtmp'], maxLinks: 1 }],
        // No listMedia or deleteMedia: vMix has no file API at all. The
        // recordings are on a Windows PC and nothing here can see them,
        // let alone remove them, so retention is told the truth.
        supports: ['startRecording', 'stopRecording'],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId === 'record') return this.recorderActions()

    const channel = channelOf(nodeId)
    if (channel === undefined || channel >= this.streamChannels) return undefined
    return this.streamActions(channel)
  }

  private streamActions(channel: number): NodeActions {
    return {
      /**
       * Points one destination at a server and key.
       *
       * Both go in as `<channel>,<value>`. Without that prefix vMix
       * applies the value to the first destination, which on a machine
       * using two of them quietly sends both to the same place.
       */
      applyStreamTarget: async ({ url, key }) => {
        await this.send('StreamingSetURL', { Value: channelValue(channel, url) })
        await this.send('StreamingSetKey', { Value: channelValue(channel, key) })
        this.targets.set(channel, { url, key })
      },

      startStreaming: async () => {
        // 0-based, and only this destination: a bare StartStreaming starts
        // all five, which on a machine with a second destination
        // configured would put an unannounced stream on air.
        await this.send('StartStreaming', { Value: String(channel) })
      },
      stopStreaming: async () => {
        await this.send('StopStreaming', { Value: String(channel) })
      },

      readState: async () => this.streamState(channel),
    }
  }

  private recorderActions(): NodeActions {
    return {
      /**
       * Starts the recorder, and reports back the name vMix chose.
       *
       * The requested filename is not passed on because there is nowhere
       * to pass it: vMix has no function to set one, and builds the name
       * from its own Recording Settings. Sending it anywhere would be
       * pretending to a control this adapter does not have.
       */
      startRecording: async () => {
        await this.send('StartRecording')
      },
      stopRecording: async () => {
        await this.send('StopRecording')
      },

      readState: async () => this.recorderState(),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.connected = false
  }

  // -- state ----------------------------------------------------------------

  private async streamState(channel: number): Promise<NodeState> {
    const status = await this.refresh()
    const target = this.targets.get(channel)

    return {
      streaming: {
        active: status.channels[channel] === true,
        ...(target === undefined ? {} : { targetUrl: target.url }),
        ...(target?.key ? { keyFingerprint: fingerprint(target.key) } : {}),
      },
    }
  }

  private async recorderState(): Promise<NodeState> {
    const status = await this.refresh()
    const [first, second] = status.recordingFilenames

    return {
      recording: {
        active: status.recording,
        // Whatever vMix called it. Nothing asked it to use this name, and
        // the ledger wants the one on disk, not the one we wanted.
        ...(first === undefined ? {} : { filename: first }),
        ...(status.recordingSeconds === undefined
          ? {}
          : { durationMs: Math.round(status.recordingSeconds * 1000) }),
      },
      // vMix writes a second file in a second format when one is set up,
      // and the state contract holds one name. Surfacing it here beats
      // dropping it, since somebody looking for their archive copy needs
      // to know there are two of them.
      ...(second === undefined ? {} : { raw: { secondFile: second } }),
    }
  }

  private async refresh(): Promise<VmixStatus> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    try {
      this.status = await this.api.status()
      this.lastError = undefined
      return this.status
    } catch (error) {
      this.lastError = describe(error)
      if (error instanceof VmixApiError && error.status === 401) throw passwordError()
      throw new DeviceError(
        'command-failed',
        `vMix would not report its state: ${describe(error)}`,
        {
          retryable: true,
        },
      )
    }
  }

  private async send(fn: string, params: Record<string, string> = {}): Promise<void> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    try {
      await this.api.call(fn, params)
    } catch (error) {
      if (error instanceof DeviceError) throw error
      if (error instanceof VmixApiError && error.status === 401) throw passwordError()
      // The function name only. The parameters may be carrying a stream key,
      // and an error message is the easiest place in the world to leak one.
      throw new DeviceError(
        'command-failed',
        `vMix would not run ${redact(fn, params)}: ${describe(error)}`,
        { retryable: true },
      )
    }
  }
}

/** The same answer wherever the password bites, which is everywhere. */
function passwordError(): DeviceError {
  return new DeviceError(
    'auth-failed',
    'vMix refused the request: its Web Controller has a password set.',
    {
      remediation:
        'Turn off the Web Controller password in vMix → Settings → Web Controller, or reach vMix ' +
        'on a network where it is not needed. This adapter does not send one.',
    },
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface VmixPluginOptions {
  now?: () => number
  /** Injected in tests, which have no vMix to talk to. */
  createApi?: CreateVmixApi
}

export function vmixPlugin(options: VmixPluginOptions = {}): PluginDefinition {
  const now = options.now ?? (() => Date.now())
  const createApi = options.createApi ?? createVmixApi

  return {
    id: 'vmix',
    displayName: 'vMix',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '').trim()
      if (!host) throw new DeviceError('bad-config', 'vMix needs an address.')
      const port = Number(ctx.config.port ?? 8088)
      const channels = Math.min(
        MAX_STREAM_CHANNELS,
        Math.max(1, Math.floor(Number(ctx.config.streamChannels ?? 1)) || 1),
      )

      const device = new VmixDevice(ctx, createApi({ host, port }), host, port, channels, now)
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
