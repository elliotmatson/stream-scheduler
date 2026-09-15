import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { hashPassword, passwordProblem, verifyPassword } from './password.js'
import { Sessions } from './sessions.js'
import { LoginThrottle } from './throttle.js'

/**
 * Who is allowed to drive this app.
 *
 * One shared password, because that is what a booth needs: several people
 * on a rota, one thing to remember, and the real boundary is the network
 * the port is on. Accounts would be a bigger thing to build and a bigger
 * thing to run.
 *
 * A password is optional and off by default. A machine listening on
 * loopback with one operator does not need a lock, and making them invent
 * one is how people end up writing it on the wall. What changes with this
 * module is that the choice is now available — and that when it is made,
 * it works in a browser.
 */

export const PASSWORD_SETTING_KEY = 'ui_password'

/**
 * When the environment's password was copied into the database.
 *
 * The whole point of this key is that it survives a restart. Without it,
 * `SCHEDULER_UI_PASSWORD` would be re-applied on every boot, which would
 * undo a password changed in the UI and — worse — put the lock back on an
 * install where somebody deliberately took it off. Its presence, not its
 * value, is what decides; the timestamp is there for whoever is reading
 * the settings table trying to work out what happened.
 */
export const PASSWORD_SEEDED_KEY = 'ui_password_seeded_at'

export type LoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'no-password' }
  | { ok: false; reason: 'wrong-password' }
  | { ok: false; reason: 'too-many-attempts'; retryAfterMs: number }

export class Auth {
  readonly sessions: Sessions
  private readonly db: Db
  private readonly throttle: LoginThrottle
  constructor(init: { db: Db; clock: Clock; envPassword?: string | undefined; ttlMs?: number }) {
    this.db = init.db
    this.sessions = new Sessions({
      db: init.db,
      clock: init.clock,
      ...(init.ttlMs === undefined ? {} : { ttlMs: init.ttlMs }),
    })
    this.throttle = new LoginThrottle({ clock: init.clock })
    this.seedFromEnvironment(init.envPassword, init.clock.now())
  }

  /**
   * Copies `SCHEDULER_UI_PASSWORD` into the database, once ever.
   *
   * Docker needs some way to start a locked container — there is no
   * first-run screen for `docker run`. But a variable that keeps winning is
   * a variable nobody can change from the UI, and it would silently re-lock
   * an install after somebody unlocked it. So the environment seeds and
   * then gets out of the way: after this has run once, the stored password
   * is the only one consulted, and the UI owns it.
   *
   * It overwrites whatever is stored on that first run. That is deliberate
   * and only affects the upgrade: before this change the environment
   * outranked the database, so the environment's password is the one that
   * works today, and it is the one that has to keep working tomorrow.
   */
  private seedFromEnvironment(envPassword: string | undefined, now: number): void {
    const password = envPassword?.trim()
    if (!password) return
    if (this.seededAt() !== undefined) return

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(PASSWORD_SETTING_KEY, hashPassword(password))
      this.db
        .prepare(
          `INSERT INTO setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(PASSWORD_SEEDED_KEY, String(now))
    })
    write()
  }

  /**
   * True when the password in the database originally came from the
   * environment.
   *
   * Reported so the UI can say where the password came from. It no longer
   * stops anything: changing it here is exactly how you take it over.
   */
  get seededFromEnvironment(): boolean {
    return this.seededAt() !== undefined
  }

  private seededAt(): number | undefined {
    const row = this.db
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(PASSWORD_SEEDED_KEY) as { value: string } | undefined
    return row === undefined ? undefined : Number(row.value)
  }

  /** False means the app is open to anyone who can reach the port. */
  get required(): boolean {
    return this.storedHash() !== undefined
  }

  /**
   * Sets or replaces the password, and signs everybody out.
   *
   * Changing a shared password almost always means somebody should no
   * longer be able to get in, and leaving their session alive would make
   * the change cosmetic.
   */
  setPassword(next: string): void {
    const problem = passwordProblem(next)
    if (problem) throw new Error(problem)
    this.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(PASSWORD_SETTING_KEY, hashPassword(next))
    this.sessions.revokeAll()
  }

  /** Takes the lock off. Every session ends with it. */
  clearPassword(): void {
    // The seeded marker deliberately stays. It is what stops the next
    // restart putting the environment's password back on an install where
    // somebody has just taken the lock off on purpose.
    this.db.prepare('DELETE FROM setting WHERE key = ?').run(PASSWORD_SETTING_KEY)
    this.sessions.revokeAll()
  }

  /**
   * Trades a password for a session token.
   *
   * `from` is whatever identifies the caller for rate limiting — an address.
   * A failure spreads the next attempt out rather than answering faster.
   */
  login(input: { password: string; from: string; userAgent?: string }): LoginResult {
    const stored = this.storedHash()
    if (stored === undefined) return { ok: false, reason: 'no-password' }

    const retryAfterMs = this.throttle.retryAfterMs(input.from)
    if (retryAfterMs > 0) return { ok: false, reason: 'too-many-attempts', retryAfterMs }

    if (!verifyPassword(input.password, stored)) {
      this.throttle.fail(input.from)
      return { ok: false, reason: 'wrong-password' }
    }

    this.throttle.succeed(input.from)
    const { token, expiresAt } = this.sessions.mint(
      input.userAgent === undefined ? {} : { userAgent: input.userAgent },
    )
    return { ok: true, token, expiresAt }
  }

  /** True when this request may proceed: either nothing is locked, or the
   *  token names a live session. */
  allows(token: string | undefined): boolean {
    if (!this.required) return true
    return token !== undefined && this.sessions.verify(token) !== undefined
  }

  private storedHash(): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(PASSWORD_SETTING_KEY) as { value: string } | undefined
    return row?.value
  }
}

export { hashPassword, MIN_PASSWORD_LENGTH, passwordProblem, verifyPassword } from './password.js'
export { DEFAULT_SESSION_TTL_MS, Sessions, type Session } from './sessions.js'
export { LoginThrottle } from './throttle.js'
