import { defineDevice, DeviceError, SDK_API_VERSION } from '@scheduler/plugin-sdk'
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
  Commands,
  FilesystemFormat,
  Hyperdeck,
  SlotStatus,
  TransportStatus,
} from 'hyperdeck-connection'

/**
 * Blackmagic HyperDeck Studio / Extreme / Shuttle.
 *
 * Speaks the documented HyperDeck Ethernet Protocol on TCP 9993 via the Sofie
 * project's `hyperdeck-connection`. This is the recording half of the product.
 *
 * The protocol is unauthenticated and unencrypted; that is the device's
 * design, not something this adapter can fix. Put the gear on a trusted
 * control VLAN.
 */

export const DEFAULT_PORT = 9993

/**
 * Codecs to suggest, not a list of what any particular deck has.
 *
 * These are the spellings in Blackmagic's own protocol documentation. A
 * given model has some subset and newer firmware adds more, and there is no
 * command that answers "what do you support", so this is offered alongside
 * whatever the deck reports it is on — which is always a valid answer.
 */
const KNOWN_FILE_FORMATS = [
  'H.264High',
  'H.264Medium',
  'H.264Low',
  'H.265High',
  'H.265Medium',
  'H.265Low',
  'QuickTimeProResHQ',
  'QuickTimeProRes',
  'QuickTimeProResLT',
  'QuickTimeProResProxy',
  'QuickTimeDNxHR220',
  'DNxHR220',
  'QuickTimeUncompressed',
]

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip: 'The HyperDeck must be reachable on the control network.',
  },
  { type: 'number', id: 'port', label: 'Port', default: DEFAULT_PORT, min: 1, max: 65535 },
  // No slot or codec here. Both are per-recording rather than per-device —
  // an event names them, and an event that names neither leaves the deck on
  // whatever it is set to.
]

/** How long to wait for the deck to answer on connect. */
const CONNECT_TIMEOUT_MS = 10_000

class HyperdeckDevice {
  private readonly deck = new Hyperdeck()
  private connectedAt = 0
  private lastError: string | undefined
  private model = 'HyperDeck'
  private slots = 1
  /** What the deck answered at the handshake, for the diagnostics. */
  private protocolVersion = 0
  private disposed = false
  /**
   * Guards against a state read feeding itself.
   *
   * The deck pushes `notify.slot`, and reading every slot is itself slot
   * traffic, so an unguarded emit triggers the notification that triggers
   * the next emit. That is not a slow loop: each pass issues a round trip
   * per slot, and the pending work grows faster than it drains.
   */
  private emitting = false
  /** The deck's own configuration, which changes about never. Read once
   *  rather than on every state read. */
  private config: Commands.ConfigurationCommandResponse | undefined

  constructor(
    private readonly ctx: DeviceContext,
    private readonly host: string,
    private readonly port: number,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new DeviceError(
            'connect-timeout',
            `${this.host}:${this.port} did not answer within 10 seconds.`,
            {
              retryable: true,
              remediation:
                'Check the address, that the deck is powered on, and that TCP 9993 is reachable.',
            },
          ),
        )
      }, CONNECT_TIMEOUT_MS)

      const onConnected = (info: { model: string; protocolVersion: number }): void => {
        cleanup()
        this.model = info.model
        this.protocolVersion = info.protocolVersion
        this.connectedAt = this.now()
        resolve()
      }
      const onError = (message: string, error: unknown): void => {
        cleanup()
        reject(
          new DeviceError(
            'connect-failed',
            `Could not reach ${this.host}:${this.port}: ${message}`,
            {
              retryable: true,
              cause: error,
            },
          ),
        )
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        this.deck.off('connected', onConnected)
        this.deck.off('error', onError)
      }

      this.deck.on('connected', onConnected)
      this.deck.on('error', onError)
      this.deck.connect(this.host, this.port)
    })

    // Errors after the handshake are health signals, not connection failures.
    this.deck.on('error', (message: string) => {
      this.lastError = message
      this.ctx.log('warn', 'hyperdeck reported an error', { message })
    })
    this.deck.on('disconnected', () => {
      this.lastError = 'The deck closed the connection.'
      this.ctx.emitHealth(this.health())
    })

    // Ask the deck to push transport and slot changes rather than polling it:
    // a recording that stops because the media filled up should surface
    // immediately, not at the next health tick.
    const notify = new Commands.NotifySetCommand()
    notify.transport = true
    notify.slot = true
    await this.deck.sendCommand(notify).catch((error: unknown) => {
      // Older firmware may not support every notification; losing push
      // updates is a degradation, not a reason to refuse the device.
      this.ctx.log('warn', 'could not subscribe to deck notifications', { error: describe(error) })
    })

    this.deck.on('notify.transport', () => void this.emit())
    this.deck.on('notify.slot', () => void this.emit())
  }

  async probe(): Promise<DeviceCapabilities> {
    const info = await this.send(new Commands.DeviceInfoCommand())
    this.model = info.model
    this.slots = info.slots
    this.protocolVersion = info.protocolVersion
    return {
      model: info.model,
      firmware: `protocol ${info.protocolVersion}`,
      // Probed, not assumed: what the deck reports is what the UI offers.
      features: ['recording', `slots:${info.slots}`],
      links: [
        {
          // Every networked HyperDeck serves its media over FTP with an
          // anonymous login, which is how a recording gets off the deck
          // without walking over to it with a card reader.
          label: 'Recordings (FTP)',
          url: `ftp://${this.host}/`,
          note: 'Log in anonymously. Browsers stopped opening ftp:// links, so paste this into Finder, Explorer or an FTP client.',
        },
      ],
    }
  }

  health(): HealthReport {
    // A disposed device is not connected, whatever the library's flag says.
    if (this.disposed || !this.deck.connected) {
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
        id: 'record',
        label: `${this.model} recorder`,
        roles: ['sink'],
        ports: [
          {
            id: 'in',
            direction: 'in',
            label: 'Record input',
            transport: ['sdi', 'hdmi'],
            maxLinks: 1,
          },
        ],
        supports: ['startRecording', 'stopRecording', 'selectSlot', 'formatStorage'],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId !== 'record') return undefined
    return {
      startRecording: async ({ filename, slot, quality }) => {
        if (slot !== undefined) {
          const select = new Commands.SlotSelectCommand()
          select.slotId = slot
          await this.send(select)
        }
        // A deck's quality is its recording codec, set on the deck rather
        // than carried with the record command, so it goes first.
        if (quality !== undefined) await this.setFileFormat(quality)
        try {
          // The deck appends its own extension, and rejects some characters
          // the core sanitizer already removes.
          await this.send(new Commands.RecordCommand(filename))
        } catch (error) {
          throw await this.explain(error)
        }
      },
      stopRecording: async () => {
        await this.send(new Commands.StopCommand())
      },
      selectSlot: async ({ slot }) => {
        const select = new Commands.SlotSelectCommand()
        select.slotId = slot
        await this.send(select)
      },
      /**
       * Erases a card. The deck's own protocol is a handshake — `format
       * prepare` answers with a token and nothing happens until `format
       * confirm` quotes it back — so this mirrors that rather than
       * inventing its own confirmation. The token is short-lived, which
       * is the point: an operator who wanders off does not leave a live
       * erase primed.
       */
      formatStorage: async ({ slot, confirm }) => {
        if (confirm) {
          const command = new Commands.FormatConfirmCommand()
          command.code = confirm
          await this.send(command)
          // The volume name and headroom both change; nothing cached
          // about the slot is true any more.
          return {}
        }
        const prepare = new Commands.FormatCommand()
        prepare.slotId = slot
        prepare.filesystem = FilesystemFormat.exFAT
        const { code } = await this.send(prepare)
        return { confirm: code }
      },
      readState: async () => this.readState(),
    }
  }

  async readState(): Promise<NodeState> {
    const transport = await this.send(new Commands.TransportInfoCommand())
    const slot = await this.slotInfo(transport)
    const slots = await this.allSlots(transport)
    const config = await this.configuration()

    return {
      recording: {
        active: transport.status === TransportStatus.RECORD,
        // No filename: `clip id` is an index into the deck's timeline, not a
        // name, and showing "40" where an operator expects "Sunday Service"
        // reads as a bug. The name lives in the clip list, which is a
        // round trip this path does not need; the index goes in `raw`.
        // `recordingTime` is seconds of headroom left on the media, which is
        // the number an operator actually wants before a long service.
        ...(slot === undefined ? {} : { remainingMs: slot.recordingTime * 1000 }),
        ...(slots.length === 0 ? {} : { slots }),
        // The deck spills onto the next mounted slot on its own when the
        // current one fills; there is no setting to read, only whether
        // there is somewhere for it to go.
        rollover: slots.filter((entry) => entry.status === SlotStatus.MOUNTED).length > 1,
      },
      // A deck's quality is the codec it records in. It takes one by name
      // and will not say which names it knows, so the current one is
      // reported as fact and the rest offered as suggestions.
      ...(config?.fileFormat === undefined
        ? {}
        : {
            options: {
              quality: {
                current: config.fileFormat,
                choices: [],
                freeform: {
                  note: 'The recording codec, spelled as the deck spells it.',
                  examples: KNOWN_FILE_FORMATS,
                },
              },
            },
          }),
      // `inputVideoFormat` is what the deck sees on the wire, as opposed to
      // `videoFormat`, which is the format of the clip it is on.
      input: {
        present: transport.inputVideoFormat !== null && transport.inputVideoFormat !== undefined,
        ...(transport.inputVideoFormat ? { format: String(transport.inputVideoFormat) } : {}),
        ...(config?.videoInput ? { source: config.videoInput } : {}),
      },
      raw: {
        transportStatus: transport.status,
        timecode: transport.timecode,
        protocolVersion: this.protocolVersion,
        ...(transport.clipId === null ? {} : { clipId: transport.clipId }),
        ...(transport.videoFormat === null ? {} : { videoFormat: transport.videoFormat }),
        ...(transport.inputVideoFormat == null
          ? {}
          : { inputVideoFormat: transport.inputVideoFormat }),
        ...(config === undefined
          ? {}
          : {
              videoInput: config.videoInput,
              audioInput: config.audioInput,
              fileFormat: config.fileFormat,
            }),
        ...(slot === undefined
          ? {}
          : { slotId: slot.slotId, slotStatus: slot.status, volumeName: slot.volumeName }),
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // Stop listeners first so a disconnect event during teardown does not
    // emit health for a device the host has already let go.
    this.deck.removeAllListeners()
    // A deck that has already vanished can leave disconnect() pending
    // forever, and shutdown must not hang on a device that is not there.
    await Promise.race([
      this.deck.disconnect().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])
  }

  private async slotInfo(
    transport: Commands.TransportInfoCommandResponse,
  ): Promise<
    { slotId: number; status: SlotStatus; volumeName: string; recordingTime: number } | undefined
  > {
    const slotId = transport.slotId ?? undefined
    if (slotId === undefined) return undefined
    try {
      return await this.send(new Commands.SlotInfoCommand(slotId))
    } catch {
      // An empty or unmounted slot answers with an error code. That is a
      // legitimate state to report, not a failure of readState.
      return undefined
    }
  }

  /**
   * Turns a refusal into something with the deck's own evidence attached.
   *
   * "No video input" from a deck that visibly has a feed is a dead end for
   * whoever is holding it at 08:40. Asking the deck what it thinks it is
   * looking at — which input it is set to, and what format it sees there —
   * turns that into a fact. The extra round trip only happens on the
   * failure path.
   */
  private async explain(error: unknown): Promise<DeviceError> {
    // `send` has already translated this. Running it through again would
    // look for a numeric protocol code on a DeviceError, not find one, and
    // flatten every specific diagnosis back to a generic failure.
    const translated = error instanceof DeviceError ? error : toDeviceError(error)
    if (translated.code !== 'no-input') return translated

    let seen = 'the deck did not say what it is looking at'
    try {
      const transport = await this.send(new Commands.TransportInfoCommand())
      const config = await this.configuration()
      const source = config?.videoInput
        ? `set to record from ${config.videoInput}`
        : 'input setting unknown'
      seen = transport.inputVideoFormat
        ? // The interesting case: the deck refuses and yet reports a signal.
          `${source}, and reports ${transport.inputVideoFormat} on its input`
        : `${source}, and reports no signal there`
    } catch {
      // The deck is refusing commands generally; the original error stands.
    }

    return new DeviceError('no-input', `The HyperDeck will not record: it is ${seen}.`, {
      retryable: true,
      remediation:
        'Check the feed into the deck and that its video input setting matches the socket it is plugged ' +
        'into — a deck set to SDI ignores an HDMI feed and calls it no input. The format has to be one ' +
        'the deck supports at its current setting, too. If the deck reports a format above and still ' +
        'refuses, the refusal is about something else and is worth reporting.',
    })
  }

  /** Every slot the deck has, so the UI can show the card it would roll onto. */
  private async allSlots(
    transport: Commands.TransportInfoCommandResponse,
  ): Promise<
    { id: number; status: string; volumeName?: string; remainingMs?: number; active?: boolean }[]
  > {
    const out: {
      id: number
      status: string
      volumeName?: string
      remainingMs?: number
      active?: boolean
    }[] = []
    for (let id = 1; id <= this.slots; id++) {
      try {
        const info = await this.send(new Commands.SlotInfoCommand(id))
        out.push({
          id,
          status: String(info.status),
          ...(info.volumeName ? { volumeName: info.volumeName } : {}),
          remainingMs: info.recordingTime * 1000,
          active: transport.slotId === id,
        })
      } catch {
        // An empty slot answers with an error code. Reporting it as empty is
        // the useful answer; dropping it would hide the card you can put in.
        out.push({ id, status: 'empty', active: transport.slotId === id })
      }
    }
    return out
  }

  /**
   * Put the deck on a recording codec.
   *
   * Which codecs a deck has depends on its model and firmware, and the
   * protocol will not list them, so this cannot be checked before it is
   * sent. A deck that does not have the one asked for refuses, and the
   * refusal is turned into something that names both the codec and what the
   * deck is on now — the alternative is a bare "unsupported parameter" at
   * the moment a service starts.
   */
  private async setFileFormat(fileFormat: string): Promise<void> {
    const before = (await this.configuration())?.fileFormat
    const command = new Commands.ConfigurationCommand()
    command.fileFormat = fileFormat
    try {
      await this.send(command)
    } catch (error) {
      const translated = error instanceof DeviceError ? error : toDeviceError(error)
      throw new DeviceError(
        'unknown-quality',
        `This HyperDeck will not record as "${fileFormat}"${before ? `; it is on ${before}` : ''}.`,
        {
          cause: error,
          retryable: translated.retryable,
          remediation:
            'Codecs differ by model and firmware, and the deck does not publish its list. Set the one ' +
            'you want on the deck itself, read it back here, and use that spelling.',
        },
      )
    }
    // The cached read is now a lie, and the next state read is what proves
    // the deck took it.
    this.config = undefined
  }

  /** What the deck is set to record *from*. Older firmware may not answer. */
  private async configuration(): Promise<Commands.ConfigurationCommandResponse | undefined> {
    if (this.config) return this.config
    try {
      this.config = await this.send(new Commands.ConfigurationGetCommand())
      return this.config
    } catch {
      return undefined
    }
  }

  private async send<T>(command: Commands.AbstractCommand<T>): Promise<T> {
    if (this.disposed) throw new DeviceError('disposed', 'This device has been closed.')
    try {
      return await this.deck.sendCommand(command)
    } catch (error) {
      throw toDeviceError(error)
    }
  }

  private async emit(): Promise<void> {
    if (this.disposed || this.emitting) return
    this.emitting = true
    try {
      this.ctx.emitState('record', await this.readState())
    } catch (error) {
      this.ctx.log('debug', 'could not read deck state after a notification', {
        error: describe(error),
      })
    } finally {
      this.emitting = false
    }
  }
}

/**
 * Turns a protocol error code into something an operator can act on.
 *
 * "104" on a Sunday morning is useless; "the media is full" is not.
 */
function toDeviceError(error: unknown): DeviceError {
  const code = errorCodeOf(error)
  switch (code) {
    case 104:
      return new DeviceError('disk-full', 'The HyperDeck media is full.', {
        remediation: 'Swap or format the card before the event.',
      })
    case 105:
      return new DeviceError('no-disk', 'The HyperDeck has no media in the selected slot.', {
        remediation: 'Insert media, or point the device at the slot that has it.',
      })
    case 106:
      return new DeviceError('disk-error', 'The HyperDeck reported a media error.', {
        remediation:
          'Reformat the card in the deck; a card that errors mid-service loses the recording.',
      })
    case 110:
      return new DeviceError('no-input', 'The HyperDeck has no video input.', {
        retryable: true,
        remediation: 'Check the SDI or HDMI feed into the deck.',
      })
    case 111:
      return new DeviceError('remote-disabled', 'The HyperDeck has remote control disabled.', {
        remediation: 'Enable remote on the deck (the REM button, or Setup > Remote).',
      })
    case 150:
      return new DeviceError(
        'invalid-state',
        'The HyperDeck cannot do that in its current state.',
        {
          retryable: true,
        },
      )
    default:
      return new DeviceError('hyperdeck-error', describe(error), { retryable: true })
  }
}

function errorCodeOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'number') return code
    if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  }
  return undefined
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
    return JSON.stringify(error)
  }
  return String(error)
}

export interface HyperdeckPluginOptions {
  now?: () => number
}

export function hyperdeckPlugin(options: HyperdeckPluginOptions = {}): PluginDefinition {
  const now = options.now ?? Date.now
  return {
    id: 'hyperdeck',
    displayName: 'Blackmagic HyperDeck',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '')
      if (!host) throw new DeviceError('no-host', 'This HyperDeck has no address configured.')
      const port = typeof ctx.config.port === 'number' ? ctx.config.port : DEFAULT_PORT

      const device = new HyperdeckDevice(ctx, host, port, now)
      await device.connect()

      return defineDevice({
        probe: () => device.probe(),
        health: async () => device.health(),
        listNodes: async () => device.nodes(),
        actionsFor: (nodeId) => device.actionsFor(nodeId),
        dispose: () => device.dispose(),
      })
    },
  }
}

export { SlotStatus, TransportStatus }
