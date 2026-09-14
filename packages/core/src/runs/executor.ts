import type { Clock, JsonObject } from '@scheduler/plugin-sdk'
import type { Logger } from '../log.js'
import { silentLogger } from '../log.js'
import type { RunFailure, RunStore } from './store.js'
import type { RunPhase } from './state-machine.js'
import type { RunPlan, Sleeper, StepContext, StepDefinition } from './steps.js'
import { realSleeper } from './steps.js'

export interface ExecutorDeps {
  store: RunStore
  clock: Clock
  sleeper?: Sleeper
  logger?: Logger
}

export type PhaseResult = { ok: true } | { ok: false; failure: RunFailure }

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
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId, phase })

  for (const [seq, step] of plan.entries()) {
    if (step.phase !== phase) continue

    const record = store.step(runId, seq)
    if (record.state === 'done' || record.state === 'compensated') continue

    const result = await executeStep(runId, seq, step, deps, logger)
    if (!result.ok) return result
  }
  return { ok: true }
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      if (attempt < maxAttempts) {
        await sleeper.sleep(backoffFor(attempt, step.backoffMs ?? DEFAULT_BACKOFF_MS))
      }
    }
  }

  const failure = failureFrom(step, lastError, retryable, maxAttempts)
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
export async function reconcileRun(runId: string, plan: RunPlan, deps: ExecutorDeps): Promise<void> {
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId })

  for (const record of store.steps(runId)) {
    if (record.state !== 'running') continue
    const step = plan[record.seq]
    if (!step) {
      store.markStepFailed(runId, record.seq, 'The plan no longer contains this step.')
      continue
    }

    const ctx = contextFor(runId, record.seq, step, deps, logger)

    if (!step.reconcile) {
      // Nothing can tell us whether this landed. Redo it only when the step
      // declares itself safe to repeat.
      if (step.retryable ?? true) {
        store.resetStep(runId, record.seq)
        logger.info('retrying an interrupted step', { kind: step.kind, seq: record.seq })
      } else {
        store.markStepFailed(
          runId,
          record.seq,
          'Interrupted mid-call and cannot be safely repeated. Check the destination by hand before retrying.',
        )
      }
      continue
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
      } else {
        store.resetStep(runId, record.seq)
        logger.info('interrupted step never landed; will retry', { kind: step.kind, seq: record.seq })
      }
    } catch (error) {
      logger.error('could not reconcile an interrupted step', { kind: step.kind, error: describe(error) })
      store.markStepFailed(runId, record.seq, `Could not determine whether this step landed: ${describe(error)}`)
    }
  }
}

/**
 * Undoes completed steps in reverse order when a run is abandoned.
 *
 * Without this, a run that failed after creating a broadcast leaves the
 * channel accumulating empty public "Sunday Service" entries.
 */
export async function compensateRun(runId: string, plan: RunPlan, deps: ExecutorDeps): Promise<void> {
  const { store } = deps
  const logger = (deps.logger ?? silentLogger).child({ runId })

  for (const record of [...store.steps(runId)].reverse()) {
    if (record.state !== 'done') continue
    const step = plan[record.seq]
    if (!step?.compensate) continue
    try {
      await step.compensate(contextFor(runId, record.seq, step, deps, logger))
      store.markStepCompensated(runId, record.seq)
      logger.info('compensated', { kind: step.kind, seq: record.seq })
    } catch (error) {
      // Compensation is best-effort: report it and keep unwinding the rest
      // rather than leaving even more behind.
      logger.error('compensation failed', { kind: step.kind, seq: record.seq, error: describe(error) })
    }
  }
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

function failureFrom(step: StepDefinition, error: unknown, retryable: boolean, attempts: number): RunFailure {
  const base: RunFailure = {
    code: codeOf(error) ?? 'step-failed',
    message: describe(error),
    step: step.kind,
  }
  const remediation = remediationOf(error)
  if (remediation) return { ...base, remediation }
  if (!retryable) {
    return { ...base, remediation: 'This step is not safe to repeat automatically. Check the destination by hand.' }
  }
  return { ...base, remediation: `Failed after ${attempts} attempts.` }
}

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

function remediationOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'remediation' in error && typeof error.remediation === 'string') {
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
