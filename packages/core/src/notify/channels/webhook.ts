import type { ConfigField, ConfigValues } from '@scheduler/plugin-sdk'
import {
  TransientChannelError,
  type ChannelSendDeps,
  type Notification,
  type NotificationChannel,
} from '../types.js'

const configSchema: ConfigField[] = [
  { type: 'secret', id: 'url', label: 'URL', required: true },
  {
    type: 'secret',
    id: 'bearerToken',
    label: 'Bearer token',
    tooltip: 'Optional. Sent as an Authorization header.',
  },
]

/**
 * A generic JSON POST, for anything the first-party channels do not cover:
 * n8n, Home Assistant, a pager, a script on a Pi.
 *
 * The body is the whole notification rather than a rendered string, because
 * whatever is on the other end wants to route on the fields, not parse prose.
 */
export const webhookChannel: NotificationChannel = {
  kind: 'webhook',
  displayName: 'Webhook',
  configSchema,

  async send(
    notification: Notification,
    config: ConfigValues,
    deps: ChannelSendDeps,
  ): Promise<void> {
    const url = String(config.url ?? '')
    if (!url) throw new Error('This webhook channel has no URL.')
    const token = typeof config.bearerToken === 'string' ? config.bearerToken : undefined

    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event: notification.event,
        severity: notification.severity,
        title: notification.title,
        summary: notification.summary,
        facts: Object.fromEntries(notification.facts.map((fact) => [fact.label, fact.value])),
        ...(notification.remediation === undefined
          ? {}
          : { remediation: notification.remediation }),
        ...(notification.link === undefined ? {} : { link: notification.link }),
        sentAt: new Date(deps.now()).toISOString(),
      }),
    })

    if (response.status === 429 || response.status >= 500) {
      throw new TransientChannelError(`The webhook answered ${response.status}.`)
    }
    if (!response.ok) {
      // The URL itself may carry a token, so it stays out of the message.
      throw new Error(`The webhook rejected the message (${response.status}).`)
    }
  },
}
