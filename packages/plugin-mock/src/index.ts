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
  StorageSlot,
  StreamTarget,
} from '@scheduler/plugin-sdk'

/**
 * A fake encoder and recorder.
 *
 * Exists for two reasons. It lets the whole scheduling engine be developed and
 * tested with no hardware, and it lets someone evaluate the app before buying
 * anything. The failure switches below are what make the error paths testable
 * at all — real gear will not fail on demand.
 */

const configSchema: ConfigField[] = [
  { type: 'textinput', id: 'host', label: 'Address', default: 'mock.local' },
  {
    type: 'dropdown',
    id: 'kind',
    label: 'Behaves like',
    choices: [
      { id: 'encoder', label: 'Streaming encoder' },
      { id: 'recorder', label: 'Disk recorder' },
      { id: 'both', label: 'Encoder and recorder' },
    ],
    default: 'both',
  },
  {
    type: 'dropdown',
    id: 'fault',
    label: 'Simulated fault',
    choices: [
      { id: 'none', label: 'None' },
      { id: 'unreachable', label: 'Refuses to connect' },
      { id: 'ignores-writes', label: 'Accepts commands and ignores them' },
      { id: 'flaky', label: 'Fails the first command after connecting' },
      { id: 'slow-to-settle', label: 'Takes a few reads to report a change' },
      { id: 'ignores-quality', label: 'Takes a quality profile and stays where it was' },
    ],
    default: 'none',
  },
  { type: 'secret', id: 'password', label: 'Password' },
]

/** Enough reads to fail a single-shot verify, few enough to settle well
 *  inside any caller's window. */
const SLOW_READS = 3

/** The profiles this fake encoder reports, in the way a real one does:
 *  named, read off the device, and the only names it will accept. */
const QUALITIES = ['low', 'standard', 'high']

type Fault =
  | 'none'
  | 'unreachable'
  | 'ignores-writes'
  | 'flaky'
  | 'slow-to-settle'
  /** Accepts everything and applies all of it but the quality. The nastiest
   *  kind of real failure: the stream comes up, at the wrong bitrate, and
   *  nothing says so unless the setting is read back. */
  | 'ignores-quality'

class MockDevice {
  private streaming = false
  private recording = false
  /** The card being written to. A deck records onto one slot at a time and
   *  an event may name which. */
  private recordingSlot = 1
  /** The encoder profile in force. Named, like a Streaming Encoder's — the
   *  numeric kind an ATEM takes is covered by that adapter's own tests. */
  private quality = 'standard'
  private target: StreamTarget | undefined
  private filename: string | undefined
  private commandCount = 0
  /**
   * Reads still owed before a change becomes visible, for `slow-to-settle`.
   *
   * This is what real hardware does and what the single-shot verify used to
   * trip over: an ATEM told to stream reports Idle for a moment, then
   * Connecting, then Streaming. Accepting the command and reflecting it are
   * two different events.
   */
  private settleReads = 0
  /** The token handed out by the last `format` prepare, if it has not been
   *  quoted back yet. */
  private formatToken: { slot: number; token: string } | undefined
  private formatCount = 0
  private readonly blanked = new Set<number>()
  private readonly connectedAt: number

  constructor(
    private readonly ctx: DeviceContext,
    private readonly kind: string,
    private readonly fault: Fault,
    private readonly now: () => number,
  ) {
    this.connectedAt = now()
  }

  capabilities(): DeviceCapabilities {
    const features = [
      ...(this.canStream ? ['streaming'] : []),
      ...(this.canRecord ? ['recording'] : []),
    ]
    return { model: `Mock ${this.kind}`, firmware: '1.0.0', features }
  }

  health(): HealthReport {
    return { state: 'connected', since: this.connectedAt }
  }

  nodes(): NodeDefinition[] {
    const nodes: NodeDefinition[] = []
    if (this.canStream) {
      nodes.push({
        id: 'stream',
        label: 'Mock stream output',
        roles: ['source'],
        ports: [
          {
            id: 'out',
            direction: 'out',
            label: 'Stream output',
            transport: ['rtmp', 'rtmps'],
            maxLinks: 1,
            requiresCredential: 'stream-key',
          },
        ],
        supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming'],
      })
    }
    if (this.canRecord) {
      nodes.push({
        id: 'record',
        label: 'Mock recorder',
        roles: ['sink'],
        ports: [{ id: 'in', direction: 'in', label: 'Record input', transport: ['sdi', 'hdmi'], maxLinks: 1 }],
        supports: ['startRecording', 'stopRecording', 'selectSlot', 'formatStorage'],
      })
    }
    return nodes
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId === 'stream' && this.canStream) {
      return {
        applyStreamTarget: async (target) => {
          this.guard()
          if (target.quality !== undefined) this.setQuality(target.quality)
          if (this.fault !== 'ignores-writes') this.target = target
        },
        startStreaming: async () => {
          this.guard()
          if (this.fault === 'slow-to-settle') this.settleReads = SLOW_READS
          if (!this.target) {
            throw new DeviceError('no-stream-target', 'No stream target has been applied.', {
              remediation: 'Push the ingest URL and key before starting the stream.',
            })
          }
          if (this.fault !== 'ignores-writes') this.streaming = true
          this.emit(nodeId)
        },
        stopStreaming: async () => {
          this.guard()
          this.streaming = false
          this.emit(nodeId)
        },
        readState: async () => this.stateOf(nodeId),
      }
    }
    if (nodeId === 'record' && this.canRecord) {
      return {
        startRecording: async ({ filename, slot, quality }) => {
          this.guard()
          if (quality !== undefined) this.setQuality(quality)
          if (this.fault === 'slow-to-settle') this.settleReads = SLOW_READS
          if (this.fault !== 'ignores-writes') {
            this.recording = true
            this.filename = filename
            if (slot !== undefined) this.recordingSlot = slot
          }
          this.emit(nodeId)
        },
        stopRecording: async () => {
          this.guard()
          this.recording = false
          this.emit(nodeId)
        },
        selectSlot: async ({ slot }) => {
          this.guard()
          if (this.fault !== 'ignores-writes') this.recordingSlot = slot
          this.emit(nodeId)
        },
        // Two steps, like the deck this stands in for: preparing hands back
        // a token and erases nothing, and only that token erases the card.
        formatStorage: async ({ slot, confirm }) => {
          this.guard()
          if (confirm === undefined) {
            this.formatToken = { slot, token: `mock-token-${++this.formatCount}` }
            return { confirm: this.formatToken.token }
          }
          if (this.formatToken?.token !== confirm || this.formatToken.slot !== slot) {
            throw new DeviceError('invalid-token', 'That is not the confirmation this device handed out.', {
              remediation: 'Start the format again: the token is good for one erase of one slot.',
            })
          }
          this.formatToken = undefined
          if (this.fault !== 'ignores-writes') this.blanked.add(slot)
          this.emit(nodeId)
          return {}
        },
        readState: async () => this.stateOf(nodeId),
      }
    }
    return undefined
  }

  async dispose(): Promise<void> {
    this.streaming = false
    this.recording = false
  }

  private get canStream(): boolean {
    return this.kind === 'encoder' || this.kind === 'both'
  }

  private get canRecord(): boolean {
    return this.kind === 'recorder' || this.kind === 'both'
  }

  private stateOf(nodeId: string): NodeState {
    if (nodeId === 'record') {
      return {
        recording: {
          active: this.settled(this.recording),
          ...(this.filename === undefined ? {} : { filename: this.filename }),
          remainingMs: 4 * 3_600_000,
          slots: [
            this.slot(1, 'Sunday A', 4 * 3_600_000),
            // Nearly full, so the low-space warning and rollover have
            // something to be about.
            this.slot(2, 'Sunday B', 40 * 60_000),
          ],
          rollover: true,
        },
        input: { present: true, format: '1080p50', source: 'SDI' },
        options: { quality: { current: this.quality, choices: QUALITIES } },
      }
    }
    return {
      streaming: {
        active: this.settled(this.streaming),
        ...(this.target === undefined
          ? {}
          : { targetUrl: this.target.url, keyFingerprint: fingerprint(this.target.key) }),
        bitrateBps: this.streaming ? 6_000_000 : 0,
      },
      options: { quality: { current: this.quality, choices: QUALITIES } },
    }
  }

  /** Refuses a profile it does not have, as real gear does: the point of
   *  reading the choices off the device is that a name it never offered is
   *  a mistake, not a new profile. */
  private setQuality(quality: string): void {
    if (!QUALITIES.includes(quality)) {
      throw new DeviceError('unknown-quality', `This device has no quality profile called "${quality}".`, {
        remediation: `It offers: ${QUALITIES.join(', ')}.`,
      })
    }
    if (this.fault !== 'ignores-writes' && this.fault !== 'ignores-quality') this.quality = quality
  }

  /** A card, blank if it has been formatted since the device connected. */
  private slot(id: number, volumeName: string, remainingMs: number): StorageSlot {
    const blank = this.blanked.has(id)
    return {
      id,
      status: 'mounted',
      volumeName: blank ? 'Untitled' : volumeName,
      remainingMs: blank ? 4 * 3_600_000 : remainingMs,
      ...(id === this.recordingSlot ? { active: true } : {}),
    }
  }

  /** Counts down `slow-to-settle`, so the Nth read is the one that agrees. */
  private settled(value: boolean): boolean {
    if (this.settleReads === 0) return value
    this.settleReads--
    return !value
  }

  private guard(): void {
    this.commandCount++
    // Models the common real failure: the first command after a connection
    // settles is rejected, and a retry succeeds. Failing on a repeating
    // pattern instead would make every retry land on a failure too, which is
    // a deterministic outage rather than flakiness.
    if (this.fault === 'flaky' && this.commandCount === 1) {
      throw new DeviceError('flaky', 'Simulated intermittent failure.', { retryable: true })
    }
  }

  private emit(nodeId: string): void {
    this.ctx.emitState(nodeId, this.stateOf(nodeId))
  }
}

export interface MockPluginOptions {
  /** Injected so tests are not at the mercy of the wall clock. */
  now?: () => number
}

export function mockPlugin(options: MockPluginOptions = {}): PluginDefinition {
  const now = options.now ?? Date.now
  return {
    id: 'mock',
    displayName: 'Mock device',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async discover() {
      return [
        { label: 'Mock encoder', config: { host: 'mock-encoder.local', kind: 'encoder', fault: 'none' } },
        { label: 'Mock recorder', config: { host: 'mock-recorder.local', kind: 'recorder', fault: 'none' } },
      ]
    },
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const kind = typeof ctx.config.kind === 'string' ? ctx.config.kind : 'both'
      const fault = (typeof ctx.config.fault === 'string' ? ctx.config.fault : 'none') as Fault

      if (fault === 'unreachable') {
        throw new DeviceError('unreachable', `Could not reach ${String(ctx.config.host)}.`, {
          retryable: true,
          remediation: 'Check the address and that the device is on the control network.',
        })
      }

      const impl = new MockDevice(ctx, kind, fault, now)
      return defineDevice({
        probe: async () => impl.capabilities(),
        health: async () => impl.health(),
        listNodes: async () => impl.nodes(),
        actionsFor: (nodeId) => impl.actionsFor(nodeId),
        dispose: () => impl.dispose(),
      })
    },
  }
}

