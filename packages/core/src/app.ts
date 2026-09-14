import { systemClock } from '@scheduler/plugin-sdk'
import type { Clock, DestinationProvider, PluginDefinition } from '@scheduler/plugin-sdk'
import { openDatabase, type Db } from './db/index.js'
import { resolvePaths, type Paths } from './config/paths.js'
import { createConsoleLogger, silentLogger, type Logger, type LogLevel } from './log.js'
import { ConnectionManager } from './devices/connection-manager.js'
import { PluginRegistry } from './plugins/registry.js'
import { DestinationRegistry } from './destinations/registry.js'
import {
  envSecretSource,
  keyFileSource,
  resolveMasterKey,
  type MasterKeySource,
} from './secrets/master-key.js'
import { scrubber } from './secrets/scrubber.js'
import { SecretVault } from './secrets/vault.js'
import { DEFAULT_HORIZON_MS, materializeAll } from './schedule/materialize.js'
import { EventPlanner } from './runs/event-planner.js'
import { RunEngine } from './runs/engine.js'
import { RunStore } from './runs/store.js'
import { Notifier } from './notify/notifier.js'
import { PreflightChecker, DEFAULT_PREFLIGHT_LEAD_MS } from './notify/preflight.js'
import { runFailedNotification } from './notify/run-events.js'

export interface AppOptions {
  configDir?: string
  clock?: Clock
  logger?: Logger
  logLevel?: LogLevel
  plugins?: PluginDefinition[]
  /** Streaming services: YouTube and anything added later. */
  destinationProviders?: DestinationProvider[]
  /** How often the scheduler loop runs. */
  tickIntervalMs?: number
  horizonMs?: number
  /** Extra key sources tried before the file and env ones. The Electron
   *  package supplies an OS-keychain source here. */
  keySources?: MasterKeySource[]
  enforceSerialization?: boolean
  /** How far ahead events are pre-flight checked. */
  preflightLeadMs?: number
  /** Used in notification links back into the UI. */
  baseUrl?: string
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
  readonly destinations: DestinationRegistry
  readonly connections: ConnectionManager
  readonly store: RunStore
  readonly planner: EventPlanner
  readonly engine: RunEngine
  readonly notifier: Notifier
  readonly preflight: PreflightChecker
  readonly logger: Logger
  readonly clock: Clock

  /**
   * Where a browser last reached this app.
   *
   * A link in an alert has no request to work from — a run fails at 09:00
   * with nobody typing anything — and the loopback default sends everyone
   * to their own machine. So the address a person actually used is recorded
   * when they open the UI, kept across restarts, and used for those links.
   */
  private readonly links: { origin: string; configured: boolean }

  private readonly tickListeners = new Set<() => void>()
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private lastMaterializedAt = 0
  private lastPreflightAt = 0
  private readonly tickIntervalMs: number
  private readonly horizonMs: number

  private constructor(init: {
    paths: Paths
    db: Db
    vault: SecretVault
    registry: PluginRegistry
    destinations: DestinationRegistry
    connections: ConnectionManager
    store: RunStore
    planner: EventPlanner
    engine: RunEngine
    notifier: Notifier
    preflight: PreflightChecker
    logger: Logger
    clock: Clock
    tickIntervalMs: number
    horizonMs: number
    links: { origin: string; configured: boolean }
  }) {
    this.paths = init.paths
    this.db = init.db
    this.vault = init.vault
    this.registry = init.registry
    this.destinations = init.destinations
    this.connections = init.connections
    this.store = init.store
    this.planner = init.planner
    this.engine = init.engine
    this.notifier = init.notifier
    this.preflight = init.preflight
    this.logger = init.logger
    this.clock = init.clock
    this.tickIntervalMs = init.tickIntervalMs
    this.horizonMs = init.horizonMs
    this.links = init.links
  }

  get publicOrigin(): string {
    return this.links.origin
  }

  /**
   * Remember where the UI was opened, so alerts can link back to it.
   *
   * Written through to the database: an install that has not been touched
   * since a restart still has to produce a link somebody can follow.
   */
  setPublicOrigin(origin: string): void {
    // An address the operator stated outright is not second-guessed.
    if (this.links.configured || origin === this.links.origin) return
    this.links.origin = origin
    this.db
      .prepare(
        "INSERT INTO setting (key, value) VALUES ('public_origin', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(origin, origin)
    this.logger.info('links in alerts will point here', { origin })
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

    const destinations = new DestinationRegistry({ db, clock, vault, logger })
    for (const provider of options.destinationProviders ?? []) destinations.register(provider)

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
    const planner = new EventPlanner({ db, connections, vault, clock, destinations })
    const notifier = new Notifier({ db, clock, vault, logger })
    // What a link should say, in order: what the operator configured, what
    // a browser last used, and failing both the address this process
    // listens on — which is right for a single machine and wrong for
    // everyone else, so it is the last resort rather than the default.
    const remembered = (
      db.prepare("SELECT value FROM setting WHERE key = 'public_origin'").get() as
        { value: string } | undefined
    )?.value
    const links = {
      origin: options.baseUrl ?? remembered ?? 'http://127.0.0.1:8500',
      configured: options.baseUrl !== undefined,
    }

    const engine = new RunEngine({
      db,
      store,
      clock,
      planner,
      logger,
      // Queued rather than sent here: the run engine's job is to end the run
      // cleanly, and a mail server that hangs must not be on that path.
      onFailure: (event) => {
        // Read at send time, not at startup: by the time a run fails, the
        // app may have learnt where it is really being reached.
        notifier.enqueue(runFailedNotification(db, event, links.origin))
      },
    })

    const preflight = new PreflightChecker({
      db,
      clock,
      planner,
      connections,
      destinations,
      notifier,
      logger,
      leadMs: options.preflightLeadMs ?? DEFAULT_PREFLIGHT_LEAD_MS,
    })

    return new Application({
      paths,
      db,
      vault,
      registry,
      destinations,
      connections,
      store,
      planner,
      engine,
      notifier,
      preflight,
      logger,
      clock,
      tickIntervalMs: options.tickIntervalMs ?? 5_000,
      horizonMs: options.horizonMs ?? DEFAULT_HORIZON_MS,
      links,
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

      // Pre-flight is hourly: the checks reach out to every device and
      // service, and doing that every five seconds would be rude to both.
      if (now - this.lastPreflightAt > 60 * 60_000) {
        this.lastPreflightAt = now
        await this.preflight.run()
      }
      await this.notifier.flush()
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
