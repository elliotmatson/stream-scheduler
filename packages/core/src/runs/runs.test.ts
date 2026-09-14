import { randomUUID } from 'node:crypto'
import { ManualClock } from '@scheduler/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { Scrubber } from '../secrets/scrubber.js'
import { RunEngine } from './engine.js'
import { compensateRun, executePhase, reconcileRun } from './executor.js'
import { assertTransition, canTransition, InvalidTransitionError, isOnAir, isTerminal } from './state-machine.js'
import { idempotencyKey, RunStore } from './store.js'
import { immediateSleeper, type RunPlan, type RunPlanner, type StepDefinition } from './steps.js'

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago
const DURATION = 90 * MINUTE

let db: Db
let clock: ManualClock
let store: RunStore

beforeEach(() => {
  db = openTestDatabase()
  clock = new ManualClock(START - 60 * MINUTE)
  store = new RunStore(db, clock, new Scrubber())
})
afterEach(() => db.close())

function seedOccurrence(over: { prepareLeadMs?: number; graceMs?: number; postrollMs?: number } = {}): string {
  const seriesId = randomUUID()
  const occurrenceId = randomUUID()
  db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run('p1', 'Main', '{}', 0)
  db.prepare(
    `INSERT INTO event_series
       (id, label, pipeline_id, timezone, rrule, dtstart, duration_ms, prepare_lead_ms, preroll_ms, postroll_ms,
        late_start_grace_ms, created_at, updated_at)
     VALUES (?, 'Sunday Service', 'p1', 'America/Chicago', NULL, ?, ?, ?, 0, ?, ?, 0, 0)`,
  ).run(seriesId, START, DURATION, over.prepareLeadMs ?? 30 * MINUTE, over.postrollMs ?? 0, over.graceMs ?? 5 * MINUTE)
  db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, '2026-03-08', 'pending', 1)`,
  ).run(occurrenceId, seriesId, START, START + DURATION)
  return occurrenceId
}

/**
 * Stands in for YouTube. Deliberately NOT idempotent: calling create twice
 * makes two broadcasts, which is what the real API does and what the
 * idempotency-key discipline exists to prevent.
 */
class FakeBroadcastService {
  readonly broadcasts = new Map<string, { id: string; tag: string; deleted: boolean }>()
  private next = 1

  create(tag: string): string {
    const id = `bc-${this.next++}`
    this.broadcasts.set(id, { id, tag, deleted: false })
    return id
  }

  findByTag(tag: string): string | undefined {
    for (const bc of this.broadcasts.values()) if (bc.tag === tag && !bc.deleted) return bc.id
    return undefined
  }

  delete(id: string): void {
    const bc = this.broadcasts.get(id)
    if (bc) bc.deleted = true
  }

  get liveCount(): number {
    return [...this.broadcasts.values()].filter((b) => !b.deleted).length
  }
}

interface PlanOptions {
  failAt?: string
  failTimes?: number
  nonRetryable?: string
}

/** A realistic five-step plan across all four phases. */
function makePlan(world: FakeBroadcastService, options: PlanOptions = {}): RunPlan {
  const failures = new Map<string, number>()
  const maybeFail = (kind: string): void => {
    if (options.failAt !== kind) return
    const seen = (failures.get(kind) ?? 0) + 1
    failures.set(kind, seen)
    if (options.failTimes === undefined || seen <= options.failTimes) {
      throw new Error(`${kind} blew up`)
    }
  }

  const steps: StepDefinition[] = [
    {
      kind: 'youtube.createBroadcast',
      phase: 'prepare',
      request: { title: 'Sunday Service', streamKey: 'live_should-not-be-logged' },
      async execute(ctx) {
        maybeFail('youtube.createBroadcast')
        return { externalId: world.create(ctx.idempotencyKey) }
      },
      async reconcile(ctx) {
        const id = world.findByTag(ctx.idempotencyKey)
        return id ? { externalId: id } : undefined
      },
      async compensate(ctx) {
        const id = world.findByTag(ctx.idempotencyKey)
        if (id) world.delete(id)
      },
    },
    {
      kind: 'encoder.applyStreamTarget',
      phase: 'prepare',
      async execute() {
        maybeFail('encoder.applyStreamTarget')
      },
    },
    {
      kind: 'encoder.startStreaming',
      phase: 'start',
      async execute() {
        maybeFail('encoder.startStreaming')
      },
    },
    { kind: 'encoder.stopStreaming', phase: 'stop', async execute() {} },
    { kind: 'youtube.finalize', phase: 'complete', async execute() {} },
  ]

  if (options.nonRetryable) {
    for (const step of steps) if (step.kind === options.nonRetryable) step.retryable = false
  }
  return steps
}

const plannerFor = (plan: RunPlan): RunPlanner => ({ plan: () => plan })

const engineFor = (planner: RunPlanner) =>
  new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })

describe('state machine', () => {
  it('allows the documented path and nothing else', () => {
    expect(canTransition('scheduled', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'ready')).toBe(true)
    expect(canTransition('live', 'stopping')).toBe(true)
    expect(canTransition('scheduled', 'live')).toBe(false)
    expect(canTransition('completed', 'live')).toBe(false)
    expect(() => assertTransition('completed', 'live')).toThrow(InvalidTransitionError)
  })

  it('knows which states are terminal and which are on air', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('live')).toBe(false)
    expect(isOnAir('live')).toBe(true)
    expect(isOnAir('ready')).toBe(false)
  })
})

describe('RunStore', () => {
  it('writes every step, with its idempotency key, before anything executes', () => {
    const occurrenceId = seedOccurrence()
    const run = store.createRun(occurrenceId, makePlan(new FakeBroadcastService()))
    const steps = store.steps(run.id)
    expect(steps).toHaveLength(5)
    expect(steps.every((s) => s.state === 'pending')).toBe(true)
    expect(steps.every((s) => s.idempotency_key.length > 0)).toBe(true)
    expect(steps[0]?.idempotency_key).toBe(idempotencyKey(run.id, 0, 'youtube.createBroadcast'))
  })

  it('redacts a recorded request so the timeline is safe to screenshot', () => {
    const occurrenceId = seedOccurrence()
    const run = store.createRun(occurrenceId, makePlan(new FakeBroadcastService()))
    expect(store.steps(run.id)[0]?.request).toContain('[redacted]')
    expect(store.steps(run.id)[0]?.request).not.toContain('live_should-not-be-logged')
  })
})

describe('executePhase', () => {
  it('runs a phase in order and records outputs', async () => {
    const world = new FakeBroadcastService()
    const plan = makePlan(world)
    const run = store.createRun(seedOccurrence(), plan)

    const result = await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(result.ok).toBe(true)
    expect(store.outputs(run.id)['youtube.createBroadcast']?.externalId).toBe('bc-1')
    expect(store.steps(run.id).filter((s) => s.state === 'done')).toHaveLength(2)
  })

  it('retries a transient failure and then succeeds', async () => {
    const plan = makePlan(new FakeBroadcastService(), { failAt: 'encoder.applyStreamTarget', failTimes: 2 })
    const run = store.createRun(seedOccurrence(), plan)

    const result = await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(result.ok).toBe(true)
    expect(store.step(run.id, 1).attempts).toBe(3)
  })

  it('gives up after the attempt limit and records a remediation', async () => {
    const plan = makePlan(new FakeBroadcastService(), { failAt: 'encoder.applyStreamTarget' })
    const run = store.createRun(seedOccurrence(), plan)

    const result = await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.step).toBe('encoder.applyStreamTarget')
    expect(store.step(run.id, 1).state).toBe('failed')
  })

  it('does not retry a step declared unsafe to repeat', async () => {
    const plan = makePlan(new FakeBroadcastService(), {
      failAt: 'encoder.applyStreamTarget',
      nonRetryable: 'encoder.applyStreamTarget',
    })
    const run = store.createRun(seedOccurrence(), plan)

    await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, 1).attempts).toBe(1)
  })

  it('skips steps already done, so a resumed phase does not repeat work', async () => {
    const world = new FakeBroadcastService()
    const plan = makePlan(world)
    const run = store.createRun(seedOccurrence(), plan)

    await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(world.liveCount).toBe(1)
  })
})

describe('reconcileRun', () => {
  it('adopts work an interrupted step had already done', async () => {
    const world = new FakeBroadcastService()
    const plan = makePlan(world)
    const run = store.createRun(seedOccurrence(), plan)

    // The process died after the API call landed but before the result was recorded.
    store.markStepRunning(run.id, 0)
    world.create(idempotencyKey(run.id, 0, 'youtube.createBroadcast'))

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, 0).state).toBe('done')
    expect(store.step(run.id, 0).external_id).toBe('bc-1')
    expect(world.liveCount).toBe(1)
  })

  it('resets a step whose call never landed', async () => {
    const plan = makePlan(new FakeBroadcastService())
    const run = store.createRun(seedOccurrence(), plan)
    store.markStepRunning(run.id, 0)

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, 0).state).toBe('pending')
  })

  it('fails an unreconcilable step that is unsafe to repeat, rather than guessing', async () => {
    const plan = makePlan(new FakeBroadcastService(), { nonRetryable: 'encoder.applyStreamTarget' })
    const run = store.createRun(seedOccurrence(), plan)
    store.markStepRunning(run.id, 1)

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    const step = store.step(run.id, 1)
    expect(step.state).toBe('failed')
    expect(step.error).toMatch(/by hand/)
  })
})

describe('compensateRun', () => {
  it('removes the orphan broadcast a half-prepared run left behind', async () => {
    const world = new FakeBroadcastService()
    const plan = makePlan(world, { failAt: 'encoder.applyStreamTarget' })
    const run = store.createRun(seedOccurrence(), plan)

    await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(world.liveCount).toBe(1)

    await compensateRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(world.liveCount).toBe(0)
    expect(store.step(run.id, 0).state).toBe('compensated')
  })
})

describe('RunEngine', () => {
  it('creates a run when the prepare window opens, and not before', async () => {
    seedOccurrence()
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))

    clock.set(START - 45 * MINUTE)
    expect((await engine.tick()).created).toHaveLength(0)

    clock.set(START - 30 * MINUTE)
    const report = await engine.tick()
    expect(report.created).toHaveLength(1)
    expect(store.getRun(report.created[0]!).state).toBe('ready')
  })

  it('drives a run all the way to completed as the clock advances', async () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(makePlan(world)))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    clock.set(START)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('live')

    clock.set(START + DURATION)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
    expect(occurrenceStatus(occurrenceId)).toBe('done')
    expect(world.liveCount).toBe(1)
  })

  it('crosses several phase boundaries in one tick after a long sleep', async () => {
    seedOccurrence({ graceMs: 15 * MINUTE })
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))

    // The machine was asleep and wakes up 10 minutes in, still inside the
    // grace period, so prepare/start/live all have to happen in one tick.
    clock.set(START + 10 * MINUTE)
    const report = await engine.tick()
    expect(report.created).toHaveLength(1)
    expect(store.getRun(report.created[0]!).state).toBe('live')
  })

  it('fails a run whose window was missed entirely', async () => {
    const occurrenceId = seedOccurrence({ graceMs: 5 * MINUTE })
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))

    clock.set(START + 4 * MINUTE * 60) // four hours late
    const report = await engine.tick()
    const run = store.getRun(report.created[0]!)
    expect(run.state).toBe('failed')
    expect(JSON.parse(run.failure!).code).toBe('missed_window')
    expect(occurrenceStatus(occurrenceId)).toBe('failed')
  })

  it('starts late but does start when inside the grace period', async () => {
    seedOccurrence({ graceMs: 10 * MINUTE })
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))

    clock.set(START + 5 * MINUTE)
    const report = await engine.tick()
    expect(store.getRun(report.created[0]!).state).toBe('live')
  })

  it('does not call a live run late just because it is past its start time', async () => {
    seedOccurrence({ graceMs: 5 * MINUTE })
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))

    clock.set(START)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('live')

    clock.set(START + 60 * MINUTE) // well past the grace period, mid-service
    await engine.tick()
    expect(store.getRun(runId).state).toBe('live')
  })

  it('compensates and fails when a prepare step will not succeed', async () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(makePlan(world, { failAt: 'encoder.applyStreamTarget' })))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('failed')
    expect(world.liveCount).toBe(0) // the orphan broadcast was cleaned up
    expect(occurrenceStatus(occurrenceId)).toBe('failed')
  })

  it('runs the stop steps when an operator cancels a live run', async () => {
    const occurrenceId = seedOccurrence()
    const plan = makePlan(new FakeBroadcastService())
    const engine = engineFor(plannerFor(plan))

    clock.set(START)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('live')

    await engine.cancel(runId, 'Stopped by an operator')
    expect(store.getRun(runId).state).toBe('cancelled')
    // The encoder was actually told to stop, not just the row marked.
    expect(store.steps(runId).find((s) => s.kind === 'encoder.stopStreaming')?.state).toBe('done')
    expect(occurrenceStatus(occurrenceId)).toBe('cancelled')
  })

  it('compensates rather than stopping when cancelling before air', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(makePlan(world)))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    await engine.cancel(runId)
    expect(world.liveCount).toBe(0)
    expect(store.steps(runId).find((s) => s.kind === 'encoder.stopStreaming')?.state).toBe('pending')
  })

  it('ignores a disabled series', async () => {
    seedOccurrence()
    db.prepare('UPDATE event_series SET enabled = 0').run()
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))
    clock.set(START)
    expect((await engine.tick()).created).toHaveLength(0)
  })

  it('does not create a second run for an occurrence', async () => {
    seedOccurrence()
    const engine = engineFor(plannerFor(makePlan(new FakeBroadcastService())))
    clock.set(START - 30 * MINUTE)
    await engine.tick()
    expect((await engine.tick()).created).toHaveLength(0)
  })
})

/**
 * The test that justifies the whole idempotency design: kill the process at
 * every step boundary, in both the "call landed" and "call never landed"
 * cases, and assert exactly one broadcast exists afterwards.
 */
describe('crash recovery', () => {
  /** When in the run's life each step is mid-flight, and the run state a
   *  crash would have left behind. */
  const crashPoints = [
    { seq: 0, at: START - 30 * MINUTE, state: 'scheduled' as const },
    { seq: 1, at: START - 30 * MINUTE, state: 'preparing' as const },
    { seq: 2, at: START, state: 'starting' as const },
  ]

  for (const landed of [true, false]) {
    for (const point of crashPoints) {
      it(`survives a crash during step ${point.seq} where the call ${landed ? 'landed' : 'never landed'}`, async () => {
        const occurrenceId = seedOccurrence({ graceMs: 20 * MINUTE })
        const world = new FakeBroadcastService()
        const plan = makePlan(world)
        const planner = plannerFor(plan)

        clock.set(point.at)
        const run = store.createRun(occurrenceId, plan)
        db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)

        // Everything before the crash point completed normally.
        for (let seq = 0; seq < point.seq; seq++) {
          store.markStepRunning(run.id, seq)
          const output = seq === 0 ? { externalId: world.create(idempotencyKey(run.id, 0, plan[0]!.kind)) } : undefined
          store.markStepDone(run.id, seq, output)
        }
        if (point.state === 'preparing') store.transition(run.id, 'preparing')
        if (point.state === 'starting') {
          store.transition(run.id, 'preparing')
          store.transition(run.id, 'ready')
          store.transition(run.id, 'starting')
        }

        // ...then the process died mid-call on this step. `landed` is the
        // ambiguous case the idempotency key exists for: the API call
        // succeeded but we died before recording its id.
        store.markStepRunning(run.id, point.seq)
        if (landed && point.seq === 0) world.create(idempotencyKey(run.id, 0, plan[0]!.kind))

        // A fresh process: same database, new engine.
        const restarted = new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })
        await restarted.recover()

        for (const at of [point.at, START, START + DURATION]) {
          clock.set(at)
          await restarted.tick()
        }

        expect(store.getRun(run.id).state).toBe('completed')
        expect(world.liveCount).toBe(1) // never two broadcasts for one service
        expect(store.steps(run.id).every((s) => s.state === 'done')).toBe(true)
      })
    }
  }

  it('resumes a run wedged mid-phase by a restart', async () => {
    // A crash between "transition to preparing" and the first step leaves a
    // state whose clock gate has already passed; the engine must resume it
    // rather than wait for a gate that will never come again.
    const occurrenceId = seedOccurrence({ graceMs: 60 * MINUTE })
    const plan = makePlan(new FakeBroadcastService())
    clock.set(START - 30 * MINUTE)
    const run = store.createRun(occurrenceId, plan)
    store.transition(run.id, 'preparing')

    const engine = engineFor(plannerFor(plan))
    await engine.recover()
    await engine.tick()
    expect(store.getRun(run.id).state).toBe('ready')
  })

  it('does not start a second broadcast when recovery runs twice', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const plan = makePlan(world)
    const engine = engineFor(plannerFor(plan))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    await engine.recover()
    await engine.recover()

    clock.set(START)
    await engine.tick()
    clock.set(START + DURATION)
    await engine.tick()

    expect(store.getRun(runId).state).toBe('completed')
    expect(world.liveCount).toBe(1)
  })
})

function occurrenceStatus(occurrenceId: string): string {
  return (db.prepare('SELECT status FROM occurrence WHERE id = ?').get(occurrenceId) as { status: string }).status
}
