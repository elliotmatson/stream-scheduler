import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from '../api/server.js'
import { silentLogger } from '../log.js'

/**
 * A backup that has never been restored is not a backup.
 *
 * So most of this file is one round trip: fill an install, take a copy,
 * restore it into an empty one, and check that what comes back is what
 * went in — the schedule, the devices, and a stream key that still
 * decrypts. The rest is about the two ways this goes quietly wrong: a
 * copy taken while the database is being written, and a restore whose
 * master key is not the one that encrypted it.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')
const SECRET = 'a-secret-long-enough-for-scrypt'

let dirs: string[] = []
let apps: Application[] = []
let servers: FastifyInstance[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-backup-'))
  dirs.push(dir)
  return dir
}

/** An install on its own config directory, keyed from the environment. */
async function install(
  configDir: string,
  options: { secret?: string; clock?: ManualClock } = {},
): Promise<{ app: Application; server: FastifyInstance }> {
  const clock = options.clock ?? new ManualClock(START)
  const app = Application.create({
    configDir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
    // The env source, so the salt handling is the thing under test rather
    // than a key file that would be copied by hand anyway.
    keySources: [
      {
        load: () => {
          const secret = options.secret ?? SECRET
          const saltFile = join(configDir, 'master.salt')
          let salt: Buffer
          if (existsSync(saltFile)) salt = readFileSync(saltFile)
          else {
            salt = randomBytes(16)
            writeFileSync(saltFile, salt)
          }
          const key = scryptSync(secret, salt, 32)
          return {
            keyId: `env:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
            key,
          }
        },
      },
    ],
  })
  const server = await createServer({ app })
  apps.push(app)
  servers.push(server)
  return { app, server }
}

afterEach(async () => {
  for (const server of servers) await server.close()
  for (const app of apps) await app.stop().catch(() => {})
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  apps = []
  servers = []
})

const json = (response: { body: string }): any => JSON.parse(response.body)

/** An install with a Sunday service, a deck and a stream key on it. */
async function populate(server: FastifyInstance): Promise<void> {
  const post = (url: string, payload: unknown) =>
    server.inject({ method: 'POST', url, payload: payload as object })

  const device = json(
    await post('/api/devices', { pluginId: 'mock', label: 'Stage deck', config: { kind: 'both' } }),
  )
  const credential = json(
    await post('/api/credentials', {
      label: 'YouTube main',
      ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
      key: 'live_the-actual-secret-key',
    }),
  )
  const series = json(
    await post('/api/series', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstart: START,
      durationMs: 90 * MINUTE,
    }),
  )
  await post(`/api/series/${series.id}/outputs`, {
    kind: 'stream',
    label: 'Main stream',
    durationMs: 90 * MINUTE,
    credentialId: credential.id,
    deviceId: device.id,
    nodeId: 'stream',
  })
}

describe('taking a backup', () => {
  it('is a database anybody can open, and says what it is', async () => {
    const { server } = await install(freshDir())
    await populate(server)

    const download = await server.inject({ method: 'GET', url: '/api/backup' })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toMatch(/attachment; filename=/)

    // Openable by any tool that reads SQLite, which is the property that
    // matters most about a format somebody only uses on a bad day.
    const file = join(freshDir(), 'backup.db')
    writeFileSync(file, download.rawPayload)
    const { readManifest } = await import('./index.js')
    const manifest = readManifest(file)
    expect(manifest.counts.events).toBe(1)
    expect(manifest.counts['stream keys']).toBe(1)
    // The key it would take, never the key itself.
    expect(manifest.keyIds).toHaveLength(1)
    expect(JSON.stringify(manifest)).not.toContain(SECRET)
    expect(download.rawPayload.toString('latin1')).not.toContain('live_the-actual-secret-key')
  })

  it('carries the salt, because a passphrase alone is not the key', async () => {
    // The trap: SCHEDULER_SECRET plus a salt is the key, and a restore
    // that generated a fresh salt would make the right passphrase derive
    // the wrong key — every secret unreadable, with nothing looking wrong.
    const { server } = await install(freshDir())
    await populate(server)
    const download = await server.inject({ method: 'GET', url: '/api/backup' })
    const file = join(freshDir(), 'backup.db')
    writeFileSync(file, download.rawPayload)
    const { readManifest } = await import('./index.js')
    expect(readManifest(file).envSalt).toBeTruthy()
  })

  it('says which key source this install is on, in words', async () => {
    const { server } = await install(freshDir())
    const status = json(await server.inject({ method: 'GET', url: '/api/backup/status' }))
    expect(status.keySource).toBe('env')
    expect(status.keySourceLabel).toMatch(/SCHEDULER_SECRET/)
    expect(status.excludes.join(' ')).toMatch(/master key/i)
  })

  it('leaves no copy behind on disk', async () => {
    // The copy exists to be sent. Keeping it would double the install's
    // disk use every time somebody pressed the button.
    const dir = freshDir()
    const { server } = await install(dir)
    await populate(server)
    await server.inject({ method: 'GET', url: '/api/backup' })
    const { readdirSync } = await import('node:fs')
    const left = existsSync(join(dir, 'restore')) ? readdirSync(join(dir, 'restore')) : []
    expect(left.filter((name) => name.startsWith('download-'))).toEqual([])
  })
})

describe('restoring one', () => {
  it('brings back the schedule, the devices and a key that still decrypts', async () => {
    // The whole point of the issue: a round trip, into an empty install.
    const source = freshDir()
    const { server: from } = await install(source)
    await populate(from)
    const backup = (await from.inject({ method: 'GET', url: '/api/backup' })).rawPayload

    const target = freshDir()
    const { server: to } = await install(target)
    expect(json(await to.inject({ method: 'GET', url: '/api/series' }))).toHaveLength(0)

    const look = await to.inject({
      method: 'POST',
      url: '/api/restore/inspect',
      headers: { 'content-type': 'application/octet-stream' },
      payload: backup,
    })
    expect(look.statusCode).toBe(200)
    const inspected = json(look)
    expect(inspected.counts.events).toBe(1)
    // A different install, so a different salt and therefore a different
    // key — said plainly rather than discovered later.
    expect(inspected.key.state).toBe('mismatch')

    const staged = await to.inject({
      method: 'POST',
      url: '/api/restore',
      headers: { 'content-type': 'application/octet-stream', 'x-confirm': inspected.confirm },
      payload: backup,
    })
    expect(staged.statusCode).toBe(200)
    expect(json(staged).message).toMatch(/restart/i)

    // Nothing has changed yet: the database is open and swapping it under
    // a live handle is how a restore becomes a corruption.
    expect(json(await to.inject({ method: 'GET', url: '/api/series' }))).toHaveLength(0)

    // The restart.
    await to.close()
    servers.shift()
    const { app: after, server: reopened } = await install(target)
    expect(after.restored).toBeDefined()

    const series = json(await reopened.inject({ method: 'GET', url: '/api/series' }))
    expect(series).toHaveLength(1)
    expect(series[0].label).toBe('Sunday Service')
    expect(json(await reopened.inject({ method: 'GET', url: '/api/devices' }))).toHaveLength(1)

    // And the key: the thing that makes a restore a recovery rather than a
    // schedule with no way to stream it. Readable because the salt
    // travelled with the backup and the passphrase is the same.
    const status = json(await reopened.inject({ method: 'GET', url: '/api/backup/status' }))
    expect(status.secretsReadable.state).toBe('ok')

    const credentials = json(await reopened.inject({ method: 'GET', url: '/api/credentials' }))
    expect(credentials).toHaveLength(1)
    const ref = (
      after.db.prepare('SELECT secret_ref AS ref FROM stream_credential').get() as { ref: string }
    ).ref
    expect(after.vault.reveal(ref)).toBe('live_the-actual-secret-key')
  })

  it('keeps the database it replaced rather than deleting it', async () => {
    // A restore is done by somebody having a bad day, sometimes with the
    // wrong file. "Your schedule is now whatever was in that file and the
    // old one is gone" is not something a button should be able to do.
    const source = freshDir()
    const { server: from } = await install(source)
    await populate(from)
    const backup = (await from.inject({ method: 'GET', url: '/api/backup' })).rawPayload

    const target = freshDir()
    const { server: to } = await install(target)
    const inspected = json(
      await to.inject({
        method: 'POST',
        url: '/api/restore/inspect',
        headers: { 'content-type': 'application/octet-stream' },
        payload: backup,
      }),
    )
    await to.inject({
      method: 'POST',
      url: '/api/restore',
      headers: { 'content-type': 'application/octet-stream', 'x-confirm': inspected.confirm },
      payload: backup,
    })
    await to.close()
    servers.shift()

    const { app: after } = await install(target)
    expect(existsSync(after.restored!.previous)).toBe(true)
  })

  it('will not restore something it has not described first', async () => {
    const { server } = await install(freshDir())
    const refused = await server.inject({
      method: 'POST',
      url: '/api/restore',
      headers: { 'content-type': 'application/octet-stream', 'x-confirm': 'made-up' },
      payload: Buffer.from('not a database'),
    })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/look at the backup/i)
  })

  it('refuses a file that is not one of ours, and says why', async () => {
    const { server } = await install(freshDir())
    const refused = await server.inject({
      method: 'POST',
      url: '/api/restore/inspect',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('this is not a database at all'),
    })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/not a database/i)
  })

  it('refuses a database that is not a backup', async () => {
    // A copy of scheduler.db taken by hand is a database and is not this:
    // it has no manifest, so nothing knows which key it needs.
    const dir = freshDir()
    const { app, server } = await install(dir)
    const raw = readFileSync(app.paths.databaseFile)
    const refused = await server.inject({
      method: 'POST',
      url: '/api/restore/inspect',
      headers: { 'content-type': 'application/octet-stream' },
      payload: raw,
    })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/manifest/i)
  })

  it('can be changed its mind about before the restart', async () => {
    const source = freshDir()
    const { server: from } = await install(source)
    await populate(from)
    const backup = (await from.inject({ method: 'GET', url: '/api/backup' })).rawPayload

    const target = freshDir()
    const { server: to } = await install(target)
    const inspected = json(
      await to.inject({
        method: 'POST',
        url: '/api/restore/inspect',
        headers: { 'content-type': 'application/octet-stream' },
        payload: backup,
      }),
    )
    await to.inject({
      method: 'POST',
      url: '/api/restore',
      headers: { 'content-type': 'application/octet-stream', 'x-confirm': inspected.confirm },
      payload: backup,
    })
    expect(json(await to.inject({ method: 'GET', url: '/api/restore' })).staged).toBe(true)

    await to.inject({ method: 'DELETE', url: '/api/restore' })
    await to.close()
    servers.shift()

    const { app: after, server: reopened } = await install(target)
    expect(after.restored).toBeUndefined()
    expect(json(await reopened.inject({ method: 'GET', url: '/api/series' }))).toHaveLength(0)
  })
})
