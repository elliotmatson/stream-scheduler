/**
 * The event form's repeat rules and clock arithmetic, kept out of the
 * component so they can be tested on their own.
 *
 * Every one of these turns what somebody picked in the form into what the
 * scheduler stores, and a mistake here is a service on the wrong day.
 */

export const WEEKDAYS = [
  { code: 'SU', label: 'Sun' },
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
]

export type Repeat = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom' | 'plan'

/** The parts of the form a rule is made from. */
export interface RuleDraft {
  repeat: Repeat
  /** The first date, `YYYY-MM-DD`. */
  date: string
  customRrule: string
  priorRrule: string | null
  /** Every how many days, weeks or months. 1 is every one. */
  interval?: number
  /** A monthly event on the same weekday ("third Sunday") or the same date
   *  ("the 20th"). */
  monthlyBy?: 'weekday' | 'day'
  /** When it stops: never, after a date, or after so many. */
  ends?: 'never' | 'on' | 'after'
  /** `YYYY-MM-DD`, the last date it can fall on. */
  until?: string
  count?: number
}

/**
 * The rule the form's choices add up to.
 *
 * Built from parts the way Resi's form asks for them — how often, every
 * how many, until when — rather than typed, and read back the same way by
 * `parseRrule`, so a rule this writes always opens in the same controls.
 */
export function toRrule(draft: RuleDraft, byday: string[]): string | null {
  const base = baseRule(draft, byday)
  if (base === null || draft.repeat === 'custom' || draft.repeat === 'plan') return base
  const parts = [base]
  if ((draft.interval ?? 1) > 1) parts.push(`INTERVAL=${draft.interval}`)
  if (draft.ends === 'on' && draft.until) {
    // A wall-clock date in the event's own zone, as the engine reads it:
    // the last moment of that day.
    parts.push(`UNTIL=${draft.until.replace(/-/g, '')}T235959`)
  } else if (draft.ends === 'after' && (draft.count ?? 0) > 0) {
    parts.push(`COUNT=${draft.count}`)
  }
  return parts.join(';')
}

function baseRule(draft: RuleDraft, byday: string[]): string | null {
  switch (draft.repeat) {
    case 'once':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekly':
      // No day selected at all is a rule that would never fire, so fall back
      // to plain weekly rather than emitting BYDAY= with nothing after it.
      return byday.length > 0 ? `FREQ=WEEKLY;BYDAY=${byday.join(',')}` : 'FREQ=WEEKLY'
    case 'monthly':
      return draft.monthlyBy === 'day'
        ? `FREQ=MONTHLY;BYMONTHDAY=${Number(draft.date.split('-')[2])}`
        : 'FREQ=MONTHLY;BYDAY=' + nthWeekdayOf(draft)
    case 'custom':
      return draft.customRrule.trim() || null
    case 'plan':
      // Stored but not consulted while the pairing is in place. Kept as it
      // was so unpairing gives back the weekly this used to be, rather than
      // silently dropping it to "does not repeat".
      return draft.priorRrule
  }
}

/** `2SU` — the second Sunday — from the chosen first date. */
export function nthWeekdayOf(draft: Pick<RuleDraft, 'date'>): string {
  const [, , day] = draft.date.split('-').map(Number) as [number, number, number]
  const nth = Math.floor((day - 1) / 7) + 1
  return `${nth}${weekdayOf(draft.date)}`
}

/** The `SU`..`SA` code for a `YYYY-MM-DD` date. Read at noon UTC so the
 *  browser's own offset cannot roll it onto the day before. */
export function weekdayOf(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return WEEKDAYS[Number.isNaN(day) ? 0 : day]!.code
}

/** What `parseRrule` reads back: the builder's own fields. */
export interface ParsedRule {
  repeat: Repeat
  byday: string[]
  interval: number
  monthlyBy: 'weekday' | 'day'
  ends: 'never' | 'on' | 'after'
  until: string
  count: number
}

/**
 * A stored rule, back in the builder's terms.
 *
 * Only what the builder can write is read into it; anything else — a rule
 * typed by hand with parts the builder has no control for — stays a
 * custom rule, shown as written rather than rewritten into something else.
 */
export function parseRrule(rrule: string | null): ParsedRule {
  const plain: ParsedRule = {
    repeat: 'once',
    byday: [],
    interval: 1,
    monthlyBy: 'weekday',
    ends: 'never',
    until: '',
    count: 10,
  }
  if (rrule === null) return plain
  const custom = { ...plain, repeat: 'custom' as const }

  const parts = new Map<string, string>()
  for (const piece of rrule.split(';')) {
    const [key, value] = piece.split('=')
    if (!key || value === undefined || parts.has(key)) return custom
    parts.set(key, value)
  }
  const out: ParsedRule = { ...plain }
  for (const [key, value] of parts) {
    if (key === 'FREQ') continue
    if (key === 'INTERVAL' && /^\d+$/.test(value) && Number(value) >= 1) {
      out.interval = Number(value)
    } else if (key === 'UNTIL' && /^\d{8}(T\d{6}Z?)?$/.test(value) && !parts.has('COUNT')) {
      out.ends = 'on'
      out.until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    } else if (key === 'COUNT' && /^\d+$/.test(value) && !parts.has('UNTIL')) {
      out.ends = 'after'
      out.count = Number(value)
    } else if (key !== 'BYDAY' && key !== 'BYMONTHDAY') {
      return custom
    }
  }

  const freq = parts.get('FREQ')
  const byday = parts.get('BYDAY')
  const bymonthday = parts.get('BYMONTHDAY')
  if (freq === 'DAILY' && byday === undefined && bymonthday === undefined) {
    return { ...out, repeat: 'daily' }
  }
  if (freq === 'WEEKLY' && bymonthday === undefined) {
    if (byday === undefined) return { ...out, repeat: 'weekly' }
    const days = byday.split(',')
    if (days.every((day) => /^[A-Z]{2}$/.test(day)))
      return { ...out, repeat: 'weekly', byday: days }
  }
  if (freq === 'MONTHLY') {
    if (byday !== undefined && bymonthday === undefined && /^[1-5][A-Z]{2}$/.test(byday)) {
      return { ...out, repeat: 'monthly', monthlyBy: 'weekday' }
    }
    if (bymonthday !== undefined && byday === undefined && /^\d{1,2}$/.test(bymonthday)) {
      return { ...out, repeat: 'monthly', monthlyBy: 'day' }
    }
  }
  return custom
}

/** `09:30` as minutes since midnight. */
export function minutesOfDay(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return 0
  }
  return hour * 60 + minute
}

/**
 * A wall-clock time moved by some minutes: "9:00" plus 90 is "10:30".
 *
 * Shown beside the boxes so nobody has to do the arithmetic to know when
 * the encoder actually starts or when the broadcast gets made.
 */
export function clockPlus(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute))
    return '—'
  const total = (((hour * 60 + minute + minutes) % 1440) + 1440) % 1440
  const date = new Date(2000, 0, 1, Math.floor(total / 60), total % 60)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
