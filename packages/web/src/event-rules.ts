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
}

export function toRrule(draft: RuleDraft, byday: string[]): string | null {
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
      return 'FREQ=MONTHLY;BYDAY=' + nthWeekdayOf(draft)
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

export function parseRrule(rrule: string | null): { repeat: Repeat; byday: string[] } {
  if (rrule === null) return { repeat: 'once', byday: [] }
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1]?.split(',') ?? []
  if (rrule === 'FREQ=DAILY') return { repeat: 'daily', byday: [] }
  // Only the shapes this form can round-trip get a friendly control; anything
  // else stays as the rule the operator wrote, rather than being rewritten.
  if (/^FREQ=WEEKLY(;BYDAY=[A-Z,]+)?$/.test(rrule)) return { repeat: 'weekly', byday }
  if (/^FREQ=MONTHLY;BYDAY=\d[A-Z]{2}$/.test(rrule)) return { repeat: 'monthly', byday: [] }
  return { repeat: 'custom', byday: [] }
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
