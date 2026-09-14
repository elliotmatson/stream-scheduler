/**
 * Makes a rendered template safe as a file name on every target.
 *
 * An accidental overwrite of a recorded service is unrecoverable, so collision
 * handling appends rather than replaces — see `uniqueFilename`.
 */
export interface SanitizeOptions {
  maxLength?: number
  replacement?: string
}

// Illegal on FAT/exFAT and NTFS, which covers HyperDeck media and Windows alike.
const ILLEGAL = /[<>:"/\\|?*\p{Cc}]/gu
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeFilename(name: string, options: SanitizeOptions = {}): string {
  const { maxLength = 100, replacement = '-' } = options
  let out = name.replace(ILLEGAL, replacement)
  out = out.replace(/\s+/g, ' ').trim()
  // Windows silently strips trailing dots and spaces, which turns two distinct
  // names into one and quietly overwrites a recording.
  out = out.replace(/[. ]+$/g, '')
  const [stem = '', ...rest] = out.split('.')
  if (RESERVED_WINDOWS.test(stem)) out = `_${out}`
  if (out === '') out = 'untitled'
  if (out.length > maxLength) {
    const extension = rest.length > 0 ? `.${rest[rest.length - 1]}` : ''
    out = out.slice(0, Math.max(1, maxLength - extension.length)) + extension
  }
  return out
}

/**
 * Returns a name not already in `taken`, suffixing `-2`, `-3` and so on.
 * Never returns an existing name: overwriting a recording loses it for good.
 */
export function uniqueFilename(
  name: string,
  taken: Iterable<string>,
  options: SanitizeOptions = {},
): string {
  const existing = new Set(taken)
  const base = sanitizeFilename(name, options)
  if (!existing.has(base)) return base

  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const extension = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 10_000; n++) {
    const candidate = sanitizeFilename(`${stem}-${n}${extension}`, options)
    if (!existing.has(candidate)) return candidate
  }
  throw new Error(`Could not find an unused name based on "${base}".`)
}
