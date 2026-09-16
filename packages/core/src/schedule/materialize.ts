import { randomUUID } from 'node:crypto'
import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { expandOccurrences } from './recurrence.js'
import type { SeriesSchedule } from './recurrence.js'

/** How far ahead concrete occurrences are created. */
export const DEFAULT_HORIZON_MS = 60 * 86_400_000

export interface SeriesRow {
  id: string
  label: string
  timezone: string
  rrule: string | null
  dtstart: number
  duration_ms: number
  exdates: string
  version: number
  enabled: number
  /** Set when the schedule comes from a plan source instead of the rule. */
  plan_source_id?: string | null
  plan_group_id?: string | null
}

export interface OccurrenceRow {
  id: string
  series_id: string
  scheduled_start: number
  scheduled_end: number
  local_date: string
  status: string
  overrides: string | null
  series_version: number
  /** Set when this occurrence came from a plan source, not from the rule. */
  external_ref?: string | null
}

export interface MaterializeResult {
  created: number
  updated: number
  removed: number
  /** Occurrences left alone because a user had edited them. */
  detached: number
}

/**
 * Brings one series' materialized occurrences in line with its rule.
 *
 * Occurrences are stored rather than computed on demand because they must be
 * individually addressable — skipped, time-shifted, retitled, or carrying the
 * run history of something that already happened. A computed view holds none
 * of that.
 *
 * Reconciliation rules, which are the ones every calendar app has and users
 * expect:
 *   - past occurrences are history and are never touched;
 *   - a future occurrence the user has edited (`overrides` set) is left alone
 *     and reported as detached, so the UI can show it did not get the update;
 *   - everything else is regenerated from the current rule.
 */
export function materializeSeries(
  db: Db,
  seriesId: string,
  options: { clock: Clock; horizonMs?: number },
): MaterializeResult {
  const series = db.prepare('SELECT * FROM event_series WHERE id = ?').get(seriesId) as
    SeriesRow | undefined
  if (!series) throw new Error(`No series with id "${seriesId}".`)

  const now = options.clock.now()
  const horizonEnd = now + (options.horizonMs ?? DEFAULT_HORIZON_MS)

  const existing = db
    .prepare('SELECT * FROM occurrence WHERE series_id = ? AND scheduled_start >= ?')
    .all(seriesId, now) as OccurrenceRow[]

  // A paired series has no rule to expand: the plan source says how many
  // services there are and when, and inventing occurrences from a rule
  // beside them would put guesses on the calendar next to real ones with
  // nothing to tell them apart. Past the last published plan the calendar
  // is deliberately empty — which is honest, and is what was asked for.
  if (series.plan_source_id && series.plan_group_id) {
    return clearRuleOccurrences(db, existing)
  }
  const byStart = new Map(existing.map((row) => [row.scheduled_start, row]))
  const detached = existing.filter((row) => row.overrides !== null)

  const wanted = series.enabled ? expandOccurrences(scheduleOf(series), now, horizonEnd) : []
  const wantedStarts = new Set(wanted.map((o) => o.start))

  const insert = db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
  const refresh = db.prepare(
    `UPDATE occurrence SET scheduled_end = ?, local_date = ?, series_version = ?
     WHERE id = ? AND overrides IS NULL`,
  )
  const remove = db.prepare('DELETE FROM occurrence WHERE id = ?')

  const result: MaterializeResult = {
    created: 0,
    updated: 0,
    removed: 0,
    detached: detached.length,
  }

  db.transaction(() => {
    for (const occurrence of wanted) {
      const current = byStart.get(occurrence.start)
      if (!current) {
        insert.run(
          randomUUID(),
          seriesId,
          occurrence.start,
          occurrence.end,
          occurrence.localDate,
          series.version,
        )
        result.created++
        continue
      }
      if (current.overrides !== null) continue // detached; the user owns this one
      const changed =
        current.scheduled_end !== occurrence.end ||
        current.local_date !== occurrence.localDate ||
        current.series_version !== series.version
      if (changed) {
        refresh.run(occurrence.end, occurrence.localDate, series.version, current.id)
        result.updated++
      }
    }

    for (const row of existing) {
      if (wantedStarts.has(row.scheduled_start)) continue
      if (row.overrides !== null) continue // never delete an occurrence a user edited
      if (row.status !== 'pending') continue // something already ran or is running
      remove.run(row.id)
      result.removed++
    }
  })()

  return result
}

/**
 * Removes what the rule left behind when a series is paired to a plan.
 *
 * Pairing changes where the schedule comes from, so occurrences the rule
 * made are now guesses about weeks the source will answer for. Anything
 * that has run, or that somebody edited, stays: history is history and an
 * edit is a decision.
 */
function clearRuleOccurrences(db: Db, existing: OccurrenceRow[]): MaterializeResult {
  const remove = db.prepare('DELETE FROM occurrence WHERE id = ?')
  const result: MaterializeResult = { created: 0, updated: 0, removed: 0, detached: 0 }

  db.transaction(() => {
    for (const row of existing) {
      if (row.external_ref) continue // the plan owns this one
      if (row.overrides !== null) {
        result.detached++
        continue
      }
      if (row.status !== 'pending') continue
      remove.run(row.id)
      result.removed++
    }
  })()

  return result
}

/** Materializes every series. Run on startup and nightly. */
export function materializeAll(
  db: Db,
  options: { clock: Clock; horizonMs?: number },
): Map<string, MaterializeResult> {
  const ids = (db.prepare('SELECT id FROM event_series').all() as { id: string }[]).map((r) => r.id)
  const results = new Map<string, MaterializeResult>()
  for (const id of ids) results.set(id, materializeSeries(db, id, options))
  return results
}

export function scheduleOf(series: SeriesRow): SeriesSchedule {
  return {
    timezone: series.timezone,
    rrule: series.rrule,
    dtstart: series.dtstart,
    durationMs: series.duration_ms,
    exdates: parseExdates(series.exdates),
  }
}

function parseExdates(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : []
  } catch {
    return []
  }
}

/** Bumped whenever a series' schedule or templates change, so materialization
 *  can tell which occurrences predate the edit. */
export function bumpSeriesVersion(db: Db, seriesId: string, clock: Clock): number {
  const row = db
    .prepare(
      'UPDATE event_series SET version = version + 1, updated_at = ? WHERE id = ? RETURNING version',
    )
    .get(clock.now(), seriesId) as { version: number } | undefined
  if (!row) throw new Error(`No series with id "${seriesId}".`)
  return row.version
}
