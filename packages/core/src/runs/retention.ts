import type { Clock, MediaItem, NodeState } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { outputsForSeries, type OutputSettings } from '../events/outputs.js'
import type { RecordingArtifact, RecordingLedger } from './artifacts.js'

/**
 * Which recordings a policy says are past their keep-by date.
 *
 * This module is the decision; `sweep.ts` is the act. Keeping them apart
 * is what makes the act reviewable — the hard part is deciding what is
 * eligible, and it is decided in one place whether a person pressed
 * something or the hourly sweep came round.
 *
 * Four rails, and they are the reason this is safe to act on:
 *
 *  - Only files this scheduler recorded, from its own ledger. A card that
 *    somebody put a camera dump on is not this app's business.
 *  - Only runs that finished. A recording still being written, or one whose
 *    run died halfway, is not a candidate for anything.
 *  - Always keep the newest few, whatever the dates say. A quiet month must
 *    not empty a card, and a card running out of room must not either.
 *  - Nothing at all unless a limit was set. An output with no policy is
 *    never swept; setting one is what asks for it to be enforced.
 */

export interface RetentionPolicy {
  /** Recordings older than this are eligible. Absent means age is no reason. */
  keepDays?: number
  /** Never let the newest this many go, whatever their age. */
  keepLast?: number
  /**
   * Sweep early when the card has less than this much recording time left.
   *
   * The case a keep-for date cannot cover: a fortnight of extra services
   * fills a card long before anything on it is thirty days old, and the
   * first anybody hears of it is a recording that stops halfway through.
   * Under that much headroom, everything past `keepLast` is eligible
   * whatever its age — which is exactly what `keepLast` is a promise
   * about.
   */
  minFreeHours?: number
}

/**
 * The floor, when a policy sets no other.
 *
 * Ten, which on a weekly service is about a quarter. Enough that somebody
 * noticing in March that they wanted January still has February, and few
 * enough to be worth sweeping at all.
 */
export const DEFAULT_KEEP_LAST = 10

export interface RetentionCandidate {
  artifact: RecordingArtifact
  /** True when the device's own listing agrees the file is there. */
  onDevice: boolean
  /**
   * What the device calls it, where the device has told us.
   *
   * Not the same string as `artifact.filename`: we ask for "service-5" and
   * the deck writes "service-5.mov", or "service-5_1.mov" when the name
   * was taken. Anything that acts on the file — deleting it, above all —
   * has to use the deck's name, not ours.
   */
  deviceName?: string
  ageMs: number
}

export interface RetentionReport {
  outputId: string
  outputLabel: string
  seriesLabel: string
  deviceId: string
  nodeId: string
  policy: RetentionPolicy
  /** Everything of ours still on the card, newest first — including
   *  anything still being recorded. */
  kept: RetentionCandidate[]
  /** What the policy says could go. Empty when no policy is set. */
  wouldDelete: RetentionCandidate[]
  /** Named by the device and not in our ledger — somebody else's files. */
  unknownToUs: string[]
  /** `keepLast` with the default filled in, so a screen need not know it. */
  effectiveKeepLast: number
  /** Whether the card is under its free-space floor, so age stopped
   *  deciding and everything past `keepLast` is eligible. */
  underPressure: boolean
  /** Recording time left, where the device reported it. */
  freeMs?: number
}

/**
 * The policy an output carries, ignoring anything nonsensical.
 *
 * Re-checked here rather than trusted from the row: settings are stored as
 * JSON and a database written by an older version, or by hand, is not
 * bound by today's schema. A `keepDays` of zero is dropped rather than
 * honoured — it would make every recording eligible the moment it
 * finished, which is never what somebody meant to type.
 */
export function policyOf(settings: OutputSettings): RetentionPolicy {
  const raw = settings.retention
  if (typeof raw !== 'object' || raw === null) return {}
  return {
    ...(typeof raw.keepDays === 'number' && raw.keepDays > 0 ? { keepDays: raw.keepDays } : {}),
    ...(typeof raw.keepLast === 'number' && raw.keepLast >= 0 ? { keepLast: raw.keepLast } : {}),
    ...(typeof raw.minFreeHours === 'number' && raw.minFreeHours > 0
      ? { minFreeHours: raw.minFreeHours }
      : {}),
  }
}

/**
 * True when a policy would ever delete anything.
 *
 * Also the consent: setting a limit is what asks for it to be enforced,
 * and an output with neither limit is never swept, by hand or otherwise.
 */
export function isConfigured(policy: RetentionPolicy): boolean {
  return policy.keepDays !== undefined || policy.minFreeHours !== undefined
}

/**
 * What one output's policy would remove, given what is on the device.
 *
 * `media` is the device's own listing where there is one. It is used to
 * confirm a file is really there and to notice files that are not ours; a
 * device that cannot list its media still gets an answer, from the ledger
 * alone.
 */
export function assess(input: {
  outputId: string
  outputLabel: string
  seriesLabel: string
  deviceId: string
  nodeId: string
  policy: RetentionPolicy
  artifacts: RecordingArtifact[]
  media?: MediaItem[]
  /** Recording time left on the slot, where the device reports it. */
  freeMs?: number
  now: number
}): RetentionReport {
  const names =
    input.media === undefined ? undefined : new Set(input.media.map((item) => item.name))

  // Everything of ours the card still holds, in-progress recordings
  // included: a file being written is on the card, and a screen that hides
  // it is lying about what is there. The rail that matters lives on
  // `wouldDelete` below, where it actually decides something.
  const ours = input.artifacts
    .map((artifact) => {
      const listed = names === undefined ? undefined : listedAs(names, artifact.filename)
      return {
        artifact,
        // A device that cannot list its media is taken at the ledger's word.
        onDevice: names === undefined || listed !== undefined,
        ...(listed === undefined ? {} : { deviceName: listed }),
        ageMs: Math.max(input.now - artifact.startedAt, 0),
      }
    })
    .sort((a, b) => b.artifact.startedAt - a.artifact.startedAt)

  const keepLast = input.policy.keepLast ?? DEFAULT_KEEP_LAST
  const cutoff =
    input.policy.keepDays === undefined ? undefined : input.policy.keepDays * 86_400_000

  // The card is running out of room, and the policy said what to do about
  // it. Age stops deciding: everything past the newest `keepLast` is
  // eligible, which is the promise `keepLast` was making all along.
  //
  // Only when the device actually said how much room is left. A deck that
  // does not report headroom must not have silence read as "nearly full".
  const underPressure =
    input.policy.minFreeHours !== undefined &&
    input.freeMs !== undefined &&
    input.freeMs < input.policy.minFreeHours * 3_600_000

  const wouldDelete = isConfigured(input.policy)
    ? ours.filter(
        (candidate, index) =>
          // A recording still being written, or one whose run died partway,
          // is not a candidate for anything.
          candidate.artifact.endedAt !== null &&
          index >= keepLast &&
          (underPressure || (cutoff !== undefined && candidate.ageMs > cutoff)) &&
          candidate.onDevice,
      )
    : []

  const known = new Set(ours.map((candidate) => candidate.artifact.filename))
  const unknownToUs = (input.media ?? [])
    .map((item) => item.name)
    .filter((name) => ![...known].some((filename) => sameFile(filename, name)))

  return {
    outputId: input.outputId,
    outputLabel: input.outputLabel,
    seriesLabel: input.seriesLabel,
    deviceId: input.deviceId,
    nodeId: input.nodeId,
    policy: input.policy,
    kept: ours,
    wouldDelete,
    unknownToUs,
    effectiveKeepLast: keepLast,
    underPressure,
    ...(input.freeMs === undefined ? {} : { freeMs: input.freeMs }),
  }
}

/**
 * Whether a listed clip is the file we recorded.
 *
 * A deck appends its own extension, and sometimes a suffix when a name is
 * taken, so the recorded name is a prefix of what comes back rather than an
 * exact match.
 */
function sameFile(filename: string, listed: string): boolean {
  if (listed === filename) return true
  const withoutExtension = listed.replace(/\.[^.]+$/, '')
  return withoutExtension === filename || withoutExtension.startsWith(`${filename}_`)
}

/** The name the device gave our file, if it has it at all. */
function listedAs(names: Set<string>, filename: string): string | undefined {
  for (const name of names) if (sameFile(filename, name)) return name
  return undefined
}

/** Every recording output that has a device, with its policy. */
export function recordingOutputs(db: Db): {
  outputId: string
  outputLabel: string
  seriesLabel: string
  deviceId: string
  nodeId: string
  policy: RetentionPolicy
}[] {
  const series = db.prepare('SELECT id, label FROM event_series WHERE enabled = 1').all() as {
    id: string
    label: string
  }[]

  const out = []
  for (const row of series) {
    for (const output of outputsForSeries(db, row.id)) {
      if (output.kind !== 'recording' || !output.deviceId || !output.nodeId) continue
      out.push({
        outputId: output.id,
        outputLabel: output.label,
        seriesLabel: row.label,
        deviceId: output.deviceId,
        nodeId: output.nodeId,
        policy: policyOf(output.settings),
      })
    }
  }
  return out
}

/** Everything the screens need: one report per recording output. */
export async function reportAll(deps: {
  db: Db
  ledger: RecordingLedger
  clock: Clock
  listMedia: (deviceId: string, nodeId: string) => Promise<MediaItem[] | undefined>
  /** Recording time left on the node's media, where it says. */
  freeMs?: (deviceId: string, nodeId: string) => number | undefined
}): Promise<RetentionReport[]> {
  const now = deps.clock.now()
  // One listing per node, however many outputs write to it.
  const listings = new Map<string, MediaItem[] | undefined>()

  const reports: RetentionReport[] = []
  for (const output of recordingOutputs(deps.db)) {
    const key = `${output.deviceId}/${output.nodeId}`
    if (!listings.has(key)) {
      listings.set(key, await deps.listMedia(output.deviceId, output.nodeId))
    }
    const media = listings.get(key)
    const free = deps.freeMs?.(output.deviceId, output.nodeId)
    reports.push(
      assess({
        ...output,
        artifacts: deps.ledger.forOutput(output.outputId),
        ...(media === undefined ? {} : { media }),
        ...(free === undefined ? {} : { freeMs: free }),
        now,
      }),
    )
  }
  return reports
}

/**
 * How much recording time a node says is left on its media.
 *
 * The active slot's headroom where the device names one, and the largest
 * otherwise: a deck that rolls onto a second card has that card's room
 * available to it too, and treating a nearly-full first card as the whole
 * story would sweep for no reason.
 */
export function freeMsOf(states: NodeState[]): number | undefined {
  let best: number | undefined
  for (const state of states) {
    const slots = state.recording?.slots ?? []
    const active = slots.find((slot) => slot.active)?.remainingMs
    const candidate =
      active ??
      (slots.length > 0
        ? slots.reduce<number | undefined>(
            (most, slot) =>
              slot.remainingMs === undefined ? most : Math.max(most ?? 0, slot.remainingMs),
            undefined,
          )
        : state.recording?.remainingMs)
    if (candidate === undefined) continue
    best = best === undefined ? candidate : Math.max(best, candidate)
  }
  return best
}

/**
 * The event, if any, that is mid-run on this device.
 *
 * Three things are refused while one is: erasing a card, re-pointing an
 * encoder, and sweeping old recordings. All three would be undone by — or
 * worse, would interfere with — a run part-way through its window.
 */
export function eventMidRunOn(db: Db, deviceId: string): string | undefined {
  return (
    db
      .prepare(
        `SELECT s.label AS label
           FROM run r
           JOIN occurrence o ON o.id = r.occurrence_id
           JOIN event_series s ON s.id = o.series_id
           JOIN event_output eo ON eo.series_id = s.id AND eo.enabled = 1
          WHERE r.state NOT IN ('completed', 'failed', 'cancelled') AND eo.device_id = ?
          LIMIT 1`,
      )
      .get(deviceId) as { label: string } | undefined
  )?.label
}
