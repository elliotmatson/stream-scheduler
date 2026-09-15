import type { SweptOutput } from '../runs/sweep.js'
import type { Notification } from './types.js'

/** As many filenames as fit before a list stops being readable. */
const NAMED = 5

/**
 * Recordings the scheduler deleted by itself.
 *
 * Sent because it happened, not because it went wrong. This is the one
 * thing in the app that destroys somebody's footage without anybody
 * pressing anything, and an operator who finds out by noticing a gap on a
 * card has been badly served. The names are in the message for that
 * reason: "four recordings were removed" is an announcement, and
 * "2026-01-04 Sunday Service and three others" is something somebody can
 * check against what they expected.
 *
 * A sweep that could not delete something is still *one* message, carrying
 * both what went and what stuck: some gone and some left behind is one
 * event, and splitting the message in two would make the reader join them
 * back up. What changes is which event kind it is announced under —
 * `retention.failed` rather than `retention.swept` — so that a channel
 * subscribing to warnings gets the one that went wrong and not the weekly
 * "removed four old recordings".
 *
 * That split exists because the severity used to depend on the outcome,
 * which made the event kind mean two different things. A screen grouping
 * kinds by severity had to guess, and a filter working off the kind got it
 * wrong half the time.
 */
export function recordingsSweptNotification(
  swept: SweptOutput[],
  baseUrl: string,
  at: number,
): Notification {
  const removed = swept.flatMap((entry) => entry.removed)
  const failed = swept.flatMap((entry) => entry.failed)
  const outputs = swept.map((entry) => `${entry.seriesLabel} · ${entry.outputLabel}`)

  return {
    event: failed.length > 0 ? 'retention.failed' : 'retention.swept',
    severity: failed.length > 0 ? 'warning' : 'info',
    title:
      failed.length > 0
        ? `Removed ${count(removed.length, 'recording')}, and could not remove ${failed.length}`
        : `Removed ${count(removed.length, 'old recording')}`,
    summary:
      failed.length > 0
        ? `A scheduled sweep freed space on ${count(swept.length, 'recording output')}, but ${count(failed.length, 'file')} would not delete.`
        : `A scheduled sweep removed ${count(removed.length, 'recording')} past the keep-for date set on ${count(swept.length, 'recording output')}.`,
    facts: [
      { label: 'Outputs', value: outputs.join(', ') },
      { label: 'Removed', value: list(removed.map((file) => file.filename)) },
      ...(failed.length === 0
        ? []
        : [
            { label: 'Left behind', value: list(failed.map((file) => file.filename)) },
            // The first reason, not all of them: several files failing on
            // one card fail for one reason, and repeating it four times
            // pushes everything else off a phone screen.
            { label: 'Why', value: failed[0]!.reason },
          ]),
    ],
    ...(failed.length === 0
      ? {}
      : {
          remediation:
            'The card may be write-protected, or the device may still have the file open. The files are still on the card and will be offered again at the next sweep.',
        }),
    link: { label: 'Open the status screen', url: `${baseUrl}/#/` },
    // One thread for retention, so a month of sweeps reads as a running
    // account of a card rather than as a month of unrelated alerts.
    threadKey: 'retention',
    // Keyed on the hour it ran: the files are gone, so this exact sweep
    // can never legitimately be announced twice.
    dedupeKey: `swept:${at}:${removed.length}:${failed.length}`,
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** Names up to a handful, then says how many more. */
function list(names: string[]): string {
  if (names.length <= NAMED) return names.join(', ')
  return `${names.slice(0, NAMED).join(', ')} and ${names.length - NAMED} more`
}
