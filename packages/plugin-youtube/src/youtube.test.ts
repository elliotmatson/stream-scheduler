import { beforeEach, describe, expect, it } from 'vitest'
import type { DestinationContext, DestinationInstance } from '@scheduler/plugin-sdk'
import { FakeYouTube } from './fake-youtube.js'
import { youtubeProvider } from './index.js'
import { CRITICAL_RESERVE, DEFAULT_DAILY_LIMIT, InMemoryQuota, QuotaExhaustedError } from './quota.js'
import { beginAuthorization, ReauthRequiredError, RefreshingTokenSource, SCOPES } from './oauth.js'
import type { Fetch } from './api.js'

const START = Date.parse('2026-03-08T14:00:00Z')
const END = START + 90 * 60_000

let youtube: FakeYouTube
let quota: InMemoryQuota
const logs: { level: string; message: string }[] = []

const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret' }

/** A token endpoint that always issues a working access token. */
function tokenFetch(inner: Fetch): Fetch {
  return async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' }),
      }
    }
    return inner(url, init)
  }
}

function context(config: Record<string, unknown> = {}): DestinationContext {
  return {
    destinationId: 'dest-1',
    config: { accountRef: 'acct-1', ...config },
    log: (level, message) => logs.push({ level, message }),
    quota,
    secrets: { read: async () => undefined, write: async () => {} },
  }
}

async function destination(config: Record<string, unknown> = {}): Promise<DestinationInstance> {
  const provider = youtubeProvider({
    fetchImpl: tokenFetch(youtube.fetch),
    resolveClient: async () => ({ client: CLIENT, refreshToken: 'rt-1' }),
  })
  return provider.createDestination(context(config))
}

const metadata = (over: Partial<{ title: string; scheduledStart: number }> = {}) => ({
  title: 'Sunday Service - March 8',
  description: 'Join us.',
  scheduledStart: START,
  scheduledEnd: END,
  privacy: 'public' as const,
  ...over,
})

const prepareInput = (over = {}) => ({ idempotencyKey: 'run-1:0:youtube.prepare', metadata: metadata(over) })

beforeEach(() => {
  youtube = new FakeYouTube()
  quota = new InMemoryQuota()
  logs.length = 0
})

describe('preparing a broadcast', () => {
  it('creates the broadcast, an ingestion stream, and binds them', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())

    expect(youtube.liveBroadcastCount).toBe(1)
    expect(result.ingest.url).toMatch(/^rtmps:\/\//)
    expect(result.ingest.key).toMatch(/^live_/)
    expect(result.watchUrl).toBe(`https://www.youtube.com/watch?v=${result.externalId}`)

    const broadcast = youtube.broadcasts.get(result.externalId)
    expect(broadcast?.boundStreamId).toBeDefined()
    expect(broadcast?.title).toBe('Sunday Service - March 8')
    expect(broadcast?.privacyStatus).toBe('public')
  })

  it('turns on autoStart and autoStop, avoiding the transition race', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())
    const broadcast = youtube.broadcasts.get(result.externalId)
    expect(broadcast?.enableAutoStart).toBe(true)
    expect(broadcast?.enableAutoStop).toBe(true)
  })

  it('reuses one ingestion stream, so the encoder key never changes', async () => {
    const first = await (await destination()).prepare(prepareInput())
    const second = await (await destination()).prepare(
      prepareInput({ title: 'Sunday Service - March 15', scheduledStart: START + 7 * 86_400_000 }),
    )

    expect(youtube.streams.size).toBe(1)
    expect(second.ingest.key).toBe(first.ingest.key)
  })

  it('creates a fresh stream per event when reuse is switched off', async () => {
    await (await destination({ reusableStream: false })).prepare(prepareInput())
    await (await destination({ reusableStream: false })).prepare(
      prepareInput({ title: 'Another', scheduledStart: START + 86_400_000 }),
    )
    expect(youtube.streams.size).toBe(2)
  })

  it('adds the broadcast to a playlist during prepare, not after the event', async () => {
    const dest = await destination({ playlistId: 'PL123' })
    const result = await dest.prepare(prepareInput())
    expect(youtube.playlistItems).toEqual([{ playlistId: 'PL123', videoId: result.externalId }])
  })

  it('does not lose the service because the playlist id is wrong', async () => {
    const dest = await destination({ playlistId: '' })
    // An empty id is treated as "no playlist"; a bad one is reported and
    // stepped over rather than failing the run.
    await expect(dest.prepare(prepareInput())).resolves.toBeDefined()
  })

  it('honours the configured privacy', async () => {
    const dest = await destination({ privacy: 'unlisted' })
    const result = await dest.prepare({ ...prepareInput(), metadata: { ...metadata(), privacy: 'unlisted' } })
    expect(youtube.broadcasts.get(result.externalId)?.privacyStatus).toBe('unlisted')
  })
})

describe('playlists', () => {
  it('lists what the channel has, so nobody pastes an id out of a URL', async () => {
    const dest = await destination({})
    expect(await dest.listPlaylists?.()).toEqual([
      { id: 'PL-services', title: 'Sunday Services' },
      { id: 'PL-worship', title: 'Worship' },
    ])
  })

  it('costs one quota unit, cheap enough to re-ask whenever the form opens', async () => {
    const dest = await destination({})
    await dest.listPlaylists?.()
    expect(youtube.calls).toContain('GET /playlists')
    expect(quota.used).toBe(1)
  })
})

describe('idempotency', () => {
  it('adopts a broadcast created by an interrupted attempt instead of making a second', async () => {
    // The call landed; the response was lost. This is the exact crash window
    // the run engine's reconcile exists for.
    youtube.setOptions({ dropResponseAfterInsert: true })
    const dest = await destination()
    await expect(dest.prepare(prepareInput())).rejects.toThrow()
    expect(youtube.liveBroadcastCount).toBe(1)

    const retry = await destination()
    const result = await retry.prepare(prepareInput())

    expect(youtube.liveBroadcastCount).toBe(1) // still one, not two
    expect(result.externalId).toBe('bc-1')
  })

  it('preparing twice is a no-op on the channel', async () => {
    const dest = await destination()
    const first = await dest.prepare(prepareInput())
    const second = await dest.prepare(prepareInput())
    expect(second.externalId).toBe(first.externalId)
    expect(youtube.liveBroadcastCount).toBe(1)
  })

  it('binds a stream to a broadcast a crash left unbound', async () => {
    const dest = await destination()
    // A broadcast exists from an interrupted attempt, but nothing is bound.
    await youtube.fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet`, {
      method: 'POST',
      body: JSON.stringify({
        snippet: {
          title: 'Sunday Service - March 8',
          scheduledStartTime: new Date(START).toISOString(),
        },
        status: { privacyStatus: 'public' },
      }),
    })

    const result = await dest.prepare(prepareInput())
    expect(youtube.liveBroadcastCount).toBe(1)
    expect(youtube.broadcasts.get(result.externalId)?.boundStreamId).toBeDefined()
  })

  it('treats a different event at the same time as a different broadcast', async () => {
    const dest = await destination()
    await dest.prepare(prepareInput())
    await dest.prepare(prepareInput({ title: 'Evening Service' }))
    expect(youtube.liveBroadcastCount).toBe(2)
  })
})

describe('compensation', () => {
  it('deletes the broadcast an abandoned run left behind', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())
    await dest.discard({ externalId: result.externalId })
    expect(youtube.liveBroadcastCount).toBe(0)
  })

  it('falls back to making it private when deletion is refused', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())

    // YouTube refuses to delete a broadcast that already started; the
    // fallback still keeps the channel clean.
    youtube.setOptions({ refuseDelete: true })

    await dest.discard({ externalId: result.externalId })
    expect(youtube.broadcasts.get(result.externalId)?.privacyStatus).toBe('private')
    expect(logs.some((l) => l.message.includes('making it private'))).toBe(true)
  })
})

describe('quota', () => {
  it('spends roughly what the plan budgeted for one event', async () => {
    const dest = await destination({ playlistId: 'PL123' })
    await dest.prepare(prepareInput())

    // insert 50 + list(reconcile) 1 + list(streams) 1 + insert stream 50
    // + bind 50 + playlist 50
    const used = await quota.usedToday()
    expect(used).toBeLessThanOrEqual(260)
    expect(used).toBeGreaterThan(150)
  })

  it('costs less on later events, because the stream is reused', async () => {
    await (await destination()).prepare(prepareInput())
    const afterFirst = await quota.usedToday()

    await (await destination()).prepare(prepareInput({ title: 'Next week', scheduledStart: START + 604_800_000 }))
    const secondEventCost = (await quota.usedToday()) - afterFirst

    expect(secondEventCost).toBeLessThan(afterFirst)
  })

  it('refuses a call that would overrun the day, before sending it', async () => {
    quota = new InMemoryQuota(100) // almost nothing left
    const dest = await destination()
    await expect(dest.prepare(prepareInput())).rejects.toBeInstanceOf(QuotaExhaustedError)
    // Nothing was created, so there is no half-built broadcast to clean up.
    expect(youtube.liveBroadcastCount).toBe(0)
  })

  it('keeps a reserve so polling cannot starve the calls that matter', async () => {
    quota = new InMemoryQuota(DEFAULT_DAILY_LIMIT)
    await quota.record('padding', DEFAULT_DAILY_LIMIT - CRITICAL_RESERVE + 1)

    const dest = await destination()
    // The reconcile list is non-critical and is refused inside the reserve...
    await expect(dest.prepare(prepareInput())).rejects.toBeInstanceOf(QuotaExhaustedError)
  })

  it('reports remaining budget so the cap is visible before it bites', async () => {
    const dest = await destination()
    await dest.prepare(prepareInput())
    const status = await dest.status()
    expect(status.state).toBe('ok')
    expect(status.quotaRemaining).toBe(DEFAULT_DAILY_LIMIT - (await quota.usedToday()))
  })

  it('never calls search, whatever the path', async () => {
    const dest = await destination({ playlistId: 'PL123' })
    await dest.prepare(prepareInput())
    await dest.prepare(prepareInput())
    await dest.finalize({ externalId: 'bc-1', metadata: metadata() })
    expect(youtube.calls.some((call) => call.includes('search'))).toBe(false)
  })
})

describe('finalizing', () => {
  it('leaves an autoStop broadcast for YouTube to complete', async () => {
    const dest = await destination()
    const result = await dest.prepare(prepareInput())
    const before = youtube.calls.length

    await dest.finalize({ externalId: result.externalId, metadata: metadata() })
    // No transition call, so no race against YouTube's own completion.
    expect(youtube.calls.slice(before)).toEqual([])
  })

  it('transitions explicitly when autoStop is off', async () => {
    const dest = await destination({ autoStartStop: false })
    const result = await dest.prepare(prepareInput())
    youtube.markStreamActive(youtube.broadcasts.get(result.externalId)!.boundStreamId!)

    await dest.finalize({ externalId: result.externalId, metadata: metadata() })
    expect(youtube.broadcasts.get(result.externalId)?.lifeCycleStatus).toBe('complete')
  })
})

describe('API errors', () => {
  it('explains a channel without live streaming enabled', async () => {
    youtube.setOptions({ failWith: { status: 403, reason: 'liveStreamingNotEnabled' } })
    const dest = await destination()
    await expect(dest.prepare(prepareInput())).rejects.toMatchObject({
      code: 'liveStreamingNotEnabled',
      remediation: expect.stringContaining('YouTube Studio'),
    })
  })

  it('marks a server error retryable and a rejection not', async () => {
    youtube.setOptions({ failWith: { status: 503, reason: 'backendError' } })
    await expect((await destination()).prepare(prepareInput())).rejects.toMatchObject({ retryable: true })

    youtube.setOptions({ failWith: { status: 403, reason: 'insufficientPermissions' } })
    await expect((await destination()).prepare(prepareInput())).rejects.toMatchObject({ retryable: false })
  })
})

describe('OAuth', () => {
  it('builds an authorization URL with PKCE and offline access', () => {
    const pending = beginAuthorization(CLIENT, 'http://127.0.0.1:8500/oauth/callback')
    const url = new URL(pending.url)

    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toBe(SCOPES.join(' '))
    // The deprecated out-of-band flow must never appear.
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8500/oauth/callback')
  })

  it('asks for only the scopes it needs', () => {
    expect(SCOPES).toEqual(['https://www.googleapis.com/auth/youtube.force-ssl'])
  })

  it('names the 7-day Testing expiry when a refresh is rejected', async () => {
    const failing: Fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    })
    const source = new RefreshingTokenSource(CLIENT, 'rt-1', () => 0, failing)

    await expect(source.accessToken()).rejects.toMatchObject({
      code: 'reauth-required',
      // This is the single most likely support burden in the project, so the
      // message has to name it rather than leave a generic invalid_grant.
      remediation: expect.stringContaining('Testing'),
    })
  })

  it('caches an access token and refreshes it before it expires', async () => {
    let refreshes = 0
    let clock = 0
    const counting: Fetch = async () => {
      refreshes++
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: `at-${refreshes}`, expires_in: 3600 }),
      }
    }
    const source = new RefreshingTokenSource(CLIENT, 'rt-1', () => clock, counting)

    expect(await source.accessToken()).toBe('at-1')
    expect(await source.accessToken()).toBe('at-1')
    expect(refreshes).toBe(1)

    clock = 3_600_000 // expired
    expect(await source.accessToken()).toBe('at-2')
    expect(refreshes).toBe(2)
  })

  it('refuses a connection Google did not give a refresh token for', async () => {
    const noRefresh: Fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600 }),
    })
    const { exchangeCode } = await import('./oauth.js')
    const pending = beginAuthorization(CLIENT, 'http://127.0.0.1:8500/oauth/callback')

    await expect(exchangeCode(CLIENT, pending, 'code', noRefresh)).rejects.toBeInstanceOf(ReauthRequiredError)
  })
})
