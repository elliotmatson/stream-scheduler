import type { QuotaRecorder } from '@scheduler/plugin-sdk'
import { assertAffordable, QUOTA_COSTS, type QuotaMethod } from './quota.js'

export const API_BASE = 'https://www.googleapis.com/youtube/v3'

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface TokenSource {
  /** A valid access token, refreshing first if necessary. */
  accessToken(): Promise<string>
}

export class YouTubeApiError extends Error {
  readonly code: string
  readonly status: number
  readonly reason: string | undefined
  readonly retryable: boolean
  readonly remediation: string | undefined

  constructor(status: number, reason: string | undefined, message: string) {
    super(message)
    this.name = 'YouTubeApiError'
    this.status = status
    this.reason = reason
    this.code = reason ?? `http-${status}`
    // 5xx and rate limits are worth another attempt; a rejected request is not.
    this.retryable = status >= 500 || status === 429
    this.remediation = remediationFor(reason)
  }
}

function remediationFor(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'quotaExceeded':
    case 'rateLimitExceeded':
      return 'The Google Cloud project is out of daily quota. Wait for the reset or request more.'
    case 'errorStreamInactive':
      return 'YouTube saw no incoming video. Check the encoder is actually pushing before the transition.'
    case 'invalidAutoStart':
    case 'invalidAutoStop':
      return 'This broadcast type does not support automatic start/stop; the scheduler will drive transitions instead.'
    case 'liveStreamingNotEnabled':
      return 'Live streaming is not enabled on this channel. Enable it in YouTube Studio; it can take 24 hours.'
    case 'insufficientPermissions':
      return 'The connected account cannot manage broadcasts on this channel. Reconnect with the right account.'
    default:
      return undefined
  }
}

export interface LiveBroadcast {
  id: string
  snippet: {
    title: string
    description?: string
    scheduledStartTime?: string
    scheduledEndTime?: string
  }
  status?: { privacyStatus?: string; lifeCycleStatus?: string }
  contentDetails?: { boundStreamId?: string; enableAutoStart?: boolean; enableAutoStop?: boolean }
}

export interface LiveStream {
  id: string
  snippet?: { title?: string }
  cdn?: {
    ingestionType?: string
    ingestionInfo?: { ingestionAddress?: string; streamName?: string; rtmpsIngestionAddress?: string }
  }
  status?: { streamStatus?: string }
  contentDetails?: { isReusable?: boolean }
}

/**
 * A thin, typed client over the YouTube Live Streaming API.
 *
 * Every call is budgeted before it is sent and recorded after, so the ledger
 * cannot drift from reality. There is deliberately no `search` method: at 100
 * units it is the most expensive call in the API, and nothing here needs it
 * that `liveBroadcasts.list` cannot serve for 1.
 */
export class YouTubeApi {
  constructor(
    private readonly tokens: TokenSource,
    private readonly quota: QuotaRecorder,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
    private readonly base: string = API_BASE,
  ) {}

  async insertBroadcast(input: {
    title: string
    description: string
    scheduledStartTime: string
    scheduledEndTime: string
    privacyStatus: string
    enableAutoStart: boolean
    enableAutoStop: boolean
    latencyPreference?: string
  }): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('liveBroadcasts.insert', 'POST', '/liveBroadcasts', {
      part: 'snippet,status,contentDetails',
    }, {
      snippet: {
        title: input.title,
        description: input.description,
        scheduledStartTime: input.scheduledStartTime,
        scheduledEndTime: input.scheduledEndTime,
      },
      status: { privacyStatus: input.privacyStatus, selfDeclaredMadeForKids: false },
      contentDetails: {
        // Preferring these over explicit transitions removes the classic
        // errorStreamInactive race, where the transition beats the encoder.
        enableAutoStart: input.enableAutoStart,
        enableAutoStop: input.enableAutoStop,
        ...(input.latencyPreference ? { latencyPreference: input.latencyPreference } : {}),
      },
    })
  }

  async listUpcomingBroadcasts(): Promise<LiveBroadcast[]> {
    const response = await this.call<{ items?: LiveBroadcast[] }>(
      'liveBroadcasts.list',
      'GET',
      '/liveBroadcasts',
      { part: 'snippet,status,contentDetails', broadcastStatus: 'upcoming', maxResults: '50', mine: 'true' },
    )
    return response.items ?? []
  }

  async getBroadcast(id: string): Promise<LiveBroadcast | undefined> {
    const response = await this.call<{ items?: LiveBroadcast[] }>('liveBroadcasts.list', 'GET', '/liveBroadcasts', {
      part: 'snippet,status,contentDetails',
      id,
    })
    return response.items?.[0]
  }

  async bindBroadcast(broadcastId: string, streamId: string): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('liveBroadcasts.bind', 'POST', '/liveBroadcasts/bind', {
      part: 'id,contentDetails',
      id: broadcastId,
      streamId,
    })
  }

  async transitionBroadcast(broadcastId: string, status: 'testing' | 'live' | 'complete'): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('liveBroadcasts.transition', 'POST', '/liveBroadcasts/transition', {
      part: 'id,status',
      id: broadcastId,
      broadcastStatus: status,
    })
  }

  async updateBroadcastPrivacy(broadcastId: string, privacyStatus: string): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('liveBroadcasts.update', 'PUT', '/liveBroadcasts', { part: 'id,status' }, {
      id: broadcastId,
      status: { privacyStatus },
    })
  }

  async deleteBroadcast(broadcastId: string): Promise<void> {
    await this.call<unknown>('liveBroadcasts.delete', 'DELETE', '/liveBroadcasts', { id: broadcastId })
  }

  async insertStream(title: string, isReusable: boolean): Promise<LiveStream> {
    return this.call<LiveStream>('liveStreams.insert', 'POST', '/liveStreams', {
      part: 'snippet,cdn,contentDetails',
    }, {
      snippet: { title },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable },
    })
  }

  async listStreams(): Promise<LiveStream[]> {
    const response = await this.call<{ items?: LiveStream[] }>('liveStreams.list', 'GET', '/liveStreams', {
      part: 'snippet,cdn,contentDetails,status',
      mine: 'true',
      maxResults: '50',
    })
    return response.items ?? []
  }

  async getStream(id: string): Promise<LiveStream | undefined> {
    const response = await this.call<{ items?: LiveStream[] }>('liveStreams.list', 'GET', '/liveStreams', {
      part: 'snippet,cdn,contentDetails,status',
      id,
    })
    return response.items?.[0]
  }

  async insertPlaylistItem(playlistId: string, videoId: string): Promise<{ id: string }> {
    return this.call<{ id: string }>('playlistItems.insert', 'POST', '/playlistItems', { part: 'snippet' }, {
      snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
    })
  }

  /**
   * The channel's playlists, newest first as the API returns them.
   *
   * One page of 50 is plenty for choosing where a service is filed, and it
   * costs a single quota unit — cheap enough to fetch whenever somebody
   * opens the form.
   */
  async listPlaylists(): Promise<{ id: string; title: string }[]> {
    const response = await this.call<{ items?: { id: string; snippet?: { title?: string } }[] }>(
      'playlists.list',
      'GET',
      '/playlists',
      { part: 'snippet', mine: 'true', maxResults: '50' },
    )
    return (response.items ?? []).map((item) => ({ id: item.id, title: item.snippet?.title ?? item.id }))
  }

  /** Identifies the channel behind the tokens, so the UI can name it. */
  async myChannel(): Promise<{ id: string; title: string }> {
    const response = await this.call<{ items?: { id: string; snippet?: { title?: string } }[] }>(
      'channels.list',
      'GET',
      '/channels',
      { part: 'snippet', mine: 'true' },
    )
    const channel = response.items?.[0]
    if (!channel) {
      throw new YouTubeApiError(404, 'channelNotFound', 'This Google account has no YouTube channel.')
    }
    return { id: channel.id, title: channel.snippet?.title ?? channel.id }
  }

  private async call<T>(
    method: QuotaMethod,
    verb: string,
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    // Checked before sending, so an exhausted budget fails cleanly instead of
    // leaving a broadcast created but unbindable.
    await assertAffordable(this.quota, method)

    const url = `${this.base}${path}?${new URLSearchParams(query).toString()}`
    const token = await this.tokens.accessToken()

    const response = await this.fetchImpl(url, {
      method: verb,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    // Recorded whatever the outcome: Google charges for a rejected call too.
    await this.quota.record(method, QUOTA_COSTS[method])

    const text = await response.text()
    if (!response.ok) throw toApiError(response.status, text)
    return (text ? JSON.parse(text) : {}) as T
  }
}

function toApiError(status: number, text: string): YouTubeApiError {
  let reason: string | undefined
  let message = text
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; errors?: { reason?: string }[] }
    }
    reason = parsed.error?.errors?.[0]?.reason
    message = parsed.error?.message ?? text
  } catch {
    // A non-JSON body (a proxy error page, say) is still worth surfacing.
  }
  return new YouTubeApiError(status, reason, message || `YouTube returned HTTP ${status}.`)
}
