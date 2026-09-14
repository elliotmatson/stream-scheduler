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
  /** Null means the event's source encoder. */
  deviceId: string | null
  nodeId: string | null
  templates: OutputTemplates
  enabled: boolean
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
    enabled: row.enabled === 1,
  }
}

/**
 * The output's own templates, falling back to the event's per key.
 *
 * Per key rather than all-or-nothing: an output that only wants a different
 * title should not have to restate the description it was happy with.
 */
export function effectiveTemplates(event: OutputTemplates, output: OutputTemplates): OutputTemplates {
  const merged: OutputTemplates = { ...event }
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === 'string' && value.length > 0) merged[key as keyof OutputTemplates] = value
  }
  return merged
}

/** Which device drives this output: its own, or the event's source encoder. */
export function deviceFor(
  output: EventOutput,
  source: { deviceId: string | null; nodeId: string | null },
): { deviceId: string; nodeId: string } | undefined {
  const deviceId = output.deviceId ?? source.deviceId
  const nodeId = output.nodeId ?? source.nodeId
  if (!deviceId || !nodeId) return undefined
  return { deviceId, nodeId }
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
