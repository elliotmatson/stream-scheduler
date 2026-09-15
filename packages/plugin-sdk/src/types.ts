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
  /** Puts the device on a particular card, ahead of recording to it. */
  | 'selectSlot'
  /** Erases a card or disk. Two-step by design; see `NodeActions`. */
  | 'formatStorage'

export interface StreamTarget {
  url: string
  key: string
  /** A quality profile the device named in `NodeState.options`. Absent
   *  leaves the device on whatever it is set to. */
  quality?: string
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
    /** How long this recording has been going, where the device counts it
     *  for itself. A deck does not, so the host falls back to when its own
     *  start step landed. */
    durationMs?: number
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
  /**
   * The device's own buffer, where it has one.
   *
   * Worth watching for the same reason on either side of the box: a send
   * cache filling up is a stream about to stall, and a write cache that
   * stops draining is a card about to refuse. Devices count it differently
   * — an ATEM and a Web Presenter report how full it is, a HyperDeck says
   * what it is doing and how much is waiting — so all three have somewhere
   * to put what they know rather than one being made to lie.
   */
  cache?: {
    /** How full, 0–100. */
    percent?: number
    /** As the device names it: 'ready', 'transferring', and so on. */
    status?: string
    /** Recording held in the cache, not yet written to the card. */
    bufferedMs?: number
  }
  routing?: Record<string, string>
  /**
   * Settings this node will accept, and what it is on now.
   *
   * Reported by the device rather than guessed, so an event offers the
   * profiles this encoder actually has rather than a free-text box whose
   * mistakes surface as an HTTP 400 at 09:00. Absent means the device
   * offers no choice, which is the common case.
   */
  options?: {
    /**
     * What the device will accept for its encoder quality.
     *
     * `current` is written in the same vocabulary as the `quality` a caller
     * passes in, so the two can be compared directly — that is what makes
     * verify-after-write possible for a setting whose spelling is the
     * device's own.
     */
    quality?: {
      current?: string
      /**
       * Other spellings of `current` that mean the same setting.
       *
       * A device may take a figure and a name for the same thing — an ATEM
       * on 6-9 Mb/s is on "Streaming High" — and whoever asked for it used
       * one or the other. Without this, a write asking in one vocabulary
       * would be read back in the other and called a failure.
       */
      aliases?: string[]
      /** Named profiles the device has. Empty when it takes a number. */
      choices: string[]
      /**
       * Set instead of `choices` by a device that takes a bitrate rather
       * than a profile name. An ATEM is the case: the named qualities in
       * ATEM Software Control live in a file on the computer, and the
       * switcher itself stores only the bitrate. `quality` is then a figure
       * in Mb/s — "9", or "7-9" for a range.
       */
      bitrate?: { minMbps: number; maxMbps: number; note?: string }
      /**
       * Set instead of either by a device that takes a name it cannot be
       * asked to list. A HyperDeck is the case: the record codec is set by
       * name over the protocol, but which codecs a given model has is not
       * something the protocol will answer, and the set differs by model and
       * firmware. `examples` are suggestions, not a contract — the device
       * refuses one it does not have, and says so.
       */
      freeform?: { note?: string; examples?: string[] }
    }
  }
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
  /** Ways to reach this device outside the app, if it offers any. */
  links?: DeviceLink[]
}

/**
 * Somewhere to go that this app does not do itself — a deck's file share,
 * a device's own web page.
 *
 * The plugin builds the address because only it knows the shape: which
 * protocol the device speaks, on which port, and whether it needs a path.
 */
export interface DeviceLink {
  label: string
  /** Complete and ready to paste, e.g. `ftp://10.0.0.5/`. */
  url: string
  /** Anything the address alone does not say — a login, or that a browser
   *  will not open it. */
  note?: string
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
  /** `slot` is which card or disk to write to, where the device has more
   *  than one. Absent means whichever it is already on. */
  startRecording?(options: { filename: string; slot?: number; quality?: string }): Promise<void>
  /** Put the device on a card without recording to it yet. A recording
   *  names its own slot; this is for an operator standing at the app. */
  selectSlot?(options: { slot: number }): Promise<void>
  stopRecording?(): Promise<void>
  route?(options: { input: string; output: string }): Promise<void>
  /**
   * Erases one slot.
   *
   * Destructive and irreversible, so the host asks twice over the wire as
   * well as in the UI: `confirm` absent means "prepare and tell me the
   * token", and calling again with that token is what actually erases. A
   * device whose protocol has no such handshake should do the work only
   * when `confirm` is present.
   */
  formatStorage?(options: { slot: number; confirm?: string }): Promise<{ confirm?: string }>
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
