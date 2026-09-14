import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { fingerprint } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { MasterKey } from './master-key.js'
import { scrubber as defaultScrubber, type Scrubber } from './scrubber.js'

const ALGORITHM = 'aes-256-gcm'

export class UnknownSecretError extends Error {
  constructor(ref: string) {
    super(`No stored secret with reference "${ref}".`)
    this.name = 'UnknownSecretError'
  }
}

export class WrongMasterKeyError extends Error {
  constructor(ref: string, storedKeyId: string, currentKeyId: string) {
    super(
      `Secret "${ref}" was encrypted with master key ${storedKeyId} but the current key is ${currentKeyId}. ` +
        `Restore the original key file or SCHEDULER_SECRET, or re-enter the affected credentials.`,
    )
    this.name = 'WrongMasterKeyError'
  }
}

/**
 * Envelope-encrypted storage for stream keys and OAuth refresh tokens.
 *
 * Every reveal registers the plaintext with the scrubber, so a secret becomes
 * unloggable the moment it enters memory rather than whenever somebody
 * remembers to redact it.
 */
export class SecretVault {
  private masterKey: MasterKey

  constructor(
    private readonly db: Db,
    masterKey: MasterKey,
    private readonly scrubber: Scrubber = defaultScrubber,
  ) {
    this.masterKey = masterKey
  }

  store(plaintext: string, id = randomId()): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, this.masterKey.key, nonce)
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    this.db
      .prepare(
        `INSERT INTO secret (id, ciphertext, nonce, key_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, key_id = excluded.key_id`,
      )
      .run(id, ciphertext, nonce, this.masterKey.keyId, Date.now())
    this.scrubber.register(plaintext)
    return id
  }

  reveal(ref: string): string {
    const row = this.db
      .prepare('SELECT ciphertext, nonce, key_id FROM secret WHERE id = ?')
      .get(ref) as { ciphertext: Buffer; nonce: Buffer; key_id: string } | undefined
    if (!row) throw new UnknownSecretError(ref)
    if (row.key_id !== this.masterKey.keyId) {
      throw new WrongMasterKeyError(ref, row.key_id, this.masterKey.keyId)
    }
    const tag = row.ciphertext.subarray(row.ciphertext.length - 16)
    const body = row.ciphertext.subarray(0, row.ciphertext.length - 16)
    const decipher = createDecipheriv(ALGORITHM, this.masterKey.key, row.nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    this.scrubber.register(plaintext)
    return plaintext
  }

  delete(ref: string): void {
    const existing = this.db.prepare('SELECT id FROM secret WHERE id = ?').get(ref)
    if (existing) this.db.prepare('DELETE FROM secret WHERE id = ?').run(ref)
  }

  has(ref: string): boolean {
    return this.db.prepare('SELECT 1 FROM secret WHERE id = ?').get(ref) !== undefined
  }

  /** Re-encrypts every secret under a new master key. */
  rotate(next: MasterKey): number {
    const rows = this.db.prepare('SELECT id FROM secret').all() as { id: string }[]
    const plaintexts = rows.map((row) => [row.id, this.reveal(row.id)] as const)
    const previous = this.masterKey
    this.masterKey = next
    try {
      this.db.transaction(() => {
        for (const [id, plaintext] of plaintexts) this.store(plaintext, id)
      })()
    } catch (error) {
      this.masterKey = previous
      throw error
    }
    return plaintexts.length
  }
}

/** Re-exported so callers holding a vault do not need a second import. */
export { fingerprint }

function randomId(): string {
  return randomBytes(12).toString('hex')
}
