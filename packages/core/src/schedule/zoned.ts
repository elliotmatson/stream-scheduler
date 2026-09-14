/**
 * Wall-clock <-> UTC conversion for a named IANA zone.
 *
 * Recurrence is expanded in local wall time and only then converted to UTC.
 * Expanding in UTC and converting back makes a weekly 9am service drift an
 * hour twice a year, which is the single most likely quiet bug in this
 * project. See docs/plan/03-scheduling-engine.md.
 */

export interface WallTime {
  year: number
  month: number // 1-12, not the JS 0-11
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(0)
    return true
  } catch {
    return false
  }
}

/** The wall-clock reading a clock in `timeZone` shows at `instant`. */
export function wallTimeAt(instant: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new Error(`Intl did not report "${type}" for zone ${timeZone}`)
    return Number(part.value)
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Offset in ms that `timeZone` is ahead of UTC at `instant`. */
export function zoneOffsetAt(instant: number, timeZone: string): number {
  const wall = wallTimeAt(instant, timeZone)
  return asNaiveUtc(wall) - instant
}

/** Encodes a wall time as the UTC instant with the same digits. */
export function asNaiveUtc(wall: WallTime): number {
  const ms = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  // Date.UTC maps years 0-99 into the 1900s; the schedule horizon never goes
  // there, but silently shifting a century is not an acceptable failure mode.
  if (wall.year >= 0 && wall.year < 100) {
    const date = new Date(ms)
    date.setUTCFullYear(wall.year)
    return date.getTime()
  }
  return ms
}

export type WallTimeResolution = 'exact' | 'ambiguous' | 'skipped'

export interface ZonedInstant {
  instant: number
  /**
   * - `exact`     the wall time happened once, as written.
   * - `ambiguous` the clocks went back, so it happened twice; we take the
   *               first (the earlier UTC instant), matching RFC 5545 readers.
   * - `skipped`   the clocks went forward over it, so it never happened; we
   *               shift forward by the gap, so an 02:30 event runs at 03:30
   *               rather than silently not running at all.
   */
  resolution: WallTimeResolution
}

/**
 * Converts a wall-clock reading in `timeZone` to a UTC instant, stating
 * explicitly what it did at a DST boundary.
 *
 * Implemented directly rather than delegating, because the two interesting
 * cases are exactly the ones libraries disagree about, and a scheduler that
 * silently skips a service on the spring-forward Sunday is worse than one
 * that runs it an hour late.
 */
export function zonedWallTimeToUtc(wall: WallTime, timeZone: string): ZonedInstant {
  const naive = asNaiveUtc(wall)

  // Probe the offsets a day either side of the wall time. A zone changes
  // offset at most once a day, so this brackets any transition from both
  // directions. Iterating from a single starting guess instead would only
  // find the second candidate when the guess happened to land on the far
  // side of the transition, which silently misses half the ambiguous cases.
  const DAY = 86_400_000
  const offsetBefore = zoneOffsetAt(naive - DAY, timeZone)
  const offsetAfter = zoneOffsetAt(naive + DAY, timeZone)

  const candidates = [...new Set([naive - offsetBefore, naive - offsetAfter])]
  const valid = candidates.filter((instant) => asNaiveUtc(wallTimeAt(instant, timeZone)) === naive)

  if (valid.length === 1) return { instant: valid[0]!, resolution: 'exact' }
  if (valid.length > 1) return { instant: Math.min(...valid), resolution: 'ambiguous' }
  return { instant: Math.max(...candidates), resolution: 'skipped' }
}

/** `YYYY-MM-DD` as read in `timeZone`, for `occurrence.local_date`. */
export function localDateAt(instant: number, timeZone: string): string {
  const { year, month, day } = wallTimeAt(instant, timeZone)
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}
