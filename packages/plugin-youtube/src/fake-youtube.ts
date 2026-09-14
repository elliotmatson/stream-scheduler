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
}

export class FakeYouTube {
  readonly broadcasts = new Map<string, FakeBroadcast>()
  readonly streams = new Map<string, FakeStream>()
  readonly playlistItems: { playlistId: string; videoId: string }[] = []
  readonly calls: string[] = []
  options: FakeOptions = {}

  private nextId = 1
  private failuresLeft = 0

  constructor(options: FakeOptions = {}) {
    this.setOptions(options)
  }

  setOptions(options: FakeOptions): void {
    this.options = options
    this.failuresLeft = options.failWith?.times ?? (options.failWith ? Number.POSITIVE_INFINITY : 0)
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
      return this.error(this.options.failWith.status, this.options.failWith.reason, 'simulated failure')
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

    return this.error(404, 'notFound', `the fake does not implement ${verb} ${path}`)
  }

  private insertBroadcast(body: Record<string, unknown> | undefined): ReturnType<Fetch> {
    const snippet = (body?.snippet ?? {}) as Record<string, string>
    const status = (body?.status ?? {}) as Record<string, string>
    const details = (body?.contentDetails ?? {}) as Record<string, boolean>

    const id = `bc-${this.nextId++}`
    const broadcast: FakeBroadcast = {
      id,
      title: snippet.title ?? '',
      description: snippet.description ?? '',
      scheduledStartTime: snippet.scheduledStartTime ?? '',
      scheduledEndTime: snippet.scheduledEndTime ?? '',
      privacyStatus: status.privacyStatus ?? 'private',
      lifeCycleStatus: 'created',
      enableAutoStart: details.enableAutoStart ?? false,
      enableAutoStop: details.enableAutoStop ?? false,
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
    const id = query.get('id')
    const all = [...this.broadcasts.values()].filter((b) => !b.deleted)
    const items = id ? all.filter((b) => b.id === id) : all.filter((b) => b.lifeCycleStatus !== 'complete')
    return this.ok({ items: items.map((b) => this.broadcastJson(b)) })
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
    if (streamId && !this.streams.has(streamId)) return this.error(404, 'notFound', 'no such stream')
    broadcast.boundStreamId = streamId ?? undefined
    return this.ok(this.broadcastJson(broadcast))
  }

  private transition(query: URLSearchParams): ReturnType<Fetch> {
    const broadcast = this.broadcasts.get(query.get('id') ?? '')
    if (!broadcast) return this.error(404, 'notFound', 'no such broadcast')
    const target = query.get('broadcastStatus') ?? ''
    const stream = broadcast.boundStreamId ? this.streams.get(broadcast.boundStreamId) : undefined

    // The real API refuses to go live without ingest, which is the failure
    // the autoStart path exists to avoid.
    if (target === 'live' && stream?.streamStatus !== 'active') {
      return this.error(403, 'errorStreamInactive', 'the stream is not active')
    }
    broadcast.lifeCycleStatus = target
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
    return this.ok({ items: items.map((s) => this.streamJson(s)) })
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

  private broadcastJson(b: FakeBroadcast): unknown {
    return {
      id: b.id,
      snippet: {
        title: b.title,
        description: b.description,
        scheduledStartTime: b.scheduledStartTime,
        scheduledEndTime: b.scheduledEndTime,
      },
      status: { privacyStatus: b.privacyStatus, lifeCycleStatus: b.lifeCycleStatus },
      contentDetails: {
        ...(b.boundStreamId === undefined ? {} : { boundStreamId: b.boundStreamId }),
        enableAutoStart: b.enableAutoStart,
        enableAutoStop: b.enableAutoStop,
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
