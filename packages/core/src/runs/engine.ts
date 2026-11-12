import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import {
  compensateOutput,
  compensateRun,
  executeSteps,
  reconcileRun,
  recordFor,
  type ExecutorDeps,
  type PhaseResult,
} from './executor.js'
import { isTerminal, type RunState } from './state-machine.js'
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
  /**
   * Called when a run or one of its outputs reaches air, or comes off it
   * cleanly. A hook for the same reason `onFailure` is: the engine's job is
   * to drive the timeline, and it should not know that notifications exist.
   *
   * Nothing here is a problem. These are the "it worked" messages, which
   * is why they are off unless a channel asks for them by name.
   */
  onLifecycle?: (event: {
    kind: 'run.started' | 'run.finished' | 'output.started' | 'output.finished'
    runId: string
    occurrenceId: string
    /** Absent on the two run-level events. */
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
  /** The last error logged for each run that would not advance. */
  private readonly reportedErrors = new Map<string, string>()
  /**
   * Who is driving each run, or creating a run for each occurrence, right
   * now. One process, so a map is enough.
   *
   * Without it the tick, a Start now, a Stop now and an overrunning tick
   * that was given up on can all be working on the same run at once — and
   * the result is two broadcasts for one service, or a stream that comes up
   * after the run was marked cancelled and is never stopped.
   */
  private readonly holders = new Map<string, { done: Promise<void>; abort: AbortController }>()

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
      // One run that cannot be reconciled must not leave the rest
      // unreconciled, nor stop the app from starting at all.
      try {
        await reconcileRun(run.id, await this.planFor(run), this.executorDeps(run.id))
        recovered.push(run.id)
        this.logger.info('recovered a run interrupted by a restart', {
          runId: run.id,
          state: run.state,
        })
      } catch (error) {
        this.logger.error('could not recover a run interrupted by a restart', {
          runId: run.id,
          state: run.state,
          error: describeError(error),
        })
      }
    }
    return recovered
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { created: [], advanced: [], failed: [], completed: [] }
    const now = this.deps.clock.now()

    for (const occurrenceId of this.dueOccurrences(now)) {
      // Skipped when an operator is creating a run for it this instant;
      // the next tick sees theirs.
      await this.exclusive(occurrenceKey(occurrenceId), { wait: false }, async () => {
        if (this.activeRunFor(occurrenceId)) return
        let plan: RunPlan | undefined
        let planError: unknown
        try {
          plan = await this.deps.planner.plan(occurrenceId)
        } catch (error) {
          planError = error
        }
        // An occurrence that cannot be planned still gets a run, failed on
        // the spot. That puts it on the Runs page and in an alert rather
        // than in a log line repeated every five seconds, and it stops the
        // occurrence being due again on the next tick.
        const run = this.deps.store.createRun(occurrenceId, plan ?? [])
        this.deps.db
          .prepare("UPDATE occurrence SET status = 'running' WHERE id = ?")
          .run(occurrenceId)
        report.created.push(run.id)
        this.logger.info('created a run', { runId: run.id, occurrenceId })
        if (planError !== undefined) {
          await this.fail(run, [], planFailure(planError))
          report.failed.push(run.id)
        }
      })
    }

    for (const run of this.deps.store.listActiveRuns()) {
      // Each run is isolated: one that throws is logged and the others
      // still advance. Without this, a single bad run would stop every
      // other service from starting, on every tick, for as long as it
      // stayed bad.
      try {
        const before = run.state
        // A run somebody else is driving — an operator's Start now, a Stop
        // now, or a tick that overran and is still going — is left to them.
        const outcome = await this.exclusive(run.id, { wait: false }, (signal) =>
          this.drive(run.id, signal),
        )
        if (!outcome.ran) continue
        const after = outcome.value
        if (after !== before) report.advanced.push(run.id)
        if (after === 'failed') report.failed.push(run.id)
        if (after === 'completed') report.completed.push(run.id)
        this.reportedErrors.delete(run.id)
      } catch (error) {
        const message = describeError(error)
        // Logged once per distinct error, not every five seconds.
        if (this.reportedErrors.get(run.id) !== message) {
          this.reportedErrors.set(run.id, message)
          this.logger.error('could not advance a run; the others carry on', {
            runId: run.id,
            error: message,
          })
        }
      }
    }
    return report
  }

  /**
   * Drives one run as far as the clock currently allows, waiting for
   * whoever is driving it now to finish first.
   */
  async advance(runId: string): Promise<RunState> {
    const outcome = await this.exclusive(runId, { wait: true }, (signal) =>
      this.drive(runId, signal),
    )
    return outcome.ran ? outcome.value : this.deps.store.getRun(runId).state
  }

  /** The body of `advance`, for a caller that already holds the run. */
  private async drive(runId: string, signal: AbortSignal): Promise<RunState> {
    // A single tick can cross several boundaries — a run whose whole window
    // elapsed while the machine was asleep has to prepare, start, stop and
    // complete in one go — so keep going while progress is being made.
    //
    // The bound is a backstop, not a limit: each pass either commits a step
    // or a transition, so a run that keeps asking for another pass without
    // recording anything is a bug, and spinning on it forever inside a tick
    // would take the scheduler down with it.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (signal.aborted) return this.deps.store.getRun(runId).state
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

    // A Stop now that could not wait for the run to be free, or that was
    // pressed just before a restart. It comes before everything else.
    if (run.cancel_requested_at !== null) {
      await this.closeCancelled(run, run.cancel_reason ?? 'Stopped by an operator')
      return true
    }

    const timeline = this.timelineFor(run)
    let plan: RunPlan
    try {
      plan = await this.planFor(run)
    } catch (error) {
      // The event was edited into something that cannot be planned — its
      // device deleted, its destination removed. Before anything has been
      // done that is a plain failure. Once steps have run, failing would
      // compensate against a plan that cannot be built, so the error is
      // left to the tick to report and the run is retried next time.
      const touched = this.deps.store.steps(run.id).some((step) => step.state !== 'pending')
      if (touched) throw error
      await this.fail(run, [], planFailure(error))
      return true
    }
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
      await this.fail(run, plan, drift, 'drift')
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
        remediation:
          'Start it manually if it is still wanted, or widen the late-start grace on the event.',
      })
      return true
    }

    if (run.state === 'scheduled' || run.state === 'preparing') {
      if (!(run.forced_at !== null || now >= timeline.windowStart - timeline.prepareLeadMs))
        return false
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
      if (this.deps.store.getRun(run.id).state === 'ready') {
        this.deps.store.transition(run.id, 'running')
        // The moment the event is actually on air, which is the one people
        // mean by "did it start?". Not when the run was created, and not
        // when it prepared half an hour earlier.
        this.deps.onLifecycle?.({
          kind: 'run.started',
          runId: run.id,
          occurrenceId: run.occurrence_id,
        })
      }
      await this.runOutputPhase(run, plan, entry, 'start')
      return true
    }

    const outstanding = [...progress.values()].some(
      (state) => state === 'pending' || state === 'started',
    )
    if (!outstanding && now >= timelineEnd(timeline) + timeline.postrollMs) {
      return this.complete(run, plan, timeline)
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
        this.executorDeps(run.id),
        { phase: 'prepare', outputId: entry.output.id },
      )
      if (result.ok) prepared++
      else if (result.aborted) return false
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
      this.executorDeps(run.id),
      { phase, outputId: entry.output.id },
    )
    if (!result.ok && result.aborted) return
    if (result.ok) {
      this.logger.info(phase === 'start' ? 'output is live' : 'output has stopped', {
        runId: run.id,
        output: entry.output.label,
      })
      this.deps.onLifecycle?.({
        kind: phase === 'start' ? 'output.started' : 'output.finished',
        runId: run.id,
        occurrenceId: run.occurrence_id,
        outputLabel: entry.output.label,
      })
      return
    }
    await this.failOutput(run, plan, entry, result.failure, { onAir: phase === 'stop' })
  }

  private async complete(run: RunRecord, plan: RunPlan, timeline: EventTimeline): Promise<boolean> {
    this.deps.store.transition(run.id, 'completing')
    // Every output's closing work, each on its own: one broadcast that will
    // not end cleanly is no reason to leave the others open. An output that
    // was compensated has no external id left, so its finalize is a no-op.
    const failures: { label: string; failure: RunFailure }[] = []
    for (const entry of timeline.outputs) {
      const result = await executeSteps(
        run.id,
        plan,
        (step) => step.outputId === entry.output.id && step.phase === 'complete',
        this.executorDeps(run.id),
        { phase: 'complete', outputId: entry.output.id },
      )
      if (!result.ok && result.aborted) return false
      if (!result.ok) failures.push({ label: entry.output.label, failure: result.failure })
    }
    const shared = await executeSteps(
      run.id,
      plan,
      (step) => step.outputId === undefined && step.phase === 'complete',
      this.executorDeps(run.id),
      { phase: 'complete' },
    )
    if (!shared.ok && shared.aborted) return false
    if (!shared.ok) failures.push({ label: timeline.label, failure: shared.failure })

    if (failures.length > 0) {
      // Not compensated: these broadcasts carried a service. Deleting them
      // because closing one out failed would throw away what people watched.
      const first = failures[0]!
      this.finish(run, 'failed', {
        code: 'finalize_failed',
        message:
          `${first.label}: ${first.failure.message}` +
          (failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''),
        remediation:
          first.failure.remediation ??
          'Everything that aired has been kept. End the broadcast on the service by hand if it is still open.',
      })
      return true
    }

    const delivered = timeline.outputs.some((entry) => this.aired(run.id, plan, entry.output.id))
    if (!delivered) {
      await this.failWholeRun(run, plan, {
        code: 'nothing_aired',
        message: `Nothing from "${timeline.label}" made it to air: every output failed.`,
        remediation: 'The timeline shows which step broke on each one.',
      })
      return true
    }

    this.deps.store.transition(run.id, 'completed')
    this.deps.db
      .prepare("UPDATE occurrence SET status = 'done' WHERE id = ?")
      .run(run.occurrence_id)
    this.deps.onLifecycle?.({
      kind: 'run.finished',
      runId: run.id,
      occurrenceId: run.occurrence_id,
    })
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
    if (!options.onAir)
      await compensateOutput(run.id, plan, entry.output.id, this.executorDeps(run.id))
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
      const record = recordFor(this.deps.store, run.id, seq, step)
      if (record?.state !== 'pending') continue
      this.deps.store.markStepFailed(run.id, record.seq, message)
    }
    // It never got on air, so the broadcast prepared for it is litter. Left
    // in place it would be closed out at the end of the event as though it
    // had carried a service, and the channel would collect an empty public
    // entry every time the app was late.
    await compensateOutput(run.id, plan, entry.output.id, this.executorDeps(run.id))
    this.logger.warn('skipped an output the clock had run past', {
      runId: run.id,
      output: entry.output.label,
    })
    this.notify({
      runId: run.id,
      occurrenceId: run.occurrence_id,
      failure: {
        code: 'missed_output',
        message: `${entry.output.label}: ${message}`,
        step: entry.output.label,
      },
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
      recorded
        ? { ...recorded, message: `${summary.message} The first was: ${recorded.message}` }
        : summary,
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
    if (
      records.length === plan.length &&
      records.every((record, seq) => record.kind === plan[seq]?.kind)
    ) {
      return undefined
    }
    return {
      code: 'plan_changed',
      message:
        'The event was edited while this run was going: an output was added, removed or switched off, so the ' +
        'steps no longer line up with what was committed when the run started.',
      remediation:
        'Start the event again if it is still wanted, and make structural changes between events rather ' +
        'than during one.',
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

  /**
   * Ends a run that went wrong.
   *
   * What happens to each output depends on whether it reached air, never on
   * why the run failed: what aired is closed out and kept, because people
   * watched it; what never aired is undone, because an empty scheduled
   * broadcast is litter on the channel. When the plan no longer matches
   * what was committed (`drift`), nothing that aired is touched at all.
   */
  private async fail(
    run: RunRecord,
    plan: RunPlan,
    failure: RunFailure,
    mode: 'fail' | 'drift' = 'fail',
  ): Promise<void> {
    const leftOnAir = await this.closeOut(run, plan, mode)
    this.finish(
      run,
      'failed',
      mode === 'drift' && leftOnAir.length > 0
        ? {
            ...failure,
            remediation:
              `Left as they were: ${leftOnAir.join(', ')} — check the encoder, it may still be streaming. ` +
              (failure.remediation ?? ''),
          }
        : failure,
    )
  }

  /** Records how a run ended and tells whoever listens. */
  private finish(run: RunRecord, to: 'failed' | 'cancelled', failure: RunFailure): void {
    this.deps.store.recordFailure(run.id, failure)
    this.deps.store.transition(run.id, to)
    this.deps.store.clearCancelRequest(run.id)
    this.deps.db.prepare('UPDATE occurrence SET status = ? WHERE id = ?').run(to, run.occurrence_id)
    if (to === 'failed') {
      this.logger.error('run failed', {
        runId: run.id,
        code: failure.code,
        message: failure.message,
      })
      this.notify({ runId: run.id, occurrenceId: run.occurrence_id, failure, attempt: run.attempt })
    } else {
      this.logger.info('run cancelled', { runId: run.id, reason: failure.message })
    }
  }

  /**
   * Winds every output down according to whether it aired.
   *
   * Returns the labels of outputs that aired, for whoever reports the end.
   */
  private async closeOut(
    run: RunRecord,
    plan: RunPlan,
    mode: 'fail' | 'cancel' | 'drift',
  ): Promise<string[]> {
    const deps = this.executorDeps(run.id)
    const timeline = this.timelineFor(run)
    const aired = timeline.outputs.filter((entry) => this.aired(run.id, plan, entry.output.id))
    const neverAired = timeline.outputs.filter((entry) => !aired.includes(entry))

    if (mode === 'cancel') {
      // Told to stop rather than left running: what is on air is taken off.
      const progress = this.progressOf(run.id, plan, timeline)
      for (const entry of aired) {
        if (progress.get(entry.output.id) !== 'started') continue
        const result = await executeSteps(
          run.id,
          plan,
          (step) => step.outputId === entry.output.id && step.phase === 'stop',
          deps,
          { phase: 'stop', outputId: entry.output.id },
        )
        this.logIfFailed(run, entry, 'stopping', result)
      }
    }

    if (mode !== 'drift') {
      for (const entry of aired) {
        const result = await executeSteps(
          run.id,
          plan,
          (step) => step.outputId === entry.output.id && step.phase === 'complete',
          deps,
          { phase: 'complete', outputId: entry.output.id },
        )
        this.logIfFailed(run, entry, 'closing out', result)
      }
    }

    if (aired.length === 0) {
      // Nothing reached air, so everything the run made is litter —
      // including steps that belong to no single output.
      await compensateRun(run.id, plan, deps)
    } else {
      for (const entry of neverAired) await compensateOutput(run.id, plan, entry.output.id, deps)
    }

    // Outputs switched off or deleted while the run was going are not in
    // the plan any more, but what they made still exists. The planner
    // rebuilds enough of their steps from the committed rows to undo it.
    const removedLeftOnAir = await this.cleanUpRemovedOutputs(run, plan)
    return [...aired.map((entry) => entry.output.label), ...removedLeftOnAir]
  }

  /**
   * Undoes what outputs that have left the event made, unless they aired.
   * Returns the labels of any that did air, which are left alone.
   */
  private async cleanUpRemovedOutputs(run: RunRecord, plan: RunPlan): Promise<string[]> {
    const known = new Set(plan.map((step) => step.kind))
    const removed = this.deps.store.steps(run.id).filter((record) => !known.has(record.kind))
    if (removed.length === 0 || !this.deps.planner.orphans) return []

    const orphans = this.deps.planner.orphans(removed)
    const full = [...plan, ...orphans]
    const outputIds = [
      ...new Set(orphans.map((step) => step.outputId).filter((id) => id !== undefined)),
    ]
    const leftOnAir: string[] = []
    for (const outputId of outputIds) {
      if (this.aired(run.id, full, outputId)) {
        const label = orphans.find((step) => step.outputId === outputId)?.label
        leftOnAir.push(label?.split(':')[0] ?? 'an output that was removed')
        continue
      }
      await compensateOutput(run.id, full, outputId, this.executorDeps(run.id))
      this.logger.info('cleaned up after an output removed mid-run', { runId: run.id, outputId })
    }
    return leftOnAir
  }

  private logIfFailed(
    run: RunRecord,
    entry: OutputWindow,
    doing: string,
    result: PhaseResult,
  ): void {
    if (result.ok) return
    this.logger.error(`${doing} an output failed while the run was wound down`, {
      runId: run.id,
      output: entry.output.label,
      message: result.failure.message,
    })
  }

  /**
   * Whether an output ever reached air.
   *
   * Every start step done; or the last one was in flight, which means the
   * device may well have gone live before anything was recorded; or the
   * output was told to stop. Anything less never aired.
   */
  private aired(runId: string, plan: RunPlan, outputId: string): boolean {
    const records = this.deps.store.steps(runId)
    const recordOf = (kind: string) => records.find((record) => record.kind === kind)
    const ofOutput = plan.filter((step) => step.outputId === outputId)
    const starts = ofOutput.filter((step) => step.phase === 'start').map((s) => recordOf(s.kind))
    const stops = ofOutput.filter((step) => step.phase === 'stop').map((s) => recordOf(s.kind))
    if (starts.length > 0 && starts.every((record) => record?.state === 'done')) return true
    if (starts.at(-1)?.state === 'running') return true
    return stops.some((record) => record !== undefined && record.attempts > 0)
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

    // Written down first, so a restart before it is acted on still stops
    // the run, and so whoever is driving it acts on it if this cannot wait.
    this.deps.store.requestCancel(runId, reason)
    // Ask whoever is driving the run to stop at its next safe point — not
    // mid-call, so a start in flight finishes and is recorded, then stopped.
    this.holders.get(runId)?.abort.abort()

    const cancelling = this.exclusive(runId, { wait: true }, async () => {
      const current = this.deps.store.getRun(runId)
      if (!isTerminal(current.state)) await this.closeCancelled(current, reason)
    })
    // A device that never answers must not hang the stop button. Past the
    // wait, the request stands and is carried out when the run is free.
    const settled = await Promise.race([
      cancelling.then(() => true),
      delay(CANCEL_WAIT_MS).then(() => false),
    ])
    if (!settled) {
      this.logger.warn('stop requested; waiting for a device call to finish first', { runId })
    }
    return this.deps.store.getRun(runId).state
  }

  /** Stops what is on air, keeps what aired, undoes what did not. */
  private async closeCancelled(run: RunRecord, reason: string): Promise<void> {
    const plan = await this.planFor(run)
    await this.closeOut(run, plan, 'cancel')
    this.finish(run, 'cancelled', { code: 'cancelled', message: reason })
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
    const outcome = await this.exclusive(
      occurrenceKey(occurrenceId),
      { wait: true },
      async (): Promise<string> => {
        const existing = this.deps.store.findRunForOccurrence(occurrenceId)
        if (existing && !isTerminal(existing.state)) return existing.id
        // Planned with its real times: this brings the preparation forward,
        // not the service. The outputs still go on air when they were going to.
        const run = this.deps.store.createRun(
          occurrenceId,
          await this.deps.planner.plan(occurrenceId),
          { attempt: (existing?.attempt ?? 0) + 1 },
        )
        this.deps.db
          .prepare("UPDATE occurrence SET status = 'running' WHERE id = ?")
          .run(occurrenceId)
        return run.id
      },
    )
    if (!outcome.ran) throw new Error('unreachable: waited for the occurrence')
    const runId = outcome.value

    // Run the prepare phase here rather than waiting for the clock: the
    // whole point is that it happens now. Pressing the button twice must
    // not cost a broadcast, so a run already past preparing is left be.
    // Everything after it stays on the timeline, driven by the tick.
    await this.exclusive(runId, { wait: true }, async () => {
      const record = this.deps.store.getRun(runId)
      if (record.state !== 'scheduled' && record.state !== 'preparing') return
      await this.prepare(record, await this.planFor(record), this.timelineFor(record))
    })
    this.logger.info('prepared a run ahead of its lead time', { runId, occurrenceId })
    return runId
  }

  /** Creates a run for an occurrence right now, ignoring its prepare lead. */
  async startNow(occurrenceId: string): Promise<string> {
    const outcome = await this.exclusive(
      occurrenceKey(occurrenceId),
      { wait: true },
      async (): Promise<string> => {
        const existing = this.deps.store.findRunForOccurrence(occurrenceId)
        if (existing && !isTerminal(existing.state)) return existing.id
        const forcedAt = this.deps.clock.now()
        const plan = await this.deps.planner.plan(occurrenceId, { forcedAt })
        const run = this.deps.store.createRun(occurrenceId, plan, {
          attempt: (existing?.attempt ?? 0) + 1,
          forcedAt,
        })
        this.deps.db
          .prepare("UPDATE occurrence SET status = 'running' WHERE id = ?")
          .run(occurrenceId)
        return run.id
      },
    )
    if (!outcome.ran) throw new Error('unreachable: waited for the occurrence')
    return outcome.value
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

    const stateByKind = new Map(records.map((record) => [record.kind, record.state]))
    for (const entry of timeline.outputs) {
      const steps = plan.filter((step) => step.outputId === entry.output.id)
      const stateOf = (phase: string): ('done' | 'other')[] =>
        steps
          .filter((step) => step.phase === phase)
          .map((step) => (stateByKind.get(step.kind) === 'done' ? 'done' : 'other'))

      if (steps.some((step) => stateByKind.get(step.kind) === 'failed')) {
        progress.set(entry.output.id, 'failed')
        continue
      }
      const stops = stateOf('stop')
      const starts = stateOf('start')
      if (stops.length > 0 && stops.every((s) => s === 'done'))
        progress.set(entry.output.id, 'stopped')
      else if (starts.length > 0 && starts.every((s) => s === 'done'))
        progress.set(entry.output.id, 'started')
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

  private executorDeps(runId: string): ExecutorDeps {
    const deps: ExecutorDeps = {
      store: this.deps.store,
      clock: this.deps.clock,
      logger: this.logger,
    }
    if (this.deps.sleeper) deps.sleeper = this.deps.sleeper
    const signal = this.holders.get(runId)?.abort.signal
    if (signal) deps.signal = signal
    return deps
  }

  private activeRunFor(occurrenceId: string): RunRecord | undefined {
    const run = this.deps.store.findRunForOccurrence(occurrenceId)
    return run && !isTerminal(run.state) ? run : undefined
  }

  /**
   * Runs `work` as the only thing driving `key` — a run's id, or an
   * occurrence's key while a run is being created for it.
   *
   * With `wait`, queues behind whoever holds it; without, gives up and
   * reports that nothing ran, which is what the tick wants.
   */
  private async exclusive<T>(
    key: string,
    options: { wait: boolean },
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    for (;;) {
      const held = this.holders.get(key)
      if (!held) break
      if (!options.wait) return { ran: false }
      await held.done
    }
    const abort = new AbortController()
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    this.holders.set(key, { done, abort })
    try {
      return { ran: true, value: await work(abort.signal) }
    } finally {
      this.holders.delete(key)
      release()
    }
  }
}

/** Enough for a full day's outputs to prepare, start, stop and close out. */
const MAX_PASSES = 500

/** How long Stop now waits for a device call in flight before answering. */
const CANCEL_WAIT_MS = 30_000

const occurrenceKey = (occurrenceId: string): string => `occurrence:${occurrenceId}`

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The failure recorded for a run whose plan could not be built. */
function planFailure(error: unknown): RunFailure {
  return {
    code: 'plan_failed',
    message: `This event could not be planned: ${describeError(error)}`,
    remediation:
      "Check the event's streams and recordings point at devices and services that still exist.",
  }
}
