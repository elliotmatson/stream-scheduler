import type { ConfigField, ConfigValues } from './config-fields.js'
import type { JsonObject, JsonValue } from './json.js'

/** What a node does in a pipeline. A node may hold several roles at once — an
 *  ATEM Mini Pro is both a `source` (hardware H.264 streamer) and a `router`
 *  (aux output). See docs/plan/02-domain-model.md. */
export type NodeRole = 'source' | 'router' | 'relay' | 'sink'

export type Transport = 'rtmp' | 'rtmps' | 'srt' | 'sdi' | 'hdmi' | 'ndi' | 'file'

export interface Port {
  id: string
  direction: 'in' | 'out'
  label: string
  transport: Transport[]
  /** An ATEM Mini Pro's stream output is 1. Fanning out past it needs a relay. */
  maxLinks: number
  requiresCredential?: 'stream-key' | 'none'
}

export interface NodeDefinition {
  id: string
  label: string
  roles: NodeRole[]
  ports: Port[]
  /** Which optional actions this node actually implements, so the host and UI
   *  can offer only what the hardware supports. Probed, never assumed. */
  supports: NodeAction[]
}

export type NodeAction =
  | 'applyStreamTarget'
  | 'startStreaming'
  | 'stopStreaming'
  | 'startRecording'
  | 'stopRecording'
  | 'route'

export interface StreamTarget {
  url: string
  key: string
}

/** One card, disk or slot a recorder can write to. */
export interface StorageSlot {
  id: number
  /** As the device reports it: 'mounted', 'empty', 'error', and so on. */
  status: string
  volumeName?: string
  remainingMs?: number
  /** True for the slot currently being written to. */
  active?: boolean
}

/** Read-back state. Never contains a secret: a key is reported as a fingerprint
 *  so the host can verify the right key landed without the value crossing back. */
export interface NodeState {
  streaming?: {
    active: boolean
    targetUrl?: string
    keyFingerprint?: string
    bitrateBps?: number
    durationMs?: number
  }
  recording?: {
    active: boolean
    filename?: string
    /** Headroom on the slot being recorded to. */
    remainingMs?: number
    /** Every slot the device has, so an operator can see the card they are
     *  about to fill and the one it would roll onto. */
    slots?: StorageSlot[]
    /** Whether the device continues onto another slot when this one fills.
     *  Absent when the device has no such notion. */
    rollover?: boolean
  }
  /**
   * What the device sees on its input.
   *
   * Worth reporting separately from whether it is recording: a deck with no
   * signal refuses to record, and finding that out from a failed command is
   * strictly worse than seeing it beforehand.
   */
  input?: {
    present: boolean
    /** As the device names it, e.g. '1080p50'. */
    format?: string
    /** Which input it is set to take, where the device has a choice. */
    source?: string
  }
  routing?: Record<string, string>
  raw?: JsonObject
}

export type HealthState = 'connected' | 'degraded' | 'disconnected' | 'unknown'

export interface HealthReport {
  state: HealthState
  message?: string
  /** Epoch ms this device entered `state`. */
  since: number
}

export interface DeviceCapabilities {
  /** Discovered on connect, not what the user picked in a dropdown. Firmware
   *  differences between ATEM models are real and probing is the only truth. */
  model: string
  firmware?: string
  features: string[]
}

/**
 * Host services available to a running device.
 *
 * Every method is async and takes serializable arguments, because in v2 these
 * become RPC calls into the parent process.
 */
export interface DeviceContext {
  deviceId: string
  /** Config with `secret` fields resolved to their plaintext values. */
  config: ConfigValues
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonObject): void
  /** Push telemetry (bitrate, transport state) to the host between polls. */
  emitState(nodeId: string, state: NodeState): void
  emitHealth(report: HealthReport): void
}

/**
 * The ergonomic authoring shape. Plugin authors implement this and hand it to
 * `defineDevice`, which turns it into the wire-shaped `DeviceInstance` below.
 */
export interface NodeActions {
  applyStreamTarget?(target: StreamTarget): Promise<void>
  startStreaming?(): Promise<void>
  stopStreaming?(): Promise<void>
  startRecording?(options: { filename: string }): Promise<void>
  stopRecording?(): Promise<void>
  route?(options: { input: string; output: string }): Promise<void>
  /** The host calls this after every write and compares. Blackmagic devices
   *  will accept a command and then ignore it; verify-after-write turns that
   *  from a showtime mystery into a prepare-phase failure. */
  readState(): Promise<NodeState>
}

export type InvokableAction = NodeAction | 'readState'

/**
 * What the host actually talks to.
 *
 * Note there is no method here that returns functions or takes a callback:
 * every call is `(serializable args) -> Promise<serializable>`. That is the
 * whole reason moving plugins into child processes in v2 is a transport swap
 * rather than a rewrite, so keep it that way.
 */
export interface DeviceInstance {
  probe(): Promise<DeviceCapabilities>
  health(): Promise<HealthReport>
  listNodes(): Promise<NodeDefinition[]>
  /** Returns `NodeState` for `readState`, and `null` for everything else. */
  invoke(nodeId: string, action: InvokableAction, args?: JsonObject): Promise<NodeState | null>
  dispose(): Promise<void>
}

export interface PluginDefinition {
  id: string
  displayName: string
  /** SDK major version. The host refuses to load a mismatch rather than
   *  failing in some subtler way later. */
  apiVersion: '1'
  configSchema: ConfigField[]
  /** Optional network discovery. Always optional — every device can be added
   *  by hand, because control VLANs routinely block multicast. */
  discover?(): Promise<DiscoveredDevice[]>
  createDevice(ctx: DeviceContext): Promise<DeviceInstance>
}

export interface DiscoveredDevice {
  label: string
  config: ConfigValues
  detail?: Record<string, JsonValue>
}

export const SDK_API_VERSION = '1' as const
