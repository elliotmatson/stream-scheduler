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
import { Commands, Hyperdeck, SlotStatus, TransportStatus } from 'hyperdeck-connection'

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

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip: 'The HyperDeck must be reachable on the control network.',
  },
  { type: 'number', id: 'port', label: 'Port', default: DEFAULT_PORT, min: 1, max: 65535 },
  {
    type: 'number',
    id: 'slot',
    label: 'Slot to record to',
    min: 1,
    max: 8,
    tooltip: 'Leave blank to use whichever slot the deck has selected.',
  },
]

/** How long to wait for the deck to answer on connect. */
const CONNECT_TIMEOUT_MS = 10_000

class HyperdeckDevice {
  private readonly deck = new Hyperdeck()
  private connectedAt = 0
  private lastError: string | undefined
  private model = 'HyperDeck'
  private slots = 1
  private disposed = false

  constructor(
    private readonly ctx: DeviceContext,
    private readonly host: string,
    private readonly port: number,
    private readonly slot: number | undefined,
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new DeviceError('connect-timeout', `${this.host}:${this.port} did not answer within 10 seconds.`, {
            retryable: true,
            remediation: 'Check the address, that the deck is powered on, and that TCP 9993 is reachable.',
          }),
        )
      }, CONNECT_TIMEOUT_MS)

      const onConnected = (info: { model: string; protocolVersion: number }): void => {
        cleanup()
        this.model = info.model
        this.connectedAt = this.now()
        resolve()
      }
      const onError = (message: string, error: unknown): void => {
        cleanup()
        reject(
          new DeviceError('connect-failed', `Could not reach ${this.host}:${this.port}: ${message}`, {
            retryable: true,
            cause: error,
          }),
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
    return {
      model: info.model,
      firmware: `protocol ${info.protocolVersion}`,
      // Probed, not assumed: what the deck reports is what the UI offers.
      features: ['recording', `slots:${info.slots}`],
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
          { id: 'in', direction: 'in', label: 'Record input', transport: ['sdi', 'hdmi'], maxLinks: 1 },
        ],
        supports: ['startRecording', 'stopRecording'],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId !== 'record') return undefined
    return {
      startRecording: async ({ filename }) => {
        if (this.slot !== undefined) {
          const select = new Commands.SlotSelectCommand()
          select.slotId = this.slot
          await this.send(select)
        }
        // The deck appends its own extension, and rejects some characters the
        // core sanitizer already removes.
        await this.send(new Commands.RecordCommand(filename))
      },
      stopRecording: async () => {
        await this.send(new Commands.StopCommand())
      },
      readState: async () => this.readState(),
    }
  }

  async readState(): Promise<NodeState> {
    const transport = await this.send(new Commands.TransportInfoCommand())
    const slot = await this.slotInfo(transport)

    return {
      recording: {
        active: transport.status === TransportStatus.RECORD,
        ...(transport.clipId === null ? {} : { filename: String(transport.clipId) }),
        // `recordingTime` is seconds of headroom left on the media, which is
        // the number an operator actually wants before a long service.
        ...(slot === undefined ? {} : { remainingMs: slot.recordingTime * 1000 }),
      },
      raw: {
        transportStatus: transport.status,
        timecode: transport.timecode,
        ...(transport.videoFormat === null ? {} : { videoFormat: transport.videoFormat }),
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
  ): Promise<{ slotId: number; status: SlotStatus; volumeName: string; recordingTime: number } | undefined> {
    const slotId = this.slot ?? transport.slotId ?? undefined
    if (slotId === undefined) return undefined
    try {
      return await this.send(new Commands.SlotInfoCommand(slotId))
    } catch {
      // An empty or unmounted slot answers with an error code. That is a
      // legitimate state to report, not a failure of readState.
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
    if (this.disposed) return
    try {
      this.ctx.emitState('record', await this.readState())
    } catch (error) {
      this.ctx.log('debug', 'could not read deck state after a notification', { error: describe(error) })
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
        remediation: 'Reformat the card in the deck; a card that errors mid-service loses the recording.',
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
      return new DeviceError('invalid-state', 'The HyperDeck cannot do that in its current state.', {
        retryable: true,
      })
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
      const slot = typeof ctx.config.slot === 'number' ? ctx.config.slot : undefined

      const device = new HyperdeckDevice(ctx, host, port, slot, now)
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
