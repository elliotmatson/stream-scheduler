import Database from 'better-sqlite3'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/index.js'
import type { Paths } from '../config/paths.js'

/**
 * Taking a copy of everything, and putting one back.
 *
 * The Dockerfile has always said an archive of the config directory is the
 * whole backup and restoring it is the whole recovery. Both halves of that
 * were true and neither was helped by anything in the app, which left two
 * ways to get it quietly wrong.
 *
 * The first is the database. It runs in WAL mode, so the bytes in
 * `scheduler.db` are not the current state — the last few minutes of it
 * are in `scheduler.db-wal`. Copying the one file while the server is
 * running produces an archive that restores to some earlier moment, or to
 * a torn one, and nothing about the copy looks wrong. `VACUUM INTO` is
 * SQLite's own answer: it reads through a transaction and writes a
 * complete, consistent, already-compacted database, with the server still
 * serving.
 *
 * The second is the master key, and it is the one that actually loses
 * somebody's Sundays. Stream keys and OAuth tokens are encrypted in the
 * database; the key that decrypts them lives outside it — in a file, in
 * the OS keychain, or derived from an environment variable. A backup of
 * the database alone is restorable and its secrets are not readable, and
 * finding that out during a recovery is the worst possible time. So the
 * backup carries, in the clear, everything needed to *identify* the key it
 * would take — and never the key itself.
 *
 * The backup is one SQLite file rather than an archive of several. It is
 * openable by any tool that reads SQLite, which is the property that
 * matters most about a format somebody will only ever use on a bad day;
 * and the manifest lives in a table inside it, so the file explains
 * itself.
 */

export const MANIFEST_TABLE = 'backup_manifest'

/** Bumped only for a change that an older build could not read safely. */
export const FORMAT_VERSION = 1

export interface BackupManifest {
  formatVersion: number
  takenAt: number
  /** The highest migration the source database had applied. */
  schemaVersion: number
  /**
   * The master keys that encrypted the secrets in here, as key ids.
   *
   * A key id is a hash prefix, not a key: it is enough to say "this is the
   * same key" or "this is a different one" and worth nothing to somebody
   * holding the file. Usually one. Empty when nothing encrypted is stored,
   * in which case the backup needs no key at all.
   */
  keyIds: string[]
  /**
   * The salt an environment-derived key was stretched with.
   *
   * Not a secret, and not the key: SCHEDULER_SECRET plus this salt is the
   * key, and without the salt the same passphrase derives a different one.
   * Leaving it out would make a correct passphrase produce unreadable
   * secrets, which is exactly the failure this file exists to prevent.
   */
  envSalt?: string
  /** What is in here, so somebody can tell one backup from another. */
  counts: Record<string, number>
}

/** The tables worth counting on a screen: what somebody recognises. */
const COUNTED = [
  ['events', 'event_series'],
  ['dates', 'occurrence'],
  ['devices', 'device'],
  ['stream keys', 'stream_credential'],
  ['runs', 'run'],
  ['notifications', 'notification_channel'],
] as const

/**
 * Writes a consistent copy of the database to `file`, manifest included.
 *
 * Safe to call while the scheduler is running: `VACUUM INTO` takes its own
 * read transaction, so the copy is the database as of one instant rather
 * than a smear across however long the write took.
 */
export function writeBackup(
  db: Db,
  file: string,
  context: { now: number; envSaltFile?: string },
): BackupManifest {
  // VACUUM INTO refuses to overwrite, which is the right default and the
  // wrong one for a path we chose ourselves a moment ago.
  rmSync(file, { force: true })
  db.prepare('VACUUM INTO ?').run(file)

  const manifest: BackupManifest = {
    formatVersion: FORMAT_VERSION,
    takenAt: context.now,
    schemaVersion: highestMigration(db),
    keyIds: (
      db.prepare('SELECT DISTINCT key_id AS keyId FROM secret').all() as { keyId: string }[]
    ).map((row) => row.keyId),
    ...(context.envSaltFile && existsSync(context.envSaltFile)
      ? { envSalt: readFileSync(context.envSaltFile).toString('base64') }
      : {}),
    counts: countOf(db),
  }

  const copy = new Database(file)
  try {
    copy.exec(`CREATE TABLE ${MANIFEST_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const insert = copy.prepare(`INSERT INTO ${MANIFEST_TABLE} (key, value) VALUES (?, ?)`)
    insert.run('manifest', JSON.stringify(manifest))
    // A line for whoever opens this in a SQLite browser wondering what it
    // is. Costs one row and answers the only question they will have.
    insert.run(
      'readme',
      'A Stream Scheduler backup: a complete copy of its database. Stream keys and ' +
        'OAuth tokens inside are encrypted and the key to them is NOT in this file — ' +
        'restoring needs the same master key the original install used. See keyIds in ' +
        'the manifest row.',
    )
  } finally {
    copy.close()
  }
  return manifest
}

/** Reads the manifest out of a file somebody uploaded, or explains why not. */
export function readManifest(file: string): BackupManifest {
  let copy: Database.Database
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true })
  } catch {
    throw new InvalidBackupError('That file is not a database this app can read.')
  }
  try {
    // Asked of sqlite_master rather than by querying the table, because
    // SQLite opens lazily: a text file passes `new Database` and only
    // fails on the first read, which would make "not a database at all"
    // and "a database without a manifest" the same message.
    let present: unknown
    try {
      present = copy
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(MANIFEST_TABLE)
    } catch {
      throw new InvalidBackupError('That file is not a database this app can read.')
    }
    if (!present) {
      throw new InvalidBackupError(
        'That is a database, but not one this app produced: it has no backup manifest. ' +
          'A copy of scheduler.db taken by hand is not enough — nothing in it says which ' +
          'master key its secrets need. Use a file downloaded from Backup on the settings screen.',
      )
    }

    const row = copy.prepare(`SELECT value FROM ${MANIFEST_TABLE} WHERE key = 'manifest'`).get() as
      { value: string } | undefined
    if (!row) {
      throw new InvalidBackupError(
        'That file has a backup manifest table with nothing in it. It is not a usable backup.',
      )
    }
    const manifest = JSON.parse(row.value) as BackupManifest
    if (manifest.formatVersion > FORMAT_VERSION) {
      throw new InvalidBackupError(
        `That backup is in format ${manifest.formatVersion} and this build understands ${FORMAT_VERSION}. ` +
          'Restore it with the version that made it, or a newer one.',
      )
    }
    return manifest
  } catch (error) {
    if (error instanceof InvalidBackupError) throw error
    throw new InvalidBackupError('That file is not a backup this app can read.')
  } finally {
    copy.close()
  }
}

export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBackupError'
  }
}

/**
 * Whether the key this install has can read the secrets in a backup.
 *
 * Three answers, because they mean three different things to whoever is
 * about to press Restore: nothing in here needs a key; this is the same
 * key; and this is a different key, so the schedule comes back and the
 * stream keys come back unreadable.
 */
export function keyVerdict(
  manifest: BackupManifest,
  currentKeyId: string,
): { state: 'no-secrets' | 'match' | 'mismatch'; message: string } {
  if (manifest.keyIds.length === 0) {
    return {
      state: 'no-secrets',
      message: 'Nothing in this backup is encrypted, so it needs no master key.',
    }
  }
  if (manifest.keyIds.includes(currentKeyId)) {
    return {
      state: 'match',
      message: 'This install has the key these secrets were encrypted with.',
    }
  }
  return {
    state: 'mismatch',
    message:
      `These secrets were encrypted with master key ${manifest.keyIds.join(', ')} and this ` +
      `install has ${currentKeyId}. Everything else restores; stream keys and connected ` +
      `accounts will not be readable until the original key is in place.`,
  }
}

/**
 * Puts a restore in the way of the next startup rather than doing it now.
 *
 * The database is open and being written to. Swapping the file under a
 * live handle is how a restore becomes a corruption, so the file is staged
 * and the swap happens before anything opens it — which is a restart, and
 * is said so plainly rather than pretended away.
 */
export function stageRestore(paths: Paths, uploaded: Buffer, now: number): BackupManifest {
  mkdirSync(pendingDir(paths), { recursive: true })
  const staged = pendingFile(paths)
  writeFileSync(staged, uploaded)

  let manifest: BackupManifest
  try {
    manifest = readManifest(staged)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }

  writeFileSync(markerFile(paths), JSON.stringify({ stagedAt: now, manifest }, null, 2), 'utf8')
  return manifest
}

/** Forgets a staged restore that has not happened yet. */
export function cancelRestore(paths: Paths): void {
  rmSync(pendingFile(paths), { force: true })
  rmSync(markerFile(paths), { force: true })
}

/** What is waiting to be restored on the next start, if anything. */
export function pendingRestore(
  paths: Paths,
): { stagedAt: number; manifest: BackupManifest } | undefined {
  if (!existsSync(markerFile(paths)) || !existsSync(pendingFile(paths))) return undefined
  try {
    return JSON.parse(readFileSync(markerFile(paths), 'utf8')) as {
      stagedAt: number
      manifest: BackupManifest
    }
  } catch {
    return undefined
  }
}

export interface RestoreApplied {
  manifest: BackupManifest
  /** Where the database that was replaced went. */
  previous: string
}

/**
 * Swaps a staged backup into place. Called before the database is opened.
 *
 * The database being replaced is moved aside rather than deleted. A
 * restore is done by somebody having a bad day, sometimes with the wrong
 * file, and "your schedule is now whatever was in that file and the old
 * one is gone" is not a thing a button should be able to do. The path it
 * went to is logged and reported.
 *
 * The WAL and shared-memory files go with it: leaving a `-wal` belonging
 * to the old database beside the new one is a database that will not open,
 * or worse, one that opens with somebody else's last few minutes in it.
 */
export function applyPendingRestore(paths: Paths, now: number): RestoreApplied | undefined {
  const pending = pendingRestore(paths)
  if (!pending) {
    // A marker with no file, or a file with no marker, is a half-written
    // staging from a crash. Neither is a restore; clear both.
    cancelRestore(paths)
    return undefined
  }

  const previous = `${paths.databaseFile}.replaced-${now}`
  if (existsSync(paths.databaseFile)) renameSync(paths.databaseFile, previous)
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${paths.databaseFile}${suffix}`, { force: true })
  }
  renameSync(pendingFile(paths), paths.databaseFile)

  // The salt goes in with it, or the same passphrase derives a different
  // key and every secret in the file just restored is unreadable.
  if (pending.manifest.envSalt) {
    writeFileSync(
      join(paths.configDir, 'master.salt'),
      Buffer.from(pending.manifest.envSalt, 'base64'),
      { mode: 0o600 },
    )
  }

  rmSync(markerFile(paths), { force: true })
  return { manifest: pending.manifest, previous }
}

/** Restores taken from this install, kept for the "what did I download" line. */
export function backupFileName(now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `stream-scheduler-${stamp}.db`
}

function pendingDir(paths: Paths): string {
  return join(paths.configDir, 'restore')
}

function pendingFile(paths: Paths): string {
  return join(pendingDir(paths), 'pending.db')
}

function markerFile(paths: Paths): string {
  return join(pendingDir(paths), 'pending.json')
}

function highestMigration(db: Db): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM schema_migration').get() as
    { id: number | null } | undefined
  return row?.id ?? 0
}

function countOf(db: Db): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [label, table] of COUNTED) {
    try {
      counts[label] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    } catch {
      // A table a future version dropped is not a reason to refuse a
      // backup of everything else.
      counts[label] = 0
    }
  }
  return counts
}

/** A scratch path for the copy a download is streamed from. */
export function scratchBackupFile(paths: Paths, now: number): string {
  mkdirSync(pendingDir(paths), { recursive: true })
  return join(pendingDir(paths), `download-${now}.db`)
}

/** Copies a file, for tests and for the desktop package's own scheduling. */
export function copyBackup(from: string, to: string): void {
  copyFileSync(from, to)
}
