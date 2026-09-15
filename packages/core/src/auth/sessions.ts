import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'

/**
 * Signed-in sessions, stored so they can be taken away again.
 *
 * A signed cookie would need no table, and could not be revoked: the only
 * way to end a leaked session would be to change the password on everyone.
 * A row per session is a few bytes and means "sign out everywhere" is a
 * DELETE.
 *
 * The token itself is never stored. What is in the table is its SHA-256,
 * so a copy of the database is not a set of working logins. The token is
 * 32 random bytes, so there is nothing to attack in the hash beyond
 * guessing the token.
 */

export interface Session {
  id: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  userAgent: string | null
}

interface SessionRow {
  id: string
  created_at: number
  expires_at: number
  last_seen_at: number
  user_agent: string | null
}

/** A booth machine should not be asked to sign in again mid-service. */
export const DEFAULT_SESSION_TTL_MS = 30 * 86_400_000

/** Writing last-seen on every request would be a write per poll. */
const LAST_SEEN_RESOLUTION_MS = 60_000

export class Sessions {
  private readonly db: Db
  private readonly clock: Clock
  private readonly ttlMs: number

  constructor(init: { db: Db; clock: Clock; ttlMs?: number }) {
    this.db = init.db
    this.clock = init.clock
    this.ttlMs = init.ttlMs ?? DEFAULT_SESSION_TTL_MS
  }

  /** Returns the token exactly once: it is not recoverable afterwards. */
  mint(options: { userAgent?: string } = {}): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url')
    const now = this.clock.now()
    const expiresAt = now + this.ttlMs
    this.db
      .prepare(
        `INSERT INTO session (id, token_hash, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        fingerprintOf(token),
        now,
        expiresAt,
        now,
        options.userAgent?.slice(0, 200) ?? null,
      )
    return { token, expiresAt }
  }

  /** The session behind a token, or undefined if it is unknown or finished. */
  verify(token: string): Session | undefined {
    if (token === '') return undefined
    const row = this.db
      .prepare(
        `SELECT id, created_at, expires_at, last_seen_at, user_agent
           FROM session
          WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(fingerprintOf(token)) as SessionRow | undefined
    if (!row) return undefined

    const now = this.clock.now()
    if (row.expires_at <= now) return undefined

    if (now - row.last_seen_at >= LAST_SEEN_RESOLUTION_MS) {
      this.db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(now, row.id)
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
    }
  }

  revoke(token: string): void {
    this.db
      .prepare('UPDATE session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.clock.now(), fingerprintOf(token))
  }

  /**
   * Ends every session. What a changed password does, because the reason
   * for changing it is usually that somebody should no longer be in.
   */
  revokeAll(): void {
    this.db
      .prepare('UPDATE session SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(this.clock.now())
  }

  list(): Session[] {
    const now = this.clock.now()
    return (
      this.db
        .prepare(
          `SELECT id, created_at, expires_at, last_seen_at, user_agent
             FROM session
            WHERE revoked_at IS NULL AND expires_at > ?
            ORDER BY last_seen_at DESC`,
        )
        .all(now) as SessionRow[]
    ).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
    }))
  }

  /** Drops what has expired or been revoked. Called from the hourly sweep. */
  sweep(): number {
    const result = this.db
      .prepare('DELETE FROM session WHERE expires_at <= ? OR revoked_at IS NOT NULL')
      .run(this.clock.now())
    return Number(result.changes ?? 0)
  }
}

function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
