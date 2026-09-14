/**
 * All display formatting goes through the *event's* timezone, not the
 * browser's.
 *
 * An operator in one place scheduling a service in another must see the
 * service's local time, and the whole scheduling engine is built around that
 * distinction — the UI would undo it by quietly formatting in the browser's
 * zone instead.
 */

export function timeIn(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(instant)
}

export function dateIn(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant)
}

export function dateTimeIn(instant: number, timeZone: string): string {
  return `${dateIn(instant, timeZone)}, ${timeIn(instant, timeZone)}`
}

/** True when the event's zone differs from the browser's, so the UI can say so. */
export function isForeignZone(timeZone: string): boolean {
  return Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone
}

export function shortZone(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(instant)
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export function relative(instant: number, now = Date.now()): string {
  const delta = instant - now
  const abs = Math.abs(delta)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60_000) return formatter.format(Math.round(delta / 1000), 'second')
  if (abs < 3_600_000) return formatter.format(Math.round(delta / 60_000), 'minute')
  if (abs < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), 'hour')
  return formatter.format(Math.round(delta / 86_400_000), 'day')
}

/** `YYYY-MM-DD` for a UTC instant as read in `timeZone`. */
export function localDateKey(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
  return parts
}

export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1))
}
