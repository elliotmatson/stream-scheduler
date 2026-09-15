/**
 * Twitch's Helix API, as much of it as a destination needs.
 *
 * The shape of this integration is decided by one fact: **Twitch has no
 * broadcast object.** A channel has a single stream key that never changes,
 * and going live is just pushing to it. There is nothing to create at
 * prepare time and nothing to finalise afterwards.
 *
 * So what a Twitch destination actually does is set the channel's title and
 * category for the service about to start, and hand back the key it read
 * rather than one somebody pasted. That is a smaller thing than YouTube's
 * broadcast, and it is the useful part of what people do by hand every week.
 */

export const HELIX = 'https://api.twitch.tv/helix'

/** Public, unauthenticated, and the only honest source for where to push:
 *  Twitch has retired ingest hosts before, and a constant in here would go
 *  stale silently and take a Sunday with it. */
export const INGEST_LIST = 'https://ingest.twitch.tv/ingests'

/** Twitch's own limit on a stream title. Longer is rejected outright, so a
 *  templated title has to be cut before it is sent rather than after. */
export const MAX_TITLE = 140

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface TokenSource {
  accessToken(): Promise<string>
}

export class TwitchApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TwitchApiError'
  }
}

/** Twitch says "slow down" with a 429 and a per-minute points bucket, not a
 *  daily quota. Worth its own type so the caller can wait rather than treat
 *  it as a dead credential. */
export class RateLimitedError extends TwitchApiError {
  constructor(message: string) {
    super(429, message)
    this.name = 'RateLimitedError'
  }
}

export interface TwitchUser {
  id: string
  login: string
  display_name: string
}

export interface IngestServer {
  name: string
  /** Carries a literal `{stream_key}` for the key to be put into. */
  url_template: string
  availability?: number
  default?: boolean
  priority?: number
}

export class TwitchApi {
  constructor(
    private readonly clientId: string,
    private readonly tokens: TokenSource,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
  ) {}

  /** Who authorised. Used to name the connected account and as the
   *  broadcaster id on every later call. */
  async me(): Promise<TwitchUser> {
    const body = await this.get<{ data: TwitchUser[] }>('/users')
    const user = body.data[0]
    if (!user) throw new TwitchApiError(200, 'Twitch returned no user for this token.')
    return user
  }

  /**
   * Sets what the channel says it is showing.
   *
   * The title is the reason this integration exists. The category is
   * optional and deliberately separate: a category that cannot be resolved
   * must not stop a service going out.
   */
  async modifyChannel(
    broadcasterId: string,
    changes: { title?: string; gameId?: string; language?: string },
  ): Promise<void> {
    const body: Record<string, string> = {}
    if (changes.title !== undefined) body.title = changes.title.slice(0, MAX_TITLE)
    if (changes.gameId !== undefined) body.game_id = changes.gameId
    if (changes.language !== undefined) body.broadcaster_language = changes.language
    if (Object.keys(body).length === 0) return

    await this.send('PATCH', `/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`, body)
  }

  /** The channel's one key. Never changes unless somebody resets it, at
   *  which point reading it again is exactly what you want. */
  async streamKey(broadcasterId: string): Promise<string> {
    const body = await this.get<{ data: { stream_key: string }[] }>(
      `/streams/key?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    )
    const key = body.data[0]?.stream_key
    if (!key) throw new TwitchApiError(200, 'Twitch returned no stream key for this channel.')
    return key
  }

  /** A category id from its name, or undefined when Twitch has no such
   *  category. Undefined rather than throwing: see `modifyChannel`. */
  async gameIdByName(name: string): Promise<string | undefined> {
    const body = await this.get<{ data: { id: string; name: string }[] }>(
      `/games?name=${encodeURIComponent(name)}`,
    )
    return body.data[0]?.id
  }

  /**
   * Where to push, read from Twitch rather than hardcoded.
   *
   * Returns the URL and the key separately, because that is what an encoder
   * wants and what the rest of this app passes around — the template joins
   * them with a slash and the key is not part of the address.
   */
  async ingest(streamKey: string): Promise<{ url: string; key: string; server: string }> {
    const response = await this.fetchImpl(INGEST_LIST)
    if (!response.ok) {
      throw new TwitchApiError(response.status, `Could not read Twitch's ingest list.`)
    }
    const body = JSON.parse(await response.text()) as { ingests?: IngestServer[] }
    const servers = body.ingests ?? []
    const chosen = pickIngest(servers)
    if (!chosen) throw new TwitchApiError(200, 'Twitch listed no ingest servers.')

    return {
      url: chosen.url_template.replace('/{stream_key}', '').replace('{stream_key}', ''),
      key: streamKey,
      server: chosen.name,
    }
  }

  private async get<T>(path: string): Promise<T> {
    return JSON.parse(await this.send('GET', path)) as T
  }

  private async send(
    method: 'GET' | 'PATCH' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<string> {
    const response = await this.fetchImpl(`${HELIX}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.tokens.accessToken()}`,
        'client-id': this.clientId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const text = await response.text()
    if (response.status === 429) {
      throw new RateLimitedError(
        'Twitch asked us to slow down. It limits by the minute, not by the day.',
      )
    }
    if (!response.ok) {
      throw new TwitchApiError(response.status, describe(text, response.status))
    }
    // PATCH answers 204 with no body; the caller does not read it.
    return text || '{}'
  }
}

/**
 * The one Twitch marks default, else the most available.
 *
 * Deliberately not "the first in the list": the order is not documented as
 * meaningful, and picking by it would be a guess that works until it does
 * not.
 */
export function pickIngest(servers: IngestServer[]): IngestServer | undefined {
  const usable = servers.filter((server) => server.url_template.includes('{stream_key}'))
  if (usable.length === 0) return undefined
  return (
    usable.find((server) => server.default === true) ??
    [...usable].sort((a, b) => (b.availability ?? 0) - (a.availability ?? 0))[0]
  )
}

function describe(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { message?: string; error?: string }
    return body.message ?? body.error ?? `Twitch answered ${status}.`
  } catch {
    return `Twitch answered ${status}.`
  }
}
