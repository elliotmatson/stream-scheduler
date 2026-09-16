import { randomUUID } from 'node:crypto'
import type { Clock, PlannedService } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import { localDateAt } from '../schedule/zoned.js'
import type { PlanSourceRegistry } from './registry.js'

/**
 * Turning published service times into occurrences.
 *
 * This is the half of the pairing that matters, and the shape of it comes
 * from one fact: **the source decides how many services there are.** A
 * normal Sunday has two, Christmas Eve has one, Easter has three. So this
 * is not a re-timing pass over occurrences a rule already made — for a
 * paired series the rule is never consulted, and what is here is the whole
 * schedule.
 *
 * Three rules keep that from being dangerous:
 *
 *   - **Occurrences are matched by the source's id for the time**, not by
 *     when they start. A service that moves is the same service, and
 *     matching on the clock would read a move as a delete and a create —
 *     losing its run history and any edit somebody made to it.
 *   - **Nothing is moved or removed once it is preparing.** Somebody
 *     tidying plan times on a Sunday morning must not cancel a broadcast
 *     that is already getting ready to go out.
 *   - **An occurrence a person edited is theirs.** Same rule the recurrence
 *     path has always had: "change this one" has to survive "the plan
 *     changed", or it was not a change at all.
 */

export interface PairedSeriesRow {
  id: string
  timezone: string
  duration_ms: number
  prepare_lead_ms: number
  version: number
  enabled: number
  plan_source_id: string | null
  plan_group_id: string | null
}

export interface SyncResult {
  created: number
  /** Moved, or re-read because the plan's details changed. */
  updated: number
  removed: number
  /** Left alone because they are already preparing or have run. */
  frozen: number
  /** Left alone because somebody edited them. */
  detached: number
  /** Things worth saying out loud rather than swallowing. */
  issues: string[]
}

const EMPTY: SyncResult = {
  created: 0,
  updated: 0,
  removed: 0,
  frozen: 0,
  detached: 0,
  issues: [],
}

interface OccurrenceRow {
  id: string
  scheduled_start: number
  scheduled_end: number
  local_date: string
  status: string
  overrides: string | null
  external_ref: string | null
  external_detail: string | null
}

export interface SyncDeps {
  db: Db
  clock: Clock
  sources: PlanSourceRegistry
  logger?: Logger
}

/** The pairing on a series, or undefined when it has none. */
export function pairingOf(
  series: Pick<PairedSeriesRow, 'plan_source_id' | 'plan_group_id'>,
): { sourceId: string; groupId: string } | undefined {
  const sourceId = series.plan_source_id?.trim()
  const groupId = series.plan_group_id?.trim()
  // Both or neither: half a pairing is not a pairing, and reading it as one
  // would empty somebody's calendar on the strength of a bad write.
  if (!sourceId || !groupId) return undefined
  return { sourceId, groupId }
}

/**
 * Brings one paired series' occurrences in line with the source.
 *
 * Reaching out to the source is the only async part; everything that
 * touches the database happens in one transaction afterwards, so a request
 * that hangs cannot hold a write lock across a network call.
 */
export async function syncSeries(deps: SyncDeps, seriesId: string): Promise<SyncResult> {
  const logger = deps.logger ?? silentLogger
  const series = deps.db.prepare('SELECT * FROM event_series WHERE id = ?').get(seriesId) as
    PairedSeriesRow | undefined
  if (!series) throw new Error(`No series with id "${seriesId}".`)

  const pairing = pairingOf(series)
  if (!pairing) return { ...EMPTY }

  // A disabled series keeps whatever it has and stops being updated, which
  // is what "disabled" means everywhere else in this app.
  if (!series.enabled) return { ...EMPTY }

  let services: PlannedService[]
  try {
    services = await deps.sources.get(pairing.sourceId).listServices(pairing.groupId)
    recordSuccess(deps, seriesId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The schedule already on the books is left exactly as it is. An
    // unreachable Planning Center must never empty a calendar — that would
    // turn a network blip into a Sunday with nothing scheduled.
    recordFailure(deps, seriesId, message)
    logger.warn('could not read the plan for a series', { seriesId, error: message })
    return { ...EMPTY, issues: [message] }
  }

  return reconcile(deps, series, services)
}

/** Every paired series. Unpaired ones are not touched. */
export async function syncAll(deps: SyncDeps): Promise<Map<string, SyncResult>> {
  const rows = deps.db
    .prepare(
      `SELECT id FROM event_series
       WHERE plan_source_id IS NOT NULL AND plan_group_id IS NOT NULL AND enabled = 1`,
    )
    .all() as { id: string }[]

  const results = new Map<string, SyncResult>()
  for (const row of rows) {
    // One series failing must not stop the next: they are usually different
    // service types, and often a different problem.
    try {
      results.set(row.id, await syncSeries(deps, row.id))
    } catch (error) {
      results.set(row.id, {
        ...EMPTY,
        issues: [error instanceof Error ? error.message : String(error)],
      })
    }
  }
  return results
}

function reconcile(
  deps: SyncDeps,
  series: PairedSeriesRow,
  services: PlannedService[],
): SyncResult {
  const now = deps.clock.now()
  const result: SyncResult = { ...EMPTY, issues: [] }

  const existing = deps.db
    .prepare('SELECT * FROM occurrence WHERE series_id = ? AND external_ref IS NOT NULL')
    .all(series.id) as OccurrenceRow[]
  const byRef = new Map(existing.map((row) => [row.external_ref!, row]))

  // Services already in the past are not scheduled. The source filters to
  // future plans, but a plan can move backwards between the fetch and here,
  // and a broadcast in the past would run immediately and fail.
  const wanted = services.filter((service) => service.startsAt > now)
  const wantedRefs = new Set(wanted.map((service) => service.externalId))

  const insert = deps.db.prepare(
    `INSERT INTO occurrence
       (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version,
        external_ref, external_detail)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
  const move = deps.db.prepare(
    `UPDATE occurrence
     SET scheduled_start = ?, scheduled_end = ?, local_date = ?, external_detail = ?,
         series_version = ?
     WHERE id = ?`,
  )
  const remove = deps.db.prepare('DELETE FROM occurrence WHERE id = ?')

  deps.db.transaction(() => {
    for (const service of wanted) {
      const start = service.startsAt
      const end = service.endsAt ?? start + series.duration_ms
      const localDate = localDateAt(start, series.timezone)
      const detail = service.detail ? JSON.stringify(service.detail) : null
      const current = byRef.get(service.externalId)

      if (!current) {
        // A start that collides with an occurrence already on the books
        // would break the (series, start) uniqueness. Reported rather than
        // thrown: one odd plan time must not stop the rest syncing.
        if (startTaken(deps, series.id, start, undefined)) {
          result.issues.push(
            `A service at ${new Date(start).toISOString()} matches one already scheduled, so it was left out.`,
          )
          continue
        }
        insert.run(
          randomUUID(),
          series.id,
          start,
          end,
          localDate,
          series.version,
          service.externalId,
          detail,
        )
        result.created++
        continue
      }

      if (current.overrides !== null) {
        result.detached++
        continue
      }
      if (isFrozen(current, series, now)) {
        result.frozen++
        continue
      }

      const changed =
        current.scheduled_start !== start ||
        current.scheduled_end !== end ||
        current.local_date !== localDate ||
        current.external_detail !== detail
      if (!changed) continue

      if (start !== current.scheduled_start && startTaken(deps, series.id, start, current.id)) {
        result.issues.push(
          `A service moved to ${new Date(start).toISOString()}, where another is already scheduled, so it was left where it was.`,
        )
        continue
      }
      move.run(start, end, localDate, detail, series.version, current.id)
      result.updated++
    }

    for (const row of existing) {
      if (wantedRefs.has(row.external_ref!)) continue
      if (row.overrides !== null) {
        result.detached++
        continue
      }
      // Something that has run is history, whatever the plan says now.
      if (row.status !== 'pending') continue
      if (isFrozen(row, series, now)) {
        result.frozen++
        continue
      }
      remove.run(row.id)
      result.removed++
    }
  })()

  return result
}

/**
 * Forgets everything a plan source put on the calendar for a series.
 *
 * Called when a pairing is removed. Without it, unpairing leaves
 * occurrences still carrying a source's id for a service — stale the moment
 * the plan changes, and quietly wrong if the series is ever paired again,
 * because they would match services they are no longer about.
 *
 * What has run stays, and what somebody edited stays. Both were true before
 * the pairing was removed and removing it does not change them.
 */
export function clearPlanOccurrences(db: Db, seriesId: string, now: number): number {
  const rows = db
    .prepare(
      `SELECT id FROM occurrence
        WHERE series_id = ? AND external_ref IS NOT NULL AND overrides IS NULL
          AND status = 'pending' AND scheduled_start >= ?`,
    )
    .all(seriesId, now) as { id: string }[]

  const remove = db.prepare('DELETE FROM occurrence WHERE id = ?')
  db.transaction(() => {
    for (const row of rows) remove.run(row.id)
  })()
  return rows.length
}

/**
 * Whether an occurrence is close enough to going out to be left alone.
 *
 * The freeze point is when the run starts preparing, which is where
 * everything else in this app commits. Before it, the plan is in charge and
 * a service tidied up on Saturday night still counts. After it, the
 * scheduler is: somebody rearranging plan times at 08:55 must not cancel a
 * broadcast that is already getting ready.
 */
export function isFrozen(
  occurrence: { scheduled_start: number },
  series: { prepare_lead_ms: number },
  now: number,
): boolean {
  return now >= occurrence.scheduled_start - series.prepare_lead_ms
}

/** Whether another occurrence in this series already starts at that instant. */
function startTaken(
  deps: SyncDeps,
  seriesId: string,
  start: number,
  exceptId: string | undefined,
): boolean {
  const row = deps.db
    .prepare('SELECT id FROM occurrence WHERE series_id = ? AND scheduled_start = ?')
    .get(seriesId, start) as { id: string } | undefined
  return row !== undefined && row.id !== exceptId
}

function recordSuccess(deps: SyncDeps, seriesId: string): void {
  deps.db
    .prepare('UPDATE event_series SET plan_synced_at = ?, plan_error = NULL WHERE id = ?')
    .run(deps.clock.now(), seriesId)
}

function recordFailure(deps: SyncDeps, seriesId: string, message: string): void {
  // `plan_synced_at` is deliberately not touched: it means "last read
  // cleanly", and a UI saying "read two minutes ago" beside an error would
  // be worse than saying nothing.
  deps.db.prepare('UPDATE event_series SET plan_error = ? WHERE id = ?').run(message, seriesId)
}
