import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { envSecretSource, keyFileSource, MissingMasterKeyError, resolveMasterKey } from './master-key.js'
import { Scrubber } from './scrubber.js'
import { fingerprint, SecretVault, UnknownSecretError, WrongMasterKeyError } from './vault.js'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-secrets-'))
  db = openTestDatabase()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('master key resolution', () => {
  it('refuses to fall back to plaintext when nothing is configured', () => {
    const sources = [keyFileSource(join(dir, 'master.key')), envSecretSource(dir, {})]
    expect(() => resolveMasterKey(sources)).toThrow(MissingMasterKeyError)
  })

  it('creates an owner-only key file on first run and reuses it after', () => {
    const file = join(dir, 'master.key')
    const first = resolveMasterKey([keyFileSource(file, { create: true })])
    expect(readFileSync(file)).toHaveLength(32)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    const second = resolveMasterKey([keyFileSource(file)])
    expect(second.keyId).toBe(first.keyId)
  })

  it('derives a stable key from SCHEDULER_SECRET across restarts', () => {
    const env = { SCHEDULER_SECRET: 'a-sufficiently-long-secret' }
    const first = resolveMasterKey([envSecretSource(dir, env)])
    const second = resolveMasterKey([envSecretSource(dir, env)])
    expect(second.keyId).toBe(first.keyId)
    expect(second.key.equals(first.key)).toBe(true)
  })

  it('rejects a short SCHEDULER_SECRET', () => {
    expect(() => resolveMasterKey([envSecretSource(dir, { SCHEDULER_SECRET: 'short' })])).toThrow(/at least 16/)
  })
})

describe('SecretVault', () => {
  const key = () => resolveMasterKey([keyFileSource(join(dir, 'master.key'), { create: true })])

  it('round-trips a stream key without storing it in the clear', () => {
    const vault = new SecretVault(db, key(), new Scrubber())
    const ref = vault.store('live_abcd-1234-efgh-5678')
    const stored = db.prepare('SELECT ciphertext FROM secret WHERE id = ?').get(ref) as { ciphertext: Buffer }
    expect(stored.ciphertext.toString('utf8')).not.toContain('live_abcd')
    expect(vault.reveal(ref)).toBe('live_abcd-1234-efgh-5678')
  })

  it('registers every revealed secret with the scrubber automatically', () => {
    const scrubber = new Scrubber()
    const vault = new SecretVault(db, key(), scrubber)
    const ref = vault.store('live_abcd-1234-efgh-5678')
    vault.reveal(ref)
    expect(scrubber.redact('pushing key live_abcd-1234-efgh-5678 to encoder')).toBe(
      'pushing key [redacted] to encoder',
    )
  })

  it('reports a wrong master key clearly instead of returning garbage', () => {
    const vault = new SecretVault(db, key(), new Scrubber())
    const ref = vault.store('live_abcd-1234-efgh-5678')
    const other = resolveMasterKey([envSecretSource(dir, { SCHEDULER_SECRET: 'a-different-long-secret' })])
    const reopened = new SecretVault(db, other, new Scrubber())
    expect(() => reopened.reveal(ref)).toThrow(WrongMasterKeyError)
  })

  it('rotates every secret onto a new key', () => {
    const vault = new SecretVault(db, key(), new Scrubber())
    const a = vault.store('live_first-key-value')
    const b = vault.store('live_second-key-value')
    const next = resolveMasterKey([envSecretSource(dir, { SCHEDULER_SECRET: 'the-new-master-secret' })])
    expect(vault.rotate(next)).toBe(2)
    expect(vault.reveal(a)).toBe('live_first-key-value')
    expect(vault.reveal(b)).toBe('live_second-key-value')
    expect((db.prepare('SELECT key_id FROM secret WHERE id = ?').get(a) as { key_id: string }).key_id).toBe(next.keyId)
  })

  it('throws a named error for an unknown reference', () => {
    const vault = new SecretVault(db, key(), new Scrubber())
    expect(() => vault.reveal('nope')).toThrow(UnknownSecretError)
  })
})

describe('Scrubber', () => {
  it('redacts registered values anywhere in a string', () => {
    const s = new Scrubber()
    s.register('live_abcd-1234-efgh')
    expect(s.redact('rtmp://a.rtmp.youtube.com/live2/live_abcd-1234-efgh')).toBe(
      'rtmp://a.rtmp.youtube.com/live2/[redacted]',
    )
  })

  it('ignores values too short to redact safely', () => {
    const s = new Scrubber()
    s.register('ok')
    expect(s.size).toBe(0)
    expect(s.redact('that is ok')).toBe('that is ok')
  })

  it('masks sensitive-looking keys even when the value was never registered', () => {
    const s = new Scrubber()
    expect(s.redactValue({ url: 'rtmps://x/live2', streamKey: 'never-registered-value', nested: { token: 'abc' } })).toEqual(
      { url: 'rtmps://x/live2', streamKey: '[redacted]', nested: { token: '[redacted]' } },
    )
  })

  it('leaves ordinary words that merely contain a sensitive word alone', () => {
    const s = new Scrubber()
    expect(s.redactValue({ keyboard: 'dvorak', monkey: 'george', STREAM_KEY: 'x' })).toEqual({
      keyboard: 'dvorak',
      monkey: 'george',
      STREAM_KEY: '[redacted]',
    })
  })

  it('survives a cyclic object rather than hanging the logger', () => {
    const s = new Scrubber()
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(s.redactValue(cyclic)).toEqual({ a: 1, self: '[circular]' })
  })
})

describe('fingerprint', () => {
  it('is stable and does not reveal the secret', () => {
    const fp = fingerprint('live_abcd-1234-efgh')
    expect(fp).toBe(fingerprint('live_abcd-1234-efgh'))
    expect(fp).toHaveLength(12)
    expect(fp).not.toContain('live_')
  })
})
