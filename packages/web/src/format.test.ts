import { describe, expect, it } from 'vitest'
import {
  dateTimeIn,
  duration,
  inputTimeIn,
  localDateKey,
  minutesOfDayIn,
  relative,
  shortZone,
  timeIn,
} from './format.ts'

/**
 * Everything on screen is read in the event's own zone, never the
 * browser's. These pin the cases where the two disagree — late evenings,
 * midnight and the clock change — because that is where a wrong answer
 * shows a service on the wrong day.
 */

const CHICAGO = 'America/Chicago'
const at = (iso: string): number => Date.parse(iso)

describe('the time box', () => {
  it('is 24-hour HH:mm in the event’s zone', () => {
    // 15:30 UTC is 09:30 in Chicago in March, before the clocks change.
    expect(inputTimeIn(at('2026-03-01T15:30:00Z'), CHICAGO)).toBe('09:30')
  })

  it('calls midnight 00:00, which is the only spelling the box accepts', () => {
    expect(inputTimeIn(at('2026-03-02T06:00:00Z'), CHICAGO)).toBe('00:00')
  })

  it('follows the clock change rather than the UTC hour', () => {
    // Both 9:00 local, an hour apart in UTC either side of 8 March.
    expect(inputTimeIn(at('2026-03-01T15:00:00Z'), CHICAGO)).toBe('09:00')
    expect(inputTimeIn(at('2026-03-08T14:00:00Z'), CHICAGO)).toBe('09:00')
  })
})

describe('which day something falls on', () => {
  it('is the event’s day, not the UTC one', () => {
    // 22:30 on a Sunday evening in Chicago is already Monday in UTC.
    const sundayEvening = at('2026-03-02T04:30:00Z')
    expect(localDateKey(sundayEvening, CHICAGO)).toBe('2026-03-01')
    expect(localDateKey(sundayEvening, 'UTC')).toBe('2026-03-02')
  })
})

describe('minutes into the day', () => {
  it('puts midnight at the top of the day, not the bottom', () => {
    expect(minutesOfDayIn(at('2026-03-02T06:00:00Z'), CHICAGO)).toBe(0)
  })

  it('puts a minute before midnight at the bottom', () => {
    expect(minutesOfDayIn(at('2026-03-02T05:59:00Z'), CHICAGO)).toBe(23 * 60 + 59)
  })

  it('keeps a 9:00 service at 9:00 across the clock change', () => {
    expect(minutesOfDayIn(at('2026-03-01T15:00:00Z'), CHICAGO)).toBe(540)
    expect(minutesOfDayIn(at('2026-03-08T14:00:00Z'), CHICAGO)).toBe(540)
  })
})

describe('the zone’s short name', () => {
  it('says standard time in winter and daylight time in summer', () => {
    expect(shortZone(at('2026-01-11T15:00:00Z'), CHICAGO)).toBe('CST')
    expect(shortZone(at('2026-07-12T14:00:00Z'), CHICAGO)).toBe('CDT')
  })
})

describe('a date and time together', () => {
  it('reads both in the event’s zone', () => {
    const sundayEvening = at('2026-03-02T04:30:00Z')
    const text = dateTimeIn(sundayEvening, CHICAGO)
    expect(text).toContain(timeIn(sundayEvening, CHICAGO))
    expect(text).toMatch(/Sun/)
    expect(text).not.toMatch(/Mon/)
  })
})

describe('a length', () => {
  it.each([
    [0, '0m'],
    [45, '45m'],
    [60, '1h'],
    [90, '1h 30m'],
    [345, '5h 45m'],
  ])('%i minutes reads as %s', (minutes, expected) => {
    expect(duration(minutes * 60_000)).toBe(expected)
  })

  it('rounds to the nearest minute rather than showing seconds', () => {
    expect(duration(89 * 60_000 + 40_000)).toBe('1h 30m')
  })
})

describe('how long ago or until', () => {
  const now = at('2026-03-01T15:00:00Z')
  const words = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  it.each([
    [30_000, 30, 'second'],
    [-5 * 60_000, -5, 'minute'],
    [90 * 60_000, 2, 'hour'],
    [3 * 86_400_000, 3, 'day'],
  ] as const)('%i ms away is counted in %is of a %s', (delta, count, unit) => {
    expect(relative(now + delta, now)).toBe(words.format(count, unit))
  })
})
