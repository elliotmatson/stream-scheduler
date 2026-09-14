import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { PendingAuthorization } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import { assertUnreferenced, ConflictError, NotFoundError } from './errors.js'

/**
 * Bring-your-own OAuth: each install supplies its own Google Cloud client.
 *
 * No client secret is embedded in a distributed binary, nothing is blocked on
 * Google's verification review, and each install gets its own daily API
 * budget instead of sharing one. The cost is a setup walkthrough, which is
 * what `/api/oauth/:provider/instructions` is for.
 */

interface Pending extends PendingAuthorization {
  provider: string
  clientRef: string
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60_000

export function registerOAuthRoutes(fastify: FastifyInstance, app: Application): void {
  // Held in memory on purpose: an authorization someone abandoned should not
  // survive a restart, and it is worthless after ten minutes anyway.
  const pending = new Map<string, Pending>()

  const sweep = (): void => {
    const cutoff = app.clock.now() - PENDING_TTL_MS
    for (const [state, entry] of pending) if (entry.createdAt < cutoff) pending.delete(state)
  }

  fastify.get('/api/destination-providers', async () =>
    app.destinations.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      configSchema: provider.configSchema,
      providesIngest: provider.providesIngest,
      supportsOAuth: provider.oauth !== undefined,
    })),
  )

  fastify.get('/api/oauth/:provider/instructions', async (request) => {
    const { provider } = z.object({ provider: z.string() }).parse(request.params)
    app.destinations.get(provider)
    return instructionsFor(provider, redirectUriFor(request))
  })

  fastify.get('/api/oauth/clients', async () =>
    (
      app.db.prepare('SELECT id, provider, label, client_id FROM oauth_client ORDER BY label').all() as {
        id: string
        provider: string
        label: string
        client_id: string
      }[]
    ).map((row) => ({ id: row.id, provider: row.provider, label: row.label, clientId: row.client_id })),
  )

  fastify.post('/api/oauth/clients', async (request, reply) => {
    const body = z
      .object({
        provider: z.string().min(1),
        label: z.string().min(1),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
      })
      .parse(request.body)
    app.destinations.get(body.provider)

    const id = randomUUID()
    app.db
      .prepare(
        'INSERT INTO oauth_client (id, provider, label, client_id, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, body.provider, body.label, body.clientId, app.vault.store(body.clientSecret), app.clock.now())
    return reply.code(201).send({ id })
  })

  fastify.post('/api/oauth/:provider/start', async (request) => {
    const { provider: providerId } = z.object({ provider: z.string() }).parse(request.params)
    const { clientRef } = z.object({ clientRef: z.string().min(1) }).parse(request.body)

    const provider = app.destinations.get(providerId)
    if (!provider.oauth) throw new Error(`${provider.displayName} does not connect through OAuth.`)

    const client = app.db.prepare('SELECT client_id FROM oauth_client WHERE id = ?').get(clientRef) as
      | { client_id: string }
      | undefined
    if (!client) throw new Error(`No OAuth client with id "${clientRef}".`)

    sweep()
    const redirectUri = redirectUriFor(request)
    const authorization = provider.oauth.begin({ clientId: client.client_id }, redirectUri)
    pending.set(authorization.state, {
      ...authorization,
      provider: providerId,
      clientRef,
      createdAt: app.clock.now(),
    })

    return { url: authorization.url, state: authorization.state, redirectUri }
  })

  /**
   * Google redirects the browser here.
   *
   * Answers HTML rather than JSON because a person is looking at it, and
   * because the useful next instruction ("close this tab") is not something
   * a JSON body conveys.
   */
  fastify.get('/oauth/callback', async (request, reply) => {
    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(request.query)

    if (query.error) return reply.type('text/html').send(page('Authorization cancelled', query.error))
    if (!query.code || !query.state) {
      return reply.type('text/html').send(page('Something went wrong', 'Google did not return a code.'))
    }

    const entry = pending.get(query.state)
    if (!entry) {
      // Also what a forged callback looks like, which is the point of state.
      return reply
        .type('text/html')
        .send(page('This link has expired', 'Start connecting the account again from the app.'))
    }
    pending.delete(query.state)

    try {
      const provider = app.destinations.get(entry.provider)
      const secret = app.db.prepare('SELECT client_id, secret_ref FROM oauth_client WHERE id = ?').get(
        entry.clientRef,
      ) as { client_id: string; secret_ref: string }

      const account = await provider.oauth!.complete(
        { clientId: secret.client_id, clientSecret: app.vault.reveal(secret.secret_ref) },
        entry,
        query.code,
      )

      // Reconnecting the same channel replaces its tokens rather than piling
      // up duplicate accounts.
      const existing = app.db
        .prepare('SELECT id, secret_ref FROM account WHERE provider = ? AND external_id = ?')
        .get(entry.provider, account.externalId) as { id: string; secret_ref: string } | undefined

      if (existing) {
        app.vault.store(account.refreshToken, existing.secret_ref)
        app.db
          .prepare("UPDATE account SET display_name = ?, oauth_client_ref = ?, scopes = ?, status = 'ok' WHERE id = ?")
          .run(account.displayName, entry.clientRef, account.scopes.join(' '), existing.id)
      } else {
        app.db
          .prepare(
            `INSERT INTO account (id, provider, external_id, display_name, secret_ref, oauth_client_ref, scopes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            entry.provider,
            account.externalId,
            account.displayName,
            app.vault.store(account.refreshToken),
            entry.clientRef,
            account.scopes.join(' '),
            app.clock.now(),
          )
      }

      app.logger.info('connected an account', { provider: entry.provider, displayName: account.displayName })
      return reply
        .type('text/html')
        .send(page(`Connected ${account.displayName}`, 'You can close this tab and go back to the app.'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      app.logger.error('could not complete the authorization', { error: message })
      return reply.type('text/html').send(page('Could not connect the account', message))
    }
  })

  fastify.get('/api/accounts', async () =>
    (
      app.db
        .prepare('SELECT id, provider, external_id, display_name, status, scopes FROM account ORDER BY display_name')
        .all() as {
        id: string
        provider: string
        external_id: string
        display_name: string
        status: string
        scopes: string
      }[]
    ).map((row) => ({
      id: row.id,
      provider: row.provider,
      externalId: row.external_id,
      displayName: row.display_name,
      status: row.status,
      scopes: row.scopes.split(' '),
    })),
  )

  fastify.get('/api/destinations', async () =>
    (
      app.db.prepare('SELECT id, plugin_id, label, account_id, config FROM destination ORDER BY label').all() as {
        id: string
        plugin_id: string
        label: string
        account_id: string | null
        config: string
      }[]
    ).map((row) => ({
      id: row.id,
      providerId: row.plugin_id,
      label: row.label,
      accountId: row.account_id,
      config: JSON.parse(row.config) as Record<string, unknown>,
    })),
  )

  /**
   * What a channel has to file finished videos in.
   *
   * Asked of the account rather than a saved destination, because the form
   * that needs it is the one creating the destination. A dropdown of the
   * names somebody recognises beats a box wanting a `PL…` id copied out of
   * a URL.
   */
  fastify.get('/api/destination-providers/:provider/playlists', async (request) => {
    const { provider: providerId } = z.object({ provider: z.string() }).parse(request.params)
    const { accountRef } = z.object({ accountRef: z.string().min(1) }).parse(request.query)

    const instance = await app.destinations.openForAccount(providerId, accountRef)
    if (!instance.listPlaylists) {
      throw new ConflictError(`${app.destinations.get(providerId).displayName} has no playlists.`)
    }
    return { playlists: await instance.listPlaylists() }
  })

  fastify.post('/api/destinations', async (request, reply) => {
    const body = z
      .object({
        providerId: z.string().min(1),
        label: z.string().min(1),
        accountId: z.string().min(1),
        config: z.record(z.unknown()).default({}),
      })
      .parse(request.body)

    app.destinations.assertValidConfig(body.providerId, {
      ...(body.config as Record<string, never>),
      accountRef: body.accountId,
    })

    const id = randomUUID()
    app.db
      .prepare(
        'INSERT INTO destination (id, plugin_id, label, account_id, config, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, body.providerId, body.label, body.accountId, JSON.stringify(body.config), app.clock.now())
    return reply.code(201).send({ id })
  })

  fastify.delete('/api/destinations/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    assertUnreferenced(app.db, 'destination_id', id, 'streaming service')
    app.db.prepare('DELETE FROM destination WHERE id = ?').run(id)
    return { ok: true }
  })

  fastify.delete('/api/accounts/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const users = app.db.prepare('SELECT label FROM destination WHERE account_id = ?').all(id) as { label: string }[]
    if (users.length > 0) {
      throw new ConflictError(
        `This account still backs ${users.map((row) => `"${row.label}"`).join(', ')}. Remove those first.`,
      )
    }
    // The refresh token goes with it: a disconnected account that leaves a
    // live token in the vault is a credential nobody knows they still hold.
    const row = app.db.prepare('SELECT secret_ref FROM account WHERE id = ?').get(id) as
      | { secret_ref: string }
      | undefined
    if (!row) throw new NotFoundError(`No account with id "${id}".`)
    app.vault.delete(row.secret_ref)
    app.db.prepare('DELETE FROM account WHERE id = ?').run(id)
    return { ok: true }
  })

  fastify.get('/api/destinations/:id/status', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const destination = await app.destinations.open(id)
    try {
      return await destination.status()
    } finally {
      await destination.dispose()
    }
  })
}

/**
 * Where Google should send the browser back to.
 *
 * It has to be *exactly* what is registered on the OAuth client, character
 * for character, or the consent screen refuses with `redirect_uri_mismatch`
 * — so this is worth getting right rather than assuming.
 *
 * It comes off the request, so it is whatever a browser actually used:
 * `X-Forwarded-Proto` and `X-Forwarded-Host` first, because an app reached
 * over HTTPS through Tailscale Serve or any reverse proxy sees a plain HTTP
 * request to an internal name, and would otherwise advertise an `http://`
 * callback that Google will not even let you register. Failing those, the
 * request's own `Host`, which is right for reaching it directly on the LAN
 * or on loopback.
 *
 * The out-of-band copy-paste flow is deprecated and is not used.
 */
function redirectUriFor(request: FastifyRequest): string {
  // A proxy may send a list; the first entry is the original client's.
  const forwardedProto = header(request, 'x-forwarded-proto')?.split(',')[0]?.trim()
  const scheme = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http'
  const host = header(request, 'x-forwarded-host')?.split(',')[0]?.trim() || request.headers.host
  return `${scheme}://${host ?? '127.0.0.1:8500'}/oauth/callback`
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Google allows a plain-HTTP callback only on loopback. */
function isLoopbackUri(uri: string): boolean {
  try {
    const { hostname } = new URL(uri)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function instructionsFor(
  provider: string,
  redirectUri: string,
): { steps: string[]; redirectUri: string; warning: string; warnings: string[] } {
  if (provider !== 'youtube') {
    return { steps: [], redirectUri, warning: '', warnings: [] }
  }
  // http:// is registerable only for localhost, so an app reached at a LAN
  // or Tailscale address has to be on HTTPS before Google will take its
  // callback at all.
  const unregisterable = redirectUri.startsWith('http://') && !isLoopbackUri(redirectUri)

  const warnings = [
    // The one that stops the flow before it starts. Google's own message
    // says nothing about which URI it expected.
    'Paste the redirect URI exactly as shown — scheme, host, port and path. Anything else and Google ' +
      'refuses with "Error 400: redirect_uri_mismatch".',
    ...(unregisterable
      ? [
          `You are reaching this app at ${new URL(redirectUri).origin}, and Google will not accept a plain ` +
            'http:// redirect for anything but localhost. Reach the app over HTTPS — Tailscale Serve or any ' +
            'reverse proxy in front of it — or set the client up while reaching this page on 127.0.0.1.',
        ]
      : []),
    // The single most likely support burden in the whole project, and it is
    // invisible for a week after setup.
    'Do not leave the consent screen on "Testing". Google expires refresh tokens after 7 days in that ' +
      'state, so every scheduled stream will work for a week and then start failing.',
    // The second one, which bites at connect time rather than a week later.
    'Set the user type to "External", even for one organisation. A YouTube channel that lives in a Brand ' +
      'Account is not a member of your Google Workspace, so an "Internal" client refuses it with ' +
      '"Error 403: org_internal" — your own channel connects, the church\'s brand channel cannot.',
  ]
  return {
    redirectUri,
    steps: [
      'Open console.cloud.google.com and create a project (or pick an existing one).',
      'Under APIs & Services > Library, enable the "YouTube Data API v3".',
      'Under APIs & Services > OAuth consent screen, set the user type to "External".',
      'On the same screen, set the publishing status to "In production".',
      'Under APIs & Services > Credentials, create an OAuth client ID of type "Web application".',
      `Add exactly this authorized redirect URI: ${redirectUri}`,
      'Copy the client ID and client secret back into this app.',
    ],
    // Kept for older clients; `warnings` is the one to render.
    warning: warnings[0]!,
    warnings,
  }
}

function page(heading: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;
background:#f7f7f8;color:#1a1a1f}main{max-width:34rem;padding:2rem;text-align:center}
@media(prefers-color-scheme:dark){body{background:#16161a;color:#ececf1}}</style>
<main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></main>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
