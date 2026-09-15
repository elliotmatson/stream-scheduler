import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from './server.js'
import { silentLogger } from '../log.js'
import { timelineFor } from '../runs/timeline.js'

/**
 * Changing one morning without changing every morning.
 *
 * The behaviour every calendar has: "just this one" has to survive a
 * later edit to the series, or it was not a change at all. That is what
 * most of these tests are about.
 */

const MINUTE = 60_000
const DAY = 86_400_000
// A Sunday, 09:00 in Chicago.
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-occurrence-'))
  clock = new ManualClock(START - DAY)
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

const post = (url: string, body?: unknown) =>
  server.inject({ method: 'POST', url, payload: (body ?? {}) as object })
const patch = (url: string, body: unknown) =>
  server.inject({ method: 'PATCH', url, payload: body as object })
const del = (url: string) => server.inject({ method: 'DELETE', url })
const get = (url: string) => server.inject({ method: 'GET', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

/** A weekly Sunday service, and the id of its first occurrence. */
async function weeklyService(): Promise<{ seriesId: string; first: any; second: any }> {
  const series = json(
    await post('/api/series', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstart: START,
      durationMs: 90 * MINUTE,
      templates: { title: '{{event.name}} — {{date "d MMMM"}}' },
    }),
  )
  const occurrences = json(await get(`/api/occurrences?from=${START - DAY}&to=${START + 30 * DAY}`))
  return { seriesId: series.id, first: occurrences[0], second: occurrences[1] }
}

describe('changing one occurrence', () => {
  it('renames only the morning it was asked about', async () => {
    const { first, second } = await weeklyService()

    const done = json(await patch(`/api/occurrences/${first.id}`, { label: 'Baptism Service' }))
    expect(done.detached).toBe(true)

    const after = json(await get(`/api/occurrences?from=${START - DAY}&to=${START + 30 * DAY}`))
    expect(after[0].label).toBe('Baptism Service')
    expect(after[0].detached).toBe(true)
    // The series is untouched, and so is every other week.
    expect(after[0].seriesLabel).toBe('Sunday Service')
    expect(after[1].id).toBe(second.id)
    expect(after[1].label).toBe('Sunday Service')
    expect(after[1].detached).toBe(false)
  })

  it('is what the run actually uses, not just what the calendar shows', async () => {
    // The whole point. An edit the engine did not honour would be a
    // rename on a screen and a service that went out under the old name.
    const { first } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, {
      label: 'Baptism Service',
      templates: { title: 'Baptism at Grace' },
    })

    const timeline = timelineFor(app.db, first.id)
    expect(timeline.label).toBe('Baptism Service')
    expect(timeline.templates.title).toBe('Baptism at Grace')
    expect(timeline.detached).toBe(true)
  })

  it('survives a later edit to the whole series', async () => {
    const { seriesId, first, second } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, { label: 'Baptism Service' })

    // Somebody moves the service to 10:00 for everybody.
    await patch(`/api/series/${seriesId}`, {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstartLocal: { date: '2026-03-08', time: '10:00' },
      durationMs: 90 * MINUTE,
    })

    const after = json(await get(`/api/occurrences?from=${START - DAY}&to=${START + 30 * DAY}`))
    const edited = after.find((o: any) => o.id === first.id)
    // Left alone, which is what detaching means.
    expect(edited.label).toBe('Baptism Service')
    expect(edited.scheduledStart).toBe(first.scheduledStart)
    // And the rest of the series did move.
    const untouched = after.find((o: any) => o.id === second.id)
    expect(untouched === undefined || untouched.scheduledStart !== second.scheduledStart).toBe(true)
  })

  it('moves one occurrence in the event’s own zone', async () => {
    const { first } = await weeklyService()

    await patch(`/api/occurrences/${first.id}`, {
      startsAt: { date: '2026-03-08', time: '11:30' },
    })

    const after = json(await get(`/api/occurrences/${first.id}`))
    // 11:30 Chicago on the day the clocks went forward: 16:30 UTC.
    expect(new Date(after.scheduledStart).toISOString()).toBe('2026-03-08T16:30:00.000Z')
    // The window keeps its length.
    expect(after.scheduledEnd - after.scheduledStart).toBe(90 * MINUTE)
    // And it remembers where it came from, so the screen can say so.
    expect(after.overrides.movedFrom).toBe(first.scheduledStart)
  })

  it('refuses a move onto a time the clocks skip over', async () => {
    const { first } = await weeklyService()
    const refused = await patch(`/api/occurrences/${first.id}`, {
      startsAt: { date: '2026-03-08', time: '02:30' },
    })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    expect(json(refused).error).toMatch(/does not exist/i)
  })

  it('refuses a move into the past', async () => {
    const { first } = await weeklyService()
    const refused = await patch(`/api/occurrences/${first.id}`, {
      startsAt: { date: '2026-03-01', time: '09:00' },
    })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/past/i)
  })

  it('refuses to change an event that is under way', async () => {
    const { first } = await weeklyService()
    await post(`/api/occurrences/${first.id}/start-now`)

    const refused = await patch(`/api/occurrences/${first.id}`, { label: 'Too late' })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/under way|no longer/i)
  })

  it('puts one back on its series when asked', async () => {
    const { first } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, {
      label: 'Baptism Service',
      startsAt: { date: '2026-03-08', time: '11:30' },
    })

    const back = json(await del(`/api/occurrences/${first.id}/overrides`))
    expect(back.detached).toBe(false)

    const after = json(await get(`/api/occurrences/${first.id}`))
    expect(after.detached).toBe(false)
    expect(after.label ?? after.seriesLabel).toBe('Sunday Service')
    // Back where the rule puts it, not where it had been dragged to.
    expect(after.scheduledStart).toBe(first.scheduledStart)
  })

  it('clears one override without clearing the other', async () => {
    const { first } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, {
      label: 'Baptism Service',
      templates: { title: 'Baptism at Grace' },
    })

    // null means "put this back on the series", absent means "leave it".
    await patch(`/api/occurrences/${first.id}`, { templates: null })

    const after = json(await get(`/api/occurrences/${first.id}`))
    expect(after.overrides.label).toBe('Baptism Service')
    expect(after.overrides.templates).toBeUndefined()
    expect(after.detached).toBe(true)
  })

  it('re-attaches an occurrence whose last override is cleared', async () => {
    const { first } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, { label: 'Baptism Service' })
    await patch(`/api/occurrences/${first.id}`, { label: null })

    // Nothing left to distinguish it, so it is not detached any more and
    // the series owns it again.
    expect(json(await get(`/api/occurrences/${first.id}`)).detached).toBe(false)
  })

  it('remembers the first move, not the last one', async () => {
    const { first } = await weeklyService()
    await patch(`/api/occurrences/${first.id}`, { startsAt: { date: '2026-03-08', time: '10:00' } })
    await patch(`/api/occurrences/${first.id}`, { startsAt: { date: '2026-03-08', time: '11:00' } })

    // Nudging a service twice still moved it from 09:00.
    const after = json(await get(`/api/occurrences/${first.id}`))
    expect(after.overrides.movedFrom).toBe(first.scheduledStart)
  })

  it('names the occurrence as it will actually be called', async () => {
    // The detail screen leads with this, and a page headed with the
    // series' name on the one date it does not apply is the wrong thing
    // in the one place it matters.
    const { first } = await weeklyService()
    expect(json(await get(`/api/occurrences/${first.id}`)).label).toBe('Sunday Service')
    await patch(`/api/occurrences/${first.id}`, { label: 'Baptism Service' })
    const after = json(await get(`/api/occurrences/${first.id}`))
    expect(after.label).toBe('Baptism Service')
    expect(after.seriesLabel).toBe('Sunday Service')
  })

  it('says plainly when there is no such occurrence', async () => {
    expect((await get('/api/occurrences/nope')).statusCode).toBe(404)
    expect((await patch('/api/occurrences/nope', { label: 'x' })).statusCode).toBe(404)
  })
})
