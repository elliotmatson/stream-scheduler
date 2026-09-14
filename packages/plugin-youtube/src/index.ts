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
import { YouTubeApi, YouTubeApiError, type Fetch, type LiveBroadcast, type LiveStream } from './api.js'
import {
  beginAuthorization,
  exchangeCode,
  RefreshingTokenSource,
  ReauthRequiredError,
  SCOPES,
  type OAuthClient,
} from './oauth.js'
import { InMemoryQuota, QuotaExhaustedError } from './quota.js'

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
  { type: 'textinput', id: 'streamTitle', label: 'Ingestion stream name', default: 'Stream Scheduler' },
  {
    type: 'dropdown',
    id: 'playlistId',
    label: 'Add finished videos to playlist',
    // Read off the channel when the account is picked. Pasting a `PL…` id
    // copied out of a URL is a step nobody gets right first time.
    choices: [],
    choicesFrom: 'playlists',
  },
  {
    type: 'checkbox',
    id: 'autoStartStop',
    label: 'Let YouTube start and stop the broadcast',
    default: true,
    tooltip:
      'Goes live when YouTube detects ingest and ends when it stops. Avoids the transition race that ' +
      'produces "stream inactive" errors. Falls back to explicit transitions where unsupported.',
  },
]

/**
 * YouTube as a streaming destination.
 *
 * The interesting decisions here, all explained at their call sites below:
 * a reusable ingestion stream by default, autoStart/autoStop instead of
 * explicit transitions, the playlist insert during prepare rather than after
 * the event, and reconcile by title plus exact scheduled start because the
 * API offers nowhere to stash an idempotency key.
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
      autoStartStop: boolean
    },
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

    const broadcast = await this.wrap(() =>
      this.api.insertBroadcast({
        title: metadata.title,
        description: metadata.description,
        scheduledStartTime: new Date(metadata.scheduledStart).toISOString(),
        scheduledEndTime: new Date(metadata.scheduledEnd).toISOString(),
        privacyStatus: metadata.privacy,
        enableAutoStart: this.settings.autoStartStop,
        enableAutoStop: this.settings.autoStartStop,
      }),
    )

    const stream = await this.ensureStream()
    await this.wrap(() => this.api.bindBroadcast(broadcast.id, stream.id))

    // The broadcast already has its video id, so the playlist insert can
    // happen now. Doing it here means a failure is a prepare-phase error
    // someone can see at T-30m, rather than something that quietly did not
    // happen after everyone went home.
    if (this.settings.playlistId) {
      try {
        await this.wrap(() => this.api.insertPlaylistItem(this.settings.playlistId!, broadcast.id))
      } catch (error) {
        // A bad playlist id should not cost the service. Report and continue.
        this.ctx.log('warn', 'could not add the broadcast to the playlist', { error: describe(error) })
      }
    }

    return this.resultFor(broadcast, stream)
  }

  /**
   * Finds a broadcast a previous attempt created.
   *
   * The Live Streaming API has nowhere to stash an idempotency key — the
   * broadcast resource has no arbitrary metadata — so this matches on title
   * plus exact scheduled start. Two broadcasts sharing both are the same
   * event by any reasonable definition, and the alternative (`search.list`)
   * costs 100 units where this costs 1.
   */
  async reconcile(input: PrepareInput): Promise<PrepareResult | undefined> {
    const wanted = new Date(input.metadata.scheduledStart).toISOString()
    const upcoming = await this.wrap(() => this.api.listUpcomingBroadcasts())

    const match = upcoming.find(
      (broadcast) =>
        broadcast.snippet.title === input.metadata.title &&
        broadcast.snippet.scheduledStartTime !== undefined &&
        sameInstant(broadcast.snippet.scheduledStartTime, wanted),
    )
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
      this.ctx.log('info', 'deleted the broadcast left by an abandoned run', { broadcastId: input.externalId })
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

  async finalize(input: { externalId: string; metadata: DestinationMetadata }): Promise<void> {
    if (this.settings.autoStartStop) {
      // YouTube ends the broadcast itself when ingest stops, so forcing a
      // transition here races it and fails on an already-complete broadcast.
      this.ctx.log('debug', 'leaving the broadcast for YouTube to complete', { broadcastId: input.externalId })
      return
    }
    try {
      await this.api.transitionBroadcast(input.externalId, 'complete')
    } catch (error) {
      if (error instanceof YouTubeApiError && error.reason === 'invalidTransition') {
        // Already finished, which is the desired end state.
        return
      }
      throw error
    }
  }

  async status(): Promise<DestinationStatus> {
    const used = await this.ctx.quota.usedToday()
    const remaining = this.ctx.quota.dailyLimit() - used
    if (this.lastError) return { state: 'error', message: this.lastError, quotaRemaining: remaining }
    if (remaining <= 0) return { state: 'quota_exhausted', quotaRemaining: 0 }
    return { state: 'ok', quotaRemaining: remaining }
  }

  async dispose(): Promise<void> {
    // Nothing held open: the client is stateless over HTTP.
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
      (stream) => stream.contentDetails?.isReusable === true && stream.snippet?.title === this.settings.streamTitle,
    )
    if (reusable) return reusable
    return this.wrap(() => this.api.insertStream(this.settings.streamTitle, true))
  }

  private resultFor(broadcast: LiveBroadcast, stream: LiveStream): PrepareResult {
    const info = stream.cdn?.ingestionInfo
    const url = info?.rtmpsIngestionAddress ?? info?.ingestionAddress
    const key = info?.streamName
    if (!url || !key) {
      throw new YouTubeApiError(500, 'noIngestionInfo', 'YouTube did not return an ingest address for the stream.')
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

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface YouTubePluginOptions {
  now?: () => number
  fetchImpl?: Fetch
  /** Resolves the BYO OAuth client for a connected account. */
  resolveClient: (accountRef: string) => Promise<{ client: OAuthClient; refreshToken: string }>
}

export function youtubeProvider(options: YouTubePluginOptions): DestinationProvider {
  const now = options.now ?? Date.now

  return {
    id: 'youtube',
    displayName: 'YouTube',
    apiVersion: SDK_API_VERSION,
    configSchema,
    providesIngest: true,
    oauth: {
      begin: (client, redirectUri) => beginAuthorization({ ...client, clientSecret: '' }, redirectUri),
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

      return new YouTubeDestination(ctx, api, {
        privacy: (ctx.config.privacy as 'public' | 'unlisted' | 'private') ?? 'public',
        reusableStream: ctx.config.reusableStream !== false,
        streamTitle: String(ctx.config.streamTitle ?? 'Stream Scheduler'),
        playlistId: typeof ctx.config.playlistId === 'string' && ctx.config.playlistId ? ctx.config.playlistId : undefined,
        autoStartStop: ctx.config.autoStartStop !== false,
      })
    },
  }
}

export * from './api.js'
export * from './oauth.js'
export * from './quota.js'
export { FakeYouTube } from './fake-youtube.js'
export { QuotaExhaustedError }
