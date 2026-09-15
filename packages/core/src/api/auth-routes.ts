import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Application } from '../app.js'
import { MIN_PASSWORD_LENGTH } from '../auth/index.js'
import { originOf } from './origin.js'

/**
 * Signing in, and the gate everything else sits behind.
 *
 * A cookie rather than a header, because the thing that broke last time was
 * a bearer check: no browser sends `Authorization` on a WebSocket upgrade
 * or on an image, so a header-only scheme locks the UI out of its own live
 * status. A cookie is sent on both. The header is still accepted, for
 * scripts and curl.
 */

export const SESSION_COOKIE = 'scheduler_session'

/** What stays reachable with no session, and why. */
function isOpen(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? ''

  // Container health checks. Exempt before this was written, and the only
  // route that was — which is how a broken lock once passed CI.
  if (path === '/healthz') return true

  // Signing in, and asking whether you need to.
  if (path === '/api/login' || path === '/api/session') return true

  // The OAuth callback carries a `state` this app issued and stored, which
  // is what makes it safe: a forged one is refused there. Leaving it open
  // also means a session that lapsed while the operator was at Google
  // costs them a re-try rather than the authorization code.
  if (path === '/oauth/callback') return true

  // Everything else outside the API is the single-page app and its assets.
  // They are public client code, and the login form is part of the bundle:
  // gating them would leave nothing to log in with.
  return path !== '/ws' && !path.startsWith('/api/')
}

export function registerAuthGate(fastify: FastifyInstance, app: Application): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!app.auth.required) return
    if (isOpen(request)) return
    if (app.auth.allows(tokenFrom(request))) return

    // The upgrade is refused at the HTTP stage, before any socket exists.
    await reply.code(401).send({ error: 'Sign in to use this.' })
  })
}

export function registerAuthRoutes(fastify: FastifyInstance, app: Application): void {
  /**
   * What the UI needs before it can decide what to show: whether there is a
   * lock at all, and whether this browser is past it.
   */
  fastify.get('/api/session', async (request) => ({
    required: app.auth.required,
    signedIn: app.auth.allows(tokenFrom(request)),
    seededFromEnvironment: app.auth.seededFromEnvironment,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  }))

  fastify.post('/api/login', async (request, reply) => {
    const body = z.object({ password: z.string() }).parse(request.body)
    const result = app.auth.login({
      password: body.password,
      from: request.ip,
      ...(request.headers['user-agent'] === undefined
        ? {}
        : { userAgent: request.headers['user-agent'] }),
    })

    if (!result.ok) {
      if (result.reason === 'too-many-attempts') {
        const seconds = Math.ceil(result.retryAfterMs / 1000)
        return reply
          .code(429)
          .header('retry-after', String(seconds))
          .send({ error: `Too many attempts. Try again in ${seconds}s.` })
      }
      if (result.reason === 'no-password') {
        return reply.code(400).send({ error: 'No password is set on this install.' })
      }
      // Deliberately the same message and the same shape for every wrong
      // password: nothing here should help somebody work out how close
      // they got.
      return reply.code(401).send({ error: 'That password is not right.' })
    }

    setSessionCookie(request, reply, result.token, result.expiresAt)
    // Also returned in the body, for a script that would rather hold a
    // token than a cookie jar.
    return { token: result.token, expiresAt: result.expiresAt }
  })

  fastify.post('/api/logout', async (request, reply) => {
    const token = tokenFrom(request)
    if (token) app.auth.sessions.revoke(token)
    void reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  /**
   * Sets, changes or removes the password.
   *
   * Gated by the hook once a password exists, so this only has to handle
   * the first-run case: on an install with no password, whoever can reach
   * the port can claim it. That is the same trust as the app itself, which
   * at that point has no lock on it at all.
   */
  fastify.post('/api/password', async (request, reply) => {
    // The length rule lives on `Auth` as well, for anything calling it
    // directly — but stating it here is what turns a short password into a
    // 400 with a field name rather than a 500.
    const body = z
      .object({
        password: z
          .string()
          .min(MIN_PASSWORD_LENGTH, `A password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
          .nullable(),
      })
      .parse(request.body)

    if (body.password === null) {
      app.auth.clearPassword()
      void reply.clearCookie(SESSION_COOKIE, { path: '/' })
      app.logger.warn('the UI password was removed')
      return { required: false, signedIn: true }
    }

    app.auth.setPassword(body.password)
    // Setting a password signs everybody out, including whoever set it —
    // so they get a fresh session rather than being bounced to the login
    // form they just came from.
    const session = app.auth.sessions.mint(
      request.headers['user-agent'] === undefined
        ? {}
        : { userAgent: request.headers['user-agent'] },
    )
    setSessionCookie(request, reply, session.token, session.expiresAt)
    app.logger.info('the UI password was changed')
    return { required: true, signedIn: true, token: session.token }
  })
}

/** The cookie a browser will actually send back. */
function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: number,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    // Lax, not Strict. Strict withholds the cookie on a cross-site top-level
    // navigation — which is exactly what Google's redirect back to
    // /oauth/callback is, so Strict would break connecting a YouTube
    // account. Lax still withholds it on cross-site POSTs and subresource
    // loads, which is the CSRF protection that matters here.
    sameSite: 'lax',
    // Only where the request arrived over https, honouring a proxy's
    // X-Forwarded-Proto: a Secure cookie on a plain-HTTP LAN install is
    // one the browser silently drops.
    secure: originOf(request).startsWith('https:'),
    expires: new Date(expiresAt),
  })
}

function tokenFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || undefined
  const cookie = (request.cookies as Record<string, string | undefined> | undefined)?.[
    SESSION_COOKIE
  ]
  return cookie || undefined
}
