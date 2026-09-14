import type { Clock } from '@scheduler/plugin-sdk'

/**
 * Slows down guessing.
 *
 * One shared password on a LAN with unlimited attempts is not much of a
 * lock: a script can try a dictionary in seconds. After a few failures from
 * one address, the next attempt is refused outright for a spreading window
 * — 1s, 2s, 4s, up to five minutes.
 *
 * Deliberately in memory rather than in the database. A restart clears it,
 * which is the right trade: the alternative is a write on every failed
 * attempt, which is its own denial of service, and anyone who can restart
 * the process has already won.
 */

const FREE_ATTEMPTS = 3
const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 5 * 60_000
/** Forgotten after this long without a failure. */
const FORGET_AFTER_MS = 60 * 60_000

interface Record {
  failures: number
  /** When the caller may try again. */
  blockedUntil: number
  lastFailureAt: number
}

export class LoginThrottle {
  private readonly clock: Clock
  private readonly records = new Map<string, Record>()

  constructor(init: { clock: Clock }) {
    this.clock = init.clock
  }

  /** How long this caller must wait. Zero means go ahead. */
  retryAfterMs(key: string): number {
    const record = this.records.get(key)
    if (!record) return 0
    const now = this.clock.now()
    if (now - record.lastFailureAt > FORGET_AFTER_MS) {
      this.records.delete(key)
      return 0
    }
    return Math.max(record.blockedUntil - now, 0)
  }

  fail(key: string): void {
    this.prune()
    const now = this.clock.now()
    const existing = this.records.get(key)
    const failures =
      existing && now - existing.lastFailureAt <= FORGET_AFTER_MS ? existing.failures + 1 : 1
    const over = failures - FREE_ATTEMPTS
    const delay = over <= 0 ? 0 : Math.min(FIRST_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS)
    this.records.set(key, { failures, blockedUntil: now + delay, lastFailureAt: now })
  }

  succeed(key: string): void {
    this.records.delete(key)
  }

  private prune(): void {
    if (this.records.size < 1_000) return
    // A flood of attempts from spoofed addresses must not grow this without
    // bound. Anything long idle goes.
    const cutoff = this.clock.now() - FORGET_AFTER_MS
    for (const [key, record] of this.records) {
      if (record.lastFailureAt < cutoff) this.records.delete(key)
    }
  }
}
