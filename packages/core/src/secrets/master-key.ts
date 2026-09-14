import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MasterKey {
  /** Records which key encrypted a row, so rotation is a background
   *  re-encrypt rather than a migration. */
  keyId: string
  key: Buffer
}

export class MissingMasterKeyError extends Error {
  constructor() {
    super(
      'No master key source is configured, so secrets cannot be encrypted.\n' +
        '  Docker/headless: set SCHEDULER_SECRET to a long random string, or mount a key file at <config-dir>/master.key.\n' +
        '  Desktop: the OS keychain is used automatically; this error means it was unavailable.\n' +
        'Refusing to start rather than storing stream keys and OAuth tokens in plaintext.',
    )
    this.name = 'MissingMasterKeyError'
  }
}

/**
 * A key source supplied by the host. The Electron package provides one backed
 * by `safeStorage` (Keychain on macOS, DPAPI on Windows); Docker and headless
 * get the file or env-derived sources below.
 */
export interface MasterKeySource {
  load(): MasterKey | undefined
}

/** A 32-byte key file, created on first run with owner-only permissions. */
export function keyFileSource(keyFile: string, options: { create?: boolean } = {}): MasterKeySource {
  return {
    load() {
      if (!existsSync(keyFile)) {
        if (!options.create) return undefined
        const key = randomBytes(32)
        writeFileSync(keyFile, key, { mode: 0o600 })
        return { keyId: keyIdFor('file', key), key }
      }
      const key = readFileSync(keyFile)
      if (key.length !== 32) {
        throw new Error(`${keyFile} is not a 32-byte key. Remove it to generate a new one — note that any secrets already stored become unreadable.`)
      }
      // Tighten permissions that a volume mount or a copy may have loosened.
      try {
        chmodSync(keyFile, 0o600)
      } catch {
        // Read-only mounts are fine; we only ever read the file after creation.
      }
      return { keyId: keyIdFor('file', key), key }
    },
  }
}

/**
 * Derives a key from `SCHEDULER_SECRET`. The salt is persisted so the same env
 * var yields the same key across restarts — without that, every container
 * restart would orphan every stored secret.
 */
export function envSecretSource(configDir: string, env: NodeJS.ProcessEnv = process.env): MasterKeySource {
  return {
    load() {
      const secret = env.SCHEDULER_SECRET
      if (!secret) return undefined
      if (secret.length < 16) {
        throw new Error('SCHEDULER_SECRET must be at least 16 characters.')
      }
      const saltFile = join(configDir, 'master.salt')
      let salt: Buffer
      if (existsSync(saltFile)) {
        salt = readFileSync(saltFile)
      } else {
        salt = randomBytes(16)
        writeFileSync(saltFile, salt, { mode: 0o600 })
      }
      const key = scryptSync(secret, salt, 32)
      return { keyId: keyIdFor('env', key), key }
    },
  }
}

/** Tries each source in order and fails loudly if none produced a key. */
export function resolveMasterKey(sources: MasterKeySource[]): MasterKey {
  for (const source of sources) {
    const key = source.load()
    if (key) return key
  }
  throw new MissingMasterKeyError()
}

function keyIdFor(kind: string, key: Buffer): string {
  return `${kind}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}
