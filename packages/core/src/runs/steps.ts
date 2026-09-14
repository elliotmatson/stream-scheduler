import type { JsonObject, JsonValue } from '@scheduler/plugin-sdk'
import type { RunPhase } from './state-machine.js'

export interface StepOutput {
  /** What the outside world called the thing this step made. Recorded so a
   *  crashed run can adopt it instead of making a second one. */
  externalId?: string
  response?: JsonValue
}

export interface StepContext {
  runId: string
  occurrenceId: string
  /** Generated and committed before the external call, so a reconcile can
   *  recognise work this run already did. */
  idempotencyKey: string
  attempt: number
  /** Outputs of earlier steps in this run, keyed by step kind. */
  outputs: Readonly<Record<string, StepOutput>>
  log(message: string, data?: JsonObject): void
}

export interface StepDefinition {
  kind: string
  phase: RunPhase
  /**
   * Which output this step drives, if any.
   *
   * The engine gates `start` and `stop` on this: an output that goes on at
   * 9:00 and off at 10:15 has its steps run then, not when the event's
   * window opens. It is also the unit of failure — one stream failing to
   * come up does not abandon the recording or the 11:00 service.
   */
  outputId?: string
  /** Shown on the run timeline. The kind carries an output id, which is
   *  stable but unreadable. */
  label?: string
  /**
   * Safe to run again after an ambiguous failure?
   *
   * Most steps are: creating a broadcast is guarded by the idempotency key,
   * and starting an already-started stream is a verified no-op. A step that
   * is not safely retryable fails the run rather than guessing.
   */
  retryable?: boolean
  maxAttempts?: number
  backoffMs?: number
  /** Recorded on the timeline, redacted. */
  request?: JsonObject
  execute(ctx: StepContext): Promise<StepOutput | void>
  /**
   * Ask the outside world whether this step already happened.
   *
   * Called during recovery for a step left mid-flight by a crash. Return the
   * output to adopt existing work, or undefined if the call never landed.
   * Without this a step can only be guessed at, which is how you end up with
   * three broadcasts for one service.
   */
  reconcile?(ctx: StepContext): Promise<StepOutput | undefined>
  /** Undo this step's effect when the run is abandoned, so a half-prepared
   *  run does not leave litter on the channel. */
  compensate?(ctx: StepContext): Promise<void>
}

export type RunPlan = StepDefinition[]

/**
 * Supplies the steps for an occurrence. Swapped for a fake in tests.
 *
 * Takes only the occurrence: a plan is a description of work, and the run's
 * identity and per-step idempotency keys are assigned by the store when the
 * run is created. Keeping runId out of here is what lets the engine build a
 * plan before the run exists.
 */
export interface RunPlanner {
  /**
   * `forcedAt` moves the whole event's window to the moment an operator
   * pressed the button, so the outputs keep their offsets relative to each
   * other instead of the first three being instantly in the past.
   */
  plan(occurrenceId: string, options?: { forcedAt?: number }): Promise<RunPlan> | RunPlan
}

export function stepsForPhase(plan: RunPlan, phase: RunPhase): StepDefinition[] {
  return plan.filter((step) => step.phase === phase)
}

export function stepsForOutput(plan: RunPlan, outputId: string): StepDefinition[] {
  return plan.filter((step) => step.outputId === outputId)
}

/** Lets tests run the executor without real delays. */
export interface Sleeper {
  sleep(ms: number): Promise<void>
}

export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const immediateSleeper: Sleeper = { sleep: async () => {} }
