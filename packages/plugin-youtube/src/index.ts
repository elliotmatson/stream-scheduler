import { SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type {
  ConfigField,
  DestinationContext,
  DestinationInstance,
  DestinationMetadata,
  DestinationProvider,
  DestinationStatus,
  PrepareInput,
  PrepareResult,
} from '@scheduler/plugin-sdk'
import {
  YouTubeApi,
  YouTubeApiError,
  type Fetch,
  type LiveBroadcast,
  type LiveStream,
} from './api.js'
import {
  beginAuthorization,
  exchangeCode,
  RefreshingTokenSource,
  ReauthRequiredError,
  SCOPES,
  type OAuthClient,
} from './oauth.js'
import { assertAffordableAll, InMemoryQuota, QuotaExhaustedError } from './quota.js'

const configSchema: ConfigField[] = [
  { type: 'textinput', id: 'accountRef', label: 'Connected account', required: true },
  {
    type: 'dropdown',
    id: 'privacy',
    label: 'Privacy',
    choices: [
      { id: 'public', label: 'Public' },
      { id: 'unlisted', label: 'Unlisted' },
      { id: 'private', label: 'Private' },
    ],
    default: 'public',
  },
  {
    type: 'checkbox',
    id: 'reusableStream',
    label: 'Reuse one ingestion stream',
    default: true,
    tooltip:
      'Keeps the encoder stream key the same forever, which removes a whole failure mode and saves API ' +
      'quota. Turn off only if you want a fresh key per event.',
  },
  {
    type: 'textinput',
    id: 'streamTitle',
    label: 'Ingestion stream name',
    default: 'Stream Scheduler',
  },
  {
    type: 'dropdown',
    id: 'playlistId',
    label: 'Add finished videos to playlist',
    // Read off the channel when the account is picked. Pasting a `PL…` id
    // copied out of a URL is a step nobody gets right first time.
    choices: [],
    choicesFrom: 'playlists',
  },
]

/**
 * YouTube as a streaming destination.
 *
 * The interesting decisions here, all explained at their call sites below:
 * a reusable ingestion stream by default; the scheduler, not YouTube,
 * deciding when the broadcast goes on and comes off air; the playlist
 * insert during prepare rather than after the event; and reconcile by title
 * and start time because the API offers nowhere to stash an idempotency key.
 */
class YouTubeDestination implements DestinationInstance {
  private lastError: string | undefined

  async listPlaylists(): Promise<{ id: string; title: string }[]> {
    return this.wrap(() => this.api.listPlaylists())
  }

  constructor(
    private readonly ctx: DestinationContext,
    private readonly api: YouTubeApi,
    private readonly settings: {
      privacy: 'public' | 'unlisted' | 'private'
      reusableStream: boolean
      streamTitle: string
      playlistId: string | undefined
    },
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const { metadata } = input

    // Anything already created by an interrupted attempt is adopted rather
    // than duplicated. The run engine commits the idempotency key before
    // ever calling this, so an interrupted attempt is always recognisable.
    const existing = await this.reconcile(input)
    if (existing) {
      this.ctx.log('info', 'adopted a broadcast a previous attempt had already created', {
        broadcastId: existing.externalId,
      })
      return existing
    }

    // Everything prepare is about to spend, checked before the first call.
    // Running out half-way — the broadcast made, the bind refused — is how
    // a channel collects broadcasts nothing will ever stream into.
    await assertAffordableAll(this.ctx.quota, [
      'liveBroadcasts.insert',
      'liveStreams.list',
      'liveBroadcasts.bind',
      'liveBroadcasts.delete',
    ])

    const broadcast = await this.wrap(() =>
      this.api.insertBroadcast({
        title: metadata.title,
        description: metadata.description,
        scheduledStartTime: new Date(this.startToSend(input)).toISOString(),
        scheduledEndTime: new Date(metadata.scheduledEnd).toISOString(),
        privacyStatus: metadata.privacy,
        // The scheduler puts the broadcast on air and takes it off, not
        // YouTube. Left to YouTube, an encoder that drops for a minute ends
        // the broadcast, and the rest of the service goes nowhere.
        enableAutoStart: false,
        enableAutoStop: false,
      }),
    )

    let stream: LiveStream
    try {
      stream = await this.ensureStream()
      await this.wrap(() => this.api.bindBroadcast(broadcast.id, stream.id))
    } catch (error) {
      // The broadcast exists and nothing will ever stream into it. Undone
      // here rather than left to the run: the run never learns its id,
      // because the step that made it did not succeed.
      await this.discard({ externalId: broadcast.id })
      throw error
    }

    // The broadcast already has its video id, so the playlist insert can
    // happen now. Doing it here means a failure is a prepare-phase error
    // someone can see at T-30m, rather than something that quietly did not
    // happen after everyone went home.
    if (this.settings.playlistId) {
      try {
        await this.wrap(() => this.api.insertPlaylistItem(this.settings.playlistId!, broadcast.id))
      } catch (error) {
        // A bad playlist id should not cost the service. Report and continue.
        this.ctx.log('warn', 'could not add the broadcast to the playlist', {
          error: describe(error),
        })
      }
    }

    return this.resultFor(broadcast, stream)
  }

  /**
   * Finds a broadcast a previous attempt created.
   *
   * The Live Streaming API has nowhere to stash an idempotency key — the
   * broadcast resource has no arbitrary metadata — so this matches on title
   * plus the start time that attempt would have sent. When that time had to
   * be moved because the real one had passed, it also accepts the same title
   * made since this prepare was first tried, which is what keeps a retry of
   * a late start from making a second broadcast without adopting next
   * week's. `search.list` would cost 100 units where this costs 1.
   */
  async reconcile(input: PrepareInput): Promise<PrepareResult | undefined> {
    const sent = this.startToSend(input)
    const intended = input.metadata.scheduledStart
    const since = (input.firstAttemptAt ?? this.now()) - 60_000
    const upcoming = await this.wrap(() => this.api.listUpcomingBroadcasts())

    const match = upcoming.find((broadcast) => {
      if (broadcast.snippet.title !== input.metadata.title) return false
      const start = broadcast.snippet.scheduledStartTime
      if (start === undefined) return false
      if (Date.parse(start) === sent) return true
      // A late start, possibly moved again by an earlier attempt.
      const published = broadcast.snippet.publishedAt
      return (
        sent !== intended &&
        Date.parse(start) >= intended &&
        published !== undefined &&
        Date.parse(published) >= since
      )
    })
    if (!match) return undefined

    const streamId = match.contentDetails?.boundStreamId
    const stream = streamId ? await this.wrap(() => this.api.getStream(streamId)) : undefined
    if (!stream) {
      // Created but never bound: bind it now rather than making a second one.
      const fresh = await this.ensureStream()
      await this.wrap(() => this.api.bindBroadcast(match.id, fresh.id))
      return this.resultFor(match, fresh)
    }
    return this.resultFor(match, stream)
  }

  async discard(input: { externalId: string }): Promise<void> {
    // Best-effort by contract. A channel slowly filling with empty public
    // "Sunday Service" broadcasts is the thing being prevented, so if delete
    // is refused, making it private is still a win.
    try {
      await this.api.deleteBroadcast(input.externalId)
      this.ctx.log('info', 'deleted the broadcast left by an abandoned run', {
        broadcastId: input.externalId,
      })
    } catch (error) {
      this.ctx.log('warn', 'could not delete the broadcast; making it private instead', {
        broadcastId: input.externalId,
        error: describe(error),
      })
      await this.api
        .updateBroadcastPrivacy(input.externalId, 'private')
        .catch((secondary: unknown) =>
          this.ctx.log('error', 'could not make the orphan broadcast private either', {
            broadcastId: input.externalId,
            error: describe(secondary),
          }),
        )
    }
  }

  /**
   * Puts the broadcast on air, once YouTube can see the encoder.
   *
   * The encoder's own start is verified before this is called, but YouTube
   * takes a few seconds more to see the ingest. Transitioning before it
   * does is the classic `errorStreamInactive`, so this waits for the stream
   * to read active first, and still retries that error if it loses the race.
   */
  async goLive(input: { externalId: string }): Promise<void> {
    const broadcast = await this.broadcastOrThrow(input.externalId)
    const state = lifecycleOf(broadcast)
    if (state === 'live' || state === 'liveStarting') return
    if (state === 'complete' || state === 'revoked') {
      throw new BroadcastEndedError(input.externalId, state)
    }

    const streamId = broadcast.contentDetails?.boundStreamId
    if (!streamId) {
      throw new YouTubeApiError(400, 'noBoundStream', 'The broadcast has no stream bound to it.')
    }
    await this.waitFor(
      async () => (await this.api.getStream(streamId))?.status?.streamStatus === 'active',
      INGEST_WAIT_MS,
    )

    // A broadcast made by an older version still has YouTube's preview
    // stage switched on, and has to go through it on the way to live.
    if (
      broadcast.contentDetails?.monitorStream?.enableMonitorStream !== false &&
      state === 'ready'
    ) {
      await this.transition(input.externalId, 'testing')
      await this.waitFor(
        async () => lifecycleOf(await this.api.getBroadcast(input.externalId)) === 'testing',
        TRANSITION_WAIT_MS,
      )
    }
    await this.transition(input.externalId, 'live')

    const reached = await this.waitFor(
      async () => lifecycleOf(await this.api.getBroadcast(input.externalId)) === 'live',
      TRANSITION_WAIT_MS,
    )
    if (!reached) {
      // YouTube accepted the transition and is still starting it. That is
      // a broadcast on its way to air, not a failure.
      this.ctx.log('warn', 'the broadcast is still starting on YouTube', {
        broadcastId: input.externalId,
      })
    }
  }

  /** Takes the broadcast off air. Already ended is the state wanted. */
  async endBroadcast(input: { externalId: string }): Promise<void> {
    let state = lifecycleOf(await this.broadcastOrThrow(input.externalId))
    if (state === 'liveStarting') {
      // Cannot be ended until it has finished starting.
      await this.waitFor(async () => {
        state = lifecycleOf(await this.api.getBroadcast(input.externalId))
        return state !== 'liveStarting'
      }, TRANSITION_WAIT_MS)
    }
    if (state !== 'live' && state !== 'testing') return
    await this.transition(input.externalId, 'complete')
  }

  async finalize(input: { externalId: string; metadata: DestinationMetadata }): Promise<void> {
    // The backstop for a broadcast that is somehow still on air at the end
    // — its end step failed, or it was made before the scheduler drove
    // YouTube. Ended already is the usual case, and is fine.
    const broadcast = await this.api.getBroadcast(input.externalId)
    const state = lifecycleOf(broadcast)
    if (state === 'live' || state === 'testing' || state === 'liveStarting') {
      await this.endBroadcast(input)
    }
  }

  async status(): Promise<DestinationStatus> {
    const used = await this.ctx.quota.usedToday()
    const remaining = this.ctx.quota.dailyLimit() - used
    // Asked of Google, not of this instance's memory: a fresh instance has
    // never failed anything, so without a real check an expired token is
    // first noticed when the service fails at T-30.
    try {
      await this.api.authorize()
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return { state: 'reauth_required', message: error.message, quotaRemaining: remaining }
      }
      return { state: 'error', message: describe(error), quotaRemaining: remaining }
    }
    if (this.lastError)
      return { state: 'error', message: this.lastError, quotaRemaining: remaining }
    if (remaining <= 0) return { state: 'quota_exhausted', quotaRemaining: 0 }
    return { state: 'ok', quotaRemaining: remaining }
  }

  async dispose(): Promise<void> {
    // Nothing held open: the client is stateless over HTTP.
  }

  /**
   * The start time to send YouTube.
   *
   * The real one, unless it is too close or already past — Start now, or a
   * catch-up after the app was down — when YouTube refuses it. Then a
   * minute after the first attempt, rounded up, so every retry sends the
   * same time and the reconcile can find what an earlier one made.
   */
  private startToSend(input: PrepareInput): number {
    const intended = input.metadata.scheduledStart
    const first = input.firstAttemptAt ?? this.now()
    const earliest = Math.ceil((first + 60_000) / 60_000) * 60_000
    return intended >= first + 60_000 ? intended : earliest
  }

  private async transition(id: string, to: 'testing' | 'live' | 'complete'): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.wrap(() => this.api.transitionBroadcast(id, to))
        return
      } catch (error) {
        if (!(error instanceof YouTubeApiError)) throw error
        // Already there: the state wanted.
        if (error.reason === 'redundantTransition') return
        if (error.reason === 'invalidTransition') {
          const now = lifecycleOf(await this.api.getBroadcast(id))
          if (to === 'live' && (now === 'live' || now === 'liveStarting')) return
          if (to === 'complete' && now === 'complete') return
          if (to === 'testing' && (now === 'testing' || now === 'testStarting')) return
          throw error
        }
        // YouTube has not caught up with the encoder yet.
        if (error.reason === 'errorStreamInactive' && attempt < INACTIVE_RETRIES) {
          await this.sleep(INACTIVE_BACKOFF_MS)
          continue
        }
        throw error
      }
    }
  }

  /** Polls until `ready` says so or the time runs out. Reports which. */
  private async waitFor(ready: () => Promise<boolean>, withinMs: number): Promise<boolean> {
    for (let waited = 0; ; waited += POLL_MS) {
      if (await ready()) return true
      if (waited >= withinMs) return false
      await this.sleep(POLL_MS)
    }
  }

  private async broadcastOrThrow(id: string): Promise<LiveBroadcast> {
    const broadcast = await this.wrap(() => this.api.getBroadcast(id))
    if (!broadcast) {
      throw new YouTubeApiError(404, 'liveBroadcastNotFound', `YouTube has no broadcast "${id}".`)
    }
    return broadcast
  }

  /**
   * A reusable ingestion stream means the encoder's key never changes.
   *
   * That removes an entire failure mode — a key push that silently did not
   * land — and saves a 50-unit insert on every event. A fresh key per event
   * remains available for anyone who wants the isolation.
   */
  private async ensureStream(): Promise<LiveStream> {
    if (!this.settings.reusableStream) {
      return this.wrap(() => this.api.insertStream(`${this.settings.streamTitle} (one-off)`, false))
    }

    const existing = await this.wrap(() => this.api.listStreams())
    const reusable = existing.find(
      (stream) =>
        stream.contentDetails?.isReusable === true &&
        stream.snippet?.title === this.settings.streamTitle,
    )
    if (reusable) return reusable
    return this.wrap(() => this.api.insertStream(this.settings.streamTitle, true))
  }

  private resultFor(broadcast: LiveBroadcast, stream: LiveStream): PrepareResult {
    const info = stream.cdn?.ingestionInfo
    const url = info?.rtmpsIngestionAddress ?? info?.ingestionAddress
    const key = info?.streamName
    if (!url || !key) {
      throw new YouTubeApiError(
        500,
        'noIngestionInfo',
        'YouTube did not return an ingest address for the stream.',
      )
    }
    return {
      externalId: broadcast.id,
      ingest: { url, key },
      watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`,
      detail: { streamId: stream.id, reusable: stream.contentDetails?.isReusable ?? false },
    }
  }

  private async wrap<T>(action: () => Promise<T>): Promise<T> {
    try {
      const result = await action()
      this.lastError = undefined
      return result
    } catch (error) {
      this.lastError = describe(error)
      throw error
    }
  }
}

/** How long to wait for YouTube to see the encoder's ingest. */
const INGEST_WAIT_MS = 60_000
/** How long to wait for a transition YouTube has accepted to finish. */
const TRANSITION_WAIT_MS = 30_000
const POLL_MS = 3_000
const INACTIVE_RETRIES = 4
const INACTIVE_BACKOFF_MS = 5_000

function lifecycleOf(broadcast: LiveBroadcast | undefined): string | undefined {
  return broadcast?.status?.lifeCycleStatus
}

/** A broadcast that ended outside the scheduler cannot be put back on air. */
export class BroadcastEndedError extends Error {
  readonly code = 'broadcast-ended'
  readonly retryable = false
  readonly remediation =
    'The broadcast was ended on YouTube before it was due. Start the event again to make a new one.'
  constructor(id: string, state: string) {
    super(`YouTube broadcast "${id}" is already ${state}, so it cannot go on air.`)
    this.name = 'BroadcastEndedError'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface YouTubePluginOptions {
  now?: () => number
  /** How to wait between polls. Injected so tests do not wait for real. */
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: Fetch
  /** Resolves the BYO OAuth client for a connected account. */
  resolveClient: (accountRef: string) => Promise<{ client: OAuthClient; refreshToken: string }>
}

export function youtubeProvider(options: YouTubePluginOptions): DestinationProvider {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return {
    id: 'youtube',
    displayName: 'YouTube',
    apiVersion: SDK_API_VERSION,
    configSchema,
    providesIngest: true,
    controlsBroadcastLifecycle: true,
    oauth: {
      begin: (client, redirectUri) =>
        beginAuthorization({ ...client, clientSecret: '' }, redirectUri),
      complete: async (client, pending, code) => {
        const tokens = await exchangeCode(client, pending, code, options.fetchImpl)

        // Identify the channel so the UI can name what was connected, rather
        // than showing an opaque account row. One quota unit; the budget for
        // it is not yet attached to an account, so it is counted locally.
        const api = new YouTubeApi(
          { accessToken: async () => tokens.access_token },
          new InMemoryQuota(),
          options.fetchImpl,
        )
        const channel = await api.myChannel()

        return {
          externalId: channel.id,
          displayName: channel.title,
          refreshToken: tokens.refresh_token!,
          scopes: SCOPES,
        }
      },
    },
    async createDestination(ctx: DestinationContext): Promise<DestinationInstance> {
      const accountRef = String(ctx.config.accountRef ?? '')
      if (!accountRef) throw new ReauthRequiredError('no account is connected to this destination')

      const { client, refreshToken } = await options.resolveClient(accountRef)
      const tokens = new RefreshingTokenSource(client, refreshToken, now, options.fetchImpl)
      const api = new YouTubeApi(tokens, ctx.quota, options.fetchImpl)

      return new YouTubeDestination(
        ctx,
        api,
        {
          privacy: (ctx.config.privacy as 'public' | 'unlisted' | 'private') ?? 'public',
          reusableStream: ctx.config.reusableStream !== false,
          streamTitle: String(ctx.config.streamTitle ?? 'Stream Scheduler'),
          playlistId:
            typeof ctx.config.playlistId === 'string' && ctx.config.playlistId
              ? ctx.config.playlistId
              : undefined,
        },
        now,
        sleep,
      )
    },
  }
}

export * from './api.js'
export * from './oauth.js'
export * from './quota.js'
export { FakeYouTube } from './fake-youtube.js'
export { QuotaExhaustedError }
