import type { Db } from '../db/index.js'
import type { RunFailure } from '../runs/store.js'
import { describeWhen } from './preflight.js'
import type { Notification } from './types.js'

/**
 * Turns a failed run into something worth reading at 08:32 on a Sunday.
 *
 * The shape matters more than it looks: whoever gets this is standing in a
 * control room, on a phone, with minutes to spare. Which event, when it was
 * meant to start, what broke, and what to do — in that order.
 */
export function runFailedNotification(
  db: Db,
  event: { runId: string; occurrenceId: string; failure: RunFailure; attempt: number },
  baseUrl: string,
): Notification {
  const context = occurrenceContext(db, event.occurrenceId)
  const when = context ? describeWhen(context.scheduledStart, context.timezone) : 'an unknown time'
  const label = context?.label ?? 'A scheduled event'

  return {
    event: 'run.failed',
    severity: 'error',
    title: `${label} failed to run`,
    summary: `The run for ${when} stopped at "${event.failure.step ?? event.failure.code}".`,
    facts: [
      { label: 'Event', value: label },
      { label: 'Scheduled', value: when },
      { label: 'Failed at', value: event.failure.step ?? event.failure.code },
      { label: 'Reason', value: event.failure.message },
    ],
    ...(event.failure.remediation === undefined ? {} : { remediation: event.failure.remediation }),
    link: { label: 'Open the run timeline', url: `${baseUrl}/#/runs/${event.runId}` },
    // One thread per occurrence, so a retry and its outcome sit with the
    // original failure rather than becoming three unrelated alerts.
    threadKey: `occurrence-${event.occurrenceId}`,
    // Keyed on the attempt: a second attempt failing is news, the same
    // attempt being re-examined on the next tick is not.
    dedupeKey: `run-failed:${event.runId}:${event.attempt}`,
  }
}

export function accountReauthNotification(account: {
  id: string
  displayName: string
  provider: string
}): Notification {
  return {
    event: 'account.reauth_required',
    severity: 'error',
    title: `${account.displayName} needs reconnecting`,
    summary: `${account.provider} rejected the stored authorization, so scheduled streams to this account will fail.`,
    facts: [
      { label: 'Account', value: account.displayName },
      { label: 'Service', value: account.provider },
    ],
    remediation:
      'Reconnect the account in Settings. If it stopped working about a week after you set it up, the ' +
      'Google Cloud OAuth consent screen is probably still set to "Testing", which expires refresh tokens ' +
      'after 7 days.',
    threadKey: `account-${account.id}`,
    dedupeKey: `reauth:${account.id}`,
  }
}

function occurrenceContext(
  db: Db,
  occurrenceId: string,
): { label: string; scheduledStart: number; timezone: string } | undefined {
  return db
    .prepare(
      `SELECT s.label AS label, o.scheduled_start AS scheduledStart, s.timezone AS timezone
         FROM occurrence o JOIN event_series s ON s.id = o.series_id
        WHERE o.id = ?`,
    )
    .get(occurrenceId) as { label: string; scheduledStart: number; timezone: string } | undefined
}

/**
 * A device's send cache filling up while it is on air.
 *
 * The one failure that gives warning. An encoder whose uplink cannot keep
 * up does not stop: it buffers, and the buffer climbs, and some minutes
 * later the stream drops or the service cuts it off. By then the only
 * evidence is a dead stream. Told at eighty per cent, somebody has time to
 * look at the network before the congregation notices.
 */
export function cacheHighNotification(
  db: Db,
  event: {
    runId: string
    occurrenceId: string
    deviceLabel: string
    outputLabel: string
    percent: number
  },
  baseUrl: string,
): Notification {
  const context = occurrenceContext(db, event.occurrenceId)
  const label = context?.label ?? 'A scheduled event'
  const percent = Math.round(event.percent)

  return {
    event: 'device.cache_high',
    severity: 'warning',
    title: `${event.deviceLabel} is falling behind`,
    summary: `Its cache is ${percent}% full while "${event.outputLabel}" is on air. A cache that keeps climbing ends in a dropped stream.`,
    facts: [
      { label: 'Event', value: label },
      { label: 'Device', value: event.deviceLabel },
      { label: 'Output', value: event.outputLabel },
      { label: 'Cache', value: `${percent}%` },
    ],
    remediation:
      'Check the upload the device is sharing — another large transfer, or a link that cannot carry the bitrate it is set to. Lowering the quality is the quickest way out mid-service.',
    link: { label: 'Open the run timeline', url: `${baseUrl}/#/runs/${event.runId}` },
    threadKey: `occurrence-${event.occurrenceId}`,
    // Once per device per run: a cache that sits high for an hour is one
    // problem, not two hundred messages.
    dedupeKey: `cache-high:${event.runId}:${event.deviceLabel}`,
  }
}
