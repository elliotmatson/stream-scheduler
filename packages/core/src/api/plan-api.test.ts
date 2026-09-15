import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanSource, PlanSourceStatus } from '@scheduler/plugin-sdk'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from './server.js'
import { silentLogger } from '../log.js'

/**
 * Connecting a schedule source.
 *
 * The behaviour worth pinning here is not the happy path — it is that the
 * secret goes in and never comes back out, and that "no token yet" and "the
 * token is wrong" stay distinguishable. Those are the two things a UI needs
 * to be truthful about, and the two a refactor could quietly break.
 */

let dir: string
let app: Application
let server: FastifyInstance
/** What the fake source is told to answer with. */
let credentialsSeen: { applicationId: string; secret: string } | undefined

/** A plan source that reports whatever the stored credentials are, so the
 *  tests can watch the registry's half of the contract rather than an API. */
function fakeSource(
  resolve: () => Promise<{ applicationId: string; secret: string } | undefined>,
): PlanSource {
  return {
    id: 'planning-center',
    displayName: 'Planning Center',
    apiVersion: '1',
    async isConfigured() {
      return (await resolve()) !== undefined
    },
    async check(): Promise<PlanSourceStatus> {
      const credentials = await resolve()
      credentialsSeen = credentials
      if (!credentials) return { state: 'not_configured' }
      if (credentials.secret !== 'right') {
        return { state: 'credentials_rejected', message: 'Make a new token.' }
      }
      return { state: 'ok', message: '2 service types visible.' }
    },
    async listGroups() {
      const credentials = await resolve()
      if (!credentials) throw new Error('No Planning Center token is saved.')
      return [{ id: '1024', name: 'Sunday Morning' }]
    },
    async listServices() {
      return [
        {
          externalId: 'time-1',
          startsAt: Date.parse('2026-09-20T14:00:00Z'),
          detail: { timeName: '9:00 Service' },
        },
      ]
    },
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-plans-'))
  credentialsSeen = undefined
  app = Application.create({ configDir: dir, logger: silentLogger })
  app.planSources.register(fakeSource(async () => app.planSources.credentials('planning-center')))
  server = await createServer({ app })
})

afterEach(async () => {
  await server.close()
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
})

const get = (url: string) => server.inject({ method: 'GET', url })
const put = (url: string, body: unknown) =>
  server.inject({ method: 'PUT', url, payload: body as object })
const del = (url: string) => server.inject({ method: 'DELETE', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

const save = (secret: string) =>
  put('/api/plan-sources/planning-center/credentials', { applicationId: 'app-id', secret })

describe('connecting a source', () => {
  it('reports it as not set up before a token is saved', async () => {
    const body = json(await get('/api/plan-sources'))
    expect(body.sources).toEqual([
      {
        id: 'planning-center',
        displayName: 'Planning Center',
        status: { state: 'not_configured' },
      },
    ])
  })

  it('checks a token as it is saved, rather than saving and hoping', async () => {
    // Worth knowing now, while the person who made the token is still
    // looking at the screen, not next Sunday.
    const body = json(await save('right'))
    expect(body.status.state).toBe('ok')
    expect(body.status.message).toContain('2 service types')
  })

  it('keeps a rejected token distinct from no token at all', async () => {
    const body = json(await save('wrong'))
    expect(body.status.state).toBe('credentials_rejected')

    const listed = json(await get('/api/plan-sources'))
    expect(listed.sources[0].status.state).toBe('credentials_rejected')
  })

  it('never hands the secret back', async () => {
    await save('right')
    // Every route that could plausibly leak it.
    const listed = await get('/api/plan-sources')
    const saved = await save('right')
    expect(listed.body).not.toContain('right')
    expect(saved.body).not.toContain('right')
  })

  it('stores the secret encrypted rather than in the settings table', async () => {
    await save('right')
    const rows = app.db.prepare('SELECT key, value FROM setting').all() as {
      key: string
      value: string
    }[]
    expect(rows.some((row) => row.value.includes('right'))).toBe(false)
    // And it is genuinely readable back through the vault.
    expect(app.planSources.credentials('planning-center')?.secret).toBe('right')
  })

  it('refuses half a credential', async () => {
    const response = await put('/api/plan-sources/planning-center/credentials', {
      applicationId: 'app-id',
      secret: '   ',
    })
    expect(response.statusCode).toBe(400)
    expect(app.planSources.credentials('planning-center')).toBeUndefined()
  })

  it('replaces a token rather than accumulating dead secrets', async () => {
    await save('right')
    await save('newer')
    expect(app.planSources.credentials('planning-center')?.secret).toBe('newer')
    const secrets = app.db.prepare('SELECT COUNT(*) AS n FROM secret').get() as { n: number }
    expect(secrets.n).toBe(1)
  })

  it('forgets a token completely when it is removed', async () => {
    await save('right')
    await del('/api/plan-sources/planning-center/credentials')

    expect(app.planSources.credentials('planning-center')).toBeUndefined()
    const secrets = app.db.prepare('SELECT COUNT(*) AS n FROM secret').get() as { n: number }
    expect(secrets.n).toBe(0)
    expect(json(await get('/api/plan-sources')).sources[0].status.state).toBe('not_configured')
  })

  it('treats an application id with no secret as not set up', async () => {
    // The state a half-finished save or a restored backup can leave behind.
    // Reporting it as "rejected" would send somebody to fix the wrong thing.
    app.db
      .prepare('INSERT INTO setting (key, value) VALUES (?, ?)')
      .run('plan_source.planning-center.app_id', 'app-id')
    expect(app.planSources.credentials('planning-center')).toBeUndefined()
    expect(json(await get('/api/plan-sources')).sources[0].status.state).toBe('not_configured')
  })
})

describe('reading what a source offers', () => {
  it('lists the groups to pair a series with', async () => {
    await save('right')
    const body = json(await get('/api/plan-sources/planning-center/groups'))
    expect(body.groups).toEqual([{ id: '1024', name: 'Sunday Morning' }])
  })

  it('hands the source the stored credentials, not ones passed in', async () => {
    await save('right')
    await get('/api/plan-sources')
    expect(credentialsSeen).toEqual({ applicationId: 'app-id', secret: 'right' })
  })

  it('shows what is actually scheduled, so pairing is not a guess', async () => {
    await save('right')
    const body = json(await get('/api/plan-sources/planning-center/groups/1024/services'))
    expect(body.services[0].detail.timeName).toBe('9:00 Service')
  })

  it('says a source it does not know is unknown', async () => {
    const response = await get('/api/plan-sources/nope/groups')
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('offers setup steps that name where the token is made', async () => {
    const body = json(await get('/api/plan-sources/planning-center/instructions'))
    expect(body.steps.join(' ')).toContain('personal_access_tokens')
    // The trap that looks fine for months: the token dies with its user.
    expect(body.warnings.join(' ')).toContain('deactivated')
  })
})
