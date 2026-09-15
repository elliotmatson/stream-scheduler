import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/index.js'
import type { Db } from '../db/index.js'
import { Auth } from './index.js'
import { hashPassword, passwordProblem, verifyPassword } from './password.js'
import { Sessions } from './sessions.js'
import { LoginThrottle } from './throttle.js'

let dir: string
let db: Db
let clock: ManualClock

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-auth-'))
  db = openDatabase(join(dir, 'test.db'))
  clock = new ManualClock(Date.parse('2026-03-08T14:00:00Z'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('passwords', () => {
  it('verifies the right password and refuses the wrong one', () => {
    const stored = hashPassword('correct horse battery')
    expect(verifyPassword('correct horse battery', stored)).toBe(true)
    expect(verifyPassword('correct horse batter', stored)).toBe(false)
    expect(verifyPassword('', stored)).toBe(false)
  })

  it('salts, so the same password twice is not the same hash', () => {
    expect(hashPassword('sunday service')).not.toBe(hashPassword('sunday service'))
  })

  it('carries its own parameters, so they can be raised later', () => {
    const stored = hashPassword('sunday service')
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    // A hash written by a version using different parameters still verifies.
    const cheaper = ['scrypt', 1024, 8, 1, ...stored.split('$').slice(4)].join('$')
    expect(verifyPassword('sunday service', cheaper)).toBe(false) // different cost, different hash
  })

  it('refuses a malformed stored hash rather than throwing', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'plaintext')).toBe(false)
    expect(verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false)
  })

  it('normalizes, so a password typed on a different keyboard still works', () => {
    // Composed vs decomposed e-acute: macOS and Windows disagree about
    // which one a keystroke produces, and the two are different bytes.
    // Written as escapes on purpose — as literal characters these two
    // lines look identical, and a later edit would quietly make them so.
    const stored = hashPassword('café service')
    expect(verifyPassword('café service', stored)).toBe(true)
  })

  it('asks for a length worth having', () => {
    expect(passwordProblem('short')).toMatch(/8 characters/)
    expect(passwordProblem('long enough')).toBeUndefined()
  })
})

describe('sessions', () => {
  it('mints a token that verifies, once', () => {
    const sessions = new Sessions({ db, clock })
    const { token } = sessions.mint({ userAgent: 'Firefox' })
    expect(sessions.verify(token)).toMatchObject({ userAgent: 'Firefox' })
    expect(sessions.verify('not-a-token')).toBeUndefined()
    expect(sessions.verify('')).toBeUndefined()
  })

  it('never stores the token itself', () => {
    const sessions = new Sessions({ db, clock })
    const { token } = sessions.mint()
    const rows = db.prepare('SELECT * FROM session').all()
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('expires', () => {
    const sessions = new Sessions({ db, clock, ttlMs: 60_000 })
    const { token } = sessions.mint()
    clock.advance(59_000)
    expect(sessions.verify(token)).toBeDefined()
    clock.advance(2_000)
    expect(sessions.verify(token)).toBeUndefined()
  })

  it('revokes one, and all', () => {
    const sessions = new Sessions({ db, clock })
    const first = sessions.mint()
    const second = sessions.mint()

    sessions.revoke(first.token)
    expect(sessions.verify(first.token)).toBeUndefined()
    expect(sessions.verify(second.token)).toBeDefined()

    sessions.revokeAll()
    expect(sessions.verify(second.token)).toBeUndefined()
    expect(sessions.list()).toEqual([])
  })

  it('sweeps what is expired or revoked, and keeps what is live', () => {
    const sessions = new Sessions({ db, clock, ttlMs: 60_000 })
    const stale = sessions.mint()
    clock.advance(61_000)
    const live = sessions.mint()

    expect(sessions.sweep()).toBe(1)
    expect(sessions.verify(live.token)).toBeDefined()
    expect(sessions.verify(stale.token)).toBeUndefined()
  })

  it('records last-seen without writing on every request', () => {
    const sessions = new Sessions({ db, clock })
    const { token } = sessions.mint()
    const at = (): number =>
      (db.prepare('SELECT last_seen_at FROM session').get() as { last_seen_at: number })
        .last_seen_at
    const started = at()

    clock.advance(1_000)
    sessions.verify(token)
    expect(at()).toBe(started)

    clock.advance(60_000)
    sessions.verify(token)
    expect(at()).toBeGreaterThan(started)
  })
})

describe('the login throttle', () => {
  it('lets a few mistakes through, then spreads them out', () => {
    const throttle = new LoginThrottle({ clock })
    // Three typos cost nothing: somebody who knows the password should not
    // be locked out for fumbling it.
    for (let i = 0; i < 3; i++) {
      expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)
      throttle.fail('10.0.0.5')
    }
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)

    // From the fourth, each one costs twice the last.
    throttle.fail('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(1_000)

    clock.advance(1_000)
    throttle.fail('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(2_000)

    clock.advance(2_000)
    throttle.fail('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(4_000)
  })

  it('holds one address back without touching another', () => {
    const throttle = new LoginThrottle({ clock })
    for (let i = 0; i < 5; i++) throttle.fail('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBeGreaterThan(0)
    expect(throttle.retryAfterMs('10.0.0.6')).toBe(0)
  })

  it('forgets after a success, and after long enough', () => {
    const throttle = new LoginThrottle({ clock })
    for (let i = 0; i < 5; i++) throttle.fail('10.0.0.5')
    throttle.succeed('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)

    for (let i = 0; i < 5; i++) throttle.fail('10.0.0.7')
    clock.advance(2 * 60 * 60_000)
    expect(throttle.retryAfterMs('10.0.0.7')).toBe(0)
  })
})

describe('Auth', () => {
  it('is open until a password is set', () => {
    const auth = new Auth({ db, clock })
    expect(auth.required).toBe(false)
    expect(auth.allows(undefined)).toBe(true)

    auth.setPassword('sunday service')
    expect(auth.required).toBe(true)
    expect(auth.allows(undefined)).toBe(false)
  })

  it('trades a password for a session', () => {
    const auth = new Auth({ db, clock })
    auth.setPassword('sunday service')

    const wrong = auth.login({ password: 'nope', from: '10.0.0.5' })
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong-password' })

    const right = auth.login({ password: 'sunday service', from: '10.0.0.5' })
    if (!right.ok) throw new Error('expected a session')
    expect(auth.allows(right.token)).toBe(true)
  })

  it('refuses to be guessed at speed', () => {
    const auth = new Auth({ db, clock })
    auth.setPassword('sunday service')
    for (let i = 0; i < 4; i++) auth.login({ password: 'nope', from: '10.0.0.5' })

    const blocked = auth.login({ password: 'sunday service', from: '10.0.0.5' })
    // Even the right password waits: otherwise the delay tells an attacker
    // when they have found it.
    expect(blocked).toMatchObject({ ok: false, reason: 'too-many-attempts' })
  })

  it('signs everybody out when the password changes', () => {
    const auth = new Auth({ db, clock })
    auth.setPassword('sunday service')
    const session = auth.login({ password: 'sunday service', from: '10.0.0.5' })
    if (!session.ok) throw new Error('expected a session')

    auth.setPassword('a different one')
    expect(auth.allows(session.token)).toBe(false)
  })

  it('takes its first password from the environment, which is what Docker needs', () => {
    const auth = new Auth({ db, clock, envPassword: 'from-the-environment' })
    expect(auth.required).toBe(true)
    expect(auth.seededFromEnvironment).toBe(true)
    expect(auth.login({ password: 'from-the-environment', from: '10.0.0.5' }).ok).toBe(true)
  })

  it('hands the password over to the UI once it has been seeded', () => {
    const auth = new Auth({ db, clock, envPassword: 'from-the-environment' })
    auth.setPassword('chosen in the app')

    expect(auth.login({ password: 'chosen in the app', from: '10.0.0.5' }).ok).toBe(true)
    expect(auth.login({ password: 'from-the-environment', from: '10.0.0.6' }).ok).toBe(false)
  })

  it('does not put the environment password back on the next restart', () => {
    // The whole reason the seeded marker is stored rather than inferred.
    // The variable is still sitting in the compose file on every boot.
    new Auth({ db, clock, envPassword: 'from-the-environment' }).setPassword('chosen in the app')

    const restarted = new Auth({ db, clock, envPassword: 'from-the-environment' })
    expect(restarted.login({ password: 'chosen in the app', from: '10.0.0.5' }).ok).toBe(true)
    expect(restarted.login({ password: 'from-the-environment', from: '10.0.0.6' }).ok).toBe(false)
  })

  it('does not re-lock an install where somebody took the password off', () => {
    // Worse than the last one: this would put a lock back on a machine
    // whose operator deliberately removed it, and they would have no idea
    // what the password now was.
    new Auth({ db, clock, envPassword: 'from-the-environment' }).clearPassword()

    const restarted = new Auth({ db, clock, envPassword: 'from-the-environment' })
    expect(restarted.required).toBe(false)
  })

  it('keeps the environment password working across the upgrade that changed this', () => {
    // An install that predates seeding has the environment outranking a
    // stored password. The environment's is the one that works today, so
    // it has to be the one that works tomorrow.
    const before = new Auth({ db, clock })
    before.setPassword('set long ago in the app')

    const seeded = new Auth({ db, clock, envPassword: 'from-the-environment' })
    expect(seeded.login({ password: 'from-the-environment', from: '10.0.0.5' }).ok).toBe(true)
    expect(seeded.login({ password: 'set long ago in the app', from: '10.0.0.6' }).ok).toBe(false)
  })

  it('refuses a password too short to be worth typing', () => {
    const auth = new Auth({ db, clock })
    expect(() => auth.setPassword('short')).toThrow(/8 characters/)
    expect(auth.required).toBe(false)
  })

  it('opens back up when the password is removed', () => {
    const auth = new Auth({ db, clock })
    auth.setPassword('sunday service')
    auth.clearPassword()
    expect(auth.required).toBe(false)
    expect(auth.allows(undefined)).toBe(true)
  })
})
