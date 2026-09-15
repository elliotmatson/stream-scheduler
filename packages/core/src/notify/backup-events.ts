import type { Notification } from './types.js'

/**
 * A scheduled backup that did not happen.
 *
 * Worth telling somebody about rather than leaving on a screen nobody
 * opens: the whole failure mode here is a volume that quietly stopped
 * being writable months ago and a directory that has been empty ever
 * since. By the time anyone looks at a backup screen they already need a
 * backup.
 *
 * Deduped on the day, so a mount that has gone away says so once a day
 * rather than once per attempt.
 */
export function backupFailed(event: {
  directory: string
  reason: string
  at: number
  nextAttemptInHours: number
}): Notification {
  return {
    event: 'backup.failed',
    severity: 'warning',
    title: 'A scheduled backup failed',
    summary:
      `The scheduler could not write its backup to ${event.directory}. ` +
      `Everything else is running normally — but there is no new copy of the database.`,
    facts: [
      { label: 'Where', value: event.directory },
      { label: 'Why', value: event.reason },
      { label: 'Next attempt', value: `in ${event.nextAttemptInHours}h` },
    ],
    remediation:
      'Check the backup volume is mounted, writable and not full. In Docker that is the ' +
      'volume mapped to SCHEDULER_BACKUP_DIR.',
    dedupeKey: `backup.failed:${new Date(event.at).toISOString().slice(0, 10)}`,
  }
}
