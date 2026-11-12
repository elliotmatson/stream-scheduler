import { describe, expect, it } from 'vitest'
import { clockAt, offsetFrom } from './output-times.ts'

const HOUR = 60 * 60_000

/** An event in Chicago opening at the given UTC instant. */
const event = (dtstart: string, hours: number) => ({
  timezone: 'America/Chicago',
  dtstart: Date.parse(dtstart),
  durationMs: hours * HOUR,
})

describe('a typed start time, as an offset into the window', () => {
  it('reads a time later the same day', () => {
    // 07:00 CST.
    expect(offsetFrom(event('2026-03-01T13:00:00Z', 6), '09:00')).toBe(2 * HOUR)
  })

  it('reads a time after midnight as the next morning in a late window', () => {
    // 23:00 CST, three hours long: 00:15 is an hour and a quarter in.
    expect(offsetFrom(event('2026-03-02T05:00:00Z', 3), '00:15')).toBe(1.25 * HOUR)
  })

  it('still calls a time before an ordinary window opens what it is', () => {
    // 07:00 CST, six hours long: 06:30 is before it, not the next day.
    expect(offsetFrom(event('2026-03-01T13:00:00Z', 6), '06:30')).toBe(-0.5 * HOUR)
  })

  it('goes back to the clock it came from', () => {
    const late = event('2026-03-02T05:00:00Z', 3)
    expect(clockAt(late, offsetFrom(late, '00:15'))).toBe('00:15')
  })

  it('treats a box left half-filled as the window opening', () => {
    expect(offsetFrom(event('2026-03-01T13:00:00Z', 6), '')).toBe(0)
  })
})
