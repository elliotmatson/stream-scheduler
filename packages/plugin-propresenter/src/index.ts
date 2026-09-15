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
  createProApi,
  destinationOf,
  ProApiError,
  rtmpTargetOf,
  targetKeyOf,
  type CreateProApi,
  type ProApi,
  type ProCaptureSettings,
  type ProCaptureStatus,
  type ProRtmpSettings,
  type ProVersion,
} from './api.js'

/**
 * ProPresenter 7.9+, over its HTTP API.
 *
 * The thing already running the service in most rooms, and the shape of
 * its capture is the whole story of this adapter.
 *
 * **It has one capture, not two outputs.** A deck and an encoder are two
 * boxes and this app drives them independently; ProPresenter has a single
 * pipeline whose settings decide whether it goes to disk, to an RTMP
 * server, or to Resi. Streaming and recording are therefore the *same*
 * start, and pointing two outputs of one event at this node would have the
 * second stop end the first one's capture. So the node reports one
 * capture, and "also keep a copy on this machine" is the `save_local`
 * option below rather than a second output.
 *
 * **A capture to disk cannot be swept.** `file_location` is documented as
 * a folder, never a filename; ProPresenter names the file and the status
 * endpoint never says what it called it. So there is nothing to put in the
 * ledger that would match the file, and `listMedia`/`deleteMedia` are
 * absent rather than half-implemented. Retention leaves these alone, which
 * is the honest answer and is stated on the node.
 *
 * **Writing a target is read-modify-write.** `PUT /v1/capture/settings`
 * requires the source screen and the audio routing, and this adapter is
 * not entitled to invent either. It reads what is there, changes the URL
 * and key, and puts it back.
 *
 * **Which of the three it goes to is not always readable.** ProPresenter's
 * own settings screen has a destination dropdown, but the published body
 * for these settings carries only the source, the audio routing and the
 * three sub-objects. So the adapter writes `destination` when the install
 * reports one, and otherwise remembers which way it last pointed the
 * capture. It will not read a leftover RTMP URL — every idle ProPresenter
 * has one — as evidence that a capture is streaming.
 */

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip:
      'The machine ProPresenter is running on. Its network API has to be switched on: ProPresenter → ' +
      'Settings → Network → Enable Network.',
  },
  {
    type: 'number',
    id: 'port',
    label: 'Port',
    default: 1025,
    min: 1,
    max: 65535,
    tooltip: 'The port from the same Network settings screen. 1025 by default.',
  },
  {
    type: 'checkbox',
    id: 'saveLocal',
    label: 'Keep a local copy while streaming',
    default: false,
    tooltip:
      'ProPresenter captures to one place at a time, so a stream and a recording cannot be two ' +
      'separate outputs here. This is how you get both: it streams and writes a copy to the folder ' +
      'below at the same time.',
  },
  {
    type: 'textinput',
    id: 'fileLocation',
    label: 'Folder for local copies',
    tooltip:
      'A folder on the ProPresenter machine, not this one. Leave blank to use whatever is already ' +
      'set in ProPresenter. ProPresenter names the file itself, so this scheduler cannot tidy these ' +
      'up later.',
  },
]

class ProPresenterDevice {
  private connectedAt = 0
  private connected = false
  private disposed = false
  private lastError: string | undefined
  /**
   * Which way this adapter last pointed the one capture.
   *
   * The fallback for the installs that do not report a destination. It is
   * honest as far as it goes: this adapter is the thing that pointed it,
   * so between the pointing and the stop nothing else has moved it —
   * unless somebody walked up to the machine, and the app's own
   * `destination` wins whenever it is there to win.
   */
  private pointedAt: 'disk' | 'rtmp' | undefined
  private version: ProVersion = {
    name: 'ProPresenter',
    platform: 'unknown',
    os_version: '',
    host_description: '',
    api_version: '',
  }

  constructor(
    private readonly ctx: DeviceContext,
    private readonly api: ProApi,
    private readonly host: string,
    private readonly port: number,
    private readonly saveLocal: boolean,
    private readonly fileLocation: string | undefined,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    try {
      this.version = (await this.api.request<ProVersion>('GET', '/version')) ?? this.version
    } catch (error) {
      throw new DeviceError(
        'unreachable',
        `Could not reach ProPresenter at ${this.host}:${this.port}: ${describe(error)}`,
        {
          retryable: true,
          remediation:
            'Check ProPresenter is open, that Settings → Network → Enable Network is on, and that ' +
            'the port matches. The API needs ProPresenter 7.9 or newer.',
        },
      )
    }
    this.connected = true
    this.connectedAt = this.now()
    this.lastError = undefined
  }

  async probe(): Promise<DeviceCapabilities> {
    return {
      // What the operator named the machine, which is what they will
      // recognise in a list — "Main sanctuary Pro7 machine".
      model: this.version.name || 'ProPresenter',
      firmware:
        `API ${this.version.api_version} on ${this.version.platform} ${this.version.os_version}`.trim(),
      features: ['streaming', 'recording'],
      links: [
        {
          label: 'ProPresenter API',
          url: `http://${this.host}:${this.port}/`,
          note: 'The machine’s own API root, for checking it is answering at all.',
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
    return [
      {
        id: 'capture',
        label: 'ProPresenter capture',
        // Both, and deliberately one node: the same pipeline does either.
        roles: ['source', 'sink'],
        ports: [
          { id: 'out', direction: 'out', label: 'Capture', transport: ['rtmp'], maxLinks: 1 },
        ],
        // No listMedia or deleteMedia. ProPresenter takes a folder and
        // names the file itself, and never reports the name, so there is
        // nothing retention could match or remove. Saying so is better
        // than implying it can tidy up.
        supports: [
          'applyStreamTarget',
          'startStreaming',
          'stopStreaming',
          'startRecording',
          'stopRecording',
        ],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId !== 'capture') return undefined

    return {
      /**
       * Points the capture at an RTMP server, keeping everything else.
       *
       * Read-modify-write because the settings body requires the source
       * screen and the audio routing, which belong to whoever set the
       * machine up. Changing the destination is this app's business;
       * deciding what ProPresenter captures is not.
       */
      applyStreamTarget: async ({ url, key, quality }) => {
        const settings = await this.settings()
        const rtmp: ProRtmpSettings = { ...(settings.rtmp ?? {}) }

        // The spec names this field `url` and its examples name it
        // `server`. Whichever the app is already using is the one it
        // understands, so that is the one written back.
        const field = targetKeyOf(settings.rtmp)
        delete rtmp.url
        delete rtmp.server
        rtmp[field] = url

        rtmp.key = key
        if (quality) rtmp.encoding = quality
        rtmp.save_local = this.saveLocal
        if (this.saveLocal) {
          const folder = this.fileLocation ?? rtmp.file_location ?? settings.disk?.file_location
          if (!folder) {
            throw new DeviceError(
              'bad-config',
              'This ProPresenter is set to keep a local copy, but no folder is configured for it.',
              {
                remediation:
                  'Set a folder on the device, or set one in ProPresenter’s own capture settings, ' +
                  'or turn off "Keep a local copy while streaming".',
              },
            )
          }
          rtmp.file_location = folder
        }

        await this.write({ ...settings, rtmp }, 'rtmp')
      },

      startStreaming: async () => {
        await this.capture('start')
      },
      stopStreaming: async () => {
        await this.capture('stop')
      },

      /**
       * Records to disk. The same single capture, pointed at a folder.
       *
       * The filename is ignored because there is nowhere to put it:
       * ProPresenter takes a folder and names the file itself. Nothing
       * downstream can match it afterwards, which is why this node does
       * not claim to list or delete media.
       */
      startRecording: async () => {
        const settings = await this.settings()
        const folder = this.fileLocation ?? settings.disk?.file_location
        if (!folder) {
          throw new DeviceError('bad-config', 'ProPresenter has no folder set to capture into.', {
            remediation:
              'Set a folder on the device, or pick one in ProPresenter under its own capture settings.',
          })
        }
        await this.write(
          { ...settings, disk: { ...(settings.disk ?? {}), file_location: folder } },
          'disk',
        )
        await this.capture('start')
      },
      stopRecording: async () => {
        await this.capture('stop')
      },

      readState: async () => this.state(),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.connected = false
  }

  // -- the capture ---------------------------------------------------------

  private async capture(operation: 'start' | 'stop'): Promise<void> {
    await this.send('GET', `/v1/capture/${operation}`)
  }

  private async settings(): Promise<ProCaptureSettings> {
    return (await this.send<ProCaptureSettings>('GET', '/v1/capture/settings')) ?? {}
  }

  /**
   * Puts settings back, saying where the capture should go.
   *
   * `destination` is only written when the install already reports one:
   * inventing a field this firmware does not have is how a settings PUT
   * gets rejected wholesale, taking the source screen with it.
   */
  private async write(settings: ProCaptureSettings, towards: 'disk' | 'rtmp'): Promise<void> {
    if (!settings.source) {
      throw new DeviceError(
        'bad-config',
        'ProPresenter has no capture source set, so there is nothing to point anywhere.',
        {
          remediation:
            'Open ProPresenter’s own capture settings and choose the screen to capture, once. ' +
            'This scheduler changes where a capture goes, not what it captures.',
        },
      )
    }
    await this.send('PUT', '/v1/capture/settings', {
      ...settings,
      ...(settings.destination === undefined ? {} : { destination: towards }),
    })
    this.pointedAt = towards
  }

  private async state(): Promise<NodeState> {
    const [status, settings] = await Promise.all([
      this.send<ProCaptureStatus>('GET', '/v1/capture/status'),
      this.send<ProCaptureSettings>('GET', '/v1/capture/settings').catch(() => undefined),
    ])
    const capturing = status?.capturing === true
    const rtmp = settings?.rtmp
    const target = rtmpTargetOf(rtmp)
    const durationMs = parseClock(status?.capture_time)

    // Where it is going, in order of how much the answer is worth: what
    // the app says, then what this adapter last told it, then the only
    // guess left. A configured URL is the weakest of the three because
    // ProPresenter keeps the last one forever.
    const where = destinationOf(settings) ?? this.pointedAt ?? (target ? 'rtmp' : 'disk')

    // One capture reported on both halves of the state, because that is
    // what it is: a stream to RTMP with save_local on is genuinely both,
    // and a screen showing only one of them would be hiding the other.
    const streamingOut = capturing && where !== 'disk'
    const savingLocally = capturing && (where === 'disk' || rtmp?.save_local === true)

    return {
      streaming: {
        active: streamingOut,
        ...(target === undefined || where === 'disk' ? {} : { targetUrl: target }),
        ...(rtmp?.key && where !== 'disk' ? { keyFingerprint: fingerprint(rtmp.key) } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      recording: {
        active: savingLocally,
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      ...(rtmp?.encoding === undefined
        ? {}
        : { options: { quality: { current: rtmp.encoding, choices: [] } } }),
    }
  }

  private async send<T>(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    try {
      return await this.api.request<T>(method, path, body)
    } catch (error) {
      if (error instanceof DeviceError) throw error
      if (error instanceof ProApiError && error.status === 404) {
        // The one failure worth naming precisely: this API arrived in 7.9,
        // and an older ProPresenter answers a 404 rather than anything
        // that explains itself.
        throw new DeviceError(
          'unsupported',
          `ProPresenter does not have ${path}. This needs ProPresenter 7.9 or newer.`,
        )
      }
      throw new DeviceError('command-failed', `ProPresenter refused ${path}: ${describe(error)}`, {
        retryable: true,
      })
    }
  }
}

/** `hh:mm:ss` as milliseconds. ProPresenter reports elapsed capture time
 *  this way and nothing else in the app speaks it. */
function parseClock(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parts = value.split(':').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined
  const [hours, minutes, seconds] = parts as [number, number, number]
  return ((hours * 60 + minutes) * 60 + seconds) * 1000
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ProPresenterPluginOptions {
  now?: () => number
  /** Injected in tests, which have no ProPresenter to talk to. */
  createApi?: CreateProApi
}

export function propresenterPlugin(options: ProPresenterPluginOptions = {}): PluginDefinition {
  const now = options.now ?? (() => Date.now())
  const createApi = options.createApi ?? createProApi

  return {
    id: 'propresenter',
    displayName: 'ProPresenter',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '').trim()
      if (!host) throw new DeviceError('bad-config', 'ProPresenter needs an address.')
      const port = Number(ctx.config.port ?? 1025)
      const saveLocal = ctx.config.saveLocal === true
      const folder = String(ctx.config.fileLocation ?? '').trim()

      const device = new ProPresenterDevice(
        ctx,
        createApi({ host, port }),
        host,
        port,
        saveLocal,
        folder === '' ? undefined : folder,
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
