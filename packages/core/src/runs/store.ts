import { randomUUID } from 'node:crypto'
import type { Clock, JsonObject, JsonValue } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { scrubber as defaultScrubber, type Scrubber } from '../secrets/scrubber.js'
import { assertTransition, type RunState } from './state-machine.js'
import type { RunPlan, StepOutput } from './steps.js'

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'compensated'

export interface RunRecord {
  id: string
  occurrence_id: string
  state: RunState
  attempt: number
  created_at: number
  started_at: number | null
  ended_at: number | null
  resolved: string | null
  failure: string | null
  /** Set when an operator started this run by hand; see RunEngine.startNow. */
  forced_at: number | null
}

export interface StepRecord {
  id: string
  run_id: string
  seq: number
  kind: string
  label: string | null
  state: StepState
  idempotency_key: string
  external_id: string | null
  attempts: number
  request: string | null
  response: string | null
  error: string | null
  started_at: number | null
  ended_at: number | null
}

export interface RunFailure {
  code: string
  message: string
  step?: string
  remediation?: string
}

/**
 * All persistence for runs and their steps.
 *
 * The load-bearing rule lives here rather than in each step implementation:
 * a step's row, including its idempotency key, is committed before the
 * external call is made. `createRun` writes every step up front for exactly
 * that reason.
 */
export class RunStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly scrubber: Scrubber = defaultScrubber,
  ) {}

  /** Creates the run and every step row in one transaction. */
  createRun(
    occurrenceId: string,
    plan: RunPlan,
    options: { attempt?: number; forcedAt?: number } = {},
  ): RunRecord {
    const runId = randomUUID()
    const attempt = options.attempt ?? 1
    const now = this.clock.now()

    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO run (id, occurrence_id, state, attempt, created_at, forced_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(runId, occurrenceId, 'scheduled', attempt, now, options.forcedAt ?? null)
      const insert = this.db.prepare(
        `INSERT INTO run_step (id, run_id, seq, kind, label, state, idempotency_key, request)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      plan.forEach((step, index) => {
        insert.run(
          randomUUID(),
          runId,
          index,
          step.kind,
          step.label ?? null,
          idempotencyKey(runId, index, step.kind),
          step.request ? JSON.stringify(this.scrubber.redactValue(step.request)) : null,
        )
      })
    })()

    return this.getRun(runId)
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM run WHERE id = ?').get(runId) as
      RunRecord | undefined
    if (!row) throw new Error(`No run with id "${runId}".`)
    return row
  }

  findRunForOccurrence(occurrenceId: string): RunRecord | undefined {
    return this.db
      .prepare('SELECT * FROM run WHERE occurrence_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(occurrenceId) as RunRecord | undefined
  }

  /** Every run the engine still has work to do on. */
  listActiveRuns(): RunRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM run WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at",
      )
      .all() as RunRecord[]
  }

  steps(runId: string): StepRecord[] {
    return this.db
      .prepare('SELECT * FROM run_step WHERE run_id = ? ORDER BY seq')
      .all(runId) as StepRecord[]
  }

  step(runId: string, seq: number): StepRecord {
    const row = this.db
      .prepare('SELECT * FROM run_step WHERE run_id = ? AND seq = ?')
      .get(runId, seq) as StepRecord | undefined
    if (!row) throw new Error(`Run "${runId}" has no step ${seq}.`)
    return row
  }

  /**
   * Outputs of completed steps, keyed by kind, for later steps to consume.
   *
   * These come back from the database, which means they have been through
   * the scrubber: a field whose *name* looks like a secret reads back as
   * "[redacted]". Pass identifiers a later step can derive for itself
   * rather than routing anything sensitive-looking through here.
   */
  outputs(runId: string): Record<string, StepOutput> {
    const out: Record<string, StepOutput> = {}
    for (const step of this.steps(runId)) {
      if (step.state !== 'done') continue
      out[step.kind] = {
        ...(step.external_id === null ? {} : { externalId: step.external_id }),
        ...(step.response === null ? {} : { response: JSON.parse(step.response) as JsonValue }),
      }
    }
    return out
  }

  transition(runId: string, to: RunState): void {
    const run = this.getRun(runId)
    if (run.state === to) return
    assertTransition(run.state, to)
    const now = this.clock.now()
    const startedAt = run.started_at ?? (to === 'preparing' ? now : null)
    const endedAt = to === 'completed' || to === 'failed' || to === 'cancelled' ? now : null
    this.db
      .prepare('UPDATE run SET state = ?, started_at = ?, ended_at = ? WHERE id = ?')
      .run(to, startedAt, endedAt, runId)
  }

  markStepRunning(runId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE run_step SET state = 'running', attempts = attempts + 1, started_at = ? WHERE run_id = ? AND seq = ?",
      )
      .run(this.clock.now(), runId, seq)
  }

  markStepDone(runId: string, seq: number, output: StepOutput | void): void {
    this.db
      .prepare(
        "UPDATE run_step SET state = 'done', external_id = ?, response = ?, error = NULL, ended_at = ? WHERE run_id = ? AND seq = ?",
      )
      .run(
        output?.externalId ?? null,
        output?.response === undefined
          ? null
          : JSON.stringify(this.scrubber.redactValue(output.response)),
        this.clock.now(),
        runId,
        seq,
      )
  }

  markStepFailed(runId: string, seq: number, error: string): void {
    this.db
      .prepare(
        "UPDATE run_step SET state = 'failed', error = ?, ended_at = ? WHERE run_id = ? AND seq = ?",
      )
      .run(this.scrubber.redact(error), this.clock.now(), runId, seq)
  }

  /** Leaves the step's recorded work in place but marks it undone. */
  markStepCompensated(runId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE run_step SET state = 'compensated', ended_at = ? WHERE run_id = ? AND seq = ?",
      )
      .run(this.clock.now(), runId, seq)
  }

  /** Resets a step left mid-flight by a crash so it can be retried. */
  resetStep(runId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE run_step SET state = 'pending', started_at = NULL WHERE run_id = ? AND seq = ?",
      )
      .run(runId, seq)
  }

  recordFailure(runId: string, failure: RunFailure): void {
    this.db
      .prepare('UPDATE run SET failure = ? WHERE id = ?')
      .run(JSON.stringify(this.scrubber.redactValue(failure)), runId)
  }

  recordResolved(runId: string, resolved: JsonObject): void {
    this.db
      .prepare('UPDATE run SET resolved = ? WHERE id = ?')
      .run(JSON.stringify(this.scrubber.redactValue(resolved)), runId)
  }
}

/**
 * Deterministic, so recovery can recompute it, and human-readable, so it can
 * be embedded in an external resource (a broadcast tag, say) and searched for
 * when reconciling.
 */
export function idempotencyKey(runId: string, seq: number, kind: string): string {
  return `${runId}:${seq}:${kind}`
}
