import { randomUUID } from 'node:crypto'
import { applyConfigDefaults, validateConfig } from '@scheduler/plugin-sdk'
import type { Clock, ConfigValues } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import { silentLogger, type Logger } from '../log.js'
import type { SecretVault } from '../secrets/vault.js'
import { emailChannel } from './channels/email.js'
import { googleChatChannel } from './channels/google-chat.js'
import { slackChannel } from './channels/slack.js'
import { webhookChannel } from './channels/webhook.js'
import {
  TransientChannelError,
  type Fetch,
  type Notification,
  type NotificationChannel,
  type NotificationEvent,
} from './types.js'

export interface ChannelRow {
  id: string
  kind: string
  label: string
  config: string
  events: string
  enabled: number
  last_error: string | null
  last_sent_at: number | null
}

interface OutboxRow {
  id: number
  channel_id: string
  dedupe_key: string
  event: string
  payload: string
  attempts: number
}

export interface NotifierDeps {
  db: Db
  clock: Clock
  vault: SecretVault
  logger?: Logger
  fetchImpl?: Fetch
  /** Lets tests flush without waiting out the per-channel pacing. */
  respectPacing?: boolean
}

const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 30 * 60_000
/** How many messages one flush will send, so a backlog cannot block a tick. */
const BATCH = 10

/**
 * Turns things worth knowing about into messages, and gets them out.
 *
 * The outbox is durable on purpose. A run that fails at 08:30 has to tell
 * somebody even if the process is killed a second later, and "we tried to
 * send an alert once and it 500'd" is the same as no alert at all.
 */
export class Notifier {
  private readonly channels = new Map<string, NotificationChannel>()
  private readonly logger: Logger
  private readonly fetchImpl: Fetch

  constructor(private readonly deps: NotifierDeps) {
    this.logger = deps.logger ?? silentLogger
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as Fetch)
    for (const channel of [googleChatChannel, slackChannel, webhookChannel, emailChannel]) {
      this.channels.set(channel.kind, channel)
    }
  }

  kinds(): NotificationChannel[] {
    return [...this.channels.values()]
  }

  kind(name: string): NotificationChannel {
    const channel = this.channels.get(name)
    if (!channel) {
      throw new Error(
        `No notification channel of kind "${name}". Known kinds: ${[...this.channels.keys()].join(', ')}.`,
      )
    }
    return channel
  }

  /** Validates against the channel's declared fields, as devices are. */
  assertValidConfig(kind: string, config: ConfigValues): void {
    const issues = validateConfig(this.kind(kind).configSchema, config)
    if (issues.length > 0) {
      throw new Error(
        `That ${this.kind(kind).displayName} channel is not configured correctly: ${issues.map((i) => i.message).join('; ')}`,
      )
    }
  }

  /**
   * Queues a notification for every channel that wants this event.
   *
   * Returns how many channels it was queued for, which is zero both when
   * nobody subscribed and when this exact thing was already queued — the
   * caller does not need to care which.
   */
  enqueue(notification: Notification): number {
    const now = this.deps.clock.now()
    const rows = this.deps.db
      .prepare('SELECT * FROM notification_channel WHERE enabled = 1')
      .all() as ChannelRow[]

    let queued = 0
    const insert = this.deps.db.prepare(
      `INSERT OR IGNORE INTO notification_outbox
         (channel_id, dedupe_key, event, payload, status, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )

    for (const row of rows) {
      if (!this.wants(row, notification.event)) continue
      const result = insert.run(
        row.id,
        notification.dedupeKey,
        notification.event,
        JSON.stringify(notification),
        now,
        now,
      )
      // Zero changes means the unique key already held it: this exact thing
      // has been announced, and the five-second tick must not repeat it.
      if (result.changes > 0) queued++
    }

    if (queued > 0) {
      this.logger.info('queued a notification', { event: notification.event, channels: queued })
    }
    return queued
  }

  /**
   * Sends what is due. Called from the scheduler loop.
   *
   * Paced per channel rather than per message: Google Chat allows one
   * request per second per space, shared by every webhook in it.
   */
  async flush(): Promise<{ sent: number; failed: number }> {
    const now = this.deps.clock.now()
    const due = this.deps.db
      .prepare(
        `SELECT * FROM notification_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY created_at LIMIT ?`,
      )
      .all(now, BATCH) as OutboxRow[]

    let sent = 0
    let failed = 0
    const sentThisFlush = new Set<string>()

    for (const row of due) {
      const channel = this.channelFor(row.channel_id)
      if (!channel) {
        this.discard(row, 'The channel this was queued for no longer exists.')
        continue
      }

      // One message per channel per flush when the channel is paced, so a
      // backlog drains at a rate the remote accepts instead of being
      // rejected in a burst.
      if (channel.definition.minIntervalMs && sentThisFlush.has(row.channel_id)) continue
      if (!this.pacingAllows(channel)) continue

      try {
        const notification = JSON.parse(row.payload) as Notification
        await channel.definition.send(notification, channel.config, {
          fetchImpl: this.fetchImpl,
          now: () => this.deps.clock.now(),
        })
        this.markSent(row, channel.id)
        sentThisFlush.add(row.channel_id)
        sent++
      } catch (error) {
        this.markFailed(row, channel.id, error)
        sentThisFlush.add(row.channel_id)
        failed++
      }
    }

    return { sent, failed }
  }

  /** Sends one message immediately, for the "send a test" button. */
  async test(channelId: string): Promise<void> {
    const channel = this.channelFor(channelId)
    if (!channel) throw new Error(`No notification channel with id "${channelId}".`)

    await channel.definition.send(
      {
        event: 'test',
        severity: 'info',
        title: 'Stream Scheduler is connected',
        summary: 'If you can read this, notifications about failed runs will reach you here.',
        facts: [{ label: 'Channel', value: channel.label }],
        dedupeKey: `test:${this.deps.clock.now()}`,
        threadKey: `test-${channelId}`,
      },
      channel.config,
      { fetchImpl: this.fetchImpl, now: () => this.deps.clock.now() },
    )

    this.deps.db
      .prepare('UPDATE notification_channel SET last_sent_at = ?, last_error = NULL WHERE id = ?')
      .run(this.deps.clock.now(), channelId)
  }

  create(input: {
    kind: string
    label: string
    config: ConfigValues
    events?: NotificationEvent[]
  }): string {
    const definition = this.kind(input.kind)
    const config = this.storeSecrets(definition, input.config, {})
    this.assertValidConfig(input.kind, config)

    const id = randomUUID()
    this.deps.db
      .prepare(
        `INSERT INTO notification_channel (id, kind, label, config, events, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.kind,
        input.label,
        JSON.stringify(config),
        JSON.stringify(input.events ?? []),
        this.deps.clock.now(),
      )
    return id
  }

  /**
   * Changes a channel in place.
   *
   * Anything left out is left alone, and a secret sent back as the masked
   * marker — or blank — keeps the stored one: an edit form has no way to
   * show a webhook URL it was never given, so it must not be able to wipe
   * one by being saved.
   */
  update(
    channelId: string,
    input: {
      label?: string
      config?: ConfigValues
      events?: NotificationEvent[]
      enabled?: boolean
    },
  ): void {
    const row = this.deps.db
      .prepare('SELECT * FROM notification_channel WHERE id = ?')
      .get(channelId) as ChannelRow | undefined
    if (!row) throw new Error(`No notification with id "${channelId}".`)

    const definition = this.kind(row.kind)
    const existing = JSON.parse(row.config) as ConfigValues
    const config =
      input.config === undefined
        ? existing
        : this.storeSecrets(definition, stripMasked(definition, input.config), existing)
    if (input.config !== undefined) this.assertValidConfig(row.kind, config)

    this.deps.db
      .prepare(
        `UPDATE notification_channel SET label = ?, config = ?, events = ?, enabled = ?
           WHERE id = ?`,
      )
      .run(
        input.label ?? row.label,
        JSON.stringify(config),
        JSON.stringify(input.events ?? (JSON.parse(row.events) as string[])),
        (input.enabled ?? row.enabled === 1) ? 1 : 0,
        channelId,
      )
  }

  remove(channelId: string): void {
    this.deps.db.prepare('DELETE FROM notification_channel WHERE id = ?').run(channelId)
  }

  list(): {
    id: string
    kind: string
    label: string
    /** Secrets as a marker, never a value: there is no read path for them. */
    config: ConfigValues
    events: string[]
    enabled: boolean
    lastError: string | null
    lastSentAt: number | null
  }[] {
    return (
      this.deps.db
        .prepare('SELECT * FROM notification_channel ORDER BY label')
        .all() as ChannelRow[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      config: this.maskedConfig(row),
      events: JSON.parse(row.events) as string[],
      enabled: row.enabled === 1,
      lastError: row.last_error,
      lastSentAt: row.last_sent_at,
    }))
  }

  /** Queue depth, for the settings screen. */
  pending(): number {
    return (
      this.deps.db
        .prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'pending'")
        .get() as {
        n: number
      }
    ).n
  }

  private wants(row: ChannelRow, event: NotificationEvent): boolean {
    const events = JSON.parse(row.events) as string[]
    // An empty list means everything, so a channel added without thinking
    // about it still reports failures.
    return events.length === 0 || events.includes(event)
  }

  private channelFor(
    channelId: string,
  ):
    | { id: string; label: string; definition: NotificationChannel; config: ConfigValues }
    | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM notification_channel WHERE id = ?')
      .get(channelId) as ChannelRow | undefined
    if (!row) return undefined

    const definition = this.channels.get(row.kind)
    if (!definition) return undefined

    // Secret fields hold vault references; the channel is handed the value
    // and never has to know where it lives.
    const stored = JSON.parse(row.config) as ConfigValues
    const config = applyConfigDefaults(definition.configSchema, stored)
    for (const field of definition.configSchema) {
      if (field.type !== 'secret') continue
      const ref = stored[field.id]
      if (typeof ref === 'string' && ref !== '') config[field.id] = this.deps.vault.reveal(ref)
    }

    return { id: row.id, label: row.label, definition, config }
  }

  /** What an edit form may be shown: everything except the secrets. */
  private maskedConfig(row: ChannelRow): ConfigValues {
    const config = JSON.parse(row.config) as ConfigValues
    let definition: NotificationChannel
    try {
      definition = this.kind(row.kind)
    } catch {
      // A channel whose plugin is no longer loaded: say nothing rather than
      // hand back config nothing can reason about.
      return {}
    }
    const out: ConfigValues = { ...config }
    for (const field of definition.configSchema) {
      if (field.type === 'secret' && out[field.id] !== undefined) out[field.id] = MASKED_SECRET
    }
    return out
  }

  private storeSecrets(
    definition: NotificationChannel,
    submitted: ConfigValues,
    existing: ConfigValues,
  ): ConfigValues {
    const out: ConfigValues = { ...submitted }
    for (const field of definition.configSchema) {
      if (field.type !== 'secret') continue
      const value = submitted[field.id]
      if (typeof value !== 'string' || value === '') {
        const previous = existing[field.id]
        if (previous === undefined) delete out[field.id]
        else out[field.id] = previous
        continue
      }
      out[field.id] = this.deps.vault.store(value)
    }
    return out
  }

  private pacingAllows(channel: { id: string; definition: NotificationChannel }): boolean {
    const interval = channel.definition.minIntervalMs
    if (!interval || this.deps.respectPacing === false) return true

    const row = this.deps.db
      .prepare('SELECT last_sent_at FROM notification_channel WHERE id = ?')
      .get(channel.id) as { last_sent_at: number | null } | undefined
    if (!row?.last_sent_at) return true
    return this.deps.clock.now() - row.last_sent_at >= interval
  }

  private markSent(row: OutboxRow, channelId: string): void {
    const now = this.deps.clock.now()
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?",
        )
        .run(now, row.id)
      this.deps.db
        .prepare('UPDATE notification_channel SET last_sent_at = ?, last_error = NULL WHERE id = ?')
        .run(now, channelId)
    })()
  }

  private markFailed(row: OutboxRow, channelId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = row.attempts + 1
    const transient = error instanceof TransientChannelError

    // A remote that asked us to wait is obeyed; otherwise back off
    // exponentially. A misconfigured channel gives up quickly rather than
    // retrying a rejected message for half an hour.
    const cap = transient ? MAX_ATTEMPTS : 2
    const delay =
      transient && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)

    const giveUp = attempts >= cap
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          `UPDATE notification_outbox
              SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ?
            WHERE id = ?`,
        )
        .run(
          attempts,
          message,
          giveUp ? 'failed' : 'pending',
          this.deps.clock.now() + delay,
          row.id,
        )
      this.deps.db
        .prepare('UPDATE notification_channel SET last_error = ? WHERE id = ?')
        .run(message, channelId)
    })()

    this.logger[giveUp ? 'error' : 'warn']('could not deliver a notification', {
      channelId,
      event: row.event,
      attempts,
      error: message,
    })
  }

  private discard(row: OutboxRow, reason: string): void {
    this.deps.db
      .prepare("UPDATE notification_outbox SET status = 'failed', last_error = ? WHERE id = ?")
      .run(reason, row.id)
  }
}

/** What a secret looks like on the way out. Matches the device API's marker. */
export const MASKED_SECRET = '••••••••'

/**
 * Drops any secret that came back exactly as it left.
 *
 * An edit form is given the marker and submits it unchanged when nobody
 * touched that field. Storing it would encrypt the marker and quietly
 * replace a working webhook with eight dots.
 */
function stripMasked(definition: NotificationChannel, config: ConfigValues): ConfigValues {
  const out: ConfigValues = { ...config }
  for (const field of definition.configSchema) {
    if (field.type === 'secret' && out[field.id] === MASKED_SECRET) delete out[field.id]
  }
  return out
}
