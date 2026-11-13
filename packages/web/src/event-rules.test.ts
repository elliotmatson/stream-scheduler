import { describe, expect, it } from 'vitest'
import {
  clockPlus,
  minutesOfDay,
  nthWeekdayOf,
  parseRrule,
  toRrule,
  weekdayOf,
  type RuleDraft,
} from './event-rules.ts'

/**
 * What the event form stores for "repeats", and reads back when it opens.
 *
 * A wrong rule here is a service scheduled on the wrong day, weeks from
 * now, with nothing on screen looking wrong until it happens.
 */

const draft = (over: Partial<RuleDraft>): RuleDraft => ({
  repeat: 'once',
  // A Sunday, the third of its month.
  date: '2026-09-20',
  customRrule: '',
  priorRrule: null,
  ...over,
})

describe('the rule the form stores', () => {
  it('stores no rule for a one-off', () => {
    expect(toRrule(draft({ repeat: 'once' }), ['SU'])).toBeNull()
  })

  it('stores every day as daily', () => {
    expect(toRrule(draft({ repeat: 'daily' }), [])).toBe('FREQ=DAILY')
  })

  it('stores the chosen weekdays', () => {
    expect(toRrule(draft({ repeat: 'weekly' }), ['SU', 'WE'])).toBe('FREQ=WEEKLY;BYDAY=SU,WE')
  })

  it('falls back to plain weekly when no day is chosen, rather than a rule that never fires', () => {
    expect(toRrule(draft({ repeat: 'weekly' }), [])).toBe('FREQ=WEEKLY')
  })

  it('stores monthly as the same weekday of the month as the first date', () => {
    expect(toRrule(draft({ repeat: 'monthly' }), [])).toBe('FREQ=MONTHLY;BYDAY=3SU')
  })

  it('stores a custom rule as typed, without the spaces around it', () => {
    expect(
      toRrule(draft({ repeat: 'custom', customRrule: '  FREQ=WEEKLY;INTERVAL=2  ' }), []),
    ).toBe('FREQ=WEEKLY;INTERVAL=2')
  })

  it('stores an empty custom rule as no rule', () => {
    expect(toRrule(draft({ repeat: 'custom', customRrule: '   ' }), [])).toBeNull()
  })

  it('keeps the old rule while paired with a plan, so unpairing gives it back', () => {
    expect(toRrule(draft({ repeat: 'plan', priorRrule: 'FREQ=WEEKLY;BYDAY=SU' }), [])).toBe(
      'FREQ=WEEKLY;BYDAY=SU',
    )
  })
})

describe('which weekday a date is', () => {
  it.each([
    ['2026-09-20', 'SU'],
    ['2026-09-23', 'WE'],
    ['2026-09-26', 'SA'],
  ])('%s is %s', (date, code) => {
    expect(weekdayOf(date)).toBe(code)
  })

  it('does not slide onto the day before in a zone west of UTC', () => {
    // Read at noon UTC, so no browser offset can cross midnight.
    expect(weekdayOf('2026-01-01')).toBe('TH')
  })

  it('falls back to Sunday when the date box is half-typed', () => {
    expect(weekdayOf('')).toBe('SU')
  })
})

describe('which week of the month', () => {
  it.each([
    ['2026-09-06', '1SU'],
    ['2026-09-07', '1MO'],
    ['2026-09-14', '2MO'],
    ['2026-09-20', '3SU'],
    ['2026-09-28', '4MO'],
    // A fifth Sunday is a real rule; months without one are skipped.
    ['2026-11-29', '5SU'],
  ])('%s is %s', (date, expected) => {
    expect(nthWeekdayOf({ date })).toBe(expected)
  })
})

describe('reading a stored rule back into the form', () => {
  it('reads no rule as a one-off', () => {
    expect(parseRrule(null)).toMatchObject({ repeat: 'once', byday: [] })
  })

  it('reads the weekdays back out of a weekly rule', () => {
    expect(parseRrule('FREQ=WEEKLY;BYDAY=SU,WE')).toMatchObject({
      repeat: 'weekly',
      byday: ['SU', 'WE'],
    })
  })

  it('round-trips everything the form itself writes', () => {
    for (const repeat of ['once', 'daily', 'weekly', 'monthly'] as const) {
      const rule = toRrule(draft({ repeat }), ['SU'])
      expect(parseRrule(rule).repeat).toBe(repeat)
    }
  })

  it.each([
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SU', { repeat: 'weekly', interval: 2, byday: ['SU'] }],
    ['FREQ=WEEKLY;BYDAY=SU;UNTIL=20261231T235959', { ends: 'on', until: '2026-12-31' }],
    ['FREQ=DAILY;COUNT=5', { repeat: 'daily', ends: 'after', count: 5 }],
    ['FREQ=MONTHLY;BYMONTHDAY=20', { repeat: 'monthly', monthlyBy: 'day' }],
    ['FREQ=MONTHLY;BYDAY=3SU', { repeat: 'monthly', monthlyBy: 'weekday' }],
  ])('opens %s in the builder', (rule, expected) => {
    expect(parseRrule(rule)).toMatchObject(expected)
  })

  it.each([
    'FREQ=MONTHLY;BYDAY=-1SU',
    'FREQ=YEARLY;BYMONTH=12',
    'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9',
    'FREQ=DAILY;COUNT=5;UNTIL=20261231',
  ])('leaves %s as the custom rule somebody wrote, rather than rewriting it', (rule) => {
    expect(parseRrule(rule).repeat).toBe('custom')
  })
})

describe('the builder', () => {
  it('writes every two weeks', () => {
    expect(toRrule(draft({ repeat: 'weekly', interval: 2 }), ['SU'])).toBe(
      'FREQ=WEEKLY;BYDAY=SU;INTERVAL=2',
    )
  })

  it('writes the same date each month', () => {
    expect(toRrule(draft({ repeat: 'monthly', monthlyBy: 'day' }), [])).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=20',
    )
  })

  it('writes an end date as the last moment of that day', () => {
    expect(toRrule(draft({ repeat: 'daily', ends: 'on', until: '2026-12-31' }), [])).toBe(
      'FREQ=DAILY;UNTIL=20261231T235959',
    )
  })

  it('writes a number of times', () => {
    expect(toRrule(draft({ repeat: 'weekly', ends: 'after', count: 6 }), ['WE'])).toBe(
      'FREQ=WEEKLY;BYDAY=WE;COUNT=6',
    )
  })

  it('reads back exactly what it wrote', () => {
    const written = draft({
      repeat: 'weekly',
      interval: 3,
      ends: 'after',
      count: 4,
    })
    const parsed = parseRrule(toRrule(written, ['SU', 'WE']))
    expect(parsed).toMatchObject({ repeat: 'weekly', interval: 3, ends: 'after', count: 4 })
    expect(parsed.byday).toEqual(['SU', 'WE'])
  })
})

describe('clock arithmetic beside the boxes', () => {
  const clock = (hour: number, minute: number): string =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })

  it('adds a length to a start time', () => {
    expect(clockPlus('09:00', 90)).toBe(clock(10, 30))
  })

  it('goes past midnight into the next morning', () => {
    expect(clockPlus('23:30', 60)).toBe(clock(0, 30))
  })

  it('goes back before midnight for an early start', () => {
    expect(clockPlus('00:15', -30)).toBe(clock(23, 45))
  })

  it('shows a dash rather than a wrong time while the box is empty', () => {
    expect(clockPlus('', 30)).toBe('—')
  })

  it('reads a time box as minutes since midnight', () => {
    expect(minutesOfDay('09:30')).toBe(570)
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('')).toBe(0)
  })
})
