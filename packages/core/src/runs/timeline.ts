import type { Db } from '../db/index.js'
import { outputsForOccurrence, type EventOutput } from '../events/outputs.js'
import type { OutputTemplates } from '../events/outputs.js'

/** When one output goes on and comes off, in absolute time. */
export interface OutputWindow {
  output: EventOutput
  /** The nominal start. Preroll is applied on top by the engine. */
  startsAt: number
  endsAt: number
}

/**
 * Everything the engine needs to drive one occurrence, resolved to instants.
 *
 * The shape that matters: an event is a *window* with a source encoder, and
 * the outputs inside it come and go on their own clocks. A Sunday morning
 * is one event from 7:00 to 12:45 with four streams and a recording inside
 * it, not five events that have to be kept in step by hand.
 */
export interface EventTimeline {
  occurrenceId: string
  seriesId: string
  label: string
  timezone: string
  windowStart: number
  windowEnd: number
  templates: OutputTemplates
  prepareLeadMs: number
  prerollMs: number
  postrollMs: number
  lateStartGraceMs: number
  outputs: OutputWindow[]
  /** Set when an operator started this run by hand; see RunEngine.startNow. */
  forcedAt?: number
}

interface TimelineRow {
  scheduled_start: number
  scheduled_end: number
  series_id: string
  label: string
  timezone: string
  templates: string
  prepare_lead_ms: number
  preroll_ms: number
  postroll_ms: number
  late_start_grace_ms: number
}

export function timelineFor(db: Db, occurrenceId: string, options: { forcedAt?: number } = {}): EventTimeline {
  const row = db
    .prepare(
      `SELECT o.scheduled_start, o.scheduled_end, o.series_id, s.label, s.timezone, s.templates,
              s.prepare_lead_ms, s.preroll_ms, s.postroll_ms, s.late_start_grace_ms
         FROM occurrence o JOIN event_series s ON s.id = o.series_id
        WHERE o.id = ?`,
    )
    .get(occurrenceId) as TimelineRow | undefined
  if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)

  // A forced run is measured from when the operator pressed the button, so
  // every output keeps its offset within the event rather than the first
  // three being instantly in the past.
  const windowStart = options.forcedAt ?? row.scheduled_start
  const shift = windowStart - row.scheduled_start

  const outputs = outputsForOccurrence(db, occurrenceId)
    .filter((output) => output.enabled)
    .map((output) => ({
      output,
      startsAt: windowStart + output.offsetMs,
      endsAt: windowStart + output.offsetMs + output.durationMs,
    }))

  return {
    occurrenceId,
    seriesId: row.series_id,
    label: row.label,
    timezone: row.timezone,
    windowStart,
    windowEnd: row.scheduled_end + shift,
    templates: parseTemplates(row.templates),
    prepareLeadMs: row.prepare_lead_ms,
    prerollMs: row.preroll_ms,
    postrollMs: row.postroll_ms,
    lateStartGraceMs: row.late_start_grace_ms,
    outputs,
    ...(options.forcedAt === undefined ? {} : { forcedAt: options.forcedAt }),
  }
}

/**
 * When the whole event is over: the later of the window's end and the last
 * output coming off, so an output that runs past the window still finishes.
 */
export function timelineEnd(timeline: EventTimeline): number {
  return timeline.outputs.reduce((latest, entry) => Math.max(latest, entry.endsAt), timeline.windowEnd)
}

function parseTemplates(raw: string): OutputTemplates {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: OutputTemplates = {}
    for (const key of ['title', 'description', 'filename'] as const) {
      if (typeof parsed?.[key] === 'string') out[key] = parsed[key] as string
    }
    return out
  } catch {
    return {}
  }
}
