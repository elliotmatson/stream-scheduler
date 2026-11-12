import type { Clock, JsonObject } from '@scheduler/plugin-sdk'
import type { Logger } from '../log.js'
import { silentLogger } from '../log.js'
import type { RunFailure, RunStore, StepRecord } from './store.js'
import type { RunPhase } from './state-machine.js'
import type { RunPlan, Sleeper, StepContext, StepDefinition } from './steps.js'
import { realSleeper } from './steps.js'

export interface ExecutorDeps {
  store: RunStore
  clock: Clock
  sleeper?: Sleeper
  logger?: Logger
  /**
   * Asks the executor to stop at the next safe point: before a step, before
   * an attempt, or after a backoff. Never mid-call — a call that is in
   * flight finishes and is recorded. A step stopped this way is left
   * `pending`, so whoever takes over runs it rather than reconciling it.
   */
  signal?: AbortSignal
}

export type PhaseResult =
  | { ok: true }
  | { ok: false; failure: RunFailure; aborted?: false }
  /** Stopped because the signal fired. Not a failure: nothing broke. */
  | { ok: false; aborted: true; failure: RunFailure }

const ABORTED: PhaseResult = {
  ok: false,
  aborted: true,
  failure: { code: 'aborted', message: 'Stopped so another action could take over.' },
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/**
 * Runs every step of one phase, in order, resuming from wherever the run got to.
 *
 * The invariant this upholds: every step's row and idempotency key are already
 * committed (by `RunStore.createRun`) before any external call is made, and
 * the step is marked `running` — also committed — immediately before its
 * `execute`. A crash therefore leaves exactly one ambiguous state, which
 * `reconcileRun` resolves by asking the outside world rather than guessing.
 */
export async function executePhase(
  runId: string,
  plan: RunPlan,
  phase: RunPhase,
  deps: ExecutorDeps,
): Promise<PhaseResult> {
  return executeSteps(runId, plan, (step) => step.phase === phase, deps, { phase })
}

/**
 * Runs the selected steps, in plan order, resuming from wherever the run got
 * to.
 *
 * The selector exists because a phase is no longer one unit of work: an
 * event's four streams each have their own start, gated on their own time,
 * and one of them failing must not take the other three off air. The engine
 * selects one output's steps at a time.
 */
export async function executeSteps(
  runId: string,
  plan: RunPlan,
  select: (step: StepDefinition, seq: number) => boolean,
  deps: ExecutorDeps,
  context: { phase?: RunPhase; outputId?: string } = {},
): Promise<PhaseResult> {
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId, ...context })

  for (const [seq, step] of plan.entries()) {
    if (!select(step, seq)) continue
    if (deps.signal?.aborted) return ABORTED

    // Matched by kind, not position. A plan rebuilt after an edit can have
    // its steps in different places, and running "stop the 9:00 service"
    // against the row that records the recorder is the worst thing this
    // could do.
    const record = recordFor(store, runId, seq, step)
    if (!record) continue // added since the run was committed: not part of it
    if (record.state === 'done' || record.state === 'compensated') continue
    if (record.state === 'running') {
      // Something was in this call and never recorded the outcome. Ask the
      // world rather than doing it again blind.
      const resolved = await reconcileStep(runId, record, step, deps, logger)
      if (resolved === 'done') continue
      if (resolved === 'failed') return failedResult(store, runId, record.seq, step)
    }

    const result = await executeStep(runId, record.seq, step, deps, logger)
    if (!result.ok) return result
  }
  return { ok: true }
}

/**
 * Undoes one output's completed steps, leaving every other output alone.
 *
 * Used when a single output fails part-way through: its broadcast has to be
 * discarded, but the event and its other outputs carry on.
 */
export async function compensateOutput(
  runId: string,
  plan: RunPlan,
  outputId: string,
  deps: ExecutorDeps,
): Promise<void> {
  await compensateSelected(runId, plan, (step) => step.outputId === outputId, deps)
}

async function executeStep(
  runId: string,
  seq: number,
  step: StepDefinition,
  deps: ExecutorDeps,
  logger: Logger,
): Promise<PhaseResult> {
  const { store } = deps
  const sleeper = deps.sleeper ?? realSleeper
  const retryable = step.retryable ?? true
  const maxAttempts = retryable ? (step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) : 1

  let lastError: unknown
  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) {
      // Between attempts: the previous one failed and was not recorded as
      // such, so put the step back where the next holder will pick it up.
      if (attempt > 1) store.resetStep(runId, seq)
      return ABORTED
    }
    attempts = attempt
    // Committed before the call, so a crash mid-call is distinguishable from
    // a crash before it.
    store.markStepRunning(runId, seq)
    const ctx = contextFor(runId, seq, step, deps, logger)
    try {
      const output = await step.execute(ctx)
      store.markStepDone(runId, seq, output)
      logger.debug('step done', { kind: step.kind, seq, attempt })
      return { ok: true }
    } catch (error) {
      lastError = error
      logger.warn('step failed', { kind: step.kind, seq, attempt, error: describe(error) })
      // An error that says another attempt cannot help — a spent quota, a
      // revoked authorization, a request the service refused — is not sent
      // again. Repeating it costs quota and minutes and changes nothing.
      if (saysNotRetryable(error)) break
      if (attempt < maxAttempts) {
        await sleeper.sleep(backoffFor(attempt, step.backoffMs ?? DEFAULT_BACKOFF_MS))
      }
    }
  }

  const failure = failureFrom(step, lastError, retryable, attempts)
  store.markStepFailed(runId, seq, failure.message)
  store.recordFailure(runId, failure)
  return { ok: false, failure }
}

/**
 * Resolves steps a crash left mid-flight, before any new work is attempted.
 *
 * Never re-executes blind: a step that may have created something asks the
 * outside world whether it exists, and adopts it if so.
 */
export async function reconcileRun(
  runId: string,
  plan: RunPlan,
  deps: ExecutorDeps,
): Promise<void> {
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId })

  for (const record of store.steps(runId)) {
    if (record.state !== 'running') continue
    const step = definitionFor(plan, record)
    if (!step) {
      store.markStepFailed(runId, record.seq, 'The plan no longer contains this step.')
      continue
    }
    await reconcileStep(runId, record, step, deps, logger)
  }
}

/**
 * Settles one step whose outcome was never recorded.
 *
 * Returns what it became: `done` when the work is found to have landed,
 * `pending` when it can safely be done again, `failed` when neither can be
 * known.
 */
async function reconcileStep(
  runId: string,
  record: StepRecord,
  step: StepDefinition,
  deps: ExecutorDeps,
  logger: Logger,
): Promise<'done' | 'pending' | 'failed'> {
  const { store } = deps
  const ctx = contextFor(runId, record.seq, step, deps, logger)

  if (!step.reconcile) {
    // Nothing can tell us whether this landed. Redo it only when the step
    // declares itself safe to repeat.
    if (step.retryable ?? true) {
      store.resetStep(runId, record.seq)
      logger.info('retrying an interrupted step', { kind: step.kind, seq: record.seq })
      return 'pending'
    }
    store.markStepFailed(
      runId,
      record.seq,
      'Interrupted mid-call and cannot be safely repeated. Check the destination by hand before retrying.',
    )
    return 'failed'
  }

  try {
    const existing = await step.reconcile(ctx)
    if (existing) {
      store.markStepDone(runId, record.seq, existing)
      logger.info('adopted work an interrupted step had already done', {
        kind: step.kind,
        seq: record.seq,
        externalId: existing.externalId ?? null,
      })
      return 'done'
    }
    store.resetStep(runId, record.seq)
    logger.info('interrupted step never landed; will retry', {
      kind: step.kind,
      seq: record.seq,
    })
    return 'pending'
  } catch (error) {
    logger.error('could not reconcile an interrupted step', {
      kind: step.kind,
      error: describe(error),
    })
    store.markStepFailed(
      runId,
      record.seq,
      `Could not determine whether this step landed: ${describe(error)}`,
    )
    return 'failed'
  }
}

/**
 * Undoes completed steps in reverse order when a run is abandoned.
 *
 * Without this, a run that failed after creating a broadcast leaves the
 * channel accumulating empty public "Sunday Service" entries.
 */
export async function compensateRun(
  runId: string,
  plan: RunPlan,
  deps: ExecutorDeps,
): Promise<void> {
  await compensateSelected(runId, plan, () => true, deps)
}

async function compensateSelected(
  runId: string,
  plan: RunPlan,
  select: (step: StepDefinition) => boolean,
  deps: ExecutorDeps,
): Promise<void> {
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId })

  for (const record of [...store.steps(runId)].reverse()) {
    if (record.state !== 'done') continue
    const step = definitionFor(plan, record)
    if (!step?.compensate || !select(step)) continue
    try {
      await step.compensate(contextFor(runId, record.seq, step, deps, logger))
      store.markStepCompensated(runId, record.seq)
      logger.info('compensated', { kind: step.kind, seq: record.seq })
    } catch (error) {
      // Compensation is best-effort: report it and keep unwinding the rest
      // rather than leaving even more behind.
      logger.error('compensation failed', {
        kind: step.kind,
        seq: record.seq,
        error: describe(error),
      })
    }
  }
}

/**
 * The committed row a plan step refers to.
 *
 * The row at the same position when its kind agrees, which is every case
 * but one; otherwise the row with that kind, wherever it is. A step with no
 * row at all was added to the event after the run committed its plan.
 */
export function recordFor(
  store: RunStore,
  runId: string,
  seq: number,
  step: StepDefinition,
): StepRecord | undefined {
  const records = store.steps(runId)
  const atSeq = records[seq]
  if (atSeq?.kind === step.kind) return atSeq
  return records.find((record) => record.kind === step.kind)
}

/** The plan's definition for a committed row, matched by kind. */
export function definitionFor(plan: RunPlan, record: StepRecord): StepDefinition | undefined {
  const atSeq = plan[record.seq]
  if (atSeq?.kind === record.kind) return atSeq
  return plan.find((step) => step.kind === record.kind)
}

function failedResult(
  store: RunStore,
  runId: string,
  seq: number,
  step: StepDefinition,
): PhaseResult {
  const failure: RunFailure = {
    code: 'step-failed',
    message: store.step(runId, seq).error ?? 'Interrupted and could not be resolved.',
    step: step.kind,
  }
  store.recordFailure(runId, failure)
  return { ok: false, failure }
}

function contextFor(
  runId: string,
  seq: number,
  step: StepDefinition,
  deps: ExecutorDeps,
  logger: Logger,
): StepContext {
  const record = deps.store.step(runId, seq)
  const run = deps.store.getRun(runId)
  return {
    runId,
    occurrenceId: run.occurrence_id,
    idempotencyKey: record.idempotency_key,
    attempt: record.attempts,
    outputs: deps.store.outputs(runId),
    log: (message: string, data?: JsonObject) => logger.info(message, { kind: step.kind, ...data }),
  }
}

function failureFrom(
  step: StepDefinition,
  error: unknown,
  retryable: boolean,
  attempts: number,
): RunFailure {
  const base: RunFailure = {
    code: codeOf(error) ?? 'step-failed',
    message: describe(error),
    step: step.kind,
  }
  const remediation = remediationOf(error)
  if (remediation) return { ...base, remediation }
  if (!retryable) {
    return {
      ...base,
      remediation: 'This step is not safe to repeat automatically. Check the destination by hand.',
    }
  }
  return { ...base, remediation: `Failed after ${attempts} attempt${attempts === 1 ? '' : 's'}.` }
}

function saysNotRetryable(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === false
  )
}

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code
  return undefined
}

function remediationOf(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'remediation' in error &&
    typeof error.remediation === 'string'
  ) {
    return error.remediation
  }
  return undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function backoffFor(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}
