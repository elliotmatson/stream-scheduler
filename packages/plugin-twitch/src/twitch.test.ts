import { beforeEach, describe, expect, it } from 'vitest'
import type { DestinationContext, DestinationInstance } from '@scheduler/plugin-sdk'
import { pickIngest } from './api.js'
import { FakeTwitch } from './fake-twitch.js'
import { titleFor, twitchProvider } from './index.js'
import { beginAuthorization, ReauthRequiredError, SCOPES } from './oauth.js'

const START = Date.parse('2026-03-08T14:00:00Z')
const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret' }

let twitch: FakeTwitch
let saved: { accountRef: string; refreshToken: string }[]
const logs: { level: string; message: string }[] = []

function context(config: Record<string, unknown> = {}): DestinationContext {
  return {
    destinationId: 'dest-1',
    config: { accountRef: 'acct-1', ...config },
    log: (level, message) => logs.push({ level, message }),
    quota: {
      record: async () => 1,
      usedToday: async () => 0,
      dailyLimit: () => 0,
    },
    secrets: { read: async () => undefined, write: async () => {} },
  }
}

function provider(over: { now?: () => number } = {}) {
  return twitchProvider({
    fetchImpl: twitch.fetch,
    // The host hands over whatever it has stored, which starts as the token
    // the connect flow returned and moves on every rotation.
    resolveClient: async () => ({
      client: CLIENT,
      refreshToken: saved.at(-1)?.refreshToken ?? 'rt-1',
    }),
    saveRefreshToken: async (accountRef, refreshToken) => {
      saved.push({ accountRef, refreshToken })
    },
    ...(over.now ? { now: over.now } : {}),
  })
}

async function destination(config: Record<string, unknown> = {}): Promise<DestinationInstance> {
  return provider().createDestination(context(config))
}

const prepareInput = (title = 'Sunday Service — March 8') => ({
  idempotencyKey: 'run-1:0:twitch.prepare',
  metadata: {
    title,
    description: 'Join us.',
    scheduledStart: START,
    scheduledEnd: START + 90 * 60_000,
    privacy: 'public' as const,
  },
})

beforeEach(() => {
  twitch = new FakeTwitch()
  saved = []
  logs.length = 0
})

describe('preparing a service', () => {
  it('sets the channel title and hands back where to push', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())

    expect(twitch.channel.title).toBe('Sunday Service — March 8')
    expect(result.ingest.url).toBe('rtmp://chi.contribute.live-video.net/app')
    expect(result.ingest.key).toBe('live_1234_abcdef')
  })

  it('reads the key from Twitch rather than trusting a stored one', async () => {
    // Somebody resets the key in the Twitch dashboard between two Sundays.
    // Nothing else changes, and the next service still goes out.
    twitch.streamKey = 'live_1234_rotated'
    const result = await (await destination()).prepare(prepareInput())
    expect(result.ingest.key).toBe('live_1234_rotated')
  })

  it('links to the channel by its login name, not its numeric id', async () => {
    // twitch.tv/149747285 is not a channel. Getting this wrong puts a dead
    // link in every run's timeline and in every notification.
    const result = await (await destination()).prepare(prepareInput())
    expect(result.watchUrl).toBe('https://twitch.tv/gracebible')
  })

  it('sets the category when Twitch knows the name', async () => {
    await (await destination({ category: 'Talk Shows & Podcasts' })).prepare(prepareInput())
    expect(twitch.channel.game_id).toBe('417752')
  })

  it('does not lose the service because a category name is wrong', async () => {
    // Twitch answers 400 for an unknown game_id, so an adapter that sent one
    // anyway would fail the whole prepare over a typo in an optional field.
    const dest = await destination({ category: 'Church Servces' })
    await expect(dest.prepare(prepareInput())).resolves.toBeDefined()
    expect(twitch.channel.title).toBe('Sunday Service — March 8')
    expect(twitch.channel.game_id).toBe('')
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true)
  })

  it('leaves the channel language alone unless one is configured', async () => {
    await (await destination()).prepare(prepareInput())
    const patch = twitch.calls.find((call) => call.method === 'PATCH')
    expect(patch?.body).not.toContain('broadcaster_language')
  })

  it('cuts a long title to what Twitch accepts, rather than being refused', async () => {
    const long = `Sunday ${'very '.repeat(40)}long`
    expect(long.length).toBeGreaterThan(140)

    const result = await (await destination()).prepare(prepareInput(long))

    expect(twitch.channel.title.length).toBeLessThanOrEqual(140)
    expect(twitch.channel.title.endsWith('…')).toBe(true)
    expect(result.detail?.title).toBe(twitch.channel.title)
  })

  it('keeps the old title rather than being refused an empty one', async () => {
    // Twitch rejects an empty title. A template that renders to nothing must
    // not be able to stop a service going out over it.
    await (await destination()).prepare(prepareInput('   '))
    expect(twitch.channel.title).toBe('Whatever was on last week')
    // Nothing left to change, so nothing is sent at all.
    expect(twitch.calls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('is safe to run again, because nothing was half-created', async () => {
    const dest = await destination()
    const first = await dest.prepare(prepareInput())
    const second = await dest.reconcile!(prepareInput())

    expect(second?.externalId).toBe(first.externalId)
    expect(second?.ingest.key).toBe(first.ingest.key)
  })

  it('says out loud that there is no per-broadcast video', async () => {
    // Somebody reading a run timeline and expecting YouTube's shape should
    // find out here, not by hunting for a video that was never made.
    const result = await (await destination()).prepare(prepareInput())
    expect(String(result.detail?.note)).toContain('no per-broadcast object')
  })

  it('discards and finalizes without touching Twitch', async () => {
    const dest = await destination()
    await dest.prepare(prepareInput())
    const before = twitch.calls.length
    await dest.discard()
    await dest.finalize()
    expect(twitch.calls.length).toBe(before)
  })
})

describe('picking an ingest server', () => {
  it('prefers the one Twitch marks default over list order', () => {
    const chosen = pickIngest([
      { name: 'first', url_template: 'rtmp://a/app/{stream_key}', availability: 1 },
      { name: 'second', url_template: 'rtmp://b/app/{stream_key}', default: true },
    ])
    expect(chosen?.name).toBe('second')
  })

  it('falls back to the most available when none is marked default', () => {
    const chosen = pickIngest([
      { name: 'first', url_template: 'rtmp://a/app/{stream_key}', availability: 0.2 },
      { name: 'second', url_template: 'rtmp://b/app/{stream_key}', availability: 0.9 },
    ])
    expect(chosen?.name).toBe('second')
  })

  it('ignores an entry with no place to put the key', () => {
    expect(pickIngest([{ name: 'odd', url_template: 'rtmp://a/app' }])).toBeUndefined()
  })

  it('fails loudly rather than pushing to a guessed host', async () => {
    // A hardcoded ingest host would go stale silently and take a Sunday with
    // it, so an empty list has to be an error, not a default.
    twitch.setIngests({ ingests: [] })
    await expect((await destination()).prepare(prepareInput())).rejects.toThrow(/ingest/i)
  })
})

describe('tokens', () => {
  it('writes back the refresh token Twitch rotates to', async () => {
    // The failure this prevents is invisible for an hour and then permanent:
    // Twitch invalidates the old refresh token, so an adapter that keeps
    // using it locks the account out.
    await (await destination()).prepare(prepareInput())

    expect(saved).toEqual([{ accountRef: 'acct-1', refreshToken: 'rt-2' }])
    expect(twitch.refreshToken).toBe('rt-2')
  })

  it('keeps working across refreshes, using the token it was given last', async () => {
    await (await destination()).prepare(prepareInput())
    await (await destination()).prepare(prepareInput('Second service'))
    await (await destination()).prepare(prepareInput('Third service'))

    expect(saved.map((entry) => entry.refreshToken)).toEqual(['rt-2', 'rt-3', 'rt-4'])
    expect(twitch.channel.title).toBe('Third service')
  })

  it('writes nothing back when Twitch hands the same token again', async () => {
    twitch.rotatesRefreshTokens = false
    await (await destination()).prepare(prepareInput())
    expect(saved).toEqual([])
  })

  it('reuses one access token across the calls of a prepare', async () => {
    await (await destination()).prepare(prepareInput())
    const refreshes = twitch.calls.filter((call) => call.url.includes('/oauth2/token'))
    expect(refreshes).toHaveLength(1)
  })

  it('fetches a new access token once the old one is nearly out', async () => {
    let clock = START
    const dest = await provider({ now: () => clock }).createDestination(context())
    await dest.prepare(prepareInput())
    // Twitch's tokens last about four hours; a minute of headroom means the
    // token is replaced before a call can fail on it.
    clock += 14_000 * 1000
    await dest.prepare(prepareInput('Later'))

    expect(twitch.calls.filter((call) => call.url.includes('/oauth2/token'))).toHaveLength(2)
  })

  it('asks for the account to be reconnected when the grant is dead', async () => {
    // What a regenerated client secret looks like from in here.
    saved.push({ accountRef: 'acct-1', refreshToken: 'rt-stale' })
    const dest = await provider().createDestination(context())
    await expect(dest.prepare(prepareInput())).rejects.toBeInstanceOf(ReauthRequiredError)
  })

  it('reports reauth_required on status rather than a bare failure', async () => {
    const dest = await destination()
    saved.push({ accountRef: 'acct-1', refreshToken: 'rt-stale' })
    const later = await provider().createDestination(context())
    expect((await later.status()).state).toBe('reauth_required')
    expect((await dest.status()).state).toBe('ok')
  })

  it('treats a rate limit as temporary, not as an exhausted quota', async () => {
    // Twitch limits by the minute. Calling this quota_exhausted would read
    // as "come back tomorrow" for something that clears in seconds.
    const dest = await destination()
    await dest.prepare(prepareInput())
    twitch.failNext = { status: 429, body: '{"message":"Too Many Requests"}' }
    const status = await dest.status()
    expect(status.state).toBe('error')
    expect(status.message).toMatch(/minute/i)
  })
})

describe('authorization', () => {
  it('asks for exactly the two scopes it uses', () => {
    const pending = beginAuthorization(CLIENT, 'http://localhost:8500/api/oauth/callback')
    const url = new URL(pending.url)
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '))
    expect(SCOPES).toEqual(['channel:manage:broadcast', 'channel:read:stream_key'])
  })

  it('forces the account chooser, so reconnecting can switch channel', () => {
    const pending = beginAuthorization(CLIENT, 'http://localhost:8500/api/oauth/callback')
    expect(new URL(pending.url).searchParams.get('force_verify')).toBe('true')
  })

  it('names the connected channel and keeps its refresh token', async () => {
    const pending = beginAuthorization(CLIENT, 'http://localhost:8500/api/oauth/callback')
    const account = await provider().oauth!.complete(CLIENT, pending, 'the-code')

    expect(account.externalId).toBe('149747285')
    expect(account.displayName).toBe('GraceBible')
    expect(account.refreshToken).toBe('rt-1')
    expect(account.scopes).toEqual(SCOPES)
  })

  it('refuses a connection that would die within the hour', async () => {
    // A public client gets no refresh token. Accepting it would look like a
    // working connection until the first access token expires.
    const pending = beginAuthorization(CLIENT, 'http://localhost:8500/api/oauth/callback')
    const publicClient = twitchProvider({
      fetchImpl: async (url, init) => {
        if (url === 'https://id.twitch.tv/oauth2/token') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 14_000 }),
          }
        }
        return twitch.fetch(url, init)
      },
      resolveClient: async () => ({ client: CLIENT, refreshToken: 'rt-1' }),
      saveRefreshToken: async () => {},
    })

    await expect(publicClient.oauth!.complete(CLIENT, pending, 'the-code')).rejects.toThrow(
      /confidential/i,
    )
  })
})

describe('titles', () => {
  it('leaves a title that fits exactly alone', () => {
    const exact = 'x'.repeat(140)
    expect(titleFor({ title: exact } as never)).toBe(exact)
  })

  it('never returns more than Twitch accepts', () => {
    expect(titleFor({ title: 'y'.repeat(400) } as never)).toHaveLength(140)
  })
})
