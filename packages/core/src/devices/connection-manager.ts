import {
  applyConfigDefaults,
  VerificationError,
  withSerializingTransport,
} from '@scheduler/plugin-sdk'
import type {
  Clock,
  ConfigValues,
  DeviceCapabilities,
  DeviceContext,
  DeviceInstance,
  HealthReport,
  InvokableAction,
  JsonObject,
  NodeDefinition,
  NodeState,
} from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SecretVault } from '../secrets/vault.js'

export interface DeviceRow {
  id: string
  plugin_id: string
  label: string
  config: string
  probed_model: string | null
  capabilities: string | null
  health: string
  last_error: string | null
  last_seen_at: number | null
  enabled: number
}

export interface Connection {
  deviceId: string
  pluginId: string
  label: string
  device: DeviceInstance
  capabilities: DeviceCapabilities
  nodes: NodeDefinition[]
  health: HealthReport
}

/** What a write is expected to produce, and how long the device may take. */
export interface VerifyCheck {
  what: string
  expected: string
  satisfiedBy: (state: NodeState) => boolean
  /**
   * How long to let the device get there before calling it a failure.
   *
   * Default for a setting that should land at once. A command that has to
   * reach past the device — an encoder opening an RTMP session — wants
   * longer, and says so at its call site.
   */
  settleMs?: number
}

/** Generous for a local command, short enough that a wedged device is not
 *  mistaken for a slow one. */
const DEFAULT_SETTLE_MS = 4_000
const VERIFY_POLL_MS = 250

export interface ConnectionManagerDeps {
  db: Db
  registry: PluginRegistry
  clock: Clock
  logger?: Logger
  vault?: SecretVault
  /** Injected in tests for deterministic backoff. */
  random?: () => number
  /** Injected in tests so the verify settle window costs no wall time. */
  sleep?: (ms: number) => Promise<void>
  /** Wrap every device in the serializing transport, as CI does, to catch
   *  anything that would not survive moving plugins into child processes. */
  enforceSerialization?: boolean
}

export type ConnectionEvent =
  | { type: 'state'; deviceId: string; nodeId: string; state: NodeState }
  | { type: 'health'; deviceId: string; report: HealthReport }

/**
 * Longest the initial state read may take per node.
 *
 * Short on purpose. This is a nicety — the screens look better for it —
 * and a nicety must never be what keeps a connection, or the loop that
 * opened it, waiting.
 */
const PRIME_TIMEOUT_MS = 8_000

/** Rejects if the promise has not settled in time. The original is left to
 *  settle on its own; nothing here can cancel it. */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} seconds.`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 5 * 60_000

/**
 * Whether a reply is about the device, rather than an answer to what was
 * asked.
 *
 * Every `invoke` comes back shaped as a `NodeState` because the transport
 * has one shape, but two actions use it as an envelope: `listMedia` puts
 * a file listing in `raw`, and `formatStorage` puts a one-shot token
 * there. Neither says anything about what the device is doing, so neither
 * should replace what it last did say.
 */
function saysSomethingAboutTheDevice(state: NodeState): boolean {
  return Object.keys(state).some((key) => key !== 'raw')
}

/**
 * Owns exactly one long-lived connection per physical device.
 *
 * Adapters never open sockets themselves: two runs can target the same ATEM,
 * and the UI needs live state whether or not anything is scheduled.
 *
 * Reconnection is driven by `tick()` rather than internal timers, matching the
 * rest of the engine — a desktop app sleeps constantly, and a pending timer
 * does not survive that.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>()
  private readonly backoff = new Map<string, { attempts: number; nextAttemptAt: number }>()
  private readonly listeners = new Set<(event: ConnectionEvent) => void>()
  /** Per device, per node: nested so no separator has to be invented for a
   *  pair of ids whose alphabets belong to plugins. */
  private readonly states = new Map<string, Map<string, { state: NodeState; at: number }>>()
  private readonly logger: Logger

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.logger = deps.logger ?? silentLogger
  }

  on(listener: (event: ConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(deviceId: string): Connection | undefined {
    return this.connections.get(deviceId)
  }

  list(): Connection[] {
    return [...this.connections.values()]
  }

  /** Connects if needed and returns the live connection. */
  async open(deviceId: string): Promise<Connection> {
    const existing = this.connections.get(deviceId)
    if (existing) return existing

    const row = this.deviceRow(deviceId)
    const plugin = this.deps.registry.get(row.plugin_id)
    const config = this.resolveConfig(row)

    const context: DeviceContext = {
      deviceId,
      config,
      log: (level, message, data) => this.logger[level](message, { deviceId, ...data }),
      emitState: (nodeId, state) => this.emit({ type: 'state', deviceId, nodeId, state }),
      emitHealth: (report) => {
        this.recordHealth(deviceId, report)
        this.emit({ type: 'health', deviceId, report })
      },
    }

    let device: DeviceInstance | undefined
    try {
      device = await plugin.createDevice(context)
      if (this.deps.enforceSerialization) device = withSerializingTransport(device)

      // Capabilities are probed, never trusted from a dropdown: streaming and
      // recording support varies by ATEM model and firmware.
      const capabilities = await device.probe()
      const nodes = await device.listNodes()
      const health = await device.health()

      const connection: Connection = {
        deviceId,
        pluginId: row.plugin_id,
        label: row.label,
        device,
        capabilities,
        nodes,
        health,
      }
      this.connections.set(deviceId, connection)
      this.backoff.delete(deviceId)
      this.recordProbe(deviceId, capabilities)
      this.recordHealth(deviceId, health)
      this.emit({ type: 'health', deviceId, report: health })
      this.logger.info('device connected', { deviceId, model: capabilities.model })
      await this.primeState(connection)
      return connection
    } catch (error) {
      if (device) await device.dispose().catch(() => {})
      this.noteFailure(deviceId, error)
      throw error
    }
  }

  /**
   * Asks a freshly connected device what it is doing, once.
   *
   * Without this, a device that has connected but not yet been asked to do
   * anything has nothing in the state cache, and every screen showing it
   * has nothing to show — a status row reading only "idle" beside a device
   * that could perfectly well say it has no card in it. Devices push as
   * things change, but nothing pushes the first reading.
   *
   * Best-effort on purpose: a node that will not answer is not a reason to
   * throw away a connection that just probed successfully.
   */
  private async primeState(connection: Connection): Promise<void> {
    for (const node of connection.nodes) {
      try {
        // Bounded, because a plugin that hangs here hangs the connect,
        // which hangs the tick that called it. The adapters have their own
        // deadlines; this does not take their word for it.
        const state = await withDeadline(
          connection.device.invoke(node.id, 'readState'),
          PRIME_TIMEOUT_MS,
          `${connection.label} did not report its state`,
        )
        if (state) this.remember(connection.deviceId, node.id, state)
      } catch (error) {
        this.logger.debug('could not read initial state', {
          deviceId: connection.deviceId,
          nodeId: node.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async close(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId)
    if (!connection) return
    this.connections.delete(deviceId)
    await connection.device.dispose().catch(() => {})
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)))
  }

  async invoke(
    deviceId: string,
    nodeId: string,
    action: InvokableAction,
    args: JsonObject = {},
  ): Promise<NodeState | null> {
    const connection = await this.open(deviceId)
    try {
      const state = await connection.device.invoke(nodeId, action, args)
      // An answer is an answer, however it was asked for. Remembering only
      // what a device volunteers leaves every screen reading "last heard
      // ten minutes ago" while something polls it every fifteen seconds.
      //
      // Unless the answer is not state at all. `listMedia` and
      // `formatStorage` reply with a file listing and a one-shot token,
      // carried in `raw` because the transport has one shape — and
      // remembering one of those as the node's state replaced everything
      // the screens read with it. Opening a deck's Files panel wiped the
      // slots that panel picks a card from, and the deck showed as doing
      // nothing until it next said otherwise.
      if (state && saysSomethingAboutTheDevice(state)) this.remember(deviceId, nodeId, state)
      return state
    } catch (error) {
      // A failed command does not by itself mean the transport is gone: a
      // device can reject one command and stay perfectly connected. Dropping
      // the connection on every command error throws away a healthy socket
      // and causes a reconnect storm, so ask the device instead.
      if (!(await this.stillHealthy(connection))) {
        await this.close(deviceId)
        this.noteFailure(deviceId, error)
      }
      throw error
    }
  }

  private async stillHealthy(connection: Connection): Promise<boolean> {
    try {
      const health = await connection.device.health()
      connection.health = health
      return health.state !== 'disconnected'
    } catch {
      return false
    }
  }

  /**
   * Writes, then reads the device back until it agrees the write took.
   *
   * Blackmagic devices will accept a command and then ignore it — a Web
   * Presenter mid-reboot happily takes a stream key and drops it. Verifying
   * turns that from a showtime mystery into a prepare-phase failure.
   *
   * The read is a *poll*, not a single shot, because these devices also
   * transition asynchronously. An ATEM told to stream goes Idle, then
   * Connecting, then Streaming, and the state arrives over its own protocol
   * some time after the command is acknowledged. Reading once, immediately,
   * caught it at Idle and called a stream that was coming up perfectly a
   * failure — on real hardware, every time.
   *
   * So each check says how long the device may take. Being slow is not the
   * same as ignoring the command, and only the second one is a fault.
   */
  async applyAndVerify(
    deviceId: string,
    nodeId: string,
    action: InvokableAction,
    args: JsonObject,
    check: VerifyCheck,
  ): Promise<NodeState> {
    await this.invoke(deviceId, nodeId, action, args)

    const settleMs = check.settleMs ?? DEFAULT_SETTLE_MS
    // Counted rather than clock-bounded: tests drive a manual clock that
    // does not advance on its own, and a deadline it never reaches would
    // spin here forever.
    const attempts = Math.max(1, Math.ceil(settleMs / VERIFY_POLL_MS))
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

    let state: NodeState | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      state = await this.invoke(deviceId, nodeId, 'readState')
      if (state && check.satisfiedBy(state)) return state
      if (attempt < attempts - 1) await sleep(VERIFY_POLL_MS)
    }

    throw new VerificationError(
      check.what,
      check.expected,
      state ? JSON.stringify(state) : 'nothing',
      settleMs,
    )
  }

  /**
   * Reconnects devices whose backoff has elapsed and refreshes health.
   * Called from the scheduler loop.
   */
  async tick(): Promise<void> {
    const now = this.deps.clock.now()

    for (const connection of this.list()) {
      try {
        const health = await connection.device.health()
        connection.health = health
        this.recordHealth(connection.deviceId, health)
        this.emit({ type: 'health', deviceId: connection.deviceId, report: health })
      } catch (error) {
        await this.close(connection.deviceId)
        this.noteFailure(connection.deviceId, error)
      }
    }

    for (const row of this.enabledDevices()) {
      if (this.connections.has(row.id)) continue
      const backoff = this.backoff.get(row.id)
      if (backoff && now < backoff.nextAttemptAt) continue
      await this.open(row.id).catch(() => {
        // noteFailure already recorded it; a device that has been down for an
        // hour must not be hammered every tick.
      })
    }
  }

  private noteFailure(deviceId: string, error: unknown): void {
    const now = this.deps.clock.now()
    const previous = this.backoff.get(deviceId)?.attempts ?? 0
    const attempts = previous + 1
    const jitter = (this.deps.random ?? Math.random)()
    const delay =
      Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS) * (0.5 + jitter / 2)
    this.backoff.set(deviceId, { attempts, nextAttemptAt: now + delay })

    const message = error instanceof Error ? error.message : String(error)
    const report: HealthReport = { state: 'disconnected', message, since: now }
    this.recordHealth(deviceId, report, message)
    this.emit({ type: 'health', deviceId, report })
    this.logger.warn('device unreachable', { deviceId, attempts, error: message })
  }

  private recordHealth(deviceId: string, report: HealthReport, error?: string): void {
    this.deps.db
      .prepare('UPDATE device SET health = ?, last_error = ?, last_seen_at = ? WHERE id = ?')
      .run(
        report.state,
        error ?? report.message ?? null,
        report.state === 'connected' ? this.deps.clock.now() : null,
        deviceId,
      )
  }

  private recordProbe(deviceId: string, capabilities: DeviceCapabilities): void {
    this.deps.db
      .prepare('UPDATE device SET probed_model = ?, capabilities = ? WHERE id = ?')
      .run(capabilities.model, JSON.stringify(capabilities), deviceId)
  }

  private deviceRow(deviceId: string): DeviceRow {
    const row = this.deps.db.prepare('SELECT * FROM device WHERE id = ?').get(deviceId) as
      DeviceRow | undefined
    if (!row) throw new Error(`No device with id "${deviceId}".`)
    return row
  }

  private enabledDevices(): DeviceRow[] {
    return this.deps.db.prepare('SELECT * FROM device WHERE enabled = 1').all() as DeviceRow[]
  }

  /**
   * Applies declared defaults and swaps stored secret references for their
   * plaintext values. A plugin sees the value and never the storage path, so
   * it cannot mishandle the secret even by accident.
   */
  private resolveConfig(row: DeviceRow): ConfigValues {
    const schema = this.deps.registry.configSchema(row.plugin_id)
    const stored = JSON.parse(row.config) as ConfigValues
    const resolved = applyConfigDefaults(schema, stored)
    if (!this.deps.vault) return resolved

    for (const field of schema) {
      if (field.type !== 'secret') continue
      const ref = stored[field.id]
      if (typeof ref === 'string' && ref !== '') resolved[field.id] = this.deps.vault.reveal(ref)
    }
    return resolved
  }

  /**
   * The last thing each node said about itself.
   *
   * Devices push their state as it changes — a deck notifies on transport
   * and slot, an ATEM on every state change — so remembering the last one
   * gives a live picture without anybody polling the rack. The status
   * screen reads this rather than asking five boxes what they are doing
   * every few seconds, which is traffic a device does not need while it is
   * recording.
   */
  lastStates(deviceId: string): { nodeId: string; state: NodeState; at: number }[] {
    return [...(this.states.get(deviceId) ?? new Map()).entries()].map(([nodeId, value]) => ({
      nodeId,
      ...(value as { state: NodeState; at: number }),
    }))
  }

  private remember(deviceId: string, nodeId: string, state: NodeState): void {
    const forDevice =
      this.states.get(deviceId) ?? new Map<string, { state: NodeState; at: number }>()
    forDevice.set(nodeId, { state, at: this.deps.clock.now() })
    this.states.set(deviceId, forDevice)
  }

  private emit(event: ConnectionEvent): void {
    if (event.type === 'state') this.remember(event.deviceId, event.nodeId, event.state)

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.error('a connection listener threw', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
