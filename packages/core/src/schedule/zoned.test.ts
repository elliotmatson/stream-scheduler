import { describe, expect, it } from 'vitest'
import {
  asNaiveUtc,
  isValidTimeZone,
  localDateAt,
  wallTimeAt,
  zoneOffsetAt,
  zonedWallTimeToUtc,
} from './zoned.js'
import type { WallTime } from './zoned.js'

const wall = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): WallTime => ({ year, month, day, hour, minute, second })

describe('wallTimeAt', () => {
  it('reads the local clock in the target zone', () => {
    expect(wallTimeAt(Date.parse('2026-03-08T14:00:00Z'), 'America/Chicago')).toEqual(wall(2026, 3, 8, 9))
    expect(wallTimeAt(Date.parse('2026-03-08T14:00:00Z'), 'UTC')).toEqual(wall(2026, 3, 8, 14))
  })

  it('handles midnight without rolling to hour 24', () => {
    expect(wallTimeAt(Date.parse('2026-03-08T06:00:00Z'), 'America/Chicago')).toEqual(wall(2026, 3, 8, 0))
  })
})

describe('zoneOffsetAt', () => {
  it('tracks the DST change', () => {
    const hour = 3_600_000
    expect(zoneOffsetAt(Date.parse('2026-01-15T12:00:00Z'), 'America/Chicago')).toBe(-6 * hour)
    expect(zoneOffsetAt(Date.parse('2026-07-15T12:00:00Z'), 'America/Chicago')).toBe(-5 * hour)
  })

  it('handles a zone with a half-hour offset', () => {
    expect(zoneOffsetAt(Date.parse('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000)
  })
})

describe('zonedWallTimeToUtc', () => {
  it('round-trips an ordinary wall time', () => {
    const result = zonedWallTimeToUtc(wall(2026, 3, 8, 9), 'America/Chicago')
    expect(result.resolution).toBe('exact')
    expect(new Date(result.instant).toISOString()).toBe('2026-03-08T14:00:00.000Z')
  })

  it('keeps a weekly 9am service at 9am local across the spring-forward weekend', () => {
    // This is the whole point of expanding in local time. The UTC instants
    // differ by an hour; the wall-clock time does not move.
    const before = zonedWallTimeToUtc(wall(2026, 3, 1, 9), 'America/Chicago')
    const after = zonedWallTimeToUtc(wall(2026, 3, 8, 9), 'America/Chicago')
    expect(new Date(before.instant).toISOString()).toBe('2026-03-01T15:00:00.000Z')
    expect(new Date(after.instant).toISOString()).toBe('2026-03-08T14:00:00.000Z')
    expect(wallTimeAt(before.instant, 'America/Chicago').hour).toBe(9)
    expect(wallTimeAt(after.instant, 'America/Chicago').hour).toBe(9)
  })

  it('shifts a skipped wall time forward rather than dropping the event', () => {
    // 02:30 on 8 March 2026 never happens in Chicago: 02:00 CST becomes 03:00 CDT.
    const result = zonedWallTimeToUtc(wall(2026, 3, 8, 2, 30), 'America/Chicago')
    expect(result.resolution).toBe('skipped')
    expect(wallTimeAt(result.instant, 'America/Chicago')).toEqual(wall(2026, 3, 8, 3, 30))
  })

  it('takes the first pass of an ambiguous wall time', () => {
    // 01:30 on 1 November 2026 happens twice in Chicago.
    const result = zonedWallTimeToUtc(wall(2026, 11, 1, 1, 30), 'America/Chicago')
    expect(result.resolution).toBe('ambiguous')
    expect(new Date(result.instant).toISOString()).toBe('2026-11-01T06:30:00.000Z') // CDT, the earlier one
    expect(wallTimeAt(result.instant, 'America/Chicago')).toEqual(wall(2026, 11, 1, 1, 30))
  })

  it('handles the southern-hemisphere transitions too', () => {
    // Sydney springs forward on 4 October 2026: 02:00 AEST becomes 03:00 AEDT.
    const skipped = zonedWallTimeToUtc(wall(2026, 10, 4, 2, 30), 'Australia/Sydney')
    expect(skipped.resolution).toBe('skipped')
    // ...and falls back on 5 April 2026.
    const ambiguous = zonedWallTimeToUtc(wall(2026, 4, 5, 2, 30), 'Australia/Sydney')
    expect(ambiguous.resolution).toBe('ambiguous')
  })

  it('is stable in a zone with no DST at all', () => {
    const result = zonedWallTimeToUtc(wall(2026, 7, 4, 9), 'Asia/Tokyo')
    expect(result.resolution).toBe('exact')
    expect(new Date(result.instant).toISOString()).toBe('2026-07-04T00:00:00.000Z')
  })

  it('round-trips every hour of both US transition days', () => {
    for (const day of [8, 9] as const) {
      for (let hour = 0; hour < 24; hour++) {
        const result = zonedWallTimeToUtc(wall(2026, 3, day, hour), 'America/Chicago')
        const readBack = wallTimeAt(result.instant, 'America/Chicago')
        if (result.resolution === 'skipped') {
          expect(readBack.hour).toBe(hour + 1)
        } else {
          expect(readBack.hour).toBe(hour)
        }
      }
    }
  })
})

describe('localDateAt', () => {
  it('reports the date in the series zone, not the server zone', () => {
    // 01:30 UTC on the 9th is still the evening of the 8th in Chicago.
    expect(localDateAt(Date.parse('2026-03-09T01:30:00Z'), 'America/Chicago')).toBe('2026-03-08')
    expect(localDateAt(Date.parse('2026-03-09T01:30:00Z'), 'UTC')).toBe('2026-03-09')
  })
})

describe('asNaiveUtc', () => {
  it('does not shift two-digit years into the 1900s', () => {
    expect(new Date(asNaiveUtc(wall(26, 3, 8))).getUTCFullYear()).toBe(26)
  })
})

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects typos', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true)
    expect(isValidTimeZone('America/Chicgao')).toBe(false)
  })
})
