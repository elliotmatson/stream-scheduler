import type { ConfigField, ConfigValues } from '@scheduler/plugin-sdk'
import {
  renderPlainText,
  severityLabel,
  TransientChannelError,
  type ChannelSendDeps,
  type Notification,
  type NotificationChannel,
} from '../types.js'

const configSchema: ConfigField[] = [
  {
    type: 'secret',
    id: 'webhookUrl',
    label: 'Incoming webhook URL',
    required: true,
    tooltip:
      'From the Slack app\'s "Incoming Webhooks" page. Stored encrypted and never shown again.',
  },
]

export const slackChannel: NotificationChannel = {
  kind: 'slack',
  displayName: 'Slack',
  configSchema,
  minIntervalMs: 1_100,

  async send(
    notification: Notification,
    config: ConfigValues,
    deps: ChannelSendDeps,
  ): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? '')
    if (!webhookUrl) throw new Error('This Slack channel has no webhook URL.')

    const blocks: Record<string, unknown>[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: trim(notification.title, 150), emoji: true },
      },
      { type: 'section', text: { type: 'mrkdwn', text: trim(notification.summary, SECTION_MAX) } },
    ]

    if (notification.facts.length > 0) {
      blocks.push({
        type: 'section',
        // Slack allows at most ten fields in one section.
        fields: notification.facts.slice(0, 10).map((fact) => ({
          type: 'mrkdwn',
          // Slack refuses a field over 2,000 characters, and an error
          // relayed from a proxy's HTML page is easily that.
          text: trim(`*${fact.label}*\n${fact.value}`, FIELD_MAX),
        })),
      })
    }
    if (notification.remediation) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: trim(notification.remediation, SECTION_MAX) },
      })
    }
    if (notification.link) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: notification.link.label },
            url: notification.link.url,
          },
        ],
      })
    }

    const text = `${severityLabel(notification.severity)}: ${notification.title}`
    const post = (body: unknown) =>
      deps.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    // Clients that cannot render blocks, and every push notification, fall
    // back to `text`.
    let response = await post({ text, blocks })
    if (response.status === 400 && (await response.text()).includes('invalid_blocks')) {
      // Something in the layout Slack would not take. The alert still
      // matters more than how it looks, so it goes again as plain text.
      response = await post({
        text: trim(`${text}\n\n${renderPlainText(notification)}`, SECTION_MAX),
      })
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers?.get('retry-after') ?? '')
      throw new TransientChannelError(
        `Slack answered ${response.status}.`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      )
    }
    if (!response.ok) {
      throw new Error(`Slack rejected the message (${response.status}): ${await response.text()}`)
    }
  },
}

const SECTION_MAX = 2_900
const FIELD_MAX = 1_900

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
