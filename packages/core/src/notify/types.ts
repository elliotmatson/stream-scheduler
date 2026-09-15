import type { ConfigField, ConfigValues } from '@scheduler/plugin-sdk'

export const NOTIFICATION_EVENTS = [
  'run.failed',
  'run.cancelled',
  'preflight.problem',
  'preflight.ready',
  'account.reauth_required',
  'device.cache_high',
  'retention.swept',
  'retention.failed',
  'backup.failed',
  'run.started',
  'run.finished',
  'output.started',
  'output.finished',
  'test',
] as const

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export type Severity = 'info' | 'warning' | 'error'

/**
 * How bad each kind of event is, fixed per kind rather than per message.
 *
 * Two things read this. The settings screen groups the checkboxes by it,
 * so somebody choosing what to be told about is looking at "things that
 * went wrong" rather than an alphabetical list. And a channel with no
 * explicit choice uses it to send warnings and errors only, so the
 * "it worked" messages are opt-in.
 *
 * That only works if a kind means one thing. A sweep used to be info or
 * warning depending on whether a delete failed, which made both the
 * grouping and the filter a guess — so it is two kinds now, and the
 * sweeper picks between them.
 */
export const EVENT_SEVERITY: Record<NotificationEvent, Severity> = {
  'run.failed': 'error',
  'run.cancelled': 'warning',
  'preflight.problem': 'warning',
  'preflight.ready': 'info',
  'account.reauth_required': 'error',
  'device.cache_high': 'warning',
  'retention.swept': 'info',
  'retention.failed': 'warning',
  'backup.failed': 'warning',
  'run.started': 'info',
  'run.finished': 'info',
  'output.started': 'info',
  'output.finished': 'info',
  test: 'info',
}

/**
 * What a channel gets when nobody has chosen.
 *
 * Warnings and errors. An empty list used to mean everything, which is the
 * wrong default now that the app can announce every service starting and
 * stopping: a channel nobody tuned would carry four messages a Sunday, and
 * a channel people have learnt to ignore does not report the failure
 * either.
 */
export function defaultsToSending(event: NotificationEvent): boolean {
  return EVENT_SEVERITY[event] !== 'info'
}

/**
 * One thing worth telling somebody about, in a shape every channel can
 * render.
 *
 * Deliberately not free-form text: a Google Chat card, a Slack message and an
 * email want the same facts laid out differently, and formatting at the call
 * site means every new channel has to re-parse prose.
 */
export interface Notification {
  event: NotificationEvent
  severity: Severity
  /** One line. Ends up as the card header, email subject, push preview. */
  title: string
  /** A sentence of context. Assume this may be all someone reads. */
  summary: string
  facts: { label: string; value: string }[]
  /** What to do about it, when there is something to do. */
  remediation?: string
  link?: { label: string; url: string }
  /** Groups related messages: a Google Chat thread per run, so a failure and
   *  its follow-up do not become two unrelated notifications. */
  threadKey?: string
  /**
   * Sending the same key to the same channel twice is a no-op. Every caller
   * must set one, because the scheduler ticks every five seconds and an
   * un-deduped failure would announce itself forever.
   */
  dedupeKey: string
}

export interface ChannelSendDeps {
  fetchImpl: Fetch
  now(): number
}

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null }
}>

/**
 * Thrown when the remote asked us to slow down or had a blip. The outbox
 * retries these with backoff; everything else is treated as a bad
 * configuration and retried only a couple of times.
 */
export class TransientChannelError extends Error {
  readonly retryAfterMs: number | undefined
  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'TransientChannelError'
    this.retryAfterMs = retryAfterMs
  }
}

export interface NotificationChannel {
  kind: string
  displayName: string
  /** Declarative, like device config, so the UI renders it without new code. */
  configSchema: ConfigField[]
  /**
   * Smallest gap between two sends on one channel.
   *
   * Google Chat allows one request per second *per space*, shared across
   * every webhook in it, so a Sunday morning with several failures would be
   * throttled without pacing.
   */
  minIntervalMs?: number
  send(notification: Notification, config: ConfigValues, deps: ChannelSendDeps): Promise<void>
}

/** Plain-text rendering, used by email and as the fallback everywhere. */
export function renderPlainText(notification: Notification): string {
  const lines = [notification.summary, '']
  for (const fact of notification.facts) lines.push(`${fact.label}: ${fact.value}`)
  if (notification.remediation) lines.push('', notification.remediation)
  if (notification.link) lines.push('', `${notification.link.label}: ${notification.link.url}`)
  return lines.join('\n')
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'error':
      return 'Failed'
    case 'warning':
      return 'Needs attention'
    default:
      return 'Info'
  }
}
