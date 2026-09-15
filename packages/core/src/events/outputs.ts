import type { Db } from '../db/index.js'

export type OutputKind = 'stream' | 'recording'

/** Name templates, as stored on an event or overridden on one of its outputs. */
export interface OutputTemplates {
  title?: string
  description?: string
  filename?: string
}

/** A row of `event_output`, with the JSON columns parsed. */
export interface EventOutput {
  id: string
  seriesId: string
  kind: OutputKind
  label: string
  position: number
  /** From the start of the event's window. */
  offsetMs: number
  durationMs: number
  /** A service that issues a key for each run. */
  destinationId: string | null
  /** A key entered by hand, used instead of a service. */
  credentialId: string | null
  /** The hardware this output runs on. Null only while an event is still
   *  being set up; nothing can run until it is chosen. */
  deviceId: string | null
  nodeId: string | null
  templates: OutputTemplates
  /** What to set on the device before this output runs. Every key absent
   *  means "leave it as it is", which is the right default for gear
   *  somebody else may have configured by hand. */
  settings: OutputSettings
  enabled: boolean
}

/**
 * Device settings an output wants applied before it runs.
 *
 * Deliberately all optional. An event that does not care should not be
 * silently reconfiguring hardware, and "as it is now" has to be an
 * expressible choice rather than the absence of one.
 */
export interface OutputSettings {
  /** Encoder quality profile, in the device's own vocabulary. */
  quality?: string
  /** Which slot or disk a recorder writes to. */
  slot?: number
  /**
   * How long this output's recordings are worth keeping.
   *
   * Only meaningful on a recording. Absent means nothing is ever eligible,
   * which is the default and the safe one: a scheduler that starts
   * deleting Sundays because somebody left a box unticked is not a
   * scheduler anybody keeps running.
   */
  retention?: {
    /** Recordings older than this are eligible. Absent means age is no reason. */
    keepDays?: number
    /** Never let the newest this many go, whatever their age. */
    keepLast?: number
  }
}

interface OutputRow {
  id: string
  series_id: string
  kind: string
  label: string
  position: number
  offset_ms: number
  duration_ms: number
  destination_id: string | null
  credential_id: string | null
  device_id: string | null
  node_id: string | null
  templates: string
  settings: string
  enabled: number
}

/** Every output of an event, in the order the operator put them in. */
export function outputsForSeries(db: Db, seriesId: string): EventOutput[] {
  const rows = db
    .prepare('SELECT * FROM event_output WHERE series_id = ? ORDER BY position, id')
    .all(seriesId) as OutputRow[]
  return rows.map(toOutput)
}

export function outputsForOccurrence(db: Db, occurrenceId: string): EventOutput[] {
  const rows = db
    .prepare(
      `SELECT eo.* FROM event_output eo
         JOIN occurrence o ON o.series_id = eo.series_id
        WHERE o.id = ?
        ORDER BY eo.position, eo.id`,
    )
    .all(occurrenceId) as OutputRow[]
  return rows.map(toOutput)
}

export function toOutput(row: OutputRow): EventOutput {
  return {
    id: row.id,
    seriesId: row.series_id,
    kind: row.kind === 'recording' ? 'recording' : 'stream',
    label: row.label,
    position: row.position,
    offsetMs: row.offset_ms,
    durationMs: row.duration_ms,
    destinationId: row.destination_id,
    credentialId: row.credential_id,
    deviceId: row.device_id,
    nodeId: row.node_id,
    templates: parseTemplates(row.templates),
    settings: parseSettings(row.settings),
    enabled: row.enabled === 1,
  }
}

/**
 * The output's own templates, falling back to the event's per key.
 *
 * Per key rather than all-or-nothing: an output that only wants a different
 * title should not have to restate the description it was happy with.
 */
export function effectiveTemplates(
  event: OutputTemplates,
  output: OutputTemplates,
): OutputTemplates {
  const merged: OutputTemplates = { ...event }
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === 'string' && value.length > 0) merged[key as keyof OutputTemplates] = value
  }
  return merged
}

/** The device this output runs on, if it has been chosen yet. */
export function deviceFor(output: EventOutput): { deviceId: string; nodeId: string } | undefined {
  if (!output.deviceId || !output.nodeId) return undefined
  return { deviceId: output.deviceId, nodeId: output.nodeId }
}

/** The node action an output of this kind needs its device to support. */
export function requiredAction(kind: OutputKind): 'startStreaming' | 'startRecording' {
  return kind === 'recording' ? 'startRecording' : 'startStreaming'
}

function parseSettings(raw: string): OutputSettings {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: OutputSettings = {}
    if (typeof parsed.quality === 'string' && parsed.quality) out.quality = parsed.quality
    if (typeof parsed.slot === 'number' && Number.isInteger(parsed.slot)) out.slot = parsed.slot
    // Shape only. Whether a given number *means* anything is retention's
    // own question — a keepDays of zero parses fine and is rejected there,
    // where the comment explaining why can sit next to the decision.
    const retention = parsed.retention
    if (retention && typeof retention === 'object') {
      const value = retention as { keepDays?: unknown; keepLast?: unknown }
      const kept: NonNullable<OutputSettings['retention']> = {}
      if (typeof value.keepDays === 'number' && Number.isInteger(value.keepDays)) {
        kept.keepDays = value.keepDays
      }
      if (typeof value.keepLast === 'number' && Number.isInteger(value.keepLast)) {
        kept.keepLast = value.keepLast
      }
      if (Object.keys(kept).length > 0) out.retention = kept
    }
    return out
  } catch {
    return {}
  }
}

function parseTemplates(raw: string): OutputTemplates {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    const out: OutputTemplates = {}
    for (const key of ['title', 'description', 'filename'] as const) {
      if (typeof record[key] === 'string') out[key] = record[key]
    }
    return out
  } catch {
    return {}
  }
}
