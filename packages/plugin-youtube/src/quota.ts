import type { QuotaRecorder } from '@scheduler/plugin-sdk'

/**
 * Quota costs for the calls this provider makes.
 *
 * These are a design estimate taken from Google's published table and should
 * be re-checked against
 * https://developers.google.com/youtube/v3/determine_quota_cost
 * when the provider is next touched: Google has changed them before, and a
 * stale table under-counts silently until a Sunday morning fails.
 *
 * The default project budget is 10,000 units per day.
 */
export const QUOTA_COSTS = {
  'liveBroadcasts.insert': 50,
  'liveBroadcasts.list': 1,
  'liveBroadcasts.bind': 50,
  'liveBroadcasts.transition': 50,
  'liveBroadcasts.update': 50,
  'liveBroadcasts.delete': 50,
  'liveStreams.insert': 50,
  'liveStreams.list': 1,
  'playlistItems.insert': 50,
  'playlists.list': 1,
  'videos.update': 50,
  'channels.list': 1,
} as const

export type QuotaMethod = keyof typeof QUOTA_COSTS

export const DEFAULT_DAILY_LIMIT = 10_000

/**
 * Held back for the calls that actually make a stream happen.
 *
 * Roughly two services' worth: one output costs about 400 units from
 * prepare to the end of the broadcast. Playlist lookups and metadata stop
 * once the day's spend crosses into it, so an afternoon of browsing forms
 * cannot eat the budget the evening service needs.
 */
export const CRITICAL_RESERVE = 1_000

/**
 * Calls without which a scheduled event does not happen, or does not end
 * cleanly.
 *
 * Every call prepare, going live, ending and cleaning up make — including
 * the cheap lookups they start with. A reserve that let the broadcast be
 * created but refused the lookup that comes before it, or the delete that
 * undoes it, would protect nothing.
 */
const CRITICAL: ReadonlySet<string> = new Set<QuotaMethod>([
  'liveBroadcasts.insert',
  'liveBroadcasts.list',
  'liveBroadcasts.bind',
  'liveBroadcasts.transition',
  'liveBroadcasts.update',
  'liveBroadcasts.delete',
  'liveStreams.insert',
  'liveStreams.list',
])

export function isCritical(method: QuotaMethod): boolean {
  return CRITICAL.has(method)
}

export class QuotaExhaustedError extends Error {
  readonly code = 'quota-exhausted'
  readonly retryable = false
  readonly remediation: string

  constructor(method: string, used: number, limit: number) {
    super(
      `The YouTube API budget for today is spent (${used} of ${limit} units); "${method}" was not sent.`,
    )
    this.name = 'QuotaExhaustedError'
    this.remediation =
      'Wait for the daily reset (midnight Pacific), or request a higher quota for the Google Cloud project. ' +
      'If this keeps happening, check for a runaway poll rather than raising the cap.'
  }
}

/**
 * A quota recorder holding everything in memory.
 *
 * The host supplies a durable one backed by the ledger table; this exists so
 * tests, and a first run before any account is connected, have something
 * valid to use.
 */
export class InMemoryQuota implements QuotaRecorder {
  private used = 0
  readonly calls: { method: string; units: number }[] = []

  constructor(private readonly limit: number = DEFAULT_DAILY_LIMIT) {}

  async record(method: string, units: number): Promise<number> {
    this.used += units
    this.calls.push({ method, units })
    return this.used
  }

  async usedToday(): Promise<number> {
    return this.used
  }

  dailyLimit(): number {
    return this.limit
  }
}

/**
 * Decides whether a call fits in what is left of today.
 *
 * Checked before the call, not after: the point is to fail with a clear
 * message instead of half-creating a broadcast and then being unable to bind
 * a stream to it.
 */
export async function assertAffordable(quota: QuotaRecorder, method: QuotaMethod): Promise<void> {
  const cost = QUOTA_COSTS[method]
  const used = await quota.usedToday()
  const limit = quota.dailyLimit()
  const ceiling = isCritical(method) ? limit : limit - CRITICAL_RESERVE

  if (used + cost > ceiling) throw new QuotaExhaustedError(method, used, limit)
}

/**
 * Decides whether a sequence of calls fits, before the first is sent.
 *
 * For work that would leave something half-made if it ran out part-way:
 * a broadcast created and then never bound.
 */
export async function assertAffordableAll(
  quota: QuotaRecorder,
  methods: QuotaMethod[],
): Promise<void> {
  const cost = methods.reduce((total, method) => total + QUOTA_COSTS[method], 0)
  const used = await quota.usedToday()
  const limit = quota.dailyLimit()
  const ceiling = methods.every(isCritical) ? limit : limit - CRITICAL_RESERVE
  if (used + cost > ceiling) throw new QuotaExhaustedError(methods[0] ?? 'prepare', used, limit)
}
