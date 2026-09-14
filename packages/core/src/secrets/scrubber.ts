/**
 * A central registry of live secret values, redacted at the logging transport
 * and before any run step is persisted.
 *
 * Doing this centrally rather than at each call site is the only version that
 * actually works — every leak in this class comes from the one log line
 * somebody forgot to redact.
 */
export class Scrubber {
  /** Short values would redact ordinary text, so they are never registered. */
  private static readonly MIN_LENGTH = 8
  private readonly values = new Set<string>()

  register(secret: string | undefined | null): void {
    if (!secret || secret.length < Scrubber.MIN_LENGTH) return
    this.values.add(secret)
  }

  forget(secret: string): void {
    this.values.delete(secret)
  }

  get size(): number {
    return this.values.size
  }

  redact(text: string): string {
    let out = text
    for (const secret of this.values) {
      if (out.includes(secret)) out = out.split(secret).join('[redacted]')
    }
    return out
  }

  /** Deep-redacts an arbitrary value, for persisting a run step's request
   *  and response. Keys that name a secret are masked even if the value was
   *  never registered, which covers a key the user typed but we never stored. */
  redactValue<T>(value: T): T {
    return this.walk(value, new WeakSet()) as T
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redact(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => this.walk(item, seen))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && typeof item === 'string' ? '[redacted]' : this.walk(item, seen)
    }
    return out
  }
}

const SENSITIVE_WORDS = new Set([
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'authorization',
  'credential',
  'credentials',
])

/**
 * Matches `streamKey`, `stream_key`, `stream-key` and `STREAM_KEY` alike, while
 * leaving `keyboard` and `monkey` alone — a whole-word check on the split
 * segments rather than a substring match.
 */
export function isSensitiveKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .some((segment) => SENSITIVE_WORDS.has(segment.toLowerCase()))
}

/** The process-wide scrubber. The vault registers into this on every reveal. */
export const scrubber = new Scrubber()
