import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import {
  compensateOutput,
  compensateRun,
  executePhase,
  executeSteps,
  reconcileRun,
  type ExecutorDeps,
} from './executor.js'
import { isOnAir, isTerminal, type RunState } from './state-machine.js'
import type { RunFailure, RunRecord, RunStore } from './store.js'
import type { RunPlan, RunPlanner, Sleeper } from './steps.js'
import { timelineEnd, timelineFor, type EventTimeline, type OutputWindow } from './timeline.js'

export interface EngineDeps {
  db: Db
  store: RunStore
  clock: Clock
  planner: RunPlanner
  sleeper?: Sleeper
  logger?: Logger
  /**
   * Called when a run, or one of its outputs, ends badly. A hook rather than
   * a notifier so the engine stays unaware of channels, outboxes and email
   * servers.
   */
  onFailure?: (event: {
    runId: string
    occurrenceId: string
    failure: RunFailure
    attempt: number
    /** Set when one output failed and the rest of the event carried on. */
    outputLabel?: string
  }) => void
}

export interface TickReport {
  created: string[]
  advanced: string[]
  failed: string[]
  completed: string[]
}

/** What one output of a run has got to. Read from its steps, not stored. */
export type OutputProgress = 'pending' | 'started' | 'stopped' | 'failed'

/**
 * The scheduler loop.
 *
 * Deliberately a poll rather than a timer per event. Long `setTimeout`s do not
 * survive machine sleep, system clock changes or NTP steps, and a desktop app
 * sleeps constantly; recomputing from wall-clock each tick makes all three
 * non-events. See docs/plan/03-scheduling-engine.md.
 *
 * A run is a *timeline*, not a single start and stop. Everything prepares at
 * T-30, then each output goes on and comes off at its own time inside the
 * event's window, then the whole thing is closed out. One output failing
 * takes that output off the air and leaves the others running: on a Sunday
 * morning, a broadcast that cannot be created for the 9:00 service is no
 * reason to abandon the 11:00 one or to stop recording.
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
      await reconcileRun(run.id, await this.planFor(run), this.executorDeps())
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
    // A single tick can cross several boundaries — a run whose whole window
    // elapsed while the machine was asleep has to prepare, start, stop and
    // complete in one go — so keep going while progress is being made.
    //
    // The bound is a backstop, not a limit: each pass either commits a step
    // or a transition, so a run that keeps asking for another pass without
    // recording anything is a bug, and spinning on it forever inside a tick
    // would take the scheduler down with it.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (!(await this.step(runId))) return this.deps.store.getRun(runId).state
      const state = this.deps.store.getRun(runId).state
      if (isTerminal(state)) return state
    }
    this.logger.error('gave up advancing a run after too many passes', { runId })
    return this.deps.store.getRun(runId).state
  }

  /** One unit of work. Returns whether anything was done. */
  private async step(runId: string): Promise<boolean> {
    const run = this.deps.store.getRun(runId)
    if (isTerminal(run.state)) return false

    const timeline = this.timelineFor(run)
    const plan = await this.planFor(run)
    const now = this.deps.clock.now()

    if (timeline.outputs.length === 0) {
      await this.fail(run, plan, {
        code: 'no_outputs',
        message: `"${timeline.label}" has nothing to do: it has no enabled streams or recordings.`,
        remediation: 'Add a stream or a recording to the event, or turn the event off.',
      })
      return true
    }

    const drift = this.planDrift(run.id, plan)
    if (drift) {
      await this.fail(run, plan, drift)
      return true
    }

    const progress = this.progressOf(run.id, plan, timeline)

    if (this.hasMissedItsWindow(run, timeline, progress, now)) {
      await this.fail(run, plan, {
        code: 'missed_window',
        message:
          `Scheduled for ${new Date(timeline.windowStart).toISOString()} but the app was not running until ` +
          `${new Date(now).toISOString()}, past the ${Math.round(timeline.lateStartGraceMs / 60_000)} minute ` +
          'grace period on every output.',
        remediation: 'Start it manually if it is still wanted, or widen the late-start grace on the event.',
      })
      return true
    }

    if (run.state === 'scheduled' || run.state === 'preparing') {
      if (!(run.forced_at !== null || now >= timeline.windowStart - timeline.prepareLeadMs)) return false
      return this.prepare(run, plan, timeline)
    }

    // Stops before starts, so one encoder handing over from one service to
    // the next is released before the next output claims it.
    for (const entry of timeline.outputs) {
      if (progress.get(entry.output.id) !== 'started') continue
      if (now < entry.endsAt + timeline.postrollMs) continue
      await this.runOutputPhase(run, plan, entry, 'stop')
      return true
    }

    for (const entry of timeline.outputs) {
      if (progress.get(entry.output.id) !== 'pending') continue
      if (now < entry.startsAt - timeline.prerollMs) continue

      if (!run.forced_at && now > entry.startsAt + timeline.lateStartGraceMs) {
        await this.markMissed(run, plan, entry, now, timeline)
        return true
      }
      if (this.deps.store.getRun(run.id).state === 'ready') this.deps.store.transition(run.id, 'running')
      await this.runOutputPhase(run, plan, entry, 'start')
      return true
    }

    const outstanding = [...progress.values()].some((state) => state === 'pending' || state === 'started')
    if (!outstanding && now >= timelineEnd(timeline) + timeline.postrollMs) {
      return this.complete(run, plan, timeline, progress)
    }
    return false
  }

  // -- phases -------------------------------------------------------------

  /**
   * Creates everything the event will need, for every output at once.
   *
   * All of it happens at one time — T minus the prepare lead — rather than
   * per output, because this is the phase whose failures a human can still
   * do something about. Finding out at 08:30 that the 11:00 broadcast
   * cannot be created is worth something; finding out at 11:00 is not.
   */
  private async prepare(run: RunRecord, plan: RunPlan, timeline: EventTimeline): Promise<boolean> {
    this.deps.store.transition(run.id, 'preparing')

    let prepared = 0
    for (const entry of timeline.outputs) {
      const result = await executeSteps(
        run.id,
        plan,
        (step) => step.outputId === entry.output.id && step.phase === 'prepare',
        this.executorDeps(),
        { phase: 'prepare', outputId: entry.output.id },
      )
      if (result.ok) prepared++
      else await this.failOutput(run, plan, entry, result.failure)
    }

    if (prepared === 0) {
      await this.failWholeRun(run, plan, {
        code: 'prepare_failed',
        message: `Nothing could be prepared for "${timeline.label}": every output failed.`,
        remediation: 'The timeline shows which step broke on each one.',
      })
      return true
    }

    this.deps.store.transition(run.id, 'ready')
    return true
  }

  private async runOutputPhase(
    run: RunRecord,
    plan: RunPlan,
    entry: OutputWindow,
    phase: 'start' | 'stop',
  ): Promise<void> {
    // Starting also picks up any of this output's prepare steps still
    // outstanding. Normally there are none — they all ran at T minus the
    // lead — but a crash part-way through the window leaves the run in
    // `running` with later outputs unprepared, and there is no second
    // prepare gate coming. The steps are ordered prepare-then-start in the
    // plan and the done ones are skipped, so in the ordinary case this
    // costs nothing.
    const phases = phase === 'start' ? ['prepare', 'start'] : ['stop']
    const result = await executeSteps(
      run.id,
      plan,
      (step) => step.outputId === entry.output.id && phases.includes(step.phase),
      this.executorDeps(),
      { phase, outputId: entry.output.id },
    )
    if (result.ok) {
      this.logger.info(phase === 'start' ? 'output is live' : 'output has stopped', {
        runId: run.id,
        output: entry.output.label,
      })
      return
    }
    await this.failOutput(run, plan, entry, result.failure, { onAir: phase === 'stop' })
  }

  private async complete(
    run: RunRecord,
    plan: RunPlan,
    timeline: EventTimeline,
    progress: Map<string, OutputProgress>,
  ): Promise<boolean> {
    this.deps.store.transition(run.id, 'completing')
    // Every output's closing work, including the ones that failed: a
    // broadcast that went out has to be ended on the channel whether or not
    // the encoder came off cleanly. An output that was compensated has no
    // external id left, so its finalize is a no-op.
    const result = await executePhase(run.id, plan, 'complete', this.executorDeps())
    if (!result.ok) {
      await this.fail(run, plan, result.failure)
      return true
    }

    const delivered = [...progress.values()].some((state) => state === 'stopped')
    if (!delivered) {
      await this.failWholeRun(run, plan, {
        code: 'nothing_aired',
        message: `Nothing from "${timeline.label}" made it to air: every output failed.`,
        remediation: 'The timeline shows which step broke on each one.',
      })
      return true
    }

    this.deps.store.transition(run.id, 'completed')
    this.deps.db.prepare("UPDATE occurrence SET status = 'done' WHERE id = ?").run(run.occurrence_id)
    return true
  }

  // -- failure ------------------------------------------------------------

  /**
   * Takes one output out of the event and leaves the rest running.
   *
   * Compensation is the difference between "never got on air" and "got on
   * air and then broke": in the first case the broadcast it created is
   * litter and is discarded, in the second it carried a service and has to
   * be closed out properly at the end.
   */
  private async failOutput(
    run: RunRecord,
    plan: RunPlan,
    entry: OutputWindow,
    failure: RunFailure,
    options: { onAir?: boolean } = {},
  ): Promise<void> {
    if (!options.onAir) await compensateOutput(run.id, plan, entry.output.id, this.executorDeps())
    this.logger.error('an output failed; the rest of the event carries on', {
      runId: run.id,
      output: entry.output.label,
      code: failure.code,
      message: failure.message,
    })
    this.notify({
      runId: run.id,
      occurrenceId: run.occurrence_id,
      failure: {
        ...failure,
        message: `${entry.output.label}: ${failure.message}`,
        ...(options.onAir
          ? {
              remediation:
                `${entry.output.label} was on air and did not stop cleanly. Check the encoder — it may still ` +
                'be streaming.',
            }
          : {}),
      },
      attempt: run.attempt,
      outputLabel: entry.output.label,
    })
  }

  /**
   * Records an output that the clock ran past.
   *
   * Written onto its start steps rather than tracked separately, so the run
   * timeline says what happened in the place someone is already looking,
   * and so the decision survives a restart without a second source of truth.
   */
  private async markMissed(
    run: RunRecord,
    plan: RunPlan,
    entry: OutputWindow,
    now: number,
    timeline: EventTimeline,
  ): Promise<void> {
    const late = Math.round((now - entry.startsAt) / 60_000)
    const message =
      `Should have started at ${new Date(entry.startsAt).toISOString()}, ${late} minutes ago, past the ` +
      `${Math.round(timeline.lateStartGraceMs / 60_000)} minute grace period. Skipped.`

    for (const [seq, step] of plan.entries()) {
      if (step.outputId !== entry.output.id || step.phase !== 'start') continue
      if (this.deps.store.step(run.id, seq).state !== 'pending') continue
      this.deps.store.markStepFailed(run.id, seq, message)
    }
    // It never got on air, so the broadcast prepared for it is litter. Left
    // in place it would be closed out at the end of the event as though it
    // had carried a service, and the channel would collect an empty public
    // entry every time the app was late.
    await compensateOutput(run.id, plan, entry.output.id, this.executorDeps())
    this.logger.warn('skipped an output the clock had run past', {
      runId: run.id,
      output: entry.output.label,
    })
    this.notify({
      runId: run.id,
      occurrenceId: run.occurrence_id,
      failure: { code: 'missed_output', message: `${entry.output.label}: ${message}`, step: entry.output.label },
      attempt: run.attempt,
      outputLabel: entry.output.label,
    })
  }

  /**
   * Fails the run once every output has failed.
   *
   * Keeps the cause a step already recorded rather than replacing it with
   * the summary: "the stored YouTube authorization was rejected, reconnect
   * the account" is the sentence somebody can act on, and "every output
   * failed" is not.
   */
  private async failWholeRun(run: RunRecord, plan: RunPlan, summary: RunFailure): Promise<void> {
    const recorded = this.recordedFailure(run.id)
    await this.fail(
      run,
      plan,
      recorded ? { ...recorded, message: `${summary.message} The first was: ${recorded.message}` } : summary,
    )
  }

  /**
   * Catches an event edited out from under a run that is already going.
   *
   * Steps are addressed by position: the plan is rebuilt from the database
   * every tick, and step 3 of the plan is matched to step 3 of the committed
   * rows. Add, remove or switch off an output mid-run and every position
   * after it shifts, so "stop the 9:00 service" would be executed against
   * the row recording the recorder. Refusing to act is the only safe answer;
   * doing nothing quietly is not, because the operator would have no idea.
   *
   * Renaming or retiming an output is fine and does not land here: a step's
   * kind carries the output's id, which does not change.
   */
  private planDrift(runId: string, plan: RunPlan): RunFailure | undefined {
    const records = this.deps.store.steps(runId)
    if (records.length === plan.length && records.every((record, seq) => record.kind === plan[seq]?.kind)) {
      return undefined
    }
    return {
      code: 'plan_changed',
      message:
        'The event was edited while this run was going: an output was added, removed or switched off, so the ' +
        'steps no longer line up with what was committed when the run started.',
      remediation:
        'Anything already on air has been left alone — check the encoder. Start the event again if it is ' +
        'still wanted, and make structural changes between events rather than during one.',
    }
  }

  private recordedFailure(runId: string): RunFailure | undefined {
    const raw = this.deps.store.getRun(runId).failure
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as RunFailure
    } catch {
      return undefined
    }
  }

  private async fail(run: RunRecord, plan: RunPlan, failure: RunFailure): Promise<void> {
    await compensateRun(run.id, plan, this.executorDeps())
    this.deps.store.recordFailure(run.id, failure)
    this.deps.store.transition(run.id, 'failed')
    this.deps.db.prepare("UPDATE occurrence SET status = 'failed' WHERE id = ?").run(run.occurrence_id)
    this.logger.error('run failed', { runId: run.id, code: failure.code, message: failure.message })
    this.notify({ runId: run.id, occurrenceId: run.occurrence_id, failure, attempt: run.attempt })
  }

  private notify(event: {
    runId: string
    occurrenceId: string
    failure: RunFailure
    attempt: number
    outputLabel?: string
  }): void {
    try {
      this.deps.onFailure?.(event)
    } catch (error) {
      // Telling somebody is best-effort; it must never turn a failed run
      // into a crashed scheduler.
      this.logger.error('the failure hook threw', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // -- operator overrides -------------------------------------------------

  /**
   * Operator override. The scheduler must never be the only way to stop a
   * stream: someone standing in a control room needs a stop button, not a
   * support ticket.
   */
  async cancel(runId: string, reason = 'Stopped by an operator'): Promise<RunState> {
    const run = this.deps.store.getRun(runId)
    if (isTerminal(run.state)) return run.state
    const plan = await this.planFor(run)

    if (isOnAir(run.state)) {
      // Something may be streaming: run the stop steps of everything that
      // actually started, so the encoder is told to stop rather than the row
      // just being marked cancelled.
      const timeline = this.timelineFor(run)
      const progress = this.progressOf(run.id, plan, timeline)
      for (const entry of timeline.outputs) {
        if (progress.get(entry.output.id) !== 'started') continue
        await executeSteps(
          runId,
          plan,
          (step) => step.outputId === entry.output.id && step.phase === 'stop',
          this.executorDeps(),
          { phase: 'stop', outputId: entry.output.id },
        )
      }
    } else {
      await compensateRun(runId, plan, this.executorDeps())
    }

    this.deps.store.recordFailure(runId, { code: 'cancelled', message: reason })
    this.deps.store.transition(runId, 'cancelled')
    this.deps.db.prepare("UPDATE occurrence SET status = 'cancelled' WHERE id = ?").run(run.occurrence_id)
    this.logger.info('run cancelled', { runId, reason })
    return 'cancelled'
  }

  /**
   * Does an occurrence's prepare phase now, ahead of its lead time.
   *
   * For the thing that has to happen before the day: an unlisted broadcast
   * exists as soon as it is prepared, so its link can be sent out to the
   * people who need it. Unlike `startNow`, the outputs keep their real
   * start times — this brings the preparation forward, not the service.
   */
  async prepareNow(occurrenceId: string): Promise<string> {
    const existing = this.deps.store.findRunForOccurrence(occurrenceId)
    if (existing && !isTerminal(existing.state)) {
      // Already has a run: prepare it if it has not been, and otherwise
      // leave it be. Pressing the button twice must not cost a broadcast.
      if (existing.state === 'scheduled' || existing.state === 'preparing') {
        await this.prepare(existing, await this.planFor(existing), this.timelineFor(existing))
      }
      return existing.id
    }

    // Planned with its real times: this brings the preparation forward, not
    // the service. The outputs still go on air when they were going to.
    const run = this.deps.store.createRun(occurrenceId, await this.deps.planner.plan(occurrenceId), {
      attempt: (existing?.attempt ?? 0) + 1,
    })
    this.deps.db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)

    // Run the prepare phase here rather than waiting for the clock: the
    // whole point is that it happens now. Everything after it stays on the
    // timeline, driven by the tick like any other run.
    const record = this.deps.store.getRun(run.id)
    await this.prepare(record, await this.planFor(record), this.timelineFor(record))
    this.logger.info('prepared a run ahead of its lead time', { runId: run.id, occurrenceId })
    return run.id
  }

  /** Creates a run for an occurrence right now, ignoring its prepare lead. */
  async startNow(occurrenceId: string): Promise<string> {
    const existing = this.deps.store.findRunForOccurrence(occurrenceId)
    if (existing && !isTerminal(existing.state)) return existing.id
    const forcedAt = this.deps.clock.now()
    const plan = await this.deps.planner.plan(occurrenceId, { forcedAt })
    const run = this.deps.store.createRun(occurrenceId, plan, {
      attempt: (existing?.attempt ?? 0) + 1,
      forcedAt,
    })
    this.deps.db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)
    return run.id
  }

  // -- reading the run ----------------------------------------------------

  /**
   * What each output has got to, derived from its step rows.
   *
   * Derived rather than stored: the step rows are already the durable record
   * of what was attempted and what landed, and a second copy of the same
   * fact is a second thing that can be wrong after a crash.
   */
  progressOf(runId: string, plan: RunPlan, timeline: EventTimeline): Map<string, OutputProgress> {
    const records = this.deps.store.steps(runId)
    const progress = new Map<string, OutputProgress>()

    for (const entry of timeline.outputs) {
      const seqs = plan
        .map((step, seq) => ({ step, seq }))
        .filter(({ step }) => step.outputId === entry.output.id)
      const stateOf = (phase: string): ('done' | 'other')[] =>
        seqs
          .filter(({ step }) => step.phase === phase)
          .map(({ seq }) => (records[seq]?.state === 'done' ? 'done' : 'other'))

      if (seqs.some(({ seq }) => records[seq]?.state === 'failed')) {
        progress.set(entry.output.id, 'failed')
        continue
      }
      const stops = stateOf('stop')
      const starts = stateOf('start')
      if (stops.length > 0 && stops.every((s) => s === 'done')) progress.set(entry.output.id, 'stopped')
      else if (starts.length > 0 && starts.every((s) => s === 'done')) progress.set(entry.output.id, 'started')
      else progress.set(entry.output.id, 'pending')
    }
    return progress
  }

  /**
   * True when the clock ran past every output and none of them got away.
   *
   * Per output rather than per event: an app that came back at 10:00 has
   * missed the 9:00 service, but the 11:00 one and the recording that runs
   * to 12:45 are still perfectly deliverable, and failing the whole event
   * would throw them away too.
   */
  private hasMissedItsWindow(
    run: RunRecord,
    timeline: EventTimeline,
    progress: Map<string, OutputProgress>,
    now: number,
  ): boolean {
    // An operator who pressed "start now" has said what they want; the
    // scheduled window no longer applies.
    if (run.forced_at !== null) return false
    if ([...progress.values()].some((state) => state !== 'pending')) return false
    return timeline.outputs.every((entry) => now > entry.startsAt + timeline.lateStartGraceMs)
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

  private timelineFor(run: RunRecord): EventTimeline {
    return timelineFor(this.deps.db, run.occurrence_id, this.forcing(run))
  }

  private async planFor(run: RunRecord): Promise<RunPlan> {
    return this.deps.planner.plan(run.occurrence_id, this.forcing(run))
  }

  private forcing(run: RunRecord): { forcedAt?: number } {
    return run.forced_at === null ? {} : { forcedAt: run.forced_at }
  }

  private executorDeps(): ExecutorDeps {
    const deps: ExecutorDeps = { store: this.deps.store, clock: this.deps.clock, logger: this.logger }
    if (this.deps.sleeper) deps.sleeper = this.deps.sleeper
    return deps
  }
}

/** Enough for a full day's outputs to prepare, start, stop and close out. */
const MAX_PASSES = 500
