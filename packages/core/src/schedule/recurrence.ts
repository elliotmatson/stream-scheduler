import { RRule } from 'rrule'
import { asNaiveUtc, isValidTimeZone, localDateAt, wallTimeAt, zonedWallTimeToUtc } from './zoned.js'
import type { WallTime, WallTimeResolution, ZonedInstant } from './zoned.js'

export interface SeriesSchedule {
  /** IANA zone the wall-clock times are written in. */
  timezone: string
  /** An RFC 5545 RRULE body, e.g. `FREQ=WEEKLY;BYDAY=SU`. Null for a one-off. */
  rrule: string | null
  /** The first occurrence, as a UTC instant. */
  dtstart: number
  durationMs: number
  /** UTC instants to skip, from the series' EXDATE list. */
  exdates?: number[]
}

export interface ExpandedOccurrence {
  start: number
  end: number
  /** `YYYY-MM-DD` in the series timezone. Stored, not derived at read time. */
  localDate: string
  /** How a DST boundary was resolved, so the UI can flag a shifted occurrence. */
  resolution: WallTimeResolution
}

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidScheduleError'
  }
}

/** Guards against a rule like `FREQ=SECONDLY` filling the database. */
const MAX_OCCURRENCES = 10_000
const DAY = 86_400_000

export function validateSchedule(schedule: SeriesSchedule): void {
  if (!isValidTimeZone(schedule.timezone)) {
    throw new InvalidScheduleError(`"${schedule.timezone}" is not a known IANA time zone.`)
  }
  if (!Number.isFinite(schedule.dtstart)) {
    throw new InvalidScheduleError('The series has no valid start time.')
  }
  if (!(schedule.durationMs > 0)) {
    throw new InvalidScheduleError('The series duration must be greater than zero.')
  }
  if (schedule.rrule !== null) buildRule(schedule)
}

/**
 * Expands a series into concrete occurrences overlapping [rangeStart, rangeEnd].
 *
 * The rule is evaluated in local wall time and each result is converted to UTC
 * afterwards, so a weekly 9am service stays at 9am across DST rather than
 * drifting an hour twice a year.
 *
 * Note on UNTIL: because expansion happens in wall time, an `UNTIL` in the rule
 * is read as a wall-clock time in the series zone, which is what a user who
 * typed "until 1 June" means.
 */
export function expandOccurrences(
  schedule: SeriesSchedule,
  rangeStart: number,
  rangeEnd: number,
  options: { limit?: number } = {},
): ExpandedOccurrence[] {
  validateSchedule(schedule)
  const limit = Math.min(options.limit ?? MAX_OCCURRENCES, MAX_OCCURRENCES)
  if (rangeEnd < rangeStart) return []

  const excluded = new Set(schedule.exdates ?? [])
  const candidates =
    schedule.rrule === null
      ? [{ instant: schedule.dtstart, resolution: 'exact' as const }]
      : expandRule(schedule, rangeStart, rangeEnd, limit + (schedule.exdates?.length ?? 0) + 64)

  const seen = new Set<number>()
  const out: ExpandedOccurrence[] = []
  for (const { instant: start, resolution } of candidates) {
    // An occurrence counts as in range when any part of it overlaps the window,
    // so a service already running when the horizon opens is not lost.
    if (start + schedule.durationMs < rangeStart || start > rangeEnd) continue
    // A skipped wall time shifts forward and can land on another occurrence.
    if (excluded.has(start) || seen.has(start)) continue
    seen.add(start)
    out.push({
      start,
      end: start + schedule.durationMs,
      localDate: localDateAt(start, schedule.timezone),
      resolution,
    })
    if (out.length >= limit) break
  }
  return out.sort((a, b) => a.start - b.start)
}

function expandRule(
  schedule: SeriesSchedule,
  rangeStart: number,
  rangeEnd: number,
  rawLimit: number,
): ZonedInstant[] {
  const rule = buildRule(schedule)

  // Pad the naive window either side: a wall time near the edge can land
  // outside the UTC range once converted, and vice versa.
  const naiveFrom = asNaiveUtc(wallTimeAt(rangeStart, schedule.timezone)) - 2 * DAY
  const naiveTo = asNaiveUtc(wallTimeAt(rangeEnd, schedule.timezone)) + 2 * DAY

  // Stop the iterator at the cap rather than filtering afterwards: a rule like
  // FREQ=MINUTELY over a year is half a million dates, and generating them all
  // just to throw them away blocks the scheduler tick for seconds.
  const naiveResults = rule.between(new Date(naiveFrom), new Date(naiveTo), true, (_date, index) => index < rawLimit)
  return naiveResults.map((naive) => zonedWallTimeToUtc(wallOf(naive), schedule.timezone))
}

function buildRule(schedule: SeriesSchedule): RRule {
  const dtstart = new Date(asNaiveUtc(wallTimeAt(schedule.dtstart, schedule.timezone)))
  try {
    return new RRule({ ...RRule.parseString(schedule.rrule ?? ''), dtstart })
  } catch (error) {
    throw new InvalidScheduleError(
      `"${schedule.rrule}" is not a valid recurrence rule: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Reads a naive Date (wall-clock digits encoded as UTC) back into parts. */
function wallOf(naive: Date): WallTime {
  return {
    year: naive.getUTCFullYear(),
    month: naive.getUTCMonth() + 1,
    day: naive.getUTCDate(),
    hour: naive.getUTCHours(),
    minute: naive.getUTCMinutes(),
    second: naive.getUTCSeconds(),
  }
}

/** A plain-language summary of a rule, for the series list. */
export function describeSchedule(schedule: SeriesSchedule): string {
  if (schedule.rrule === null) return 'Once'
  try {
    return buildRule(schedule).toText()
  } catch {
    return schedule.rrule
  }
}
