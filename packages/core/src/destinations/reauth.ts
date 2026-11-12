import type { Db } from '../db/index.js'
import type { Notification } from '../notify/types.js'
import type { Notifier } from '../notify/notifier.js'

/**
 * Marks the account behind a destination as needing reconnecting, and says
 * so — once.
 *
 * Called wherever a service is found to have refused the stored
 * authorization: the evening check, or a run failing on it. The account row
 * is what the dashboard and the Services page read, so without this an
 * expired token showed as "ok" right up to the Sunday it failed. The alert
 * goes only when the status actually changes, so an hourly check does not
 * send one every hour.
 */
export function markAccountReauth(db: Db, notifier: Notifier, destinationId: string): void {
  const row = db
    .prepare(
      `SELECT a.id, a.display_name, a.provider, a.status
         FROM destination d JOIN account a ON a.id = d.account_id
        WHERE d.id = ?`,
    )
    .get(destinationId) as
    { id: string; display_name: string; provider: string; status: string } | undefined
  if (!row || row.status === 'reauth_required') return

  db.prepare("UPDATE account SET status = 'reauth_required' WHERE id = ?").run(row.id)
  notifier.enqueue(
    accountReauthNotification({
      id: row.id,
      displayName: row.display_name,
      provider: providerName(row.provider),
    }),
  )
}

/** The destination an output streams to, from the kind of one of its steps. */
export function destinationOfStep(db: Db, stepKind: string | undefined): string | undefined {
  if (!stepKind) return undefined
  const dot = stepKind.lastIndexOf('.')
  if (dot <= 0) return undefined
  const row = db
    .prepare('SELECT destination_id FROM event_output WHERE id = ?')
    .get(stepKind.slice(0, dot)) as { destination_id: string | null } | undefined
  return row?.destination_id ?? undefined
}

function providerName(provider: string): string {
  if (provider === 'youtube') return 'YouTube'
  if (provider === 'twitch') return 'Twitch'
  return provider
}

/**
 * Kept here rather than with the run events: those are read by the evening
 * check, which also marks accounts, and the two importing each other is a
 * cycle.
 */
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
