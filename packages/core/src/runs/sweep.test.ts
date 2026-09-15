import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from '../api/server.js'
import { silentLogger } from '../log.js'

/**
 * Removing recordings.
 *
 * The only operation in this app that destroys somebody's footage, so
 * these tests are mostly about what it refuses to do. The happy path is
 * one test; the rails are the rest.
 */

const DAY = 86_400_000
const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-sweep-'))
  clock = new ManualClock(START)
  app = Application.create({
    configDir: dir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
  })
  server = await createServer({ app })
})

afterEach(async () => {
  await server.close()
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
})

const post = (url: string, body: unknown) =>
  server.inject({ method: 'POST', url, payload: body as object })
const get = (url: string) => server.inject({ method: 'GET', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

/**
 * A deck with `count` finished recordings on it, each a week apart, the
 * newest `newestAgeDays` old — and a policy that would remove the old ones.
 */
async function seedRecordings(
  count: number,
  options: {
    keepDays?: number
    keepLast?: number
    minFreeHours?: number
    /** Moves the event's window, for tests that drive the scheduler loop
     *  and must not have a run start under them. */
    startsAt?: number
  } = {},
): Promise<{ outputId: string; deviceId: string; filenames: string[] }> {
  const device = json(
    await post('/api/devices', {
      pluginId: 'mock',
      label: 'Stage deck',
      config: { kind: 'recorder' },
    }),
  )
  await post(`/api/devices/${device.id}/connect`, {})

  const series = json(
    await post('/api/series', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: options.startsAt === undefined ? 'FREQ=WEEKLY;BYDAY=SU' : null,
      dtstart: options.startsAt ?? START,
      durationMs: 90 * MINUTE,
    }),
  )
  const output = json(
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive copy',
      durationMs: 60 * MINUTE,
      deviceId: device.id,
      nodeId: 'record',
      settings: {
        retention: {
          keepDays: options.keepDays ?? 30,
          ...(options.keepLast === undefined ? {} : { keepLast: options.keepLast }),
          ...(options.minFreeHours === undefined ? {} : { minFreeHours: options.minFreeHours }),
        },
      },
    }),
  )

  // Written straight into the ledger and onto the card, a week apart, so
  // the ages are exact rather than whatever a run happened to take.
  const filenames: string[] = []
  for (let i = count; i >= 1; i--) {
    const at = START - i * 7 * DAY
    const filename = `service-${i}`
    filenames.push(filename)
    app.ledger.started({
      runId: `run-${i}`,
      outputId: output.id,
      deviceId: device.id,
      nodeId: 'record',
      slot: 1,
      filename,
      at,
    })
    app.ledger.finished(`run-${i}`, output.id, at + 60 * MINUTE)
    await post(`/api/devices/${device.id}/nodes/record/startRecording`, { filename, slot: 1 })
    await post(`/api/devices/${device.id}/nodes/record/stopRecording`, {})
  }

  return { outputId: output.id, deviceId: device.id, filenames }
}

describe('sweeping a card', () => {
  it('removes exactly what it said it would, and nothing else', async () => {
    const { outputId, deviceId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })

    const plan = json(await post('/api/retention/sweep', { outputId }))
    expect(plan.swept).toBe(false)
    expect(typeof plan.confirm).toBe('string')
    // Older than 30 days: the ones 5 and 6 weeks back.
    const named = plan.files.map((file: { filename: string }) => file.filename)
    expect(named.length).toBeGreaterThan(0)

    const done = json(await post('/api/retention/sweep', { outputId, confirm: plan.confirm }))
    expect(done.swept).toBe(true)
    expect(done.removed.map((file: { filename: string }) => file.filename)).toEqual(named)
    expect(done.failed).toEqual([])

    // Gone from the card, and marked gone in the ledger.
    const listed = await app.connections.invoke(deviceId, 'record', 'listMedia')
    const onCard = ((listed?.raw?.media ?? []) as { name: string }[]).map((item) => item.name)
    for (const filename of named) expect(onCard).not.toContain(`${filename}.mov`)

    const left = app.ledger.forOutput(outputId).map((a) => a.filename)
    for (const filename of named) expect(left).not.toContain(filename)
  })

  it('will not sweep a deck that is recording', async () => {
    const { outputId, deviceId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })
    await post(`/api/devices/${deviceId}/nodes/record/startRecording`, { filename: 'live' })

    const refused = await post('/api/retention/sweep', { outputId })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/recording/i)
  })

  it('will not sweep a deck an event is mid-run on', async () => {
    const { outputId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })

    const occurrences = json(
      await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`),
    )
    await post(`/api/occurrences/${occurrences[0].id}/start-now`, {})

    const refused = await post('/api/retention/sweep', { outputId })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/mid-run/i)
  })

  it('refuses a token that has already been used', async () => {
    const { outputId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })
    const plan = json(await post('/api/retention/sweep', { outputId }))

    expect(
      json(await post('/api/retention/sweep', { outputId, confirm: plan.confirm })).swept,
    ).toBe(true)

    // A token that could be replayed is a sweep that could run twice
    // against a card somebody has since put new footage on.
    const again = await post('/api/retention/sweep', { outputId, confirm: plan.confirm })
    expect(again.statusCode).toBe(409)
    expect(json(again).error).toMatch(/expired|already/i)
  })

  it('refuses a token that has gone stale', async () => {
    const { outputId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })
    const plan = json(await post('/api/retention/sweep', { outputId }))

    clock.advance(6 * MINUTE)
    const stale = await post('/api/retention/sweep', { outputId, confirm: plan.confirm })
    expect(stale.statusCode).toBe(409)
    expect(json(stale).error).toMatch(/five minutes/i)
  })

  it('removes nothing when the policy protects everything', async () => {
    // Six recordings, all older than the policy, but keepLast covers them.
    const { outputId } = await seedRecordings(3, { keepDays: 1, keepLast: 10 })

    const plan = json(await post('/api/retention/sweep', { outputId }))
    expect(plan.files).toEqual([])

    const done = json(await post('/api/retention/sweep', { outputId, confirm: plan.confirm }))
    expect(done.removed).toEqual([])
  })

  it('carries on past one file it cannot remove, and records why', async () => {
    const { outputId, deviceId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })
    const plan = json(await post('/api/retention/sweep', { outputId }))
    expect(plan.files.length).toBeGreaterThan(1)

    // One of them is taken off the card by hand between preparing and
    // confirming. That is the same outcome arriving by another route, so
    // it is skipped rather than failing the sweep.
    const [first] = plan.files
    await app.connections.invoke(deviceId, 'record', 'deleteMedia', {
      name: `${first.filename}.mov`,
      slot: 1,
    })

    const done = json(await post('/api/retention/sweep', { outputId, confirm: plan.confirm }))
    expect(done.swept).toBe(true)
    // The rest still went.
    expect(done.removed.length + done.failed.length).toBe(plan.files.length)
  })

  it('will not sweep an output that does not exist', async () => {
    const refused = await post('/api/retention/sweep', { outputId: 'nope' })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/No recording output/i)
  })
})

/**
 * The hourly sweep, which is the one that runs with nobody watching.
 *
 * Every rail the button has, because it goes through the same two steps —
 * so what is tested here is the part that is new: which outputs it picks
 * up, what it does when a card is busy, and that it says what it did.
 */
describe('the sweep that runs on its own', () => {
  it('enforces the policy without anybody pressing anything', async () => {
    const { outputId, deviceId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })

    const swept = await app.sweeper.sweepDue()

    expect(swept).toHaveLength(1)
    expect(swept[0]?.outputId).toBe(outputId)
    expect(swept[0]?.removed.length).toBeGreaterThan(0)
    expect(swept[0]?.failed).toEqual([])

    const gone = swept[0]!.removed.map((file) => file.filename)
    const listed = await app.connections.invoke(deviceId, 'record', 'listMedia')
    const onCard = ((listed?.raw?.media ?? []) as { name: string }[]).map((item) => item.name)
    for (const filename of gone) expect(onCard).not.toContain(`${filename}.mov`)
  })

  it('leaves an output with no policy alone', async () => {
    // The consent rule: nobody set a limit, so nothing is enforced. An
    // output that could be swept by accident is the failure this whole
    // feature has to avoid.
    const device = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Stage deck',
        config: { kind: 'recorder' },
      }),
    )
    await post(`/api/devices/${device.id}/connect`, {})
    const series = json(
      await post('/api/series', {
        label: 'Sunday Service',
        timezone: 'America/Chicago',
        rrule: null,
        dtstart: START,
        durationMs: 90 * MINUTE,
      }),
    )
    const output = json(
      await post(`/api/series/${series.id}/outputs`, {
        kind: 'recording',
        label: 'Archive copy',
        durationMs: 60 * MINUTE,
        deviceId: device.id,
        nodeId: 'record',
      }),
    )
    for (let i = 5; i >= 1; i--) {
      const at = START - i * 400 * DAY
      app.ledger.started({
        runId: `run-${i}`,
        outputId: output.id,
        deviceId: device.id,
        nodeId: 'record',
        slot: 1,
        filename: `ancient-${i}`,
        at,
      })
      app.ledger.finished(`run-${i}`, output.id, at + 60 * MINUTE)
    }

    expect(await app.sweeper.sweepDue()).toEqual([])
    expect(app.ledger.forOutput(output.id)).toHaveLength(5)
  })

  it('skips a deck that is recording rather than failing the whole pass', async () => {
    const { deviceId } = await seedRecordings(6, { keepDays: 30, keepLast: 0 })
    await post(`/api/devices/${deviceId}/nodes/record/startRecording`, { filename: 'live' })

    expect(await app.sweeper.sweepDue()).toEqual([])

    // Said out loud rather than swallowed: "not now" on an hourly job is
    // simply the next hour, but it should be visible in the log.
    const refusals = app.sweeper.takeRefusals()
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.reason).toMatch(/recording/i)
    // And taking them empties the list, so the next hour starts clean.
    expect(app.sweeper.takeRefusals()).toEqual([])

    // Once it stops, the same pass does the work.
    await post(`/api/devices/${deviceId}/nodes/record/stopRecording`, {})
    expect(await app.sweeper.sweepDue()).toHaveLength(1)
  })

  it('reports nothing on an hour when there was nothing to do', async () => {
    await seedRecordings(3, { keepDays: 3650, keepLast: 0 })
    expect(await app.sweeper.sweepDue()).toEqual([])
  })
})

describe('the hourly job, end to end', () => {
  it('sweeps on the tick and says what it removed', async () => {
    // The event itself is days away: this test drives the real loop, and
    // a run starting under it would (rightly) refuse the sweep.
    const { outputId } = await seedRecordings(6, {
      keepDays: 30,
      keepLast: 0,
      startsAt: START + 3 * DAY,
    })
    const left = (): number => app.ledger.forOutput(outputId).length

    // Somebody who asked to be told about this.
    await post('/api/notifications/channels', {
      kind: 'webhook',
      label: 'Booth',
      config: { url: 'https://example.invalid/hook' },
      events: ['retention.swept'],
    })

    // Starting must not sweep. It is the one job here that destroys
    // something, and a restart — a crash loop most of all — must not be a
    // way to trigger it.
    await app.start()
    expect(left()).toBe(6)

    clock.advance(61 * MINUTE)
    await app.tick()

    // Older than thirty days: five and six weeks back.
    expect(left()).toBe(4)

    const queued = app.db
      .prepare("SELECT payload FROM notification_outbox WHERE event = 'retention.swept'")
      .all() as { payload: string }[]
    expect(queued).toHaveLength(1)
    const notification = JSON.parse(queued[0]!.payload)
    expect(notification.severity).toBe('info')
    // The names are in the message on purpose: "two recordings were
    // removed" is an announcement, and a list is something somebody can
    // check against what they expected.
    const removed = notification.facts.find((fact: { label: string }) => fact.label === 'Removed')
    expect(removed.value).toContain('service-6')
    expect(removed.value).toContain('service-5')

    // And the hour after, with nothing newly past the date, it says
    // nothing rather than repeating itself.
    clock.advance(61 * MINUTE)
    await app.tick()
    expect(left()).toBe(4)
    expect(
      app.db
        .prepare("SELECT count(*) AS n FROM notification_outbox WHERE event = 'retention.swept'")
        .get(),
    ).toEqual({ n: 1 })
  })
})
