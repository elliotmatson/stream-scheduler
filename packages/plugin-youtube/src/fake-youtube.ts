import type { Fetch } from './api.js'

/**
 * An in-memory YouTube, good enough to develop and test against.
 *
 * It is deliberately **not** idempotent: inserting twice makes two
 * broadcasts, exactly as the real API does. That is what makes the
 * idempotency and reconcile machinery testable at all — a forgiving fake
 * would quietly hide the bug it exists to catch.
 *
 * It also fails the test run if anything calls `search`, which at 100 units
 * is the most expensive call in the API and is never needed here.
 */

export interface FakeBroadcast {
  id: string
  title: string
  description: string
  scheduledStartTime: string
  scheduledEndTime: string
  privacyStatus: string
  lifeCycleStatus: string
  boundStreamId?: string
  enableAutoStart: boolean
  enableAutoStop: boolean
  /** YouTube's preview stage. On unless the insert turns it off, as on the
   *  real API, and while it is on a broadcast cannot go straight to live. */
  enableMonitorStream: boolean
  publishedAt: string
  deleted: boolean
}

export interface FakeStream {
  id: string
  title: string
  isReusable: boolean
  ingestionAddress: string
  streamName: string
  streamStatus: string
}

export interface FakeOptions {
  /** Reject calls with this reason until `failuresRemaining` runs out. */
  failWith?: { status: number; reason: string; times?: number }
  /** Reject the next insert *after* it has taken effect, modelling the crash
   *  window where the call landed but the answer never arrived. */
  dropResponseAfterInsert?: boolean
  /** Refuse deletion, as YouTube does for a broadcast that already started.
   *  The provider must then fall back to making it private. */
  refuseDelete?: boolean
  /** Fail one kind of call, leaving the rest alone. */
  failOn?: { verb: string; path: string; status: number; reason: string; times?: number }
  /** The fake's clock. When set, a start time already past is refused, as
   *  YouTube refuses it. */
  now?: () => number
}

/** What each `broadcastStatus` filter returns. Empty means everything. */
const BROADCAST_STATUS: Record<string, string[]> = {
  all: [],
  upcoming: ['created', 'ready', 'testStarting', 'testing'],
  active: ['liveStarting', 'live'],
  completed: ['complete'],
}

export class FakeYouTube {
  readonly broadcasts = new Map<string, FakeBroadcast>()
  readonly streams = new Map<string, FakeStream>()
  readonly playlistItems: { playlistId: string; videoId: string }[] = []
  /** The channel's playlists, as the picker would offer them. */
  playlists: { id: string; title: string }[] = [
    { id: 'PL-services', title: 'Sunday Services' },
    { id: 'PL-worship', title: 'Worship' },
  ]
  readonly calls: string[] = []
  options: FakeOptions = {}

  private nextId = 1
  private failuresLeft = 0
  private targetedFailuresLeft = 0

  constructor(options: FakeOptions = {}) {
    this.setOptions(options)
  }

  setOptions(options: FakeOptions): void {
    this.options = options
    this.failuresLeft = options.failWith?.times ?? (options.failWith ? Number.POSITIVE_INFINITY : 0)
    this.targetedFailuresLeft =
      options.failOn?.times ?? (options.failOn ? Number.POSITIVE_INFINITY : 0)
  }

  get liveBroadcastCount(): number {
    return [...this.broadcasts.values()].filter((b) => !b.deleted).length
  }

  /** A `fetch` the API client can be constructed with. */
  fetch: Fetch = async (url, init) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/^.*\/youtube\/v3/, '')
    const verb = init?.method ?? 'GET'
    const query = parsed.searchParams
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined

    if (path.includes('/search')) {
      throw new Error(
        'Something called search.list. It costs 100 units and nothing here needs it; ' +
          'use liveBroadcasts.list with known ids instead.',
      )
    }

    this.calls.push(`${verb} ${path}`)

    if (this.failuresLeft > 0 && this.options.failWith) {
      this.failuresLeft--
      return this.error(
        this.options.failWith.status,
        this.options.failWith.reason,
        'simulated failure',
      )
    }
    const target = this.options.failOn
    if (target && this.targetedFailuresLeft > 0 && target.verb === verb && target.path === path) {
      this.targetedFailuresLeft--
      return this.error(target.status, target.reason, 'simulated failure')
    }

    if (path === '/liveBroadcasts' && verb === 'POST') return this.insertBroadcast(body)
    if (path === '/liveBroadcasts' && verb === 'GET') return this.listBroadcasts(query)
    if (path === '/liveBroadcasts' && verb === 'PUT') return this.updateBroadcast(body)
    if (path === '/liveBroadcasts' && verb === 'DELETE') return this.deleteBroadcast(query)
    if (path === '/liveBroadcasts/bind') return this.bind(query)
    if (path === '/liveBroadcasts/transition') return this.transition(query)
    if (path === '/liveStreams' && verb === 'POST') return this.insertStream(body)
    if (path === '/liveStreams' && verb === 'GET') return this.listStreams(query)
    if (path === '/playlistItems' && verb === 'POST') return this.insertPlaylistItem(body)
    if (path === '/playlists' && verb === 'GET') return this.listPlaylists(query)
    if (path === '/channels' && verb === 'GET') return this.myChannel()

    return this.error(404, 'notFound', `the fake does not implement ${verb} ${path}`)
  }

  /** What a channel has to file videos in. Named like a church's would be. */
  private listPlaylists(query: URLSearchParams): ReturnType<Fetch> {
    return this.page(
      this.playlists.map((playlist) => ({ id: playlist.id, snippet: { title: playlist.title } })),
      query,
    )
  }

  private myChannel(): ReturnType<Fetch> {
    return this.ok({ items: [{ id: 'chan-1', snippet: { title: 'Grace Bible Church' } }] })
  }

  private insertBroadcast(body: Record<string, unknown> | undefined): ReturnType<Fetch> {
    const snippet = (body?.snippet ?? {}) as Record<string, string>
    const status = (body?.status ?? {}) as Record<string, string>
    const details = (body?.contentDetails ?? {}) as Record<string, unknown> & {
      monitorStream?: { enableMonitorStream?: boolean }
    }

    const now = this.options.now?.()
    if (now !== undefined && Date.parse(snippet.scheduledStartTime ?? '') < now) {
      return this.error(
        400,
        'invalidScheduledStartTime',
        'Scheduled start time must be in the future.',
      )
    }

    const id = `bc-${this.nextId++}`
    const broadcast: FakeBroadcast = {
      id,
      title: snippet.title ?? '',
      description: snippet.description ?? '',
      scheduledStartTime: snippet.scheduledStartTime ?? '',
      scheduledEndTime: snippet.scheduledEndTime ?? '',
      privacyStatus: status.privacyStatus ?? 'private',
      lifeCycleStatus: 'created',
      enableAutoStart: details.enableAutoStart === true,
      enableAutoStop: details.enableAutoStop === true,
      enableMonitorStream: details.monitorStream?.enableMonitorStream !== false,
      publishedAt: new Date(now ?? Date.now()).toISOString(),
      deleted: false,
    }
    this.broadcasts.set(id, broadcast)

    if (this.options.dropResponseAfterInsert) {
      // The broadcast exists; the caller never learns its id. This is the
      // ambiguous crash window the idempotency key is for.
      this.options.dropResponseAfterInsert = false
      return this.error(503, 'backendError', 'the response was lost')
    }
    return this.ok(this.broadcastJson(broadcast))
  }

  private listBroadcasts(query: URLSearchParams): ReturnType<Fetch> {
    // The API takes exactly one filter, and rejects a request carrying two
    // before it looks at anything else. Enforced here because a fake that
    // is more forgiving than the service is a fake that passes while the
    // real call fails at 09:00 — which is exactly what happened.
    const filters = ['id', 'mine', 'broadcastStatus'].filter((name) => query.get(name))
    if (filters.length > 1) {
      return this.error(
        400,
        'incompatibleParameters',
        `Incompatible parameters specified in the request: ${filters.join(', ')}`,
      )
    }

    const id = query.get('id')
    const all = [...this.broadcasts.values()].filter((b) => !b.deleted)
    if (id) {
      const found = all.filter((b) => b.id === id)
      // A transition YouTube has accepted finishes a moment later; reading
      // the broadcast again is what sees it through.
      const items = found.map((b) => this.broadcastJson(b))
      for (const b of found) this.settle(b)
      return this.ok({ items })
    }
    const wanted = BROADCAST_STATUS[query.get('broadcastStatus') ?? 'all'] ?? []
    const matching = all.filter((b) => wanted.length === 0 || wanted.includes(b.lifeCycleStatus))
    return this.page(
      matching.map((b) => this.broadcastJson(b)),
      query,
    )
  }

  private settle(broadcast: FakeBroadcast): void {
    if (broadcast.lifeCycleStatus === 'liveStarting') broadcast.lifeCycleStatus = 'live'
    if (broadcast.lifeCycleStatus === 'testStarting') broadcast.lifeCycleStatus = 'testing'
  }

  private updateBroadcast(body: Record<string, unknown> | undefined): ReturnType<Fetch> {
    const id = String(body?.id ?? '')
    const broadcast = this.broadcasts.get(id)
    if (!broadcast) return this.error(404, 'notFound', 'no such broadcast')
    const status = (body?.status ?? {}) as Record<string, string>
    if (status.privacyStatus) broadcast.privacyStatus = status.privacyStatus
    return this.ok(this.broadcastJson(broadcast))
  }

  private deleteBroadcast(query: URLSearchParams): ReturnType<Fetch> {
    const broadcast = this.broadcasts.get(query.get('id') ?? '')
    if (!broadcast) return this.error(404, 'notFound', 'no such broadcast')
    if (this.options.refuseDelete) {
      return this.error(403, 'forbidden', 'this broadcast cannot be deleted')
    }
    broadcast.deleted = true
    return this.ok({})
  }

  private bind(query: URLSearchParams): ReturnType<Fetch> {
    const broadcast = this.broadcasts.get(query.get('id') ?? '')
    if (!broadcast) return this.error(404, 'notFound', 'no such broadcast')
    const streamId = query.get('streamId')
    if (streamId && !this.streams.has(streamId))
      return this.error(404, 'notFound', 'no such stream')
    if (!['created', 'ready'].includes(broadcast.lifeCycleStatus)) {
      return this.error(403, 'invalidTransition', 'a broadcast on air cannot be rebound')
    }
    broadcast.boundStreamId = streamId ?? undefined
    broadcast.lifeCycleStatus = streamId ? 'ready' : 'created'
    return this.ok(this.broadcastJson(broadcast))
  }

  /**
   * YouTube's lifecycle, as strictly as YouTube keeps it.
   *
   * created → ready on bind; ready → testing only with the preview stage on;
   * ready → live only with it off; testing → live; live or testing →
   * complete. Going to testing or live needs the stream to be receiving,
   * and passes through a starting state for one read. Asking for where it
   * already is is `redundantTransition`; anything else is
   * `invalidTransition`. A fake that let created go straight to complete
   * is how a broadcast that never aired passed every test.
   */
  private transition(query: URLSearchParams): ReturnType<Fetch> {
    const broadcast = this.broadcasts.get(query.get('id') ?? '')
    if (!broadcast) return this.error(404, 'notFound', 'no such broadcast')
    const target = query.get('broadcastStatus') ?? ''
    const from = broadcast.lifeCycleStatus
    const stream = broadcast.boundStreamId ? this.streams.get(broadcast.boundStreamId) : undefined

    const starting = target === 'testing' ? 'testStarting' : `${target}Starting`
    if (from === target || from === starting) {
      return this.error(403, 'redundantTransition', `the broadcast is already ${from}`)
    }
    const allowed =
      (target === 'testing' && from === 'ready' && broadcast.enableMonitorStream) ||
      (target === 'live' && from === 'ready' && !broadcast.enableMonitorStream) ||
      (target === 'live' && from === 'testing') ||
      (target === 'complete' && (from === 'live' || from === 'testing'))
    if (!allowed) {
      return this.error(403, 'invalidTransition', `cannot go from ${from} to ${target}`)
    }
    if ((target === 'live' || target === 'testing') && stream?.streamStatus !== 'active') {
      return this.error(403, 'errorStreamInactive', 'the stream is not active')
    }
    broadcast.lifeCycleStatus = target === 'complete' ? 'complete' : starting
    return this.ok(this.broadcastJson(broadcast))
  }

  private insertStream(body: Record<string, unknown> | undefined): ReturnType<Fetch> {
    const snippet = (body?.snippet ?? {}) as Record<string, string>
    const details = (body?.contentDetails ?? {}) as Record<string, boolean>
    const id = `st-${this.nextId++}`
    const stream: FakeStream = {
      id,
      title: snippet.title ?? '',
      isReusable: details.isReusable ?? false,
      ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
      streamName: `live_${id}_key`,
      streamStatus: 'inactive',
    }
    this.streams.set(id, stream)
    return this.ok(this.streamJson(stream))
  }

  private listStreams(query: URLSearchParams): ReturnType<Fetch> {
    const id = query.get('id')
    const items = [...this.streams.values()].filter((s) => !id || s.id === id)
    return this.page(
      items.map((s) => this.streamJson(s)),
      query,
    )
  }

  private insertPlaylistItem(body: Record<string, unknown> | undefined): ReturnType<Fetch> {
    const snippet = (body?.snippet ?? {}) as {
      playlistId?: string
      resourceId?: { videoId?: string }
    }
    if (!snippet.playlistId) return this.error(400, 'playlistIdRequired', 'playlistId is required')
    this.playlistItems.push({
      playlistId: snippet.playlistId,
      videoId: snippet.resourceId?.videoId ?? '',
    })
    return this.ok({ id: `pli-${this.nextId++}` })
  }

  /** Simulates the encoder actually pushing, so a transition can succeed. */
  markStreamActive(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) stream.streamStatus = 'active'
  }

  /** Every stream receiving, as when every encoder is pushing. */
  markAllStreamsActive(): void {
    for (const stream of this.streams.values()) stream.streamStatus = 'active'
  }

  /** Simulates the encoder dropping. The broadcast is left as it is. */
  markStreamInactive(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) stream.streamStatus = 'inactive'
  }

  /** One page of `items`, honouring `maxResults` and `pageToken`. */
  private page(items: unknown[], query: URLSearchParams): ReturnType<Fetch> {
    const size = Number(query.get('maxResults') ?? 5) || 5
    const offset = Number(query.get('pageToken') ?? 0) || 0
    const next = offset + size < items.length ? String(offset + size) : undefined
    return this.ok({
      items: items.slice(offset, offset + size),
      ...(next === undefined ? {} : { nextPageToken: next }),
    })
  }

  private broadcastJson(b: FakeBroadcast): unknown {
    return {
      id: b.id,
      snippet: {
        title: b.title,
        description: b.description,
        scheduledStartTime: b.scheduledStartTime,
        scheduledEndTime: b.scheduledEndTime,
        publishedAt: b.publishedAt,
      },
      status: { privacyStatus: b.privacyStatus, lifeCycleStatus: b.lifeCycleStatus },
      contentDetails: {
        ...(b.boundStreamId === undefined ? {} : { boundStreamId: b.boundStreamId }),
        enableAutoStart: b.enableAutoStart,
        enableAutoStop: b.enableAutoStop,
        monitorStream: { enableMonitorStream: b.enableMonitorStream },
      },
    }
  }

  private streamJson(s: FakeStream): unknown {
    return {
      id: s.id,
      snippet: { title: s.title },
      cdn: {
        ingestionType: 'rtmp',
        ingestionInfo: {
          ingestionAddress: s.ingestionAddress,
          rtmpsIngestionAddress: s.ingestionAddress.replace('rtmp://', 'rtmps://'),
          streamName: s.streamName,
        },
      },
      status: { streamStatus: s.streamStatus },
      contentDetails: { isReusable: s.isReusable },
    }
  }

  private async ok(value: unknown): ReturnType<Fetch> {
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  }

  private async error(status: number, reason: string, message: string): ReturnType<Fetch> {
    return {
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { message, errors: [{ reason }] } }),
    }
  }
}
