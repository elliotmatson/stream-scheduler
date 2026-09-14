import { systemClock } from '@scheduler/plugin-sdk'
import type { Clock, PluginDefinition } from '@scheduler/plugin-sdk'
import { openDatabase, type Db } from './db/index.js'
import { resolvePaths, type Paths } from './config/paths.js'
import { createConsoleLogger, silentLogger, type Logger, type LogLevel } from './log.js'
import { ConnectionManager } from './devices/connection-manager.js'
import { PluginRegistry } from './plugins/registry.js'
import { envSecretSource, keyFileSource, resolveMasterKey, type MasterKeySource } from './secrets/master-key.js'
import { scrubber } from './secrets/scrubber.js'
import { SecretVault } from './secrets/vault.js'
import { DEFAULT_HORIZON_MS, materializeAll } from './schedule/materialize.js'
import { DevicePlanner } from './runs/device-planner.js'
import { RunEngine } from './runs/engine.js'
import { RunStore } from './runs/store.js'

export interface AppOptions {
  configDir?: string
  clock?: Clock
  logger?: Logger
  logLevel?: LogLevel
  plugins?: PluginDefinition[]
  /** How often the scheduler loop runs. */
  tickIntervalMs?: number
  horizonMs?: number
  /** Extra key sources tried before the file and env ones. The Electron
   *  package supplies an OS-keychain source here. */
  keySources?: MasterKeySource[]
  enforceSerialization?: boolean
}

/**
 * Everything wired together: database, vault, plugins, connections, scheduler.
 *
 * The Electron main process and the headless entrypoint both construct this,
 * so there is exactly one code path regardless of how the app was started.
 */
export class Application {
  readonly paths: Paths
  readonly db: Db
  readonly vault: SecretVault
  readonly registry: PluginRegistry
  readonly connections: ConnectionManager
  readonly store: RunStore
  readonly planner: DevicePlanner
  readonly engine: RunEngine
  readonly logger: Logger
  readonly clock: Clock

  private readonly tickListeners = new Set<() => void>()
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private lastMaterializedAt = 0
  private readonly tickIntervalMs: number
  private readonly horizonMs: number

  private constructor(init: {
    paths: Paths
    db: Db
    vault: SecretVault
    registry: PluginRegistry
    connections: ConnectionManager
    store: RunStore
    planner: DevicePlanner
    engine: RunEngine
    logger: Logger
    clock: Clock
    tickIntervalMs: number
    horizonMs: number
  }) {
    this.paths = init.paths
    this.db = init.db
    this.vault = init.vault
    this.registry = init.registry
    this.connections = init.connections
    this.store = init.store
    this.planner = init.planner
    this.engine = init.engine
    this.logger = init.logger
    this.clock = init.clock
    this.tickIntervalMs = init.tickIntervalMs
    this.horizonMs = init.horizonMs
  }

  static create(options: AppOptions = {}): Application {
    const paths = resolvePaths(options.configDir)
    const clock = options.clock ?? systemClock
    const logger =
      options.logger ?? createConsoleLogger({ level: options.logLevel ?? 'info', scrubber })

    // Refuses to start rather than keeping stream keys and OAuth tokens in
    // plaintext; the error names the fix for each platform.
    const masterKey = resolveMasterKey([
      ...(options.keySources ?? []),
      keyFileSource(paths.keyFile),
      envSecretSource(paths.configDir),
      // Only create a key file once the other sources have all declined, so
      // a misconfigured SCHEDULER_SECRET does not silently orphan secrets.
      keyFileSource(paths.keyFile, { create: true }),
    ])

    const db = openDatabase(paths.databaseFile)
    const vault = new SecretVault(db, masterKey, scrubber)
    const registry = new PluginRegistry()
    for (const plugin of options.plugins ?? []) registry.register(plugin)

    const connections = new ConnectionManager({
      db,
      registry,
      clock,
      logger,
      vault,
      ...(options.enforceSerialization === undefined
        ? {}
        : { enforceSerialization: options.enforceSerialization }),
    })
    const store = new RunStore(db, clock, scrubber)
    const planner = new DevicePlanner({ db, connections, vault, clock })
    const engine = new RunEngine({ db, store, clock, planner, logger })

    return new Application({
      paths,
      db,
      vault,
      registry,
      connections,
      store,
      planner,
      engine,
      logger,
      clock,
      tickIntervalMs: options.tickIntervalMs ?? 5_000,
      horizonMs: options.horizonMs ?? DEFAULT_HORIZON_MS,
    })
  }

  /** Resolves interrupted runs, fills the horizon, and starts the loop. */
  async start(): Promise<void> {
    await this.engine.recover()
    this.materialize()
    await this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickIntervalMs)
    this.timer.unref?.()
    this.logger.info('scheduler started', { configDir: this.paths.configDir })
  }

  /**
   * One pass of the loop. Guarded against overlap: a slow device must not
   * cause two ticks to interleave and drive the same run twice.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.clock.now()
      if (now - this.lastMaterializedAt > 60 * 60_000) {
        this.materialize()
        this.lastMaterializedAt = now
      }
      await this.connections.tick()
      await this.engine.tick()
    } catch (error) {
      this.logger.error('scheduler tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.ticking = false
      for (const listener of this.tickListeners) {
        try {
          listener()
        } catch (error) {
          this.logger.error('a tick listener threw', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /** Notified after every completed tick, so the API can push live state. */
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  materialize(): void {
    materializeAll(this.db, { clock: this.clock, horizonMs: this.horizonMs })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.connections.closeAll()
    this.db.close()
    this.logger.info('scheduler stopped')
  }
}

export const silentAppLogger = silentLogger
