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
    ],
    default: 'none',
  },
  { type: 'secret', id: 'password', label: 'Password' },
]

type Fault = 'none' | 'unreachable' | 'ignores-writes' | 'flaky'

class MockDevice {
  private streaming = false
  private recording = false
  private target: StreamTarget | undefined
  private filename: string | undefined
  private routes: Record<string, string> = {}
  private commandCount = 0
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
      'routing',
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
        supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming', 'route'],
      })
    }
    if (this.canRecord) {
      nodes.push({
        id: 'record',
        label: 'Mock recorder',
        roles: ['sink'],
        ports: [{ id: 'in', direction: 'in', label: 'Record input', transport: ['sdi', 'hdmi'], maxLinks: 1 }],
        supports: ['startRecording', 'stopRecording'],
      })
    }
    return nodes
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId === 'stream' && this.canStream) {
      return {
        applyStreamTarget: async (target) => {
          this.guard()
          if (this.fault !== 'ignores-writes') this.target = target
        },
        startStreaming: async () => {
          this.guard()
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
        route: async ({ input, output }) => {
          this.guard()
          this.routes[output] = input
        },
        readState: async () => this.stateOf(nodeId),
      }
    }
    if (nodeId === 'record' && this.canRecord) {
      return {
        startRecording: async ({ filename }) => {
          this.guard()
          if (this.fault !== 'ignores-writes') {
            this.recording = true
            this.filename = filename
          }
          this.emit(nodeId)
        },
        stopRecording: async () => {
          this.guard()
          this.recording = false
          this.emit(nodeId)
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
          active: this.recording,
          ...(this.filename === undefined ? {} : { filename: this.filename }),
          remainingMs: 4 * 3_600_000,
        },
      }
    }
    return {
      streaming: {
        active: this.streaming,
        ...(this.target === undefined
          ? {}
          : { targetUrl: this.target.url, keyFingerprint: fingerprint(this.target.key) }),
        bitrateBps: this.streaming ? 6_000_000 : 0,
      },
      routing: { ...this.routes },
    }
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

