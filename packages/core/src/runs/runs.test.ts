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
import { timelineFor } from './timeline.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse('2026-03-08T13:00:00Z') // 07:00 America/Chicago
/** A Sunday morning: doors at 07:00, everything done by 12:45. */
const WINDOW = 5 * HOUR + 45 * MINUTE

let db: Db
let clock: ManualClock
let store: RunStore

beforeEach(() => {
  db = openTestDatabase()
  clock = new ManualClock(START - HOUR)
  store = new RunStore(db, clock, new Scrubber())
})
afterEach(() => db.close())

interface OutputSpec {
  label: string
  kind?: 'stream' | 'recording'
  /** From the window's start. */
  offsetMs?: number
  durationMs?: number
  /** Whether it goes to a service that has to issue a key first. */
  destination?: boolean
  deviceId?: string
}

interface SeedOptions {
  prepareLeadMs?: number
  graceMs?: number
  postrollMs?: number
  outputs?: OutputSpec[]
}

/** The shape the whole model exists for, unless a test says otherwise. */
const SUNDAY: OutputSpec[] = [
  { label: 'Main // 9:00', offsetMs: 2 * HOUR, durationMs: 75 * MINUTE, destination: true },
  { label: 'Main // 11:00', offsetMs: 4 * HOUR, durationMs: 75 * MINUTE, destination: true },
  { label: 'Archive', kind: 'recording', offsetMs: 0, durationMs: WINDOW, deviceId: 'deck' },
]

function seedOccurrence(over: SeedOptions = {}): string {
  const seriesId = randomUUID()
  const occurrenceId = randomUUID()
  db.prepare("INSERT INTO device (id, plugin_id, label, config, created_at) VALUES ('enc', 'mock', 'Encoder', '{}', 0)").run()
  db.prepare("INSERT INTO device (id, plugin_id, label, config, created_at) VALUES ('deck', 'mock', 'HyperDeck', '{}', 0)").run()
  db.prepare("INSERT INTO destination (id, plugin_id, label, config, created_at) VALUES ('svc', 'mock', 'Service', '{}', 0)").run()

  db.prepare(
    `INSERT INTO event_series
       (id, label, source_device_id, source_node_id, timezone, rrule, dtstart, duration_ms, prepare_lead_ms,
        preroll_ms, postroll_ms, late_start_grace_ms, created_at, updated_at)
     VALUES (?, 'Sunday // AND', 'enc', 'stream', 'America/Chicago', NULL, ?, ?, ?, 0, ?, ?, 0, 0)`,
  ).run(seriesId, START, WINDOW, over.prepareLeadMs ?? 30 * MINUTE, over.postrollMs ?? 0, over.graceMs ?? 5 * MINUTE)

  const insert = db.prepare(
    `INSERT INTO event_output
       (id, series_id, kind, label, position, offset_ms, duration_ms, destination_id, device_id, node_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  ;(over.outputs ?? SUNDAY).forEach((spec, index) => {
    insert.run(
      randomUUID(),
      seriesId,
      spec.kind ?? 'stream',
      spec.label,
      index,
      spec.offsetMs ?? 0,
      spec.durationMs ?? WINDOW,
      spec.destination ? 'svc' : null,
      spec.deviceId ?? null,
      spec.deviceId ? 'record' : null,
    )
  })

  db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, '2026-03-08', 'pending', 1)`,
  ).run(occurrenceId, seriesId, START, START + WINDOW)
  return occurrenceId
}

/**
 * Stands in for YouTube. Deliberately NOT idempotent: calling create twice
 * makes two broadcasts, which is what the real API does and what the
 * idempotency-key discipline exists to prevent.
 */
class FakeBroadcastService {
  readonly broadcasts = new Map<string, { id: string; tag: string; deleted: boolean }>()
  /** Every start and stop, in order, labelled by output. */
  readonly log: string[] = []
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
  /** `${output label}.${action}`, e.g. 'Main // 9:00.prepare'. */
  failAt?: string
  failTimes?: number
  nonRetryable?: string
}

/**
 * A planner with the same shape as the real one — a prepare and a finalize
 * per service-backed output, a start and a stop per output — but with the
 * outside world faked out.
 */
function plannerFor(world: FakeBroadcastService, options: PlanOptions = {}): RunPlanner {
  const failures = new Map<string, number>()
  const maybeFail = (key: string): void => {
    if (options.failAt !== key) return
    const seen = (failures.get(key) ?? 0) + 1
    failures.set(key, seen)
    if (options.failTimes === undefined || seen <= options.failTimes) throw new Error(`${key} blew up`)
  }

  return {
    plan(occurrenceId, planOptions) {
      const timeline = timelineFor(db, occurrenceId, planOptions ?? {})
      const steps: StepDefinition[] = []

      for (const { output } of timeline.outputs) {
        const at = (action: string): string => `${output.label}.${action}`
        const mark = (step: StepDefinition): StepDefinition =>
          options.nonRetryable && step.kind.endsWith(options.nonRetryable)
            ? { ...step, retryable: false }
            : step

        if (output.destinationId) {
          steps.push(
            mark({
              kind: `${output.id}.prepare`,
              phase: 'prepare',
              outputId: output.id,
              label: at('prepare'),
              request: { title: output.label, streamKey: 'live_should-not-be-logged' },
              async execute(ctx) {
                maybeFail(at('prepare'))
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
            }),
          )
        }

        steps.push(
          mark({
            kind: `${output.id}.start`,
            phase: 'start',
            outputId: output.id,
            label: at('start'),
            async execute() {
              maybeFail(at('start'))
              world.log.push(`start ${output.label}`)
            },
          }),
          mark({
            kind: `${output.id}.stop`,
            phase: 'stop',
            outputId: output.id,
            label: at('stop'),
            async execute() {
              maybeFail(at('stop'))
              world.log.push(`stop ${output.label}`)
            },
          }),
        )

        if (output.destinationId) {
          steps.push({
            kind: `${output.id}.finalize`,
            phase: 'complete',
            outputId: output.id,
            label: at('finalize'),
            async execute() {
              maybeFail(at('finalize'))
            },
          })
        }
      }
      return steps
    },
  }
}

const engineFor = (planner: RunPlanner, onFailure?: EngineFailure) =>
  new RunEngine({
    db,
    store,
    clock,
    planner,
    sleeper: immediateSleeper,
    ...(onFailure ? { onFailure } : {}),
  })

type EngineFailure = NonNullable<ConstructorParameters<typeof RunEngine>[0]['onFailure']>

describe('state machine', () => {
  it('allows the documented path and nothing else', () => {
    expect(canTransition('scheduled', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'ready')).toBe(true)
    expect(canTransition('ready', 'running')).toBe(true)
    // The run sits in `running` for the whole window while outputs come
    // and go beneath it.
    expect(canTransition('running', 'running')).toBe(true)
    expect(canTransition('scheduled', 'running')).toBe(false)
    expect(canTransition('completed', 'running')).toBe(false)
    expect(() => assertTransition('completed', 'running')).toThrow(InvalidTransitionError)
  })

  it('knows which states are terminal and which may have something on air', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    expect(isOnAir('running')).toBe(true)
    expect(isOnAir('completing')).toBe(true)
    expect(isOnAir('ready')).toBe(false)
  })
})

describe('RunStore', () => {
  it('writes every step, with its idempotency key, before anything executes', () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const plan = plannerFor(world).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    const steps = store.steps(run.id)
    // Two streams: prepare, start, stop, finalize. One recording: start, stop.
    expect(steps).toHaveLength(10)
    expect(steps.every((s) => s.state === 'pending')).toBe(true)
    expect(steps.every((s) => s.idempotency_key.length > 0)).toBe(true)
    expect(steps[0]?.idempotency_key).toBe(idempotencyKey(run.id, 0, steps[0]!.kind))
  })

  it('records the human-readable label beside the output-scoped kind', () => {
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(new FakeBroadcastService()).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)
    expect(store.steps(run.id).map((s) => s.label)).toContain('Main // 9:00.start')
  })

  it('redacts a recorded request so the timeline is safe to screenshot', () => {
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(new FakeBroadcastService()).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)
    expect(store.steps(run.id)[0]?.request).toContain('[redacted]')
    expect(store.steps(run.id)[0]?.request).not.toContain('live_should-not-be-logged')
  })
})

describe('executePhase', () => {
  const prepare = (runId: string, plan: RunPlan) =>
    executePhase(runId, plan, 'prepare', { store, clock, sleeper: immediateSleeper })

  it('runs a phase in order and records outputs', async () => {
    const world = new FakeBroadcastService()
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(world).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    expect((await prepare(run.id, plan)).ok).toBe(true)
    expect(world.liveCount).toBe(2)
    expect(store.steps(run.id).filter((s) => s.state === 'done')).toHaveLength(2)
  })

  it('retries a transient failure and then succeeds', async () => {
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(new FakeBroadcastService(), {
      failAt: 'Main // 9:00.prepare',
      failTimes: 2,
    }).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    expect((await prepare(run.id, plan)).ok).toBe(true)
    expect(store.step(run.id, 0).attempts).toBe(3)
  })

  it('gives up after the attempt limit and records a remediation', async () => {
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(new FakeBroadcastService(), { failAt: 'Main // 9:00.prepare' }).plan(
      occurrenceId,
    ) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    const result = await prepare(run.id, plan)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.remediation).toMatch(/3 attempts/)
    expect(store.step(run.id, 0).state).toBe('failed')
  })

  it('does not retry a step declared unsafe to repeat', async () => {
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(new FakeBroadcastService(), {
      failAt: 'Main // 9:00.prepare',
      nonRetryable: '.prepare',
    }).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    await prepare(run.id, plan)
    expect(store.step(run.id, 0).attempts).toBe(1)
  })

  it('skips steps already done, so a resumed phase does not repeat work', async () => {
    const world = new FakeBroadcastService()
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(world).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    await prepare(run.id, plan)
    await prepare(run.id, plan)
    expect(world.liveCount).toBe(2)
  })
})

describe('reconcileRun', () => {
  const setup = (options: PlanOptions = {}) => {
    const world = new FakeBroadcastService()
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(world, options).plan(occurrenceId) as RunPlan
    return { world, plan, run: store.createRun(occurrenceId, plan) }
  }

  it('adopts work an interrupted step had already done', async () => {
    const { world, plan, run } = setup()
    // The process died after the API call landed but before the result was
    // recorded.
    store.markStepRunning(run.id, 0)
    world.create(idempotencyKey(run.id, 0, plan[0]!.kind))

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, 0).state).toBe('done')
    expect(store.step(run.id, 0).external_id).toBe('bc-1')
    expect(world.liveCount).toBe(1)
  })

  it('resets a step whose call never landed', async () => {
    const { plan, run } = setup()
    store.markStepRunning(run.id, 0)

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, 0).state).toBe('pending')
  })

  it('fails an unreconcilable step that is unsafe to repeat, rather than guessing', async () => {
    const { plan, run } = setup({ nonRetryable: '.start' })
    const seq = plan.findIndex((step) => step.kind.endsWith('.start'))
    store.markStepRunning(run.id, seq)

    await reconcileRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(store.step(run.id, seq).state).toBe('failed')
    expect(store.step(run.id, seq).error).toMatch(/by hand/)
  })
})

describe('compensateRun', () => {
  it('removes the orphan broadcasts a half-prepared run left behind', async () => {
    const world = new FakeBroadcastService()
    const occurrenceId = seedOccurrence()
    const plan = plannerFor(world).plan(occurrenceId) as RunPlan
    const run = store.createRun(occurrenceId, plan)

    await executePhase(run.id, plan, 'prepare', { store, clock, sleeper: immediateSleeper })
    expect(world.liveCount).toBe(2)

    await compensateRun(run.id, plan, { store, clock, sleeper: immediateSleeper })
    expect(world.liveCount).toBe(0)
    expect(store.step(run.id, 0).state).toBe('compensated')
  })
})

describe('RunEngine', () => {
  it('creates a run when the prepare window opens, and not before', async () => {
    seedOccurrence()
    const engine = engineFor(plannerFor(new FakeBroadcastService()))

    clock.set(START - 45 * MINUTE)
    expect((await engine.tick()).created).toHaveLength(0)

    clock.set(START - 30 * MINUTE)
    const report = await engine.tick()
    expect(report.created).toHaveLength(1)
    // Everything is prepared up front; nothing has started yet, because the
    // first output is two hours into the window.
    expect(store.getRun(report.created[0]!).state).toBe('ready')
  })

  it('prepares every output at once, long before any of them airs', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    await engine.tick()
    // Both broadcasts exist at 06:30, not at 09:00 and 11:00. Finding out
    // the 11:00 one cannot be created is worth something at 06:30.
    expect(world.liveCount).toBe(2)
    expect(world.log).toEqual([])
  })

  it('starts and stops each output on its own clock inside the window', async () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    // 07:00: the window opens and the recorder rolls; neither service is on.
    clock.set(START)
    await engine.tick()
    expect(world.log).toEqual(['start Archive'])
    expect(store.getRun(runId).state).toBe('running')

    clock.set(START + 2 * HOUR) // 09:00
    await engine.tick()
    expect(world.log).toContain('start Main // 9:00')

    clock.set(START + 3 * HOUR + 15 * MINUTE) // 10:15, the 9:00 service ends
    await engine.tick()
    expect(world.log).toContain('stop Main // 9:00')
    expect(world.log).not.toContain('start Main // 11:00')
    expect(store.getRun(runId).state).toBe('running')

    clock.set(START + 4 * HOUR) // 11:00
    await engine.tick()
    expect(world.log).toContain('start Main // 11:00')

    clock.set(START + WINDOW) // 12:45
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
    expect(world.log).toEqual([
      'start Archive',
      'start Main // 9:00',
      'stop Main // 9:00',
      'start Main // 11:00',
      'stop Main // 11:00',
      'stop Archive',
    ])
    expect(occurrenceStatus(occurrenceId)).toBe('done')
  })

  it('releases the encoder before the next output claims it', async () => {
    // Back-to-back outputs on one encoder: the second starts exactly when
    // the first ends. The stop must be ordered before the start, or the
    // retarget takes the first one off air a moment after it was told to
    // keep going.
    seedOccurrence({
      graceMs: 8 * HOUR,
      outputs: [
        { label: 'First', offsetMs: 0, durationMs: HOUR, destination: true },
        { label: 'Second', offsetMs: HOUR, durationMs: HOUR, destination: true },
      ],
    })
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    await engine.tick()
    clock.set(START + HOUR)
    await engine.tick()

    expect(world.log).toEqual(['start First', 'stop First', 'start Second'])
  })

  it('crosses the whole window in one tick after a long sleep', async () => {
    seedOccurrence({ graceMs: 8 * HOUR })
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START + WINDOW + MINUTE)
    const report = await engine.tick()
    expect(store.getRun(report.created[0]!).state).toBe('completed')
    expect(world.log.filter((entry) => entry.startsWith('start'))).toHaveLength(3)
  })

  it('keeps the rest of the event when one output fails to prepare', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const failures: string[] = []
    const engine = engineFor(plannerFor(world, { failAt: 'Main // 9:00.prepare' }), (event) => {
      failures.push(event.outputLabel ?? '(whole run)')
    })

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')
    expect(failures).toEqual(['Main // 9:00'])
    // The broadcast the failed output created was cleaned up; the other
    // one is untouched.
    expect(world.liveCount).toBe(1)

    await runTheMorning(engine)
    expect(store.getRun(runId).state).toBe('completed')
    expect(world.log).not.toContain('start Main // 9:00')
    expect(world.log).toContain('start Main // 11:00')
    expect(world.log).toContain('start Archive')
  })

  it('keeps the rest of the event when one output fails to start', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world, { failAt: 'Main // 9:00.start' }))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    await runTheMorning(engine)

    expect(store.getRun(runId).state).toBe('completed')
    expect(world.log).toContain('start Main // 11:00')
    // It never got on air, so its broadcast is litter and was discarded.
    expect(world.liveCount).toBe(1)
  })

  it('keeps a broadcast that aired but would not stop cleanly', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world, { failAt: 'Main // 9:00.stop' }))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    await runTheMorning(engine)

    expect(store.getRun(runId).state).toBe('completed')
    // It went out. Discarding it would delete a service people watched.
    expect(world.liveCount).toBe(2)
  })

  it('fails the run only when nothing at all made it to air', async () => {
    const occurrenceId = seedOccurrence({
      outputs: [{ label: 'Only', offsetMs: 0, durationMs: HOUR, destination: true }],
    })
    const engine = engineFor(plannerFor(new FakeBroadcastService(), { failAt: 'Only.prepare' }))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('failed')
    // The summary says nothing could be prepared, but the cause the step
    // recorded is kept: that is the sentence somebody can act on.
    const failure = JSON.parse(store.getRun(runId).failure!)
    expect(failure.message).toContain('Nothing could be prepared')
    expect(failure.message).toContain('Only.prepare blew up')
    expect(occurrenceStatus(occurrenceId)).toBe('failed')
  })

  it('skips an output the clock ran past and runs the ones still to come', async () => {
    seedOccurrence({
      graceMs: 15 * MINUTE,
      outputs: [
        { label: 'Main // 9:00', offsetMs: 0, durationMs: 75 * MINUTE, destination: true },
        { label: 'Main // 11:00', offsetMs: 2 * HOUR, durationMs: 75 * MINUTE, destination: true },
      ],
    })
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    // The app came back two hours in: the first service is long gone, but
    // the second is due right now and is still perfectly deliverable.
    clock.set(START + 2 * HOUR)
    const runId = (await engine.tick()).created[0]!
    expect(world.log).toEqual(['start Main // 11:00'])

    // The skipped one says so on the timeline, in the place someone is
    // already looking.
    const skipped = store.steps(runId).find((step) => step.label === 'Main // 9:00.start')
    expect(skipped?.state).toBe('failed')
    expect(skipped?.error).toMatch(/Skipped/)

    // The event's window runs to 12:45 whatever its outputs do, so the run
    // is not finished the moment the last one comes off.
    clock.set(START + 3 * HOUR + 15 * MINUTE)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('running')

    clock.set(START + WINDOW)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
  })

  it('fails a run whose whole window was missed', async () => {
    const occurrenceId = seedOccurrence({ graceMs: 5 * MINUTE })
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START + 2 * 86_400_000) // two days late
    const report = await engine.tick()
    const run = store.getRun(report.created[0]!)
    expect(run.state).toBe('failed')
    expect(JSON.parse(run.failure!).code).toBe('missed_window')
    expect(occurrenceStatus(occurrenceId)).toBe('failed')
    // Nothing was created for an event that is already over.
    expect(world.liveCount).toBe(0)
  })

  it('fails an event with nothing on it, rather than quietly succeeding', async () => {
    seedOccurrence({ outputs: [] })
    const engine = engineFor(plannerFor(new FakeBroadcastService()))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(JSON.parse(store.getRun(runId).failure!).code).toBe('no_outputs')
  })

  it('does not call a running event late just because it is past its start', async () => {
    seedOccurrence({ graceMs: 5 * MINUTE })
    const engine = engineFor(plannerFor(new FakeBroadcastService()))

    clock.set(START)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('running')

    clock.set(START + HOUR) // well past the grace period, mid-morning
    await engine.tick()
    expect(store.getRun(runId).state).toBe('running')
  })

  it('stops everything still on air when an operator cancels', async () => {
    const occurrenceId = seedOccurrence({ graceMs: 8 * HOUR })
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START + 2 * HOUR) // the 9:00 service is live, so is the recorder
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('running')

    await engine.cancel(runId, 'Stopped by an operator')
    expect(store.getRun(runId).state).toBe('cancelled')
    expect(world.log).toContain('stop Main // 9:00')
    expect(world.log).toContain('stop Archive')
    // The 11:00 service never started, so there is nothing to stop.
    expect(world.log).not.toContain('stop Main // 11:00')
    expect(occurrenceStatus(occurrenceId)).toBe('cancelled')
  })

  it('compensates rather than stopping when cancelling before air', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    await engine.cancel(runId)
    expect(world.liveCount).toBe(0)
    expect(world.log).toEqual([])
  })

  it('ignores a disabled event', async () => {
    seedOccurrence()
    db.prepare('UPDATE event_series SET enabled = 0').run()
    const engine = engineFor(plannerFor(new FakeBroadcastService()))
    clock.set(START)
    expect((await engine.tick()).created).toHaveLength(0)
  })

  it('leaves a disabled output out of the run entirely', async () => {
    seedOccurrence()
    db.prepare("UPDATE event_output SET enabled = 0 WHERE label = 'Main // 9:00'").run()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    await engine.tick()
    expect(world.liveCount).toBe(1)

    clock.set(START + WINDOW)
    await engine.tick()
    expect(world.log).not.toContain('start Main // 9:00')
  })

  it('does not create a second run for an occurrence', async () => {
    seedOccurrence()
    const engine = engineFor(plannerFor(new FakeBroadcastService()))
    clock.set(START - 30 * MINUTE)
    await engine.tick()
    expect((await engine.tick()).created).toHaveLength(0)
  })
})

/**
 * The test that justifies the whole idempotency design: kill the process at
 * every step boundary, in both the "call landed" and "call never landed"
 * cases, and assert exactly one broadcast per service afterwards.
 */
describe('crash recovery', () => {
  const crashPoints = [
    { label: 'the first broadcast', at: START - 30 * MINUTE, state: 'scheduled' as const, kind: '.prepare' },
    { label: 'the recorder rolling', at: START, state: 'running' as const, kind: '.start' },
  ]

  for (const landed of [true, false]) {
    for (const point of crashPoints) {
      it(`survives a crash during ${point.label} where the call ${landed ? 'landed' : 'never landed'}`, async () => {
        const occurrenceId = seedOccurrence({ graceMs: 8 * HOUR })
        const world = new FakeBroadcastService()
        const planner = plannerFor(world)
        const plan = planner.plan(occurrenceId) as RunPlan
        const seq = plan.findIndex((step) => step.kind.endsWith(point.kind))

        clock.set(point.at)
        const run = store.createRun(occurrenceId, plan)
        db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)

        // Everything before the crash point completed normally.
        for (let before = 0; before < seq; before++) {
          store.markStepRunning(run.id, before)
          const output = plan[before]!.kind.endsWith('.prepare')
            ? { externalId: world.create(idempotencyKey(run.id, before, plan[before]!.kind)) }
            : undefined
          store.markStepDone(run.id, before, output)
        }
        if (point.state === 'running') {
          store.transition(run.id, 'preparing')
          store.transition(run.id, 'ready')
          store.transition(run.id, 'running')
        }

        // ...then the process died mid-call on this step. `landed` is the
        // ambiguous case the idempotency key exists for: the API call
        // succeeded but we died before recording its id.
        store.markStepRunning(run.id, seq)
        if (landed && plan[seq]!.kind.endsWith('.prepare')) {
          world.create(idempotencyKey(run.id, seq, plan[seq]!.kind))
        }

        // A fresh process: same database, new engine.
        const restarted = new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })
        await restarted.recover()

        for (const at of [point.at, START + 2 * HOUR, START + 4 * HOUR, START + WINDOW]) {
          clock.set(at)
          await restarted.tick()
        }

        expect(store.getRun(run.id).state).toBe('completed')
        expect(world.liveCount).toBe(2) // never three broadcasts for two services
        expect(store.steps(run.id).every((s) => s.state === 'done')).toBe(true)
      })
    }
  }

  it('resumes a run wedged mid-phase by a restart', async () => {
    // A crash between "transition to preparing" and the first step leaves a
    // state whose clock gate has already passed; the engine must resume it
    // rather than wait for a gate that will never come again.
    const occurrenceId = seedOccurrence({ graceMs: 8 * HOUR })
    const planner = plannerFor(new FakeBroadcastService())
    clock.set(START - 30 * MINUTE)
    const run = store.createRun(occurrenceId, planner.plan(occurrenceId) as RunPlan)
    store.transition(run.id, 'preparing')

    const engine = engineFor(planner)
    await engine.recover()
    await engine.tick()
    expect(store.getRun(run.id).state).toBe('ready')
  })

  it('does not start a second broadcast when recovery runs twice', async () => {
    seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    await engine.recover()
    await engine.recover()
    await runTheMorning(engine)

    expect(store.getRun(runId).state).toBe('completed')
    expect(world.liveCount).toBe(2)
  })
})

describe('operator start-now', () => {
  it('starts an occurrence that is days away, without waiting for its window', async () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    // Nowhere near the prepare window: a scheduled tick would do nothing.
    clock.set(START - 6 * 86_400_000)
    expect((await engine.tick()).created).toHaveLength(0)

    const runId = await engine.startNow(occurrenceId)
    expect(await engine.advance(runId)).toBe('running')
    // The whole window moved to now, so only the output at offset zero is
    // on: the 9:00 service is still two hours away.
    expect(world.log).toEqual(['start Archive'])
  })

  it('keeps the outputs spaced as they were, measured from when it was forced', async () => {
    const occurrenceId = seedOccurrence()
    const world = new FakeBroadcastService()
    const engine = engineFor(plannerFor(world))

    const forcedAt = START - 6 * 86_400_000
    clock.set(forcedAt)
    const runId = await engine.startNow(occurrenceId)
    await engine.advance(runId)

    clock.set(forcedAt + 2 * HOUR)
    await engine.tick()
    expect(world.log).toContain('start Main // 9:00')

    clock.set(forcedAt + WINDOW)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
  })

  it('never calls a forced run late', async () => {
    const occurrenceId = seedOccurrence({ graceMs: MINUTE })
    const engine = engineFor(plannerFor(new FakeBroadcastService()))

    clock.set(START + 5 * HOUR) // hours past the grace period
    const runId = await engine.startNow(occurrenceId)
    expect(await engine.advance(runId)).toBe('running')
  })
})

function occurrenceStatus(occurrenceId: string): string {
  return (db.prepare('SELECT status FROM occurrence WHERE id = ?').get(occurrenceId) as { status: string }).status
}

/**
 * Walks the clock through the whole window a tick at a time.
 *
 * Jumping straight to the end is not the same test: every output would be
 * past its late-start grace at once, which is a missed event, not a Sunday.
 */
async function runTheMorning(engine: RunEngine): Promise<void> {
  for (const at of [START, START + 2 * HOUR, START + 3 * HOUR + 15 * MINUTE, START + 4 * HOUR, START + WINDOW]) {
    clock.set(at)
    await engine.tick()
  }
}
