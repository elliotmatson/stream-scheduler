import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import { compensateRun, executePhase, reconcileRun, type ExecutorDeps } from './executor.js'
import { isOnAir, isTerminal, PHASE_STATES, type RunPhase, type RunState } from './state-machine.js'
import type { RunFailure, RunRecord, RunStore } from './store.js'
import type { RunPlanner, Sleeper } from './steps.js'

export interface EngineDeps {
  db: Db
  store: RunStore
  clock: Clock
  planner: RunPlanner
  sleeper?: Sleeper
  logger?: Logger
}

export interface Timing {
  scheduledStart: number
  scheduledEnd: number
  prepareLeadMs: number
  prerollMs: number
  postrollMs: number
  lateStartGraceMs: number
}

export interface TickReport {
  created: string[]
  advanced: string[]
  failed: string[]
  completed: string[]
}

/**
 * The scheduler loop.
 *
 * Deliberately a poll rather than a timer per event. Long `setTimeout`s do not
 * survive machine sleep, system clock changes or NTP steps, and a desktop app
 * sleeps constantly; recomputing from wall-clock each tick makes all three
 * non-events. See docs/plan/03-scheduling-engine.md.
 */
export class RunEngine {
  private readonly logger: Logger

  constructor(private readonly deps: EngineDeps) {
    this.logger = deps.logger ?? silentLogger
  }

  /**
   * Resolves anything a crash left mid-flight. Call once at startup, before
   * the first tick, so no new work is attempted on top of an unknown state.
   */
  async recover(): Promise<string[]> {
    const recovered: string[] = []
    for (const run of this.deps.store.listActiveRuns()) {
      const plan = await this.deps.planner.plan(run.occurrence_id)
      await reconcileRun(run.id, plan, this.executorDeps())
      recovered.push(run.id)
      this.logger.info('recovered a run interrupted by a restart', { runId: run.id, state: run.state })
    }
    return recovered
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { created: [], advanced: [], failed: [], completed: [] }
    const now = this.deps.clock.now()

    for (const occurrenceId of this.dueOccurrences(now)) {
      const run = this.deps.store.createRun(occurrenceId, await this.deps.planner.plan(occurrenceId))
      this.deps.db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)
      report.created.push(run.id)
      this.logger.info('created a run', { runId: run.id, occurrenceId })
    }

    for (const run of this.deps.store.listActiveRuns()) {
      const before = run.state
      const after = await this.advance(run.id)
      if (after !== before) report.advanced.push(run.id)
      if (after === 'failed') report.failed.push(run.id)
      if (after === 'completed') report.completed.push(run.id)
    }
    return report
  }

  /** Drives one run as far as the clock currently allows. */
  async advance(runId: string): Promise<RunState> {
    let state = this.deps.store.getRun(runId).state
    // A single tick can cross several boundaries — a run created at its
    // prepare time when the app was asleep may need to prepare, start and go
    // live immediately — so keep going while progress is being made.
    for (;;) {
      const next = await this.step(runId)
      if (next === state) return state
      state = next
      if (isTerminal(state)) return state
    }
  }

  private async step(runId: string): Promise<RunState> {
    const run = this.deps.store.getRun(runId)
    if (isTerminal(run.state)) return run.state

    const timing = this.timingFor(run.occurrence_id)
    const now = this.deps.clock.now()

    if (this.hasMissedItsWindow(run, timing, now)) {
      await this.fail(run, {
        code: 'missed_window',
        message:
          `Scheduled for ${new Date(timing.scheduledStart).toISOString()} but the app was not running until ` +
          `${new Date(now).toISOString()}, past the ${Math.round(timing.lateStartGraceMs / 60_000)} minute grace period.`,
        remediation: 'Start it manually if it is still wanted, or widen the late-start grace on the series.',
      })
      return 'failed'
    }

    const phase = this.duePhase(run.state, timing, now)
    if (!phase) return run.state

    return this.runPhase(run, phase)
  }

  private async runPhase(run: RunRecord, phase: RunPhase): Promise<RunState> {
    const { during, after } = PHASE_STATES[phase]
    const plan = await this.deps.planner.plan(run.occurrence_id)

    this.deps.store.transition(run.id, during)
    const result = await executePhase(run.id, plan, phase, this.executorDeps())

    if (!result.ok) {
      await this.fail(this.deps.store.getRun(run.id), result.failure)
      return 'failed'
    }

    this.deps.store.transition(run.id, after)
    if (after === 'completed') {
      this.deps.db.prepare("UPDATE occurrence SET status = 'done' WHERE id = ?").run(run.occurrence_id)
    }
    return after
  }

  /**
   * Only a run that has not gone on air yet can miss its window.
   *
   * Checking "not on air and not terminal" is not enough: a run in `stopping`
   * or `completing` has long passed its scheduled start by definition, and
   * treating that as a missed window fails every run at the finish line.
   */
  private hasMissedItsWindow(run: RunRecord, timing: Timing, now: number): boolean {
    if (run.state !== 'scheduled' && run.state !== 'preparing' && run.state !== 'ready') return false
    return now > timing.scheduledStart + timing.lateStartGraceMs
  }

  private duePhase(state: RunState, timing: Timing, now: number): RunPhase | undefined {
    switch (state) {
      case 'scheduled':
        return now >= timing.scheduledStart - timing.prepareLeadMs ? 'prepare' : undefined
      case 'ready':
        return now >= timing.scheduledStart - timing.prerollMs ? 'start' : undefined
      case 'live':
        return now >= timing.scheduledEnd + timing.postrollMs ? 'stop' : undefined
      case 'completing':
        return 'complete'

      // A run found in one of these states is one a crash interrupted
      // part-way through that phase: its clock gate was already passed, so
      // resume it. Without these cases a restart leaves the run wedged
      // forever, which is the failure the whole recovery path exists to
      // prevent.
      case 'preparing':
        return 'prepare'
      case 'starting':
        return 'start'
      case 'stopping':
        return 'stop'

      default:
        return undefined
    }
  }

  private async fail(run: RunRecord, failure: RunFailure): Promise<void> {
    const plan = await this.deps.planner.plan(run.occurrence_id)
    await compensateRun(run.id, plan, this.executorDeps())
    this.deps.store.recordFailure(run.id, failure)
    this.deps.store.transition(run.id, 'failed')
    this.deps.db.prepare("UPDATE occurrence SET status = 'failed' WHERE id = ?").run(run.occurrence_id)
    this.logger.error('run failed', { runId: run.id, code: failure.code, message: failure.message })
  }

  /**
   * Operator override. The scheduler must never be the only way to stop a
   * stream: someone standing in a control room needs a stop button, not a
   * support ticket.
   */
  async cancel(runId: string, reason = 'Stopped by an operator'): Promise<RunState> {
    const run = this.deps.store.getRun(runId)
    if (isTerminal(run.state)) return run.state
    const plan = await this.deps.planner.plan(run.occurrence_id)

    if (isOnAir(run.state)) {
      // Already streaming: run the stop steps so the encoder is actually told
      // to stop, rather than just marking the row cancelled.
      if (run.state !== 'stopping') this.deps.store.transition(runId, 'stopping')
      await executePhase(runId, plan, 'stop', this.executorDeps())
    } else {
      await compensateRun(runId, plan, this.executorDeps())
    }

    this.deps.store.recordFailure(runId, { code: 'cancelled', message: reason })
    this.deps.store.transition(runId, 'cancelled')
    this.deps.db.prepare("UPDATE occurrence SET status = 'cancelled' WHERE id = ?").run(run.occurrence_id)
    this.logger.info('run cancelled', { runId, reason })
    return 'cancelled'
  }

  /** Creates a run for an occurrence right now, ignoring its prepare lead. */
  async startNow(occurrenceId: string): Promise<string> {
    const existing = this.deps.store.findRunForOccurrence(occurrenceId)
    if (existing && !isTerminal(existing.state)) return existing.id
    const plan = await this.deps.planner.plan(occurrenceId)
    const run = this.deps.store.createRun(occurrenceId, plan, { attempt: (existing?.attempt ?? 0) + 1 })
    this.deps.db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)
    return run.id
  }

  private dueOccurrences(now: number): string[] {
    const rows = this.deps.db
      .prepare(
        `SELECT o.id AS id
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
          WHERE o.status = 'pending'
            AND s.enabled = 1
            AND ? >= o.scheduled_start - s.prepare_lead_ms
            AND NOT EXISTS (SELECT 1 FROM run r WHERE r.occurrence_id = o.id)
          ORDER BY o.scheduled_start`,
      )
      .all(now) as { id: string }[]
    return rows.map((row) => row.id)
  }

  private timingFor(occurrenceId: string): Timing {
    const row = this.deps.db
      .prepare(
        `SELECT o.scheduled_start, o.scheduled_end, s.prepare_lead_ms, s.preroll_ms, s.postroll_ms,
                s.late_start_grace_ms
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
          WHERE o.id = ?`,
      )
      .get(occurrenceId) as
      | {
          scheduled_start: number
          scheduled_end: number
          prepare_lead_ms: number
          preroll_ms: number
          postroll_ms: number
          late_start_grace_ms: number
        }
      | undefined
    if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)
    return {
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      prepareLeadMs: row.prepare_lead_ms,
      prerollMs: row.preroll_ms,
      postrollMs: row.postroll_ms,
      lateStartGraceMs: row.late_start_grace_ms,
    }
  }

  private executorDeps(): ExecutorDeps {
    const deps: ExecutorDeps = { store: this.deps.store, clock: this.deps.clock, logger: this.logger }
    if (this.deps.sleeper) deps.sleeper = this.deps.sleeper
    return deps
  }
}
