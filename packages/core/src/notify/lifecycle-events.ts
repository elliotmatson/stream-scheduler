import type { Db } from '../db/index.js'
import type { Notification } from './types.js'

/**
 * The "it worked" messages.
 *
 * Nothing here is a problem, which is exactly why none of it is sent
 * unless a channel asks for it by name. A channel that announced every
 * service starting and stopping would carry four messages on a quiet
 * Sunday, and a channel people have learnt to scroll past does not report
 * the failure either.
 *
 * Worth having anyway: somebody who is not in the building wants to know
 * the 9am went on air without opening a laptop to find out, and "the
 * recording stopped and it was called this" is the one message an
 * archivist actually needs.
 */

export type LifecycleKind = 'run.started' | 'run.finished' | 'output.started' | 'output.finished'

export function lifecycleNotification(
  db: Db,
  event: { kind: LifecycleKind; runId: string; occurrenceId: string; outputLabel?: string },
  baseUrl: string,
): Notification {
  const label = eventLabel(db, event.occurrenceId)
  const where = event.outputLabel === undefined ? label : `${label} · ${event.outputLabel}`

  const wording: Record<LifecycleKind, { title: string; summary: string }> = {
    'run.started': {
      title: `${label} is on air`,
      summary: `The first output of "${label}" started. Everything scheduled after it runs on its own time.`,
    },
    'run.finished': {
      title: `${label} finished`,
      summary: `Every output of "${label}" came off air and the run closed out cleanly.`,
    },
    'output.started': {
      title: `${where} started`,
      summary: `One output of "${label}" went live.`,
    },
    'output.finished': {
      title: `${where} stopped`,
      summary: `One output of "${label}" came off air cleanly.`,
    },
  }

  return {
    event: event.kind,
    severity: 'info',
    ...wording[event.kind],
    facts: [
      { label: 'Event', value: label },
      ...(event.outputLabel === undefined ? [] : [{ label: 'Output', value: event.outputLabel }]),
    ],
    link: { label: 'Open the run', url: `${baseUrl}/#/runs/${event.runId}` },
    // The same thread as everything else about this run, so a service
    // reads as one conversation rather than four unrelated messages.
    threadKey: `run-${event.runId}`,
    // No timestamp in the key, deliberately: each of these can only
    // legitimately happen once per output per run, so the run and the
    // output are the whole identity. A clock in here would let the
    // five-second tick announce the same start twice.
    dedupeKey: `${event.kind}:${event.runId}:${event.outputLabel ?? ''}`,
  }
}

/** The event's name, or something honest when the row has gone. */
function eventLabel(db: Db, occurrenceId: string): string {
  const row = db
    .prepare(
      `SELECT s.label AS label
         FROM occurrence o JOIN event_series s ON s.id = o.series_id
        WHERE o.id = ?`,
    )
    .get(occurrenceId) as { label: string } | undefined
  return row?.label ?? 'A scheduled event'
}
