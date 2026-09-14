import { describe, expect, it } from 'vitest'
import { describeSchedule, expandOccurrences, InvalidScheduleError, validateSchedule } from './recurrence.js'
import type { SeriesSchedule } from './recurrence.js'
import { wallTimeAt } from './zoned.js'

const NINETY_MINUTES = 90 * 60 * 1000

/** Sundays at 09:00 America/Chicago, starting 1 February 2026. */
const sundayService: SeriesSchedule = {
  timezone: 'America/Chicago',
  rrule: 'FREQ=WEEKLY;BYDAY=SU',
  dtstart: Date.parse('2026-02-01T15:00:00Z'), // 09:00 CST
  durationMs: NINETY_MINUTES,
}

const localTimes = (schedule: SeriesSchedule, from: string, to: string) =>
  expandOccurrences(schedule, Date.parse(from), Date.parse(to)).map((o) => {
    const w = wallTimeAt(o.start, schedule.timezone)
    return `${o.localDate} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
  })

describe('expandOccurrences', () => {
  it('produces weekly occurrences at the same local time', () => {
    expect(localTimes(sundayService, '2026-02-01T00:00:00Z', '2026-02-23T00:00:00Z')).toEqual([
      '2026-02-01 09:00',
      '2026-02-08 09:00',
      '2026-02-15 09:00',
      '2026-02-22 09:00',
    ])
  })

  it('does not drift an hour across the spring-forward weekend', () => {
    expect(localTimes(sundayService, '2026-03-01T00:00:00Z', '2026-03-16T00:00:00Z')).toEqual([
      '2026-03-01 09:00',
      '2026-03-08 09:00', // DST begins this morning
      '2026-03-15 09:00',
    ])
  })

  it('does not drift across the autumn fall-back weekend either', () => {
    expect(localTimes(sundayService, '2026-10-25T00:00:00Z', '2026-11-09T00:00:00Z')).toEqual([
      '2026-10-25 09:00',
      '2026-11-01 09:00', // DST ends this morning
      '2026-11-08 09:00',
    ])
  })

  it('emits UTC instants that shift by an hour even though local time does not', () => {
    const [beforeDst, afterDst] = expandOccurrences(
      sundayService,
      Date.parse('2026-03-01T00:00:00Z'),
      Date.parse('2026-03-09T00:00:00Z'),
    )
    expect(new Date(beforeDst!.start).toISOString()).toBe('2026-03-01T15:00:00.000Z') // CST
    expect(new Date(afterDst!.start).toISOString()).toBe('2026-03-08T14:00:00.000Z') // CDT
  })

  it('flags an occurrence the clocks skipped instead of dropping it', () => {
    // A 02:30 Sunday event on the spring-forward morning never happens as written.
    const early: SeriesSchedule = { ...sundayService, dtstart: Date.parse('2026-02-01T08:30:00Z') }
    const [occurrence] = expandOccurrences(
      early,
      Date.parse('2026-03-08T00:00:00Z'),
      Date.parse('2026-03-09T00:00:00Z'),
    )
    expect(occurrence?.resolution).toBe('skipped')
    expect(wallTimeAt(occurrence!.start, 'America/Chicago').hour).toBe(3)
  })

  it('handles monthly-by-weekday rules', () => {
    const secondSunday: SeriesSchedule = { ...sundayService, rrule: 'FREQ=MONTHLY;BYDAY=2SU' }
    expect(localTimes(secondSunday, '2026-02-01T00:00:00Z', '2026-05-01T00:00:00Z')).toEqual([
      '2026-02-08 09:00',
      '2026-03-08 09:00',
      '2026-04-12 09:00',
    ])
  })

  it('honours UNTIL as a wall-clock date in the series zone', () => {
    const bounded: SeriesSchedule = { ...sundayService, rrule: 'FREQ=WEEKLY;BYDAY=SU;UNTIL=20260215T235959Z' }
    expect(localTimes(bounded, '2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual([
      '2026-02-01 09:00',
      '2026-02-08 09:00',
      '2026-02-15 09:00',
    ])
  })

  it('honours COUNT', () => {
    const bounded: SeriesSchedule = { ...sundayService, rrule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=2' }
    expect(localTimes(bounded, '2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z')).toHaveLength(2)
  })

  it('drops excluded dates', () => {
    const withExdate: SeriesSchedule = { ...sundayService, exdates: [Date.parse('2026-02-08T15:00:00Z')] }
    expect(localTimes(withExdate, '2026-02-01T00:00:00Z', '2026-02-16T00:00:00Z')).toEqual([
      '2026-02-01 09:00',
      '2026-02-15 09:00',
    ])
  })

  it('returns the single instant for a one-off', () => {
    const once: SeriesSchedule = { ...sundayService, rrule: null }
    expect(localTimes(once, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual(['2026-02-01 09:00'])
    expect(localTimes(once, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).toEqual([])
  })

  it('includes an occurrence already under way when the window opens', () => {
    // Window opens 09:30, half an hour into the 09:00 service.
    const results = expandOccurrences(
      sundayService,
      Date.parse('2026-02-01T15:30:00Z'),
      Date.parse('2026-02-01T18:00:00Z'),
    )
    expect(results).toHaveLength(1)
    expect(new Date(results[0]!.start).toISOString()).toBe('2026-02-01T15:00:00.000Z')
  })

  it('returns nothing for an inverted window', () => {
    expect(expandOccurrences(sundayService, Date.parse('2026-03-01T00:00:00Z'), Date.parse('2026-02-01T00:00:00Z'))).toEqual([])
  })

  it('caps runaway rules rather than filling the database', () => {
    const everyMinute: SeriesSchedule = { ...sundayService, rrule: 'FREQ=MINUTELY' }
    const results = expandOccurrences(everyMinute, sundayService.dtstart, sundayService.dtstart + 365 * 86_400_000)
    expect(results).toHaveLength(10_000)
  })

  it('respects an explicit limit', () => {
    expect(
      expandOccurrences(sundayService, Date.parse('2026-02-01T00:00:00Z'), Date.parse('2027-02-01T00:00:00Z'), {
        limit: 3,
      }),
    ).toHaveLength(3)
  })

  it('works the same in a zone that never changes offset', () => {
    const tokyo: SeriesSchedule = { ...sundayService, timezone: 'Asia/Tokyo', dtstart: Date.parse('2026-02-01T00:00:00Z') }
    expect(localTimes(tokyo, '2026-02-01T00:00:00Z', '2026-02-16T00:00:00Z')).toEqual([
      '2026-02-01 09:00',
      '2026-02-08 09:00',
      '2026-02-15 09:00',
    ])
  })
})

describe('validateSchedule', () => {
  it('rejects an unknown timezone', () => {
    expect(() => validateSchedule({ ...sundayService, timezone: 'America/Chicgao' })).toThrow(InvalidScheduleError)
  })

  it('rejects a malformed rule', () => {
    expect(() => validateSchedule({ ...sundayService, rrule: 'FREQ=NEVER' })).toThrow(InvalidScheduleError)
  })

  it('rejects a zero-length event', () => {
    expect(() => validateSchedule({ ...sundayService, durationMs: 0 })).toThrow(/greater than zero/)
  })
})

describe('describeSchedule', () => {
  it('summarises a rule in plain language', () => {
    expect(describeSchedule(sundayService)).toMatch(/week/i)
    expect(describeSchedule({ ...sundayService, rrule: null })).toBe('Does not repeat')
  })
})
