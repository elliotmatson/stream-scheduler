import type { Series } from './api.ts'

/** The window's opening time, as a clock in the event's own zone. */
export function timeOf(series: Pick<Series, 'timezone' | 'dtstart'>): string {
  return clockAt(series, 0)
}

/** The clock time an offset into the window falls at, in the event's zone. */
export function clockAt(series: Pick<Series, 'timezone' | 'dtstart'>, offsetMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: series.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(series.dtstart + offsetMs)
}

/**
 * Turns a typed clock time back into an offset from the window's start.
 *
 * A time earlier on the clock than the window opens is the next morning
 * when the window runs past midnight: 00:15 in a window opening at 23:00
 * is an hour and a quarter in, not 22 hours and 45 minutes before it.
 */
export function offsetFrom(
  series: Pick<Series, 'timezone' | 'dtstart' | 'durationMs'>,
  startsAt: string,
): number {
  const [hour, minute] = startsAt.split(':').map(Number)
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute))
    return 0
  const [openHour, openMinute] = timeOf(series).split(':').map(Number) as [number, number]
  const offset = (hour * 60 + minute - openHour * 60 - openMinute) * 60_000
  const day = 24 * 60 * 60_000
  return offset < 0 && offset + day < series.durationMs ? offset + day : offset
}
