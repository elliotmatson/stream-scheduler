import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type Db } from '../db/index.js'
import type { Paths } from '../config/paths.js'
import {
  backupDue,
  BACKUP_EVERY_HOURS_KEY,
  DEFAULT_EVERY_HOURS,
  DEFAULT_KEEP,
  prune,
  readSchedule,
  recordFailure,
  recordSuccess,
  scheduleState,
  takeScheduledBackup,
  writeSchedule,
} from './schedule.js'
import { readManifest } from './index.js'

/**
 * Scheduled backups, against a real database and a real directory.
 *
 * The parts worth testing here are the ones that are wrong quietly: a
 * cadence that does not survive a restart, a prune that removes the wrong
 * end of the list, and a failure that stops the schedule instead of
 * retrying it.
 */

const NOW = Date.parse('2026-03-08T02:00:00Z')
const HOUR = 60 * 60_000

let dir: string
let db: Db
let paths: Paths

function backupDir(): string {
  return join(dir, 'backups')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-backup-schedule-'))
  paths = {
    configDir: dir,
    databaseFile: join(dir, 'scheduler.db'),
    logDir: join(dir, 'logs'),
    keyFile: join(dir, 'master.key'),
    backupDir: backupDir(),
  }
  db = openDatabase(paths.databaseFile)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the schedule', () => {
  it('is daily and keeps a fortnight until somebody says otherwise', () => {
    expect(readSchedule(db)).toEqual({
      enabled: true,
      everyHours: DEFAULT_EVERY_HOURS,
      keep: DEFAULT_KEEP,
    })
  })

  it('is due when nothing has ever been taken', () => {
    expect(backupDue(db, NOW)).toBe(true)
  })

  it('waits a full cadence after one that worked', () => {
    recordSuccess(db, NOW)
    expect(backupDue(db, NOW + 23 * HOUR)).toBe(false)
    expect(backupDue(db, NOW + 24 * HOUR)).toBe(true)
  })

  it('remembers across a restart, so a crash loop does not back up every boot', () => {
    // The reason the timestamp is a setting rather than a field. A
    // container restarting every minute would otherwise take a backup a
    // minute and prune the useful ones out of the directory within the
    // hour.
    recordSuccess(db, NOW)
    db.close()

    db = openDatabase(paths.databaseFile)
    expect(backupDue(db, NOW + HOUR)).toBe(false)
  })

  it('can be turned off, for somebody backing the volume up by other means', () => {
    writeSchedule(db, { enabled: false })
    expect(readSchedule(db).enabled).toBe(false)
    expect(backupDue(db, NOW + 365 * 24 * HOUR)).toBe(false)
  })

  it('comes back on with its cadence intact', () => {
    writeSchedule(db, { everyHours: 6, keep: 3 })
    writeSchedule(db, { enabled: false })
    writeSchedule(db, { enabled: true })
    expect(readSchedule(db)).toMatchObject({ enabled: true, everyHours: 6, keep: 3 })
  })

  it('refuses a cadence that would hammer the disk', () => {
    writeSchedule(db, { everyHours: 0 })
    expect(readSchedule(db).everyHours).toBeGreaterThanOrEqual(1)
  })

  it('keeps the cadence when it is turned off, rather than losing it', () => {
    // The first version stored "off" as a cadence of zero, which read back
    // clamped to one hour — so turning backups off and on again silently
    // changed a six-hourly schedule into an hourly one.
    writeSchedule(db, { everyHours: 6 })
    writeSchedule(db, { enabled: false })
    expect(readSchedule(db).everyHours).toBe(6)
  })

  it('survives a settings row somebody edited by hand', () => {
    db.prepare('INSERT INTO setting (key, value) VALUES (?, ?)').run(
      BACKUP_EVERY_HOURS_KEY,
      'every tuesday',
    )
    expect(readSchedule(db).everyHours).toBeGreaterThanOrEqual(1)
  })
})

describe('taking one', () => {
  it('writes a restorable backup into the directory', () => {
    const taken = takeScheduledBackup(db, paths, backupDir(), NOW)

    expect(readdirSync(backupDir())).toHaveLength(1)
    // Not just a file of the right size: a backup nobody can read back is
    // not a backup.
    const manifest = readManifest(taken.file)
    expect(manifest.takenAt).toBe(NOW)
  })

  it('creates the directory, because on a fresh install nothing has', () => {
    expect(() => takeScheduledBackup(db, paths, join(backupDir(), 'nested'), NOW)).not.toThrow()
  })

  it('keeps only as many as the schedule says, oldest first', () => {
    writeSchedule(db, { keep: 2 })
    const taken = []
    for (let i = 0; i < 4; i++) {
      taken.push(takeScheduledBackup(db, paths, backupDir(), NOW + i * 24 * HOUR))
    }

    const left = readdirSync(backupDir())
    expect(left).toHaveLength(2)
    // The two most recent, not whichever two the filesystem listed first.
    expect(left).toEqual(
      expect.arrayContaining(taken.slice(2).map((entry) => entry.file.split('/').pop())),
    )
  })

  it('leaves other people’s files alone', () => {
    // The directory is a volume somebody chose. It may well have other
    // things in it, and deleting those would be unforgivable.
    mkdirSync(backupDir(), { recursive: true })
    writeFileSync(join(backupDir(), 'notes.txt'), 'not ours')
    writeFileSync(join(backupDir(), 'someone-elses.db'), 'not ours either')

    writeSchedule(db, { keep: 1 })
    takeScheduledBackup(db, paths, backupDir(), NOW)
    takeScheduledBackup(db, paths, backupDir(), NOW + 24 * HOUR)

    const left = readdirSync(backupDir())
    expect(left).toContain('notes.txt')
    expect(left).toContain('someone-elses.db')
    expect(left.filter((name) => name.startsWith('stream-scheduler-'))).toHaveLength(1)
  })

  it('prunes by age rather than by name', () => {
    // A file restored or copied onto the volume by hand sorts wherever its
    // name says. The honest question is which one is actually oldest.
    mkdirSync(backupDir(), { recursive: true })
    const old = join(backupDir(), 'stream-scheduler-2099-01-01-00-00-00.db')
    const recent = join(backupDir(), 'stream-scheduler-2020-01-01-00-00-00.db')
    writeFileSync(old, 'x')
    writeFileSync(recent, 'x')
    utimesSync(old, new Date(NOW - 400 * 24 * HOUR), new Date(NOW - 400 * 24 * HOUR))
    utimesSync(recent, new Date(NOW), new Date(NOW))

    expect(prune(backupDir(), 1)).toEqual(['stream-scheduler-2099-01-01-00-00-00.db'])
  })
})

describe('when it fails', () => {
  it('waits for the next cadence rather than retrying every tick', () => {
    // Otherwise a volume that has gone away produces one failed attempt
    // and one log line every five seconds until somebody notices.
    recordFailure(db, NOW, 'EACCES: permission denied')
    expect(backupDue(db, NOW + HOUR)).toBe(false)
    expect(backupDue(db, NOW + 24 * HOUR)).toBe(true)
  })

  it('remembers why, so a screen can say so without guessing', () => {
    recordFailure(db, NOW, 'ENOSPC: no space left on device')
    expect(scheduleState(db, backupDir()).lastError).toMatch(/ENOSPC/)
  })

  it('forgets the failure once one works', () => {
    recordFailure(db, NOW, 'EACCES: permission denied')
    recordSuccess(db, NOW + 24 * HOUR)
    expect(scheduleState(db, backupDir()).lastError).toBeUndefined()
  })

  it('reports how many are actually there, not how many were meant to be', () => {
    takeScheduledBackup(db, paths, backupDir(), NOW)
    expect(scheduleState(db, backupDir()).count).toBe(1)

    rmSync(backupDir(), { recursive: true, force: true })
    // A volume that vanished reads as empty rather than throwing at
    // whoever asked for the status.
    expect(scheduleState(db, backupDir()).count).toBe(0)
  })
})
