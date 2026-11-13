/** Timezone lists for the pickers: the likely few first, then all of them. */

const US_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
]

/** This browser's zone, the one already chosen, and the US zones. */
export function commonZones(current: string): string[] {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [...new Set([current, here, ...US_ZONES])]
}

/** "America/Chicago" as "Central — Chicago", where there is a short name. */
export function zoneName(zone: string): string {
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value
    return name ? `${city} (${name.replace(/ (Standard|Daylight) Time$/, '')})` : city
  } catch {
    return city
  }
}

/** Every zone the browser knows, with the current one guaranteed present. */
export function zoneChoices(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [Intl.DateTimeFormat().resolvedOptions().timeZone]
  return supported.includes(current) ? supported : [current, ...supported]
}
