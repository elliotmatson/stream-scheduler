import type { Fetch } from './api.js'

/**
 * Twitch at the HTTP round trip, not at the API client.
 *
 * The seam matters more than the fake does. Replacing `TwitchApi` would
 * leave the token refresh, the rotated refresh token, the `client-id`
 * header and the ingest template all untested — and those are exactly the
 * parts that fail in the field, because they only run after the first hour
 * or only on somebody else's channel. Faking the fetch means every one of
 * them is the adapter's real code under test.
 */
export class FakeTwitch {
  /** What the channel currently says it is showing. */
  channel = { title: 'Whatever was on last week', game_id: '', broadcaster_language: 'en' }
  streamKey = 'live_1234_abcdef'
  /** Category names Twitch knows about, by lower-cased name. */
  games = new Map<string, string>([['talk shows & podcasts', '417752']])
  user = { id: '149747285', login: 'gracebible', display_name: 'GraceBible' }

  /** Every refresh token this fake has handed out, oldest first. Twitch
   *  rotates, so only the last one is valid. */
  readonly issuedRefreshTokens = ['rt-1']
  /** Whether each refresh returns a new refresh token. Twitch's own
   *  behaviour is "sometimes", which is why both are worth testing. */
  rotatesRefreshTokens = true
  /** Set to fail the next Helix call with this status. */
  failNext: { status: number; body: string } | undefined

  readonly calls: { method: string; url: string; body?: string }[] = []
  private accessTokens = 0
  private ingestServers: unknown = {
    ingests: [
      {
        _id: 1,
        availability: 1,
        default: false,
        name: 'Frankfurt, Germany',
        url_template: 'rtmp://fra.contribute.live-video.net/app/{stream_key}',
      },
      {
        _id: 2,
        availability: 0.6,
        default: true,
        name: 'Chicago, IL',
        url_template: 'rtmp://chi.contribute.live-video.net/app/{stream_key}',
      },
    ],
  }

  setIngests(value: unknown): void {
    this.ingestServers = value
  }

  /** The current, valid refresh token. */
  get refreshToken(): string {
    return this.issuedRefreshTokens[this.issuedRefreshTokens.length - 1]!
  }

  readonly fetch: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    this.calls.push({ method, url, ...(init?.body === undefined ? {} : { body: init.body }) })

    if (url === 'https://id.twitch.tv/oauth2/token') return this.token(init?.body ?? '')
    if (url === 'https://ingest.twitch.tv/ingests') {
      return ok(JSON.stringify(this.ingestServers))
    }

    const headers = init?.headers ?? {}
    // Twitch rejects a Helix call with no client-id even when the bearer is
    // perfectly good, and the message it gives back says nothing useful. A
    // fake that ignores the header would let that ship.
    if (!headers['client-id']) return json(401, { message: 'Missing client id' })
    const bearer = headers['authorization']
    if (!bearer?.startsWith('Bearer at-')) return json(401, { message: 'Invalid OAuth token' })

    if (this.failNext) {
      const { status, body } = this.failNext
      this.failNext = undefined
      return { ok: false, status, text: async () => body }
    }

    return this.helix(method, url, init?.body)
  }

  private token(body: string): ReturnType<Fetch> {
    const form = new URLSearchParams(body)
    if (form.get('client_secret') !== 'client-secret') {
      return json(403, { message: 'invalid client secret' })
    }

    if (form.get('grant_type') === 'authorization_code') {
      return json(200, {
        access_token: this.nextAccess(),
        expires_in: 14_000,
        refresh_token: 'rt-1',
      })
    }

    // A refresh token Twitch has already rotated past is dead, which is the
    // whole reason the new one has to be written back.
    if (form.get('refresh_token') !== this.refreshToken) {
      return json(400, { message: 'Invalid refresh token', status: 400 })
    }
    if (this.rotatesRefreshTokens) {
      this.issuedRefreshTokens.push(`rt-${this.issuedRefreshTokens.length + 1}`)
    }
    return json(200, {
      access_token: this.nextAccess(),
      expires_in: 14_000,
      refresh_token: this.refreshToken,
    })
  }

  private helix(method: string, url: string, body: string | undefined): ReturnType<Fetch> {
    const parsed = new URL(url)
    const path = parsed.pathname.replace('/helix', '')

    if (path === '/users') return json(200, { data: [this.user] })

    if (path === '/channels' && method === 'PATCH') {
      const changes = JSON.parse(body ?? '{}') as Record<string, string>
      if (parsed.searchParams.get('broadcaster_id') !== this.user.id) {
        return json(401, { message: 'The ID in broadcaster_id must match the user in the token' })
      }
      // Twitch's real limit, enforced here so a too-long title is a test
      // failure rather than something discovered on a Sunday morning.
      if (changes.title !== undefined && changes.title.length > 140) {
        return json(400, { message: 'The title must not be longer than 140 characters' })
      }
      if (changes.game_id !== undefined && ![...this.games.values()].includes(changes.game_id)) {
        return json(400, { message: 'The ID in game_id is not valid' })
      }
      this.channel = { ...this.channel, ...changes }
      return Promise.resolve({ ok: true, status: 204, text: async () => '' })
    }

    if (path === '/streams/key') return json(200, { data: [{ stream_key: this.streamKey }] })

    if (path === '/games') {
      const name = parsed.searchParams.get('name') ?? ''
      const id = this.games.get(name.toLowerCase())
      return json(200, { data: id === undefined ? [] : [{ id, name }] })
    }

    if (path === '/streams') return json(200, { data: [] })

    return json(404, { message: `no route ${path}` })
  }

  private nextAccess(): string {
    this.accessTokens += 1
    return `at-${this.accessTokens}`
  }
}

function json(status: number, body: unknown): ReturnType<Fetch> {
  return Promise.resolve({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  })
}

function ok(text: string): ReturnType<Fetch> {
  return Promise.resolve({ ok: true, status: 200, text: async () => text })
}
