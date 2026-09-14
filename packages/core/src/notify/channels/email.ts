import { createTransport } from 'nodemailer'
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
  { type: 'textinput', id: 'host', label: 'SMTP server', required: true },
  { type: 'number', id: 'port', label: 'Port', default: 587, min: 1, max: 65535 },
  {
    type: 'checkbox',
    id: 'secure',
    label: 'Implicit TLS',
    default: false,
    tooltip: 'On for port 465. Port 587 upgrades with STARTTLS and should leave this off.',
  },
  { type: 'textinput', id: 'username', label: 'Username' },
  {
    type: 'secret',
    id: 'password',
    label: 'Password',
    tooltip: 'For Google Workspace this must be an app password, not the account password.',
  },
  { type: 'textinput', id: 'from', label: 'From address', required: true },
  {
    type: 'textinput',
    id: 'to',
    label: 'To addresses',
    required: true,
    tooltip: 'Comma separated.',
  },
]

export const emailChannel: NotificationChannel = {
  kind: 'email',
  displayName: 'Email',
  configSchema,

  async send(notification: Notification, config: ConfigValues): Promise<void> {
    const host = String(config.host ?? '')
    const to = String(config.to ?? '')
    const from = String(config.from ?? '')
    if (!host || !to || !from)
      throw new Error('This email channel is missing a server, sender or recipient.')

    const username =
      typeof config.username === 'string' && config.username ? config.username : undefined
    const password =
      typeof config.password === 'string' && config.password ? config.password : undefined

    const transport = createTransport({
      host,
      port: typeof config.port === 'number' ? config.port : 587,
      secure: config.secure === true,
      ...(username && password ? { auth: { user: username, pass: password } } : {}),
    })

    try {
      await transport.sendMail({
        from,
        to: to
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean),
        // The subject is the whole message for anyone reading on a phone
        // lock screen, which on a Sunday morning is most people.
        subject: `[${severityLabel(notification.severity)}] ${notification.title}`,
        text: renderPlainText(notification),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A refused connection or a greylisting deserves another go; a
      // rejected recipient does not.
      if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|4\d\d/.test(message)) {
        throw new TransientChannelError(`The mail server could not be reached: ${message}`)
      }
      throw new Error(`The mail server rejected the message: ${message}`)
    } finally {
      transport.close()
    }
  },
}

export type { ChannelSendDeps }
