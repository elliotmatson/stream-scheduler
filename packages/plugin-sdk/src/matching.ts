/**
 * Whether two stream URLs name the same endpoint.
 *
 * A trailing slash and the case of the scheme and host are not differences
 * any ingest server cares about, and a device that reports back the URL of
 * the preset it matched — with or without the slash it was given — has
 * taken the setting, not refused it.
 */
export function sameStreamUrl(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return normaliseUrl(a) === normaliseUrl(b)
}

function normaliseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(trimmed)
  return scheme ? scheme[1]!.toLowerCase() + scheme[2]! : trimmed.toLowerCase()
}

/**
 * Whether a quality an operator typed is the one a device reports.
 *
 * Typed as free text, so "8 Mb/s", "8", "8.0", "Streaming High" and "streaming
 * high", or "7 - 9" and "7-9", are each one setting. Compared exactly, the
 * device was set correctly and verification still failed — at the output's
 * start time, on air.
 */
export function sameQuality(reported: string, asked: string): boolean {
  return normaliseQuality(reported) === normaliseQuality(asked)
}

function normaliseQuality(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(mb\/s|mbps|mbit\/s|mbits\/s)$/, '')
    .replace(/(\d)\.0+(?=\D|$)/g, '$1')
}
