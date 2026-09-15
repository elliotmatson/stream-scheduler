import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/index.js'
import type { Paths } from '../config/paths.js'
import { backupFileName, writeBackup } from './index.js'

/**
 * Backups that happen without anybody remembering to take one.
 *
 * The manual download has existed since the backup module was written, and
 * it has the same problem every manual backup has: the person who would
 * press the button is the person who has not thought about it since the
 * last time something went wrong.
 *
 * These go to a directory of their own rather than next to the database,
 * so a mounted volume can point them at a different disk entirely. That is
 * the difference between surviving a bad restore and surviving a dead
 * drive — and it is a Docker concern rather than an app one, so the app
 * takes a path and does not care what is behind it.
 */

export const BACKUP_ENABLED_KEY = 'backup_enabled'
export const BACKUP_EVERY_HOURS_KEY = 'backup_every_hours'
export const BACKUP_KEEP_KEY = 'backup_keep'
export const BACKUP_LAST_AT_KEY = 'backup_last_at'
export const BACKUP_LAST_ERROR_KEY = 'backup_last_error'

/** Daily, a fortnight kept. A fortnight covers "it broke last Sunday and
 *  nobody noticed until this Sunday", and the database is small enough
 *  that fourteen of them cost nothing worth counting. */
export const DEFAULT_EVERY_HOURS = 24
export const DEFAULT_KEEP = 14

/** Hourly at the fastest. This runs off the scheduler's hourly branch, and
 *  a backup every few minutes would be a lot of writing for a database
 *  that changes a handful of times a week. */
export const MIN_EVERY_HOURS = 1
export const MAX_EVERY_HOURS = 24 * 14
export const MIN_KEEP = 1
export const MAX_KEEP = 365

export interface BackupSchedule {
  /** Hours between backups. */
  everyHours: number
  /** How many to keep in the directory; the oldest go first. */
  keep: number
  /** Off entirely, for somebody backing the volume up by other means. */
  enabled: boolean
}

export interface BackupScheduleState extends BackupSchedule {
  directory: string
  lastAt: number | undefined
  /** What went wrong last time, cleared by the next one that works. */
  lastError: string | undefined
  /** How many are sitting in the directory now. */
  count: number
}

export interface TakenBackup {
  file: string
  takenAt: number
  /** What was removed to stay within `keep`. */
  pruned: string[]
}

export function readSchedule(db: Db): BackupSchedule {
  return {
    // Its own setting rather than a cadence of zero. Overloading the
    // cadence loses it: turning backups off and on again would forget that
    // somebody had asked for every six hours and quietly give them every
    // hour instead.
    enabled: stringSetting(db, BACKUP_ENABLED_KEY) !== 'false',
    everyHours: clamp(
      numberSetting(db, BACKUP_EVERY_HOURS_KEY) ?? DEFAULT_EVERY_HOURS,
      MIN_EVERY_HOURS,
      MAX_EVERY_HOURS,
    ),
    keep: clamp(numberSetting(db, BACKUP_KEEP_KEY) ?? DEFAULT_KEEP, MIN_KEEP, MAX_KEEP),
  }
}

export function writeSchedule(
  db: Db,
  next: { everyHours?: number; keep?: number; enabled?: boolean },
): void {
  const current = readSchedule(db)
  const enabled = next.enabled ?? current.enabled
  const everyHours = clamp(next.everyHours ?? current.everyHours, MIN_EVERY_HOURS, MAX_EVERY_HOURS)
  const keep = clamp(next.keep ?? current.keep, MIN_KEEP, MAX_KEEP)

  putSetting(db, BACKUP_ENABLED_KEY, enabled ? 'true' : 'false')
  putSetting(db, BACKUP_EVERY_HOURS_KEY, String(everyHours))
  putSetting(db, BACKUP_KEEP_KEY, String(keep))
}

export function scheduleState(db: Db, directory: string): BackupScheduleState {
  return {
    ...readSchedule(db),
    directory,
    lastAt: numberSetting(db, BACKUP_LAST_AT_KEY),
    lastError: stringSetting(db, BACKUP_LAST_ERROR_KEY),
    count: existing(directory).length,
  }
}

/** True when enough time has passed, or when none has ever been taken. */
export function backupDue(db: Db, now: number): boolean {
  const schedule = readSchedule(db)
  if (!schedule.enabled) return false
  const last = numberSetting(db, BACKUP_LAST_AT_KEY)
  if (last === undefined) return true
  return now - last >= schedule.everyHours * 60 * 60_000
}

/**
 * Takes one and prunes the rest.
 *
 * The timestamp is recorded whether this works or not, by the caller. A
 * mount that has gone away fails every time it is tried, and retrying it
 * every five seconds until somebody notices would fill the log with the
 * same line and do nothing useful — so a failure waits for the next
 * cadence, and says so out loud in the meantime.
 */
export function takeScheduledBackup(
  db: Db,
  paths: Paths,
  directory: string,
  now: number,
): TakenBackup {
  // Deliberately `recursive`: on a fresh install nothing has created this,
  // and on Docker the mount point exists but the app's own subdirectory
  // under it may not.
  mkdirSync(directory, { recursive: true })

  const file = join(directory, backupFileName(now))
  writeBackup(db, file, { now, envSaltFile: join(paths.configDir, 'master.salt') })

  return { file, takenAt: now, pruned: prune(directory, readSchedule(db).keep) }
}

/**
 * Removes the oldest until `keep` remain.
 *
 * By modification time rather than by the name, even though the name
 * carries a timestamp: a file copied or restored onto this volume by hand
 * would sort wherever its name says, and the honest question is which one
 * is actually oldest.
 */
export function prune(directory: string, keep: number): string[] {
  const files = existing(directory)
  if (files.length <= keep) return []

  const byAge = files
    .map((name) => ({ name, at: modifiedAt(join(directory, name)) }))
    .sort((a, b) => b.at - a.at)

  const doomed = byAge.slice(keep).map((entry) => entry.name)
  for (const name of doomed) rmSync(join(directory, name), { force: true })
  return doomed
}

export function recordSuccess(db: Db, at: number): void {
  putSetting(db, BACKUP_LAST_AT_KEY, String(at))
  db.prepare('DELETE FROM setting WHERE key = ?').run(BACKUP_LAST_ERROR_KEY)
}

export function recordFailure(db: Db, at: number, message: string): void {
  // The timestamp moves even on a failure, so the next attempt is a
  // cadence away rather than five seconds away.
  putSetting(db, BACKUP_LAST_AT_KEY, String(at))
  putSetting(db, BACKUP_LAST_ERROR_KEY, message)
}

/** Only this app's own backups. Anything else in the directory is somebody
 *  else's and is not this app's to count or delete. */
function existing(directory: string): string[] {
  if (!existsSync(directory)) return []
  try {
    return readdirSync(directory).filter(
      (name) => name.startsWith('stream-scheduler-') && name.endsWith('.db'),
    )
  } catch {
    return []
  }
}

function modifiedAt(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, Math.round(value)))
}

function numberSetting(db: Db, key: string): number | undefined {
  const raw = stringSetting(db, key)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value
}

function putSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}
