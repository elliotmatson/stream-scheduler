import type { OccurrenceDetail as Detail, OccurrenceEdit } from './api.ts'
import { inputTimeIn, localDateKey } from './format.ts'

/**
 * Editing one date of a repeating event, as the request that gets sent.
 *
 * Kept out of the screen because what it gets wrong is invisible there:
 * sending a field nobody touched pins it to today's value, and the next
 * change to the event then silently never reaches this date.
 */

export interface Draft {
  label: string
  date: string
  time: string
  minutes: number
  title: string
  description: string
  filename: string
}

/** What the form should show when nothing has been typed into it yet. */
export function draftOf(detail: Detail): Draft {
  const zone = detail.timezone
  return {
    // The occurrence's own values where it has them, and the series' where
    // it does not — so the boxes read as what will happen, which is what
    // somebody is checking when they open this.
    label: detail.overrides.label ?? detail.seriesLabel,
    date: localDateKey(detail.scheduledStart, zone),
    time: inputTimeIn(detail.scheduledStart, zone),
    minutes: Math.round((detail.scheduledEnd - detail.scheduledStart) / 60_000),
    title: detail.overrides.templates?.title ?? detail.seriesTemplates.title ?? '',
    description:
      detail.overrides.templates?.description ?? detail.seriesTemplates.description ?? '',
    filename: detail.overrides.templates?.filename ?? detail.seriesTemplates.filename ?? '',
  }
}

/**
 * Only what differs from what the form opened with.
 *
 * A box set back to what the event itself says clears the override rather
 * than pinning the same value onto this one date for ever.
 */
export function editOf(detail: Detail, original: Draft, draft: Draft): OccurrenceEdit {
  const edit: OccurrenceEdit = {}
  if (draft.label !== original.label) {
    edit.label = draft.label === detail.seriesLabel ? null : draft.label
  }
  if (draft.date !== original.date || draft.time !== original.time) {
    edit.startsAt = { date: draft.date, time: draft.time }
  }
  if (draft.minutes !== original.minutes) edit.durationMs = draft.minutes * 60_000
  const templates: Record<string, string | null> = {}
  for (const key of ['title', 'description', 'filename'] as const) {
    if (draft[key] === original[key]) continue
    templates[key] = draft[key] === (detail.seriesTemplates[key] ?? '') ? null : draft[key]
  }
  if (Object.keys(templates).length > 0) edit.templates = templates
  return edit
}
