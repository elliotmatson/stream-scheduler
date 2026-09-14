import { randomUUID } from 'node:crypto'
import { ManualClock } from '@scheduler/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/index.js'
import type { Db } from '../db/index.js'
import { bumpSeriesVersion, materializeAll, materializeSeries } from './materialize.js'
import type { OccurrenceRow } from './materialize.js'

let db: Db
let clock: ManualClock

/** A Wednesday, so "next Sunday" is unambiguous in the tests below. */
const NOW = '2026-02-25T12:00:00Z'

beforeEach(() => {
  db = openTestDatabase()
  clock = new ManualClock(NOW)
  db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'Main',
    '{}',
    clock.now(),
  )
})
afterEach(() => db.close())

function createSeries(over: Partial<Record<string, unknown>> = {}): string {
  const id = randomUUID()
  const row = {
    id,
    label: 'Sunday Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstart: Date.parse('2026-02-01T15:00:00Z'), // 09:00 CST
    duration_ms: 90 * 60 * 1000,
    enabled: 1,
    ...over,
  }
  db.prepare(
    `INSERT INTO event_series (id, label, timezone, rrule, dtstart, duration_ms, enabled, created_at, updated_at)
     VALUES (@id, @label, @timezone, @rrule, @dtstart, @duration_ms, @enabled, ${clock.now()}, ${clock.now()})`,
  ).run(row)
  return id
}

const occurrences = (seriesId: string): OccurrenceRow[] =>
  db
    .prepare('SELECT * FROM occurrence WHERE series_id = ? ORDER BY scheduled_start')
    .all(seriesId) as OccurrenceRow[]

describe('materializeSeries', () => {
  it('creates occurrences across the horizon', () => {
    const id = createSeries()
    const result = materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    expect(result.created).toBe(3)
    expect(occurrences(id).map((o) => o.local_date)).toEqual(['2026-03-01', '2026-03-08', '2026-03-15'])
  })

  it('is idempotent', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    const second = materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    expect(second).toMatchObject({ created: 0, updated: 0, removed: 0 })
    expect(occurrences(id)).toHaveLength(3)
  })

  it('extends the horizon without disturbing what exists', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 14 * 86_400_000 })
    const before = occurrences(id).map((o) => o.id)
    materializeSeries(db, id, { clock, horizonMs: 35 * 86_400_000 })
    const after = occurrences(id)
    expect(after.length).toBeGreaterThan(before.length)
    // Existing rows keep their identity, so run history stays attached.
    expect(after.map((o) => o.id).slice(0, before.length)).toEqual(before)
  })

  it('regenerates future occurrences when the rule changes', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    db.prepare("UPDATE event_series SET rrule = 'FREQ=WEEKLY;BYDAY=WE' WHERE id = ?").run(id)
    bumpSeriesVersion(db, id, clock)

    const result = materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    expect(result.removed).toBe(3)
    expect(result.created).toBe(3)
    // The clock reads Wednesday 12:00Z and the service is at 09:00 local
    // (15:00Z), so today's own occurrence is still ahead and gets created.
    expect(occurrences(id).map((o) => o.local_date)).toEqual(['2026-02-25', '2026-03-04', '2026-03-11'])
  })

  it('leaves an occurrence the user edited alone and reports it as detached', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    const [first] = occurrences(id)
    db.prepare("UPDATE occurrence SET overrides = ? WHERE id = ?").run(
      JSON.stringify({ title: 'Guest speaker' }),
      first!.id,
    )

    db.prepare("UPDATE event_series SET rrule = 'FREQ=WEEKLY;BYDAY=WE' WHERE id = ?").run(id)
    bumpSeriesVersion(db, id, clock)
    const result = materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })

    expect(result.detached).toBe(1)
    const rows = occurrences(id)
    expect(rows.find((o) => o.id === first!.id)?.overrides).toContain('Guest speaker')
    expect(rows.map((o) => o.local_date)).toContain('2026-03-01') // the edited one survived
    expect(rows.map((o) => o.local_date)).toContain('2026-03-04') // and the new rule applied
  })

  it('never touches occurrences in the past', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    clock.set('2026-03-20T12:00:00Z')
    const before = occurrences(id).map((o) => o.id)

    db.prepare("UPDATE event_series SET rrule = 'FREQ=WEEKLY;BYDAY=WE' WHERE id = ?").run(id)
    bumpSeriesVersion(db, id, clock)
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })

    const remaining = occurrences(id).map((o) => o.id)
    for (const id of before) expect(remaining).toContain(id)
  })

  it('does not delete an occurrence that already started running', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    const [first] = occurrences(id)
    db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(first!.id)

    db.prepare("UPDATE event_series SET rrule = 'FREQ=WEEKLY;BYDAY=WE' WHERE id = ?").run(id)
    bumpSeriesVersion(db, id, clock)
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })

    expect(occurrences(id).map((o) => o.id)).toContain(first!.id)
  })

  it('clears future occurrences for a disabled series', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    db.prepare('UPDATE event_series SET enabled = 0 WHERE id = ?').run(id)
    const result = materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    expect(result.removed).toBe(3)
    expect(occurrences(id)).toHaveLength(0)
  })

  it('stores the local date in the series timezone, not the process timezone', () => {
    // 20:30 Chicago on Saturday is 02:30 UTC on Sunday. The stored date must
    // say Saturday, or the calendar shows the event on the wrong day.
    const id = createSeries({ rrule: 'FREQ=WEEKLY;BYDAY=SA', dtstart: Date.parse('2026-02-08T02:30:00Z') })
    materializeSeries(db, id, { clock, horizonMs: 10 * 86_400_000 })
    expect(occurrences(id)[0]?.local_date).toBe('2026-02-28')
  })

  it('keeps a weekly service at the same local time across DST', () => {
    const id = createSeries()
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    const [beforeDst, afterDst] = occurrences(id)
    // 15:00Z is 09:00 CST; 14:00Z is 09:00 CDT.
    expect(beforeDst?.scheduled_start).toBe(Date.parse('2026-03-01T15:00:00Z'))
    expect(afterDst?.scheduled_start).toBe(Date.parse('2026-03-08T14:00:00Z'))
  })

  it('materializes a one-off exactly once', () => {
    const id = createSeries({ rrule: null, dtstart: Date.parse('2026-03-05T15:00:00Z') })
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    materializeSeries(db, id, { clock, horizonMs: 21 * 86_400_000 })
    expect(occurrences(id)).toHaveLength(1)
  })

  it('reports an unknown series rather than silently doing nothing', () => {
    expect(() => materializeSeries(db, 'nope', { clock })).toThrow(/No series/)
  })
})

describe('materializeAll', () => {
  it('covers every series', () => {
    const a = createSeries()
    const b = createSeries({ rrule: 'FREQ=WEEKLY;BYDAY=WE' })
    const results = materializeAll(db, { clock, horizonMs: 14 * 86_400_000 })
    expect(results.size).toBe(2)
    expect(occurrences(a).length).toBeGreaterThan(0)
    expect(occurrences(b).length).toBeGreaterThan(0)
  })
})
