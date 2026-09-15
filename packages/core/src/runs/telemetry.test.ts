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
 * What the devices were doing while an event was on air.
 *
 * The readings themselves come from the mock, which wanders the way real
 * gear does and can be told to pin its cache — that is how the
 * falling-behind warning gets exercised without waiting for a bad day.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-telemetry-'))
  clock = new ManualClock(START - 2 * MINUTE)
  app = Application.create({
    configDir: dir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
    telemetryIntervalMs: 15_000,
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

/** An encoder, an event streaming off it, and a run that is on air. */
async function seedRunningEvent(deviceConfig: Record<string, unknown> = {}): Promise<{
  runId: string
  deviceId: string
  outputId: string
}> {
  const device = json(
    await post('/api/devices', {
      pluginId: 'mock',
      label: 'Sanctuary encoder',
      config: { kind: 'encoder', ...deviceConfig },
    }),
  )
  await post(`/api/devices/${device.id}/connect`, {})
  const credential = json(
    await post('/api/credentials', {
      label: 'House key',
      ingestUrl: 'rtmps://example.invalid/live',
      key: 'a-key',
    }),
  )
  const series = json(
    await post('/api/series', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstart: START,
      durationMs: 90 * MINUTE,
    }),
  )
  const output = json(
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'stream',
      label: 'Main',
      durationMs: 90 * MINUTE,
      credentialId: credential.id,
      deviceId: device.id,
      nodeId: 'stream',
    }),
  )

  const occurrences = json(
    await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`),
  )
  const started = json(await post(`/api/occurrences/${occurrences[0].id}/start-now`, {}))
  return { runId: started.runId, deviceId: device.id, outputId: output.id }
}

describe('recording what the devices were doing', () => {
  it('samples a run that is on air, and stops when nothing is', async () => {
    const { runId } = await seedRunningEvent()

    await app.telemetry.tick()
    const first = app.telemetry.read(runId)
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]?.bitrateBps).toBeGreaterThan(0)

    // Not due yet: the interval is what keeps this from being a poll.
    clock.advance(5_000)
    await app.telemetry.tick()
    expect(app.telemetry.read(runId)).toHaveLength(first.length)

    clock.advance(15_000)
    await app.telemetry.tick()
    expect(app.telemetry.read(runId).length).toBeGreaterThan(first.length)
  })

  it('records nothing at all when no event is running', async () => {
    const device = json(
      await post('/api/devices', { pluginId: 'mock', label: 'Idle', config: { kind: 'encoder' } }),
    )
    await post(`/api/devices/${device.id}/connect`, {})

    clock.advance(60_000)
    await app.telemetry.tick()
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM telemetry_sample').get()).toEqual({ n: 0 })
  })

  it('builds a series a chart can be drawn from', async () => {
    const { runId } = await seedRunningEvent()
    for (let i = 0; i < 5; i++) {
      clock.advance(15_000)
      await app.telemetry.tick()
    }

    const body = json(await get(`/api/runs/${runId}/telemetry`))
    expect(body.outputs).toHaveLength(1)
    const samples = body.outputs[0].samples
    expect(samples.length).toBeGreaterThan(3)
    // Ordered, and each one says when it was taken.
    expect(samples.map((s: { at: number }) => s.at)).toEqual(
      [...samples.map((s: { at: number }) => s.at)].sort((a, b) => a - b),
    )
    expect(samples.every((s: { streaming: boolean }) => s.streaming)).toBe(true)
  })

  it('thins a long run down to something a chart can use', async () => {
    const { runId } = await seedRunningEvent()
    for (let i = 0; i < 40; i++) {
      clock.advance(15_000)
      await app.telemetry.tick()
    }

    const all = json(await get(`/api/runs/${runId}/telemetry`)).outputs[0].samples
    const thinned = json(await get(`/api/runs/${runId}/telemetry?points=10`)).outputs[0].samples
    expect(all.length).toBeGreaterThan(10)
    expect(thinned).toHaveLength(10)
    // The ends are kept, so the chart spans the run rather than a slice.
    expect(thinned[0].at).toBe(all[0].at)
    expect(thinned[9].at).toBe(all[all.length - 1].at)
  })

  it('narrows to the last stretch of a run when asked', async () => {
    const { runId } = await seedRunningEvent()
    for (let i = 0; i < 40; i++) {
      clock.advance(60_000)
      await app.telemetry.tick()
    }

    const all = json(await get(`/api/runs/${runId}/telemetry`)).outputs[0].samples
    // Ten minutes of a forty-minute run.
    const recent = json(await get(`/api/runs/${runId}/telemetry?windowMs=600000`)).outputs[0]
      .samples

    expect(recent.length).toBeGreaterThan(0)
    expect(recent.length).toBeLessThan(all.length)
    // Measured from the last reading, not from now, so a finished run does
    // not narrow to nothing as the day goes on.
    const latest = all[all.length - 1].at
    expect(recent[recent.length - 1].at).toBe(latest)
    expect(recent.every((sample: { at: number }) => sample.at >= latest - 600_000)).toBe(true)
  })

  it('throws away readings older than the retention window', async () => {
    const { runId } = await seedRunningEvent()
    await app.telemetry.tick()
    const old = app.telemetry.read(runId).map((sample) => sample.at)
    expect(old.length).toBeGreaterThan(0)

    clock.advance(31 * 86_400_000)
    await app.telemetry.tick()

    // The run is still going, so a fresh reading is taken on the same tick
    // the old ones are swept. What matters is that the old ones are gone.
    const kept = app.telemetry.read(runId).map((sample) => sample.at)
    expect(kept.some((at) => old.includes(at))).toBe(false)
  })
})

describe('a device falling behind', () => {
  it('says so once, while it is on air', async () => {
    await seedRunningEvent({ cachePercent: 95 })
    // Set up before the first reading is taken: a warning raised when
    // nobody is listening is delivered to nobody, which is the notifier's
    // behaviour everywhere and not special here.
    await post('/api/notifications/channels', {
      kind: 'google-chat',
      label: 'AV team',
      config: { webhookUrl: 'https://chat.googleapis.invalid/v1/spaces/A/messages' },
    })

    const queued = () =>
      (app.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as { n: number }).n

    await app.telemetry.tick()
    const after = queued()
    expect(after).toBeGreaterThan(0)

    // Sitting high for the rest of the morning is one problem, not two
    // hundred messages.
    for (let i = 0; i < 5; i++) {
      clock.advance(15_000)
      await app.telemetry.tick()
    }
    expect(queued()).toBe(after)
  })

  it('stays quiet below the threshold, and speaks when the threshold is lowered', async () => {
    await seedRunningEvent({ cachePercent: 55 })
    await post('/api/notifications/channels', {
      kind: 'google-chat',
      label: 'AV team',
      config: { webhookUrl: 'https://chat.googleapis.invalid/v1/spaces/A/messages' },
    })

    const queued = () =>
      (app.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as { n: number }).n

    await app.telemetry.tick()
    expect(queued()).toBe(0)

    // Somebody whose uplink normally sits high turns the number down.
    app.thresholds.set({ cacheWarningPercent: 50 })
    clock.advance(15_000)
    await app.telemetry.tick()
    expect(queued()).toBeGreaterThan(0)
  })

  it('shows up on the status screen too, because that is what is already open', async () => {
    await seedRunningEvent({ cachePercent: 95 })
    await app.telemetry.tick()

    const dashboard = json(await get('/api/dashboard'))
    expect(
      dashboard.attention.some((item: { message: string }) => /cache/i.test(item.message)),
    ).toBe(true)
  })
})

describe('when to tell somebody', () => {
  it('round-trips, and refuses a number that would switch a warning off', async () => {
    expect(json(await get('/api/notifications/settings'))).toEqual({
      cacheWarningPercent: 80,
      mediaWarningMinutes: 60,
    })

    const patched = await server.inject({
      method: 'PATCH',
      url: '/api/notifications/settings',
      payload: { cacheWarningPercent: 65 },
    })
    expect(json(patched)).toMatchObject({ cacheWarningPercent: 65, mediaWarningMinutes: 60 })

    const silly = await server.inject({
      method: 'PATCH',
      url: '/api/notifications/settings',
      payload: { cacheWarningPercent: 0 },
    })
    expect(silly.statusCode).toBe(500)
    // And the stored one is untouched.
    expect(app.thresholds.get().cacheWarningPercent).toBe(65)
  })

  it('decides when a card counts as nearly full', async () => {
    const device = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Deck',
        config: { kind: 'recorder' },
      }),
    )
    await post(`/api/devices/${device.id}/connect`, {})
    await post(`/api/devices/${device.id}/nodes/record/startRecording`, { filename: 'sunday' })

    const complains = (body: { attention: { message: string }[] }): boolean =>
      body.attention.some((item) => /minutes left/.test(item.message))

    // The mock records to a slot with four hours on it, which no sensible
    // default calls a problem.
    expect(complains(json(await get('/api/dashboard')))).toBe(false)

    // Somebody who wants half a day's headroom says so, and the same card
    // becomes worth mentioning. The threshold is the whole difference.
    app.thresholds.set({ mediaWarningMinutes: 300 })
    expect(complains(json(await get('/api/dashboard')))).toBe(true)
  })
})
