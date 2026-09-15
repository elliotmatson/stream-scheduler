import type { Db } from '../db/index.js'
import type { OutputTemplates } from './outputs.js'

/**
 * What one occurrence of a repeating event had changed about it.
 *
 * A record of the *edit*, not a second copy of the event. The times an
 * occurrence runs at live where they always have, in `scheduled_start`
 * and `scheduled_end` — every query that orders a calendar reads those
 * columns, and a duplicate of the truth in a JSON blob is a duplicate
 * that eventually disagrees. What is kept here is only what could not be
 * expressed in those columns: a name and templates for this one morning,
 * and where it was moved from.
 *
 * The column being non-null is also the detach marker that
 * `materializeSeries` already honours: an occurrence somebody has edited
 * is never regenerated, never re-timed, and never deleted when the rule
 * changes underneath it. That is the behaviour every calendar has and
 * everybody expects — "change this one" has to survive "change the
 * series", or it was not a change at all.
 */
export interface OccurrenceOverrides {
  /** What this one is called, when it is not what the series is called. */
  label?: string
  /** The event's own templates, for this occurrence only. */
  templates?: OutputTemplates
  /**
   * The start this one had before somebody moved it.
   *
   * Kept so the UI can say "moved from 09:00" rather than only "edited",
   * and so reverting has something to revert to. Never used to decide
   * when anything runs; the column does that.
   */
  movedFrom?: number
  /** The length it had before somebody changed it, for the same reason. */
  lengthenedFrom?: number
}

/** Reads the column, treating anything unrecognisable as no overrides. */
export function parseOverrides(raw: string | null): OccurrenceOverrides {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const value = parsed as Record<string, unknown>
    const out: OccurrenceOverrides = {}
    if (typeof value.label === 'string' && value.label) out.label = value.label
    if (typeof value.movedFrom === 'number') out.movedFrom = value.movedFrom
    if (typeof value.lengthenedFrom === 'number') out.lengthenedFrom = value.lengthenedFrom

    const templates = value.templates
    if (templates && typeof templates === 'object') {
      const kept: OutputTemplates = {}
      for (const key of ['title', 'description', 'filename'] as const) {
        const entry = (templates as Record<string, unknown>)[key]
        if (typeof entry === 'string') kept[key] = entry
      }
      if (Object.keys(kept).length > 0) out.templates = kept
    }
    return out
  } catch {
    return {}
  }
}

/** True when there is nothing left to distinguish this one from its series. */
export function isEmpty(overrides: OccurrenceOverrides): boolean {
  return Object.keys(overrides).length === 0
}

/** What to write back, or null to reattach the occurrence to its series. */
export function serializeOverrides(overrides: OccurrenceOverrides): string | null {
  return isEmpty(overrides) ? null : JSON.stringify(overrides)
}

export interface OccurrenceRowShape {
  id: string
  series_id: string
  scheduled_start: number
  scheduled_end: number
  local_date: string
  status: string
  overrides: string | null
}

/** One occurrence, or nothing. */
export function occurrenceRow(db: Db, id: string): OccurrenceRowShape | undefined {
  return db.prepare('SELECT * FROM occurrence WHERE id = ?').get(id) as
    OccurrenceRowShape | undefined
}
