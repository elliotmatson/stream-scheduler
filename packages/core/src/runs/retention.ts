import type { Clock, MediaItem } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { outputsForSeries, type OutputSettings } from '../events/outputs.js'
import type { RecordingArtifact, RecordingLedger } from './artifacts.js'

/**
 * Which recordings a policy says are past their keep-by date.
 *
 * Deliberately only an answer, not an action. Automated deletion of
 * somebody's Sunday is the sort of feature that has to earn its place: this
 * says what would go, on a screen, and a later phase gets the ability to
 * actually do it. Everything hard is already here — deciding what is
 * eligible is the part that has to be right.
 *
 * Three rails, and they are the reason this is safe to build on:
 *
 *  - Only files this scheduler recorded, from its own ledger. A card that
 *    somebody put a camera dump on is not this app's business.
 *  - Only runs that finished. A recording still being written, or one whose
 *    run died halfway, is not a candidate for anything.
 *  - Always keep the newest few, whatever the dates say. A quiet month must
 *    not empty a card.
 */

export interface RetentionPolicy {
  /** Recordings older than this are eligible. Absent means age is no reason. */
  keepDays?: number
  /** Never let the newest this many go, whatever their age. */
  keepLast?: number
}

/** The floor, when a policy sets no other. Three Sundays. */
export const DEFAULT_KEEP_LAST = 3

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
  }
}

/** True when a policy would ever delete anything. */
export function isConfigured(policy: RetentionPolicy): boolean {
  return policy.keepDays !== undefined
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

  const wouldDelete = isConfigured(input.policy)
    ? ours.filter(
        (candidate, index) =>
          // A recording still being written, or one whose run died partway,
          // is not a candidate for anything.
          candidate.artifact.endedAt !== null &&
          index >= keepLast &&
          cutoff !== undefined &&
          candidate.ageMs > cutoff &&
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
    reports.push(
      assess({
        ...output,
        artifacts: deps.ledger.forOutput(output.outputId),
        ...(media === undefined ? {} : { media }),
        now,
      }),
    )
  }
  return reports
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
