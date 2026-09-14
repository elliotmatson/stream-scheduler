import type { ConfigField, ConfigValues } from '@scheduler/plugin-sdk'
import {
  renderPlainText,
  severityLabel,
  TransientChannelError,
  type ChannelSendDeps,
  type Notification,
  type NotificationChannel,
} from '../types.js'

/**
 * Google Chat via an incoming webhook.
 *
 * Two things about Chat shape this:
 *
 * 1. A space allows **one request per second, shared by every webhook in
 *    it**, and answers 429 beyond that. Hence `minIntervalMs` and the
 *    Retry-After handling below.
 * 2. Messages can be threaded by `threadKey`, so everything about one run
 *    lands in a single thread instead of scattering across the space.
 */

const configSchema: ConfigField[] = [
  {
    type: 'secret',
    id: 'webhookUrl',
    label: 'Webhook URL',
    required: true,
    tooltip:
      'In the Google Chat space: Apps & integrations > Webhooks > Add webhooks. The URL contains a key ' +
      'and token, so it is stored encrypted and never shown again.',
  },
  {
    type: 'checkbox',
    id: 'threadPerRun',
    label: 'Keep each event in one thread',
    default: true,
    tooltip: 'Replies about the same run go under the first message rather than filling the space.',
  },
  {
    type: 'checkbox',
    id: 'useCards',
    label: 'Send formatted cards',
    default: true,
    tooltip: 'Turn off to send plain text, which renders identically on every client.',
  },
]

export const googleChatChannel: NotificationChannel = {
  kind: 'google-chat',
  displayName: 'Google Chat',
  configSchema,
  // One request per second per space, shared across webhooks.
  minIntervalMs: 1_100,

  async send(notification: Notification, config: ConfigValues, deps: ChannelSendDeps): Promise<void> {
    const webhookUrl = String(config.webhookUrl ?? '')
    if (!webhookUrl) throw new Error('This Google Chat channel has no webhook URL.')

    const threadKey = config.threadPerRun === false ? undefined : notification.threadKey
    const url = buildUrl(webhookUrl, threadKey !== undefined)

    if (config.useCards !== false) {
      try {
        await post(url, cardBody(notification, threadKey), deps)
        return
      } catch (error) {
        // A card this code got subtly wrong would otherwise mean a silently
        // lost notification. Text always renders, so fall back to it rather
        // than let a formatting mistake cost somebody their alert.
        if (error instanceof TransientChannelError) throw error
        await post(url, textBody(notification, threadKey), deps)
        return
      }
    }

    await post(url, textBody(notification, threadKey), deps)
  },
}

function buildUrl(webhookUrl: string, threaded: boolean): string {
  if (!threaded) return webhookUrl
  const url = new URL(webhookUrl)
  // Replies to an existing thread with this key, and starts one if there is
  // none yet.
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
  return url.toString()
}

function textBody(notification: Notification, threadKey: string | undefined): Record<string, unknown> {
  // Chat's text formatting: *bold*, and <url|label> for links.
  const lines = [`*${notification.title}*`, notification.summary, '']
  for (const fact of notification.facts) lines.push(`*${fact.label}:* ${fact.value}`)
  if (notification.remediation) lines.push('', notification.remediation)
  if (notification.link) lines.push('', `<${notification.link.url}|${notification.link.label}>`)

  return {
    text: lines.join('\n'),
    ...(threadKey === undefined ? {} : { thread: { threadKey } }),
  }
}

function cardBody(notification: Notification, threadKey: string | undefined): Record<string, unknown> {
  const widgets: Record<string, unknown>[] = [
    { decoratedText: { text: notification.summary, wrapText: true } },
    ...notification.facts.map((fact) => ({
      decoratedText: { topLabel: fact.label, text: fact.value, wrapText: true },
    })),
  ]

  if (notification.remediation) {
    widgets.push({ decoratedText: { topLabel: 'What to do', text: notification.remediation, wrapText: true } })
  }
  if (notification.link) {
    widgets.push({
      buttonList: {
        buttons: [{ text: notification.link.label, onClick: { openLink: { url: notification.link.url } } }],
      },
    })
  }

  return {
    // The plain text rides along so notifications and mobile previews say
    // something useful rather than "sent a card".
    text: `*${notification.title}*`,
    cardsV2: [
      {
        cardId: notification.event,
        card: {
          header: { title: notification.title, subtitle: severityLabel(notification.severity) },
          sections: [{ widgets }],
        },
      },
    ],
    ...(threadKey === undefined ? {} : { thread: { threadKey } }),
  }
}

async function post(url: string, body: unknown, deps: ChannelSendDeps): Promise<void> {
  const response = await deps.fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  })

  if (response.status === 429 || response.status >= 500) {
    const retryAfter = Number(response.headers?.get('retry-after') ?? '')
    throw new TransientChannelError(
      `Google Chat answered ${response.status}.`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    )
  }
  if (!response.ok) {
    // Deliberately not including the URL: it carries the key and token.
    throw new Error(`Google Chat rejected the message (${response.status}): ${truncate(await response.text())}`)
  }
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

export { renderPlainText }
