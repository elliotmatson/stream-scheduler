import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { MasterKey, MasterKeySource } from '@scheduler/core'

/**
 * Master key backed by the OS keychain: Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux where available.
 *
 * The key itself is generated once and stored on disk *encrypted by the OS*,
 * so the file is useless on another machine or to another user account. This
 * is why the desktop build needs no `SCHEDULER_SECRET`.
 */
export function safeStorageKeySource(configDir: string): MasterKeySource {
  const file = join(configDir, 'master.key.enc')

  return {
    load(): MasterKey | undefined {
      // Not available on a Linux box with no secret service, and not until
      // Electron's `ready` event. Declining lets the file and env sources
      // take over rather than failing the whole startup.
      if (!safeStorage.isEncryptionAvailable()) return undefined

      if (existsSync(file)) {
        const key = safeStorage.decryptString(readFileSync(file))
        return toMasterKey(Buffer.from(key, 'base64'))
      }

      const key = randomBytes(32)
      writeFileSync(file, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 })
      return toMasterKey(key)
    },
  }
}

function toMasterKey(key: Buffer): MasterKey {
  return { keyId: `keychain:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`, key }
}
