import type { ConfigField, ConfigValues } from './config-fields.js'
import type { JsonObject } from './json.js'

/**
 * The contract for a streaming service: YouTube, a generic RTMP endpoint,
 * anything the pipeline can terminate in.
 *
 * Parallel to the device contract, and under the same discipline: every
 * method is async and takes and returns only serializable values, so a
 * destination can move into a child process later without an API change.
 *
 * The shape is driven by what the run engine needs rather than by what any
 * one API offers. `prepare` must be safe to attempt twice — the engine
 * guarantees an idempotency key is committed before it is ever called, and
 * `reconcile` is how the destination reports what an interrupted attempt
 * already created.
 */

export interface DestinationMetadata {
  /** Already rendered from the series' templates, in the event's timezone. */
  title: string
  description: string
  /** Epoch ms. */
  scheduledStart: number
  scheduledEnd: number
  privacy: 'public' | 'unlisted' | 'private'
  /** Provider-specific extras from the destination's config. */
  extra?: JsonObject
}

export interface PrepareInput {
  /** Committed before the call, so an interrupted attempt is recognisable. */
  idempotencyKey: string
  metadata: DestinationMetadata
}

export interface PrepareResult {
  /** What the service called the thing we made, for reconcile and cleanup. */
  externalId: string
  /** Where the encoder should push, and the key it needs. */
  ingest: { url: string; key: string }
  /** Shown in the run timeline and linked from the UI. */
  watchUrl?: string
  detail?: JsonObject
}

/**
 * Durable per-day API budget accounting, provided by the host.
 *
 * Lives in the contract rather than inside one provider because the budget
 * is a property of the credentials, survives restarts, and has to be visible
 * in the UI before it matters — hitting the cap mid-Sunday should have been
 * a warning on Saturday.
 */
export interface QuotaRecorder {
  /** Records spend and returns the day's running total. */
  record(method: string, units: number): Promise<number>
  usedToday(): Promise<number>
  dailyLimit(): number
}

export interface DestinationContext {
  destinationId: string
  config: ConfigValues
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonObject): void
  quota: QuotaRecorder
  /** Reads and writes secrets (refresh tokens) through the host's vault, so
   *  a provider never chooses how a credential is stored. */
  secrets: {
    read(ref: string): Promise<string | undefined>
    write(ref: string, value: string): Promise<void>
  }
}

export interface DestinationInstance {
  /**
   * Create or adopt the remote broadcast and return where to push.
   *
   * Called during the run's prepare phase, typically T-30m, so that a bad
   * token or an exhausted quota surfaces while someone can still fix it.
   */
  prepare(input: PrepareInput): Promise<PrepareResult>

  /**
   * Did a previous, interrupted `prepare` already land?
   *
   * Return its result to adopt it, or undefined if the call never took
   * effect. Without this the engine can only guess, which is how a channel
   * ends up with three broadcasts for one service.
   */
  reconcile(input: PrepareInput): Promise<PrepareResult | undefined>

  /**
   * Undo a prepare whose run was abandoned, so the channel does not collect
   * empty public broadcasts. Best-effort by contract: if the remote refuses
   * deletion, make it private rather than throwing.
   */
  discard(input: { externalId: string }): Promise<void>

  /** Called once the event has finished: playlists, final metadata, tidy-up. */
  finalize(input: { externalId: string; metadata: DestinationMetadata }): Promise<void>

  /** Live health of the account behind this destination. */
  status(): Promise<DestinationStatus>

  dispose(): Promise<void>
}

export interface DestinationStatus {
  state: 'ok' | 'reauth_required' | 'quota_exhausted' | 'error'
  message?: string
  /** Remaining daily budget, where the service has one worth showing. */
  quotaRemaining?: number
}

export interface DestinationProvider {
  id: string
  displayName: string
  apiVersion: '1'
  configSchema: ConfigField[]
  /** True when this provider issues its own ingest URL and key, so the user
   *  does not enter a stream key by hand. */
  providesIngest: boolean
  createDestination(ctx: DestinationContext): Promise<DestinationInstance>
}
