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
      { id: 'never-answers', label: 'Accepts commands and never answers' },
    ],
    default: 'none',
  },
  {
    type: 'number',
    id: 'cachePercent',
    label: 'Report this cache level',
    tooltip:
      'Pins the send cache, for seeing what a device falling behind looks like. Left unset it wanders the way real gear does.',
    min: 0,
    max: 100,
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
  /**
   * Takes the command and never resolves.
   *
   * What a HyperDeck does while it remounts a card it was told to format:
   * the socket stays open, the command is accepted, and no answer ever
   * comes. Nothing in JavaScript can cancel that promise, so every caller
   * above it has to have its own deadline — and this is how those get
   * tested without a deck.
   */
  | 'never-answers'

class MockDevice {
  private streaming = false
  private recording = false
  /** When each started, so the fake can age like a real device does. */
  private streamingSince: number | undefined
  private recordingSince: number | undefined
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
  /**
   * What is on the cards, in the order it was written.
   *
   * A real deck names a clip and remembers nothing about when it was made;
   * this keeps `recordedAt` because a fake that is harder to inspect than
   * the hardware helps nobody, and retention never reads it — the ledger
   * is where "when" comes from.
   */
  private clips: { name: string; slot: number; recordedAt: number; codec: string }[] = []
  private readonly connectedAt: number

  constructor(
    private readonly ctx: DeviceContext,
    private readonly kind: string,
    private readonly fault: Fault,
    private readonly now: () => number,
    /** Pins the cache reading, for exercising the falling-behind warning. */
    private readonly pinnedCache?: number,
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
        ports: [
          {
            id: 'in',
            direction: 'in',
            label: 'Record input',
            transport: ['sdi', 'hdmi'],
            maxLinks: 1,
          },
        ],
        supports: [
          'startRecording',
          'stopRecording',
          'selectSlot',
          'formatStorage',
          'listMedia',
          'deleteMedia',
        ],
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
          if (this.fault !== 'ignores-writes') {
            this.streaming = true
            this.streamingSince ??= this.now()
          }
          this.emit(nodeId)
        },
        stopStreaming: async () => {
          this.guard()
          this.streaming = false
          this.streamingSince = undefined
          this.emit(nodeId)
        },
        readState: async () =>
          this.fault === 'never-answers' ? this.hang() : this.stateOf(nodeId),
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
            this.recordingSince ??= this.now()
            this.filename = filename
            if (slot !== undefined) this.recordingSlot = slot
            // The card keeps what was written to it, the way a real one
            // does — which is what makes a retention report testable.
            this.clips.push({
              name: `${filename}.mov`,
              slot: slot ?? this.recordingSlot,
              recordedAt: this.now(),
              codec: 'ProRes422HQ',
            })
          }
          this.emit(nodeId)
        },
        stopRecording: async () => {
          this.guard()
          this.recording = false
          this.recordingSince = undefined
          this.emit(nodeId)
        },
        selectSlot: async ({ slot }) => {
          this.guard()
          if (this.fault !== 'ignores-writes') this.recordingSlot = slot
          this.emit(nodeId)
        },
        // Refuses while recording, the way a card in use does. The host
        // already refuses a sweep on a busy deck; this is the second line,
        // so a bug in the first one fails loudly rather than quietly
        // deleting off a card being written to.
        deleteMedia: async ({ name, slot }) => {
          this.guard()
          if (this.recording) {
            throw new DeviceError('busy', 'This device is recording and will not remove files.')
          }
          const before = this.clips.length
          this.clips = this.clips.filter(
            (clip) => !(clip.name === name && (slot === undefined || clip.slot === slot)),
          )
          if (this.clips.length === before) {
            throw new DeviceError('not-found', `There is no file called "${name}" on this device.`)
          }
        },
        listMedia: async ({ slot }) =>
          this.clips
            .filter((clip) => slot === undefined || clip.slot === slot)
            .filter((clip) => !this.blanked.has(clip.slot))
            .map((clip) => ({ ...clip })),
        // Two steps, like the deck this stands in for: preparing hands back
        // a token and erases nothing, and only that token erases the card.
        formatStorage: async ({ slot, confirm }) => {
          this.guard()
          if (confirm === undefined) {
            this.formatToken = { slot, token: `mock-token-${++this.formatCount}` }
            return { confirm: this.formatToken.token }
          }
          if (this.formatToken?.token !== confirm || this.formatToken.slot !== slot) {
            throw new DeviceError(
              'invalid-token',
              'That is not the confirmation this device handed out.',
              {
                remediation: 'Start the format again: the token is good for one erase of one slot.',
              },
            )
          }
          this.formatToken = undefined
          if (this.fault !== 'ignores-writes') {
            this.blanked.add(slot)
            this.clips = this.clips.filter((clip) => clip.slot !== slot)
          }
          this.emit(nodeId)
          return {}
        },
        readState: async () =>
          this.fault === 'never-answers' ? this.hang() : this.stateOf(nodeId),
      }
    }
    return undefined
  }

  async dispose(): Promise<void> {
    this.streaming = false
    this.recording = false
    this.streamingSince = undefined
    this.recordingSince = undefined
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
          ...(this.elapsed(this.recordingSince) === undefined
            ? {}
            : { durationMs: this.elapsed(this.recordingSince) }),
          // Falls as the recording runs, which is the point of watching it.
          remainingMs: Math.max(4 * 3_600_000 - (this.elapsed(this.recordingSince) ?? 0), 0),
          slots: [
            this.slot(
              1,
              'Sunday A',
              Math.max(4 * 3_600_000 - (this.elapsed(this.recordingSince) ?? 0), 0),
            ),
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
        // Wanders the way a real encoder's does, so a chart of it has a
        // shape. Deterministic in the clock, so a test that pins the clock
        // pins the number too.
        bitrateBps: this.streaming ? 6_000_000 + this.wobble(800_000) : 0,
        ...(this.elapsed(this.streamingSince) === undefined
          ? {}
          : { durationMs: this.elapsed(this.streamingSince) }),
      },
      // A send cache that mostly sits low and occasionally fills, which is
      // what an uplink under strain looks like — unless it has been pinned,
      // which is how the warning gets exercised without waiting for a bad
      // day.
      ...(this.streaming
        ? { cache: { percent: this.pinnedCache ?? Math.max(12 + this.wobble(10) / 1000, 0) } }
        : {}),
      options: { quality: { current: this.quality, choices: QUALITIES } },
    }
  }

  /** How long something has been going, or undefined if it is not. */
  private elapsed(since: number | undefined): number | undefined {
    return since === undefined ? undefined : Math.max(this.now() - since, 0)
  }

  /**
   * A slow wander, zero at the instant a thing starts.
   *
   * Zero at the start matters: a test that starts a stream and reads it
   * straight back gets the round number it asked for, and only a fake left
   * running long enough to be charted goes anywhere.
   */
  private wobble(amplitude: number): number {
    const seconds = (this.elapsed(this.streamingSince) ?? 0) / 1000
    return Math.round(Math.sin(seconds / 45) * amplitude)
  }

  /** Refuses a profile it does not have, as real gear does: the point of
   *  reading the choices off the device is that a name it never offered is
   *  a mistake, not a new profile. */
  private setQuality(quality: string): void {
    if (!QUALITIES.includes(quality)) {
      throw new DeviceError(
        'unknown-quality',
        `This device has no quality profile called "${quality}".`,
        {
          remediation: `It offers: ${QUALITIES.join(', ')}.`,
        },
      )
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

  /** Never resolves, for the fault of the same name. */
  private hang(): Promise<never> {
    return new Promise<never>(() => {})
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
        {
          label: 'Mock encoder',
          config: { host: 'mock-encoder.local', kind: 'encoder', fault: 'none' },
        },
        {
          label: 'Mock recorder',
          config: { host: 'mock-recorder.local', kind: 'recorder', fault: 'none' },
        },
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

      const pinnedCache =
        typeof ctx.config.cachePercent === 'number' ? ctx.config.cachePercent : undefined
      const impl = new MockDevice(ctx, kind, fault, now, pinnedCache)
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
