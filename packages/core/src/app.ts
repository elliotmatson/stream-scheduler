import { systemClock } from '@scheduler/plugin-sdk'
import type { Clock, DestinationProvider, MediaItem, PluginDefinition } from '@scheduler/plugin-sdk'
import { openDatabase, type Db } from './db/index.js'
import { resolvePaths, type Paths } from './config/paths.js'
import { createConsoleLogger, silentLogger, type Logger, type LogLevel } from './log.js'
import { ConnectionManager } from './devices/connection-manager.js'
import { PluginRegistry } from './plugins/registry.js'
import { DestinationRegistry } from './destinations/registry.js'
import { PlanSourceRegistry } from './plans/registry.js'
import { syncAll } from './plans/sync.js'
import {
  envSecretSource,
  keyFileSource,
  resolveMasterKey,
  type MasterKeySource,
} from './secrets/master-key.js'
import { scrubber } from './secrets/scrubber.js'
import { Auth } from './auth/index.js'
import { TelemetryRecorder } from './runs/telemetry.js'
import { cacheHighNotification } from './notify/run-events.js'
import { Thresholds } from './notify/thresholds.js'
import { SecretVault } from './secrets/vault.js'
import { DEFAULT_HORIZON_MS, materializeAll } from './schedule/materialize.js'
import { EventPlanner } from './runs/event-planner.js'
import { RunEngine } from './runs/engine.js'
import { RunStore } from './runs/store.js'
import { Notifier } from './notify/notifier.js'
import { PreflightChecker, DEFAULT_PREFLIGHT_LEAD_MS } from './notify/preflight.js'
import { RecordingLedger } from './runs/artifacts.js'
import { Tags } from './tags/index.js'
import { eventMidRunOn, freeMsOf } from './runs/retention.js'
import { Sweeper } from './runs/sweep.js'
import { runFailedNotification } from './notify/run-events.js'
import { lifecycleNotification } from './notify/lifecycle-events.js'
import { applyPendingRestore, type RestoreApplied } from './backup/index.js'
import {
  backupDue,
  readSchedule,
  recordFailure,
  recordSuccess,
  takeScheduledBackup,
} from './backup/schedule.js'
import { backupFailed } from './notify/backup-events.js'
import { recordingsSweptNotification } from './notify/retention-events.js'

/**
 * How long a tick may run before the next one stops waiting for it.
 *
 * Comfortably longer than a healthy pass — devices, engine, telemetry and
 * the outbox — and far shorter than a service, so a wedged tick costs
 * seconds rather than a morning.
 */
export const TICK_DEADLINE_MS = 60_000

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
  /** How often a running event's devices are asked what they are doing. */
  telemetryIntervalMs?: number
  /** How long those readings are kept. */
  telemetryRetentionMs?: number
  /** Used in notification links back into the UI. */
  baseUrl?: string
  /**
   * Sets the UI password from the environment, which is how Docker does it
   * — there is no first-run screen in a container somebody started with
   * `docker run`. Passed in rather than read here so core stays testable
   * without touching `process.env`, the same way the master key does it.
   */
  uiPassword?: string | undefined
  /** How long a signed-in session lasts. */
  sessionTtlMs?: number
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
  /** Where schedules can come from: Planning Center, and whatever follows. */
  readonly planSources: PlanSourceRegistry
  readonly connections: ConnectionManager
  readonly store: RunStore
  readonly planner: EventPlanner
  readonly engine: RunEngine
  readonly notifier: Notifier
  readonly preflight: PreflightChecker
  readonly telemetry: TelemetryRecorder
  readonly thresholds: Thresholds
  /** What this scheduler has recorded, and where it put it. */
  readonly ledger: RecordingLedger
  /** Labels on devices and events, for finding things in a full rack. */
  readonly tags: Tags
  /** Removes recordings a policy says are past their keep-by date. */
  readonly sweeper: Sweeper
  readonly auth: Auth
  readonly logger: Logger
  readonly clock: Clock
  /**
   * Set when this start began by putting a backup in place.
   *
   * Reported on the settings screen rather than only logged: somebody who
   * has just restored wants to see that it happened, what was in it, and
   * where the database it replaced went.
   */
  readonly restored: RestoreApplied | undefined

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
  private reachableFromNetwork = false
  private ticking = false
  /** When the in-flight tick began, for the overrun deadline. */
  private tickStartedAt = 0
  /** Identifies the in-flight tick, so a late one cannot clear the guard. */
  private tickToken: symbol | undefined
  private lastMaterializedAt = 0
  private lastPreflightAt = 0
  private lastSweepAt = 0
  private readonly tickIntervalMs: number
  private readonly horizonMs: number

  private constructor(init: {
    paths: Paths
    db: Db
    vault: SecretVault
    registry: PluginRegistry
    destinations: DestinationRegistry
    planSources: PlanSourceRegistry
    connections: ConnectionManager
    store: RunStore
    planner: EventPlanner
    engine: RunEngine
    notifier: Notifier
    preflight: PreflightChecker
    telemetry: TelemetryRecorder
    thresholds: Thresholds
    auth: Auth
    logger: Logger
    clock: Clock
    tickIntervalMs: number
    horizonMs: number
    links: { origin: string; configured: boolean }
    restored?: RestoreApplied
  }) {
    this.paths = init.paths
    this.db = init.db
    this.vault = init.vault
    this.registry = init.registry
    this.destinations = init.destinations
    this.planSources = init.planSources
    this.connections = init.connections
    this.store = init.store
    this.planner = init.planner
    this.engine = init.engine
    this.notifier = init.notifier
    this.preflight = init.preflight
    this.telemetry = init.telemetry
    this.thresholds = init.thresholds
    // Stateless SQL over the same database as the planner's own, so the
    // two are the same ledger rather than two views of one.
    this.ledger = new RecordingLedger({ db: init.db })
    this.tags = new Tags({ db: init.db })
    this.sweeper = new Sweeper({
      db: init.db,
      ledger: this.ledger,
      clock: init.clock,
      listMedia: async (deviceId, nodeId) => {
        const state = await this.connections.invoke(deviceId, nodeId, 'listMedia')
        const media = state?.raw?.media
        return Array.isArray(media) ? (media as unknown as MediaItem[]) : undefined
      },
      deleteMedia: async (deviceId, nodeId, args) => {
        await this.connections.invoke(deviceId, nodeId, 'deleteMedia', args)
      },
      stateOf: (deviceId) => this.connections.lastStates(deviceId).map((entry) => entry.state),
      runOn: (deviceId) => eventMidRunOn(init.db, deviceId),
      freeMs: (deviceId, nodeId) =>
        freeMsOf(
          this.connections
            .lastStates(deviceId)
            .filter((entry) => entry.nodeId === nodeId)
            .map((entry) => entry.state),
        ),
      canDelete: (deviceId, nodeId) =>
        this.connections
          .get(deviceId)
          ?.nodes.find((node) => node.id === nodeId)
          ?.supports.includes('deleteMedia') === true,
    })
    this.auth = init.auth
    this.logger = init.logger
    this.clock = init.clock
    this.tickIntervalMs = init.tickIntervalMs
    this.horizonMs = init.horizonMs
    this.links = init.links
    this.restored = init.restored
  }

  get publicOrigin(): string {
    return this.links.origin
  }

  /**
   * Whether this app is listening anywhere but loopback.
   *
   * Set by the server as it binds, because the address is its business and
   * not the application's. What reads it is the status screen: "no password"
   * is worth saying on a machine other people can reach, and is noise on a
   * booth machine that only answers itself.
   */
  get exposed(): boolean {
    return this.reachableFromNetwork
  }

  setExposed(exposed: boolean): void {
    this.reachableFromNetwork = exposed
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

    // Before anything opens the database or resolves a key. A restore that
    // swapped the file under a live handle would be a corruption, and the
    // salt an environment-derived key needs has to be in place before that
    // key is derived — both of which mean here, and only here.
    const restored = applyPendingRestore(paths, clock.now())
    if (restored) {
      logger.warn('a backup was restored on startup', {
        takenAt: restored.manifest.takenAt,
        counts: restored.manifest.counts,
        previousDatabase: restored.previous,
      })
    }

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

    // Registered after construction by the host, like the destinations
    // above: a source's credential lookup has to close over a built app.
    const planSources = new PlanSourceRegistry({ db, vault })

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
      // Queued on the same terms as a failure, and reaching nobody unless
      // a channel asked for these by name: they are the "it worked"
      // messages, and a channel full of those is a channel people stop
      // reading.
      onLifecycle: (event) => {
        notifier.enqueue(lifecycleNotification(db, event, links.origin))
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

    const thresholds = new Thresholds({ db })

    const telemetry = new TelemetryRecorder({
      db,
      store,
      connections,
      clock,
      logger,
      // Read at the moment of the check, not at startup: a threshold
      // changed on a Sunday morning should take effect on that morning.
      cacheWarningPercent: () => thresholds.get().cacheWarningPercent,
      ...(options.telemetryIntervalMs === undefined
        ? {}
        : { intervalMs: options.telemetryIntervalMs }),
      ...(options.telemetryRetentionMs === undefined
        ? {}
        : { retentionMs: options.telemetryRetentionMs }),
      // Queued rather than sent from here, for the same reason a failed run
      // is: sampling must not wait on a mail server.
      onCacheHigh: (event) => {
        notifier.enqueue(cacheHighNotification(db, event, links.origin))
      },
    })

    const auth = new Auth({
      db,
      clock,
      envPassword: options.uiPassword,
      ...(options.sessionTtlMs === undefined ? {} : { ttlMs: options.sessionTtlMs }),
    })

    return new Application({
      paths,
      db,
      ...(restored === undefined ? {} : { restored }),
      vault,
      registry,
      destinations,
      planSources,
      connections,
      store,
      planner,
      engine,
      notifier,
      preflight,
      telemetry,
      thresholds,
      auth,
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
    // The sweep waits an hour rather than running on the first tick. It
    // is the one job here that destroys something, and a restart — a
    // crash loop most of all — must not be a way to trigger it. Nothing
    // about a keep-for date is urgent enough to want the other behaviour.
    this.lastSweepAt = this.clock.now()
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
   *
   * The guard is time-bounded, and that bound is load-bearing. A plugin
   * that awaits something which never settles — a deck that accepts a
   * socket and then stops answering while it remounts a card is the real
   * case — would otherwise leave `ticking` true forever, and every
   * subsequent tick returns at the guard. The scheduler stops: no
   * reconnects, no telemetry, no runs started, and no sign of it anywhere
   * except that the screens go quiet. One device must not be able to do
   * that, so a tick that overruns is abandoned and the next one goes.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      if (this.clock.now() - this.tickStartedAt < TICK_DEADLINE_MS) return
      // The previous tick is still pending and past its deadline. It is
      // not cancellable — nothing in JavaScript is — so it is left to
      // settle or not, and the loop carries on without it.
      this.logger.error('a scheduler tick overran and was abandoned', {
        startedAt: this.tickStartedAt,
        deadlineMs: TICK_DEADLINE_MS,
      })
    }

    // Whoever holds the current token owns the guard. An abandoned tick
    // that settles later finds the token has moved on and leaves it alone,
    // rather than clearing it out from under its successor.
    const token = Symbol('tick')
    this.tickToken = token
    this.ticking = true
    this.tickStartedAt = this.clock.now()
    try {
      const now = this.clock.now()
      if (now - this.lastMaterializedAt > 60 * 60_000) {
        this.materialize()
        this.lastMaterializedAt = now
        // Paired series get their occurrences from the source rather than
        // from a rule, so reading the plans belongs with the same hourly
        // work. Hourly is right for a schedule people publish days ahead —
        // and the freeze at prepare time means a change arriving in the
        // last hour would not have been acted on anyway.
        await this.syncPlans()
        // Expired and revoked sessions go with it. Nothing depends on this
        // happening promptly — `verify` already refuses them — so it rides
        // along with the other hourly work rather than owning a timer.
        this.auth.sessions.sweep()
      }
      await this.connections.tick()
      await this.engine.tick()

      // Pre-flight is hourly: the checks reach out to every device and
      // service, and doing that every five seconds would be rude to both.
      if (now - this.lastPreflightAt > 60 * 60_000) {
        this.lastPreflightAt = now
        await this.preflight.run()
      }

      // And so is the sweep, on the same reasoning and after the checks:
      // reading a card is slow, and nothing about a keep-for date needs
      // acting on within the hour.
      if (now - this.lastSweepAt > 60 * 60_000) {
        this.lastSweepAt = now
        await this.sweep()
      }

      // The backup's own cadence is stored rather than held here, because
      // it has to survive a restart: a container in a crash loop would
      // otherwise take a backup on every boot and prune the useful ones
      // out of the directory within the hour.
      if (backupDue(this.db, now)) this.backup(now)
      // After the engine, so a run that has just gone on air is sampled
      // rather than waiting a whole interval to appear on its own timeline.
      await this.telemetry.tick()
      await this.notifier.flush()
    } catch (error) {
      this.logger.error('scheduler tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (this.tickToken === token) this.ticking = false
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

  /**
   * Enforces the keep-for policies, once an hour.
   *
   * Errors are caught here rather than left to the tick's own handler,
   * because tidying up old files is the least important thing this loop
   * does and must never be what stops a run from starting.
   *
   * Loud in the log whatever the alert does, for the same reason the
   * manual sweep is: this is the one thing in the app that destroys
   * somebody's footage, and it now does it with nobody watching.
   */
  private async sweep(): Promise<void> {
    try {
      const swept = await this.sweeper.sweepDue()

      for (const refusal of this.sweeper.takeRefusals()) {
        // Not an error: a deck mid-record or an event under way means "not
        // now", which on an hourly job is simply the next hour.
        this.logger.info('a scheduled sweep skipped an output', refusal)
      }

      if (swept.length === 0) return

      this.logger.warn('a scheduled sweep removed recordings', {
        outputs: swept.map((entry) => entry.outputId),
        removed: swept.flatMap((entry) => entry.removed.map((file) => file.filename)),
        failed: swept.flatMap((entry) => entry.failed.map((file) => file.filename)),
      })
      this.notifier.enqueue(recordingsSweptNotification(swept, this.links.origin, this.clock.now()))
    } catch (error) {
      this.logger.error('the scheduled sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Takes a scheduled backup, and never lets that be what breaks a Sunday.
   *
   * Synchronous because `VACUUM INTO` is, and cheap enough not to matter:
   * the database is a few megabytes and this happens once a day.
   *
   * A failure is announced rather than logged and forgotten. The failure
   * that actually happens here is a volume that stopped being writable
   * months ago and a directory that has been empty ever since — and by the
   * time anybody opens a backup screen, they already need a backup.
   */
  private backup(now: number): void {
    try {
      const taken = takeScheduledBackup(this.db, this.paths, this.paths.backupDir, now)
      recordSuccess(this.db, now)
      this.logger.info('took a scheduled backup', {
        file: taken.file,
        ...(taken.pruned.length === 0 ? {} : { pruned: taken.pruned }),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      recordFailure(this.db, now, reason)
      this.logger.error('a scheduled backup failed', { directory: this.paths.backupDir, reason })
      this.notifier.enqueue(
        backupFailed({
          directory: this.paths.backupDir,
          reason,
          at: now,
          nextAttemptInHours: readSchedule(this.db).everyHours,
        }),
      )
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

  /**
   * Brings every paired series in line with its plan source.
   *
   * Never throws: this runs inside the scheduler tick, and a Planning
   * Center outage must not stop devices being polled or runs being driven.
   * Each series records its own error, which is where the UI reads it from.
   */
  async syncPlans(): Promise<void> {
    try {
      const results = await syncAll({
        db: this.db,
        clock: this.clock,
        sources: this.planSources,
        logger: this.logger,
      })
      for (const [seriesId, result] of results) {
        const touched = result.created + result.updated + result.removed
        if (touched > 0) this.logger.info('plan sync changed a schedule', { seriesId, ...result })
      }
    } catch (error) {
      this.logger.error('the plan sync failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
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
