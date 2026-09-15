import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { Application } from '../app.js'
import { ConflictError } from './errors.js'
import {
  backupFileName,
  cancelRestore,
  InvalidBackupError,
  keyVerdict,
  pendingRestore,
  readManifest,
  scratchBackupFile,
  stageRestore,
  writeBackup,
} from '../backup/index.js'
import {
  MAX_EVERY_HOURS,
  MAX_KEEP,
  MIN_EVERY_HOURS,
  MIN_KEEP,
  scheduleState,
  writeSchedule,
} from '../backup/schedule.js'
import { join } from 'node:path'

/** A restore somebody has looked at but not yet agreed to. */
const CONFIRM_TTL_MS = 10 * 60_000

/** Room for a database with years of runs in it. */
const MAX_UPLOAD = 256 * 1024 * 1024

/**
 * Backing the install up, and putting one back.
 *
 * Two steps for the restore, like every other irreversible thing in this
 * app: uploading answers "what is in this file, and will its secrets be
 * readable here", and only a second call with that answer's token puts it
 * in the way of the next start. A restore is done by somebody having a bad
 * day, sometimes with the wrong file, and being told what is in it before
 * it lands is the difference between a recovery and a second disaster.
 */
export function registerBackupRoutes(fastify: FastifyInstance, app: Application): void {
  // The upload is a database, not JSON. Parsed as a buffer and handed
  // straight on: nothing about it is inspected until it is on disk and
  // SQLite can be asked what it is.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
    (_request, body, done) => done(null, body),
  )

  const pending = new Map<string, { at: number }>()

  /**
   * What a backup would contain, and what restoring one would need.
   *
   * Read before pressing anything: which key source this install uses is
   * the part nobody thinks about until a restore, and the part that
   * decides whether the restore is any use.
   */
  fastify.get('/api/backup/status', async () => {
    const keyId = app.vault.keyId
    const [kind] = keyId.split(':')
    const staged = pendingRestore(app.paths)

    return {
      keyId,
      keySource: kind,
      schedule: scheduleState(app.db, app.paths.backupDir),
      keySourceLabel: describeKeySource(kind ?? 'unknown'),
      // Whether the secrets already here can actually be read, which is
      // the same question a restore raises and is worth answering before
      // anybody is depending on the answer.
      secretsReadable: secretsReadable(app),
      includes: [
        'Every event, date, device, output and run',
        'Stream keys and connected accounts, still encrypted',
        'Notification channels and settings',
      ],
      excludes: [
        'The master key itself, whatever its source',
        'Logs, which are not needed to bring the app back',
      ],
      ...(staged === undefined
        ? {}
        : {
            stagedRestore: {
              stagedAt: staged.stagedAt,
              takenAt: staged.manifest.takenAt,
              counts: staged.manifest.counts,
            },
          }),
      ...(app.restored === undefined
        ? {}
        : {
            lastRestore: {
              takenAt: app.restored.manifest.takenAt,
              counts: app.restored.manifest.counts,
              previousDatabase: app.restored.previous,
            },
          }),
    }
  })

  /**
   * Changes when backups are taken and how many are kept.
   *
   * Deliberately does not take a directory. Where the files go is a
   * deployment decision — a volume in Docker, an environment variable
   * otherwise — and a path typed into a browser is a path somebody can
   * point at the database's own directory by accident.
   */
  fastify.put('/api/backup/schedule', async (request) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        everyHours: z.number().int().min(MIN_EVERY_HOURS).max(MAX_EVERY_HOURS).optional(),
        keep: z.number().int().min(MIN_KEEP).max(MAX_KEEP).optional(),
      })
      .parse(request.body)

    writeSchedule(app.db, body)
    return scheduleState(app.db, app.paths.backupDir)
  })

  /** The file itself. A consistent copy, taken while the app keeps running. */
  fastify.get('/api/backup', async (_request, reply) => {
    const now = app.clock.now()
    const file = scratchBackupFile(app.paths, now)
    try {
      writeBackup(app.db, file, {
        now,
        envSaltFile: join(app.paths.configDir, 'master.salt'),
      })
      const bytes = readFileSync(file)
      app.logger.info('a backup was downloaded', { bytes: bytes.length })
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${backupFileName(now)}"`)
        .send(bytes)
    } finally {
      // The copy exists only to be sent. Leaving it behind would quietly
      // double the install's disk use every time somebody pressed this.
      rmSync(file, { force: true })
    }
  })

  /**
   * Says what is in an uploaded backup. Changes nothing.
   *
   * The token it returns is what the restore below takes, so nothing can
   * be restored that was not first described to whoever is restoring it.
   */
  fastify.post('/api/restore/inspect', async (request) => {
    const body = request.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ConflictError('Send the backup file itself, as application/octet-stream.')
    }

    const scratch = scratchBackupFile(app.paths, app.clock.now())
    try {
      writeFileSync(scratch, body)
      const manifest = readManifest(scratch)
      const verdict = keyVerdict(manifest, app.vault.keyId)

      const token = randomUUID()
      pending.set(token, { at: app.clock.now() })
      return {
        confirm: token,
        takenAt: manifest.takenAt,
        counts: manifest.counts,
        schemaVersion: manifest.schemaVersion,
        carriesEnvSalt: manifest.envSalt !== undefined,
        key: verdict,
      }
    } catch (error) {
      if (error instanceof InvalidBackupError) throw new ConflictError(error.message)
      throw error
    } finally {
      rmSync(scratch, { force: true })
    }
  })

  /**
   * Stages a restore for the next start.
   *
   * Not applied here. The database is open and being written to, and
   * swapping the file under a live handle is how a restore becomes a
   * corruption — so it is put in the way of the next start instead, and
   * that restart is said plainly rather than pretended away.
   */
  fastify.post('/api/restore', async (request) => {
    const token = String(request.headers['x-confirm'] ?? '')
    const agreed = pending.get(token)
    if (!agreed) {
      throw new ConflictError('Look at the backup first: upload it to see what is in it.')
    }
    if (app.clock.now() - agreed.at > CONFIRM_TTL_MS) {
      pending.delete(token)
      throw new ConflictError('That confirmation is more than ten minutes old. Look again.')
    }
    pending.delete(token)

    const body = request.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ConflictError('Send the backup file itself, as application/octet-stream.')
    }

    try {
      const manifest = stageRestore(app.paths, body, app.clock.now())
      app.logger.warn('a restore was staged for the next start', {
        takenAt: manifest.takenAt,
        counts: manifest.counts,
      })
      return {
        staged: true,
        takenAt: manifest.takenAt,
        counts: manifest.counts,
        message:
          'Restart the app to finish. The database in place now will be kept alongside the ' +
          'restored one rather than deleted.',
      }
    } catch (error) {
      if (error instanceof InvalidBackupError) throw new ConflictError(error.message)
      throw error
    }
  })

  /** Changes its mind before the restart. */
  fastify.delete('/api/restore', async () => {
    cancelRestore(app.paths)
    return { staged: false }
  })

  fastify.get('/api/restore', async () => {
    const staged = pendingRestore(app.paths)
    return staged === undefined
      ? { staged: false }
      : { staged: true, stagedAt: staged.stagedAt, ...staged.manifest }
  })
}

/** Which master key source an install is on, in words rather than a prefix. */
function describeKeySource(kind: string): string {
  switch (kind) {
    case 'file':
      return 'A key file at master.key in the config directory. Keep a copy of it somewhere else — a backup without it restores the schedule and not the stream keys.'
    case 'env':
      return 'Derived from SCHEDULER_SECRET. Restoring needs the same value set; the salt it is stretched with travels in the backup, because without it the same passphrase makes a different key.'
    case 'keychain':
      return 'The OS keychain on this machine. It never leaves it, so a backup restored anywhere else will not be able to read its stream keys.'
    default:
      return 'Unknown. Restoring will need whatever key this install was using.'
  }
}

/**
 * Whether the secrets already stored here can be read with the key in hand.
 *
 * Asked by reading one, because that is the only way to know. A vault that
 * cannot be read is the state a bad restore leaves behind, and it is
 * invisible until a Sunday morning.
 */
function secretsReadable(app: Application): {
  state: 'ok' | 'none' | 'unreadable'
  message: string
} {
  const row = app.db.prepare('SELECT id FROM secret LIMIT 1').get() as { id: string } | undefined
  if (!row) return { state: 'none', message: 'Nothing encrypted is stored yet.' }
  try {
    app.vault.reveal(row.id)
    return { state: 'ok', message: 'Stored stream keys and accounts can be read.' }
  } catch (error) {
    return {
      state: 'unreadable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
