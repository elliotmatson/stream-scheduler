import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import type { PlannedService, PlanSource } from '@scheduler/plugin-sdk'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from './server.js'
import { silentLogger } from '../log.js'

/**
 * Pairing an event with a service type, through the API.
 *
 * The unit tests cover the reconciliation; what is worth pinning here is
 * the part somebody actually experiences — that pairing takes effect
 * immediately rather than at the next hourly tick, that the preview shows
 * real services instead of the rule's guesses, and that the rule's
 * occurrences do not linger beside the plan's.
 */

const NOW = Date.parse('2026-09-14T12:00:00Z')
const SUNDAY_9 = Date.parse('2026-09-20T14:00:00Z')
const SUNDAY_11 = Date.parse('2026-09-20T16:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance
let published: PlannedService[]

const source: PlanSource = {
  id: 'planning-center',
  displayName: 'Planning Center',
  apiVersion: '1',
  isConfigured: async () => true,
  check: async () => ({ state: 'ok' }),
  listGroups: async () => [{ id: '1024', name: 'Sunday Morning' }],
  listServices: async (groupId) => {
    if (groupId !== '1024') throw new Error('Resource not found.')
    return published
  },
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-pairing-'))
  clock = new ManualClock(NOW)
  published = [
    {
      externalId: 'nine',
      startsAt: SUNDAY_9,
      detail: { planTitle: 'The Weight of Glory', seriesTitle: 'Romans', timeName: '9:00 Service' },
    },
    { externalId: 'eleven', startsAt: SUNDAY_11, detail: { timeName: '11:00 Service' } },
  ]
  app = Application.create({ configDir: dir, clock, logger: silentLogger })
  app.planSources.register(source)
  server = await createServer({ app })
})

afterEach(async () => {
  await server.close()
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
})

const post = (url: string, body: unknown) =>
  server.inject({ method: 'POST', url, payload: body as object })
const patch = (url: string, body: unknown) =>
  server.inject({ method: 'PATCH', url, payload: body as object })
const get = (url: string) => server.inject({ method: 'GET', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

const SERIES = {
  label: 'Sunday Service',
  timezone: 'America/Chicago',
  rrule: 'FREQ=WEEKLY;BYDAY=SU',
  dtstart: SUNDAY_9,
  durationMs: 90 * 60_000,
}

async function series(over: Record<string, unknown> = {}): Promise<string> {
  const created = await post('/api/series', { ...SERIES, ...over })
  return json(created).id
}

const occurrencesOf = (id: string) =>
  app.db
    .prepare('SELECT * FROM occurrence WHERE series_id = ? ORDER BY scheduled_start')
    .all(id) as { scheduled_start: number; external_ref: string | null }[]

describe('pairing a series', () => {
  it('takes its schedule from the plan straight away', async () => {
    // Not at the next hourly tick: an empty calendar for an hour is
    // indistinguishable from the pairing not working.
    const id = await series({ planSourceId: 'planning-center', planGroupId: '1024' })

    expect(occurrencesOf(id).map((o) => o.scheduled_start)).toEqual([SUNDAY_9, SUNDAY_11])
    expect(occurrencesOf(id).map((o) => o.external_ref)).toEqual(['nine', 'eleven'])
  })

  it('clears the rule’s guesses when an existing series is paired', async () => {
    const id = await series()
    expect(occurrencesOf(id).length).toBeGreaterThan(2)

    await patch(`/api/series/${id}`, { planSourceId: 'planning-center', planGroupId: '1024' })

    expect(occurrencesOf(id).map((o) => o.external_ref)).toEqual(['nine', 'eleven'])
  })

  it('hands the series back to its rule when unpaired', async () => {
    const id = await series({ planSourceId: 'planning-center', planGroupId: '1024' })
    await patch(`/api/series/${id}`, { planSourceId: null, planGroupId: null })

    const refs = occurrencesOf(id).map((o) => o.external_ref)
    expect(refs.length).toBeGreaterThan(2)
    expect(refs.every((ref) => ref === null)).toBe(true)
  })

  it('refuses a source this build does not have', async () => {
    // Stored silently, this would be a series with an empty calendar and
    // nothing at all to explain it.
    const response = await post('/api/series', {
      ...SERIES,
      planSourceId: 'church-tools',
      planGroupId: '7',
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('treats half a pairing as none', async () => {
    const id = await series({ planSourceId: 'planning-center' })
    const row = json(await get('/api/series')).find((s: { id: string }) => s.id === id)
    expect(row.planSourceId).toBeNull()
  })

  it('saves the pairing even when the source cannot be read', async () => {
    // The pairing is a decision; the read is a network call. Losing the
    // first because of the second would be maddening.
    const id = await series({ planSourceId: 'planning-center', planGroupId: 'nope' })
    const row = json(await get('/api/series')).find((s: { id: string }) => s.id === id)

    expect(row.planGroupId).toBe('nope')
    expect(row.planError).toContain('not found')
  })

  it('reports when the plan was last read cleanly', async () => {
    const id = await series({ planSourceId: 'planning-center', planGroupId: '1024' })
    const row = json(await get('/api/series')).find((s: { id: string }) => s.id === id)
    expect(row.planSyncedAt).toBe(NOW)
    expect(row.planError).toBeNull()
  })
})

describe('what the series list says next happens', () => {
  it('answers from the plan, not from the rule', async () => {
    // The rule says every Sunday at 9:00. If the plan says otherwise, the
    // rule's answer is a lie told on the main list screen.
    published = [{ externalId: 'moved', startsAt: SUNDAY_9 + 3_600_000 }]
    const id = await series({ planSourceId: 'planning-center', planGroupId: '1024' })

    const row = json(await get('/api/series')).find((s: { id: string }) => s.id === id)
    expect(row.nextAt).toBe(SUNDAY_9 + 3_600_000)
  })

  it('says nothing is next when no plan is published', async () => {
    published = []
    const id = await series({ planSourceId: 'planning-center', planGroupId: '1024' })
    const row = json(await get('/api/series')).find((s: { id: string }) => s.id === id)
    expect(row.nextAt).toBeNull()
  })
})

describe('previewing a paired series', () => {
  const preview = (body: Record<string, unknown>) =>
    post('/api/schedule/preview', {
      ...SERIES,
      templates: { title: '{{event.name}} — {{plan.title}}' },
      ...body,
    })

  it('shows the real services rather than expanding the rule', async () => {
    const body = json(await preview({ planSourceId: 'planning-center', planGroupId: '1024' }))
    expect(body.occurrences).toHaveLength(2)
    expect(body.occurrences[0].start).toBe(SUNDAY_9)
    expect(body.describes).toContain('Planning Center')
  })

  it('renders the plan tokens against what the plan actually says', async () => {
    const body = json(await preview({ planSourceId: 'planning-center', planGroupId: '1024' }))
    expect(body.occurrences[0].title).toBe('Sunday Service — The Weight of Glory')
  })

  it('names the token when the plan has not filled it in yet', async () => {
    // A Saturday-afternoon problem with a different owner than a setup
    // mistake, so it gets a different message.
    const body = json(await preview({ planSourceId: 'planning-center', planGroupId: '1024' }))
    expect(body.occurrences[1].error).toContain('no plan title')
  })

  it('says plainly when nothing is planned', async () => {
    published = []
    const body = json(await preview({ planSourceId: 'planning-center', planGroupId: '1024' }))
    expect(body.occurrences).toEqual([])
    expect(body.describes).toContain('Nothing is planned')
  })

  it('reports a source that will not answer rather than showing a rule', async () => {
    const body = json(await preview({ planSourceId: 'planning-center', planGroupId: 'nope' }))
    expect(body.error).toContain('not found')
    expect(body.occurrences).toEqual([])
  })

  it('still expands the rule when there is no pairing', async () => {
    const body = json(await preview({ templates: { title: '{{event.name}}' } }))
    expect(body.occurrences.length).toBeGreaterThan(0)
    expect(body.describes).not.toContain('Planning Center')
  })

  it('explains a plan token on a series that is not paired', async () => {
    const body = json(await preview({}))
    expect(body.occurrences[0].error).toContain('does not take its schedule from Planning Center')
  })
})
