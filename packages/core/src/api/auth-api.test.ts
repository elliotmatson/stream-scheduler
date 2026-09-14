import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { silentLogger } from '../log.js'
import { createServer } from './server.js'
import { SESSION_COOKIE } from './auth-routes.js'

/**
 * The gate, from the outside.
 *
 * The bug this replaced was not in the checking — it was that nothing ever
 * asked for a page. So these tests drive `/`, `/ws` and the API, not just
 * the one route that used to be exempt.
 */

const PASSWORD = 'sunday service 9am'

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

async function boot(options: { uiPassword?: string } = {}): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-auth-api-'))
  clock = new ManualClock(Date.parse('2026-03-08T14:00:00Z'))
  app = Application.create({
    configDir: dir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
    ...(options.uiPassword === undefined ? {} : { uiPassword: options.uiPassword }),
  })
  server = await createServer({ app })
}

afterEach(async () => {
  await server.close()
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
})

const get = (url: string, headers: Record<string, string> = {}) =>
  server.inject({ method: 'GET', url, headers })
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url, payload: payload as object, headers })

/** The upgrade is an ordinary GET until it is accepted, so it can be injected. */
const upgrade = (headers: Record<string, string> = {}) =>
  server.inject({
    method: 'GET',
    url: '/ws',
    headers: {
      connection: 'upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...headers,
    },
  })

async function signIn(): Promise<{ cookie: string; token: string }> {
  const response = await post('/api/login', { password: PASSWORD })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)
  if (!cookie) throw new Error('no session cookie was set')
  return { cookie: `${cookie.name}=${cookie.value}`, token: JSON.parse(response.body).token }
}

describe('with no password set', () => {
  beforeEach(() => boot())

  it('serves the whole app to anyone, which is the single-booth case', async () => {
    expect((await get('/healthz')).statusCode).toBe(200)
    expect((await get('/api/devices')).statusCode).toBe(200)
    expect((await get('/api/series')).statusCode).toBe(200)
    // No webRoot in these tests, so there is no page to serve — but the
    // gate must not be what answers.
    expect((await get('/')).statusCode).not.toBe(401)
  })

  it('says so, so the UI can offer to set one', async () => {
    expect(JSON.parse((await get('/api/session')).body)).toMatchObject({
      required: false,
      signedIn: true,
      managedByEnvironment: false,
    })
  })

  it('lets the live socket through', async () => {
    expect((await upgrade()).statusCode).not.toBe(401)
  })

  it('takes a first password from whoever can reach it', async () => {
    const set = await post('/api/password', { password: PASSWORD })
    expect(set.statusCode).toBe(200)
    expect(app.auth.required).toBe(true)

    // Whoever set it is signed in on the way out, rather than being sent
    // to a login form for the password they just chose.
    expect(set.cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')).toBe(true)
  })

  it('refuses a password too short to be worth having', async () => {
    const set = await post('/api/password', { password: 'short' })
    expect(set.statusCode).toBe(400)
    expect(app.auth.required).toBe(false)
  })
})

describe('with a password set', () => {
  beforeEach(async () => {
    await boot()
    app.auth.setPassword(PASSWORD)
  })

  it('refuses the API, the socket and nothing else', async () => {
    expect((await get('/api/devices')).statusCode).toBe(401)
    expect((await upgrade()).statusCode).toBe(401)

    // A health check has no way to log in, and a container restarting in a
    // loop because of that would be worse than the exposure.
    expect((await get('/healthz')).statusCode).toBe(200)

    // The page and its assets stay open: the login form is part of that
    // bundle, so gating them would leave nothing to log in with.
    expect((await get('/')).statusCode).not.toBe(401)
    expect((await get('/api/session')).statusCode).toBe(200)
  })

  it('lets a browser in with the cookie it was given', async () => {
    const { cookie } = await signIn()
    expect((await get('/api/devices', { cookie })).statusCode).toBe(200)
    expect((await upgrade({ cookie })).statusCode).not.toBe(401)
  })

  it('lets a script in with the bearer token, so automation needs no browser', async () => {
    const { token } = await signIn()
    expect((await get('/api/devices', { authorization: `Bearer ${token}` })).statusCode).toBe(200)
  })

  it('refuses a token it never issued', async () => {
    expect((await get('/api/devices', { cookie: `${SESSION_COOKIE}=made-up` })).statusCode).toBe(
      401,
    )
    expect((await get('/api/devices', { authorization: 'Bearer made-up' })).statusCode).toBe(401)
    // The shape the old, broken check expected. It is not a session.
    expect((await get('/api/devices', { authorization: `Bearer ${PASSWORD}` })).statusCode).toBe(
      401,
    )
  })

  it('reports who is asking', async () => {
    const { cookie } = await signIn()
    expect(JSON.parse((await get('/api/session')).body)).toMatchObject({
      required: true,
      signedIn: false,
    })
    expect(JSON.parse((await get('/api/session', { cookie })).body)).toMatchObject({
      required: true,
      signedIn: true,
    })
  })

  it('ends the session on sign-out', async () => {
    const { cookie } = await signIn()
    expect((await post('/api/logout', {}, { cookie })).statusCode).toBe(200)
    expect((await get('/api/devices', { cookie })).statusCode).toBe(401)
  })

  it('says the same thing however wrong the password is', async () => {
    const near = await post('/api/login', { password: 'sunday service 9a' })
    const far = await post('/api/login', { password: 'x' })
    expect(near.statusCode).toBe(401)
    expect(far.statusCode).toBe(401)
    expect(near.body).toBe(far.body)
  })

  it('slows down a guesser, and says for how long', async () => {
    for (let i = 0; i < 4; i++) await post('/api/login', { password: 'wrong' })
    const blocked = await post('/api/login', { password: PASSWORD })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBeDefined()
  })

  it('signs everybody out when the password changes', async () => {
    const { cookie } = await signIn()
    const changed = await post('/api/password', { password: 'a different one' }, { cookie })
    expect(changed.statusCode).toBe(200)

    // The old cookie is dead; the one that came back works.
    expect((await get('/api/devices', { cookie })).statusCode).toBe(401)
    const fresh = changed.cookies.find((c) => c.name === SESSION_COOKIE)
    expect(
      (await get('/api/devices', { cookie: `${SESSION_COOKIE}=${fresh?.value ?? ''}` })).statusCode,
    ).toBe(200)
  })

  it('opens back up when the password is removed', async () => {
    const { cookie } = await signIn()
    expect((await post('/api/password', { password: null }, { cookie })).statusCode).toBe(200)
    expect((await get('/api/devices')).statusCode).toBe(200)
  })

  it('sets a cookie a browser will send back on the OAuth redirect', async () => {
    const response = await post('/api/login', { password: PASSWORD })
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)
    expect(cookie).toMatchObject({ httpOnly: true, path: '/' })
    // Lax, never Strict: Google's redirect back to /oauth/callback is a
    // cross-site top-level navigation, and Strict would withhold the cookie
    // — which is how connecting a YouTube account would break.
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
    // Plain HTTP on a LAN is the normal install. A Secure cookie there is
    // one the browser drops on the floor.
    expect(cookie?.secure).toBeFalsy()
  })

  it('marks the cookie Secure behind an https proxy', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD },
      headers: { 'x-forwarded-proto': 'https', host: 'scheduler.example.org' },
    })
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true)
  })

  it('keeps the OAuth callback reachable, so a lapsed session costs a retry not the code', async () => {
    expect((await get('/oauth/callback?state=nonsense&code=nonsense')).statusCode).not.toBe(401)
  })
})

describe('with the password set by the environment', () => {
  beforeEach(() => boot({ uiPassword: 'from-the-environment' }))

  it('locks the app without anybody opening a screen, which is what Docker needs', async () => {
    expect((await get('/api/devices')).statusCode).toBe(401)
    const signedIn = await post('/api/login', { password: 'from-the-environment' })
    expect(signedIn.statusCode).toBe(200)
  })

  it('will not be changed from the UI, because the environment would win back', async () => {
    const cookie = (await post('/api/login', { password: 'from-the-environment' })).cookies.find(
      (c) => c.name === SESSION_COOKIE,
    )
    const changed = await post(
      '/api/password',
      { password: 'something else' },
      { cookie: `${SESSION_COOKIE}=${cookie?.value ?? ''}` },
    )
    expect(changed.statusCode).toBe(409)
    expect(JSON.parse(changed.body).error).toMatch(/SCHEDULER_UI_PASSWORD/)
  })

  it('says it is managed, so the UI does not offer a control that cannot work', async () => {
    expect(JSON.parse((await get('/api/session')).body)).toMatchObject({
      required: true,
      managedByEnvironment: true,
    })
  })
})
