import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import { Notifier } from './notifier.js'
import type { Fetch, Notification } from './types.js'

const CHAT_WEBHOOK =
  'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=secret-key&token=secret-token'

let db: Db
let clock: ManualClock
let vault: SecretVault
let dir: string
let requests: { url: string; body: any }[]
let respond: (
  url: string,
  body: any,
) => { ok: boolean; status: number; text?: string; retryAfter?: string }

const fetchImpl: Fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : undefined
  requests.push({ url, body })
  const result = respond(url, body)
  return {
    ok: result.ok,
    status: result.status,
    text: async () => result.text ?? '',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? (result.retryAfter ?? null) : null,
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-notify-'))
  db = openTestDatabase()
  clock = new ManualClock('2026-03-07T18:00:00Z')
  vault = new SecretVault(
    db,
    resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]),
    new Scrubber(),
  )
  requests = []
  respond = () => ({ ok: true, status: 200 })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const notifier = (over: Partial<ConstructorParameters<typeof Notifier>[0]> = {}) =>
  new Notifier({ db, clock, vault, fetchImpl, ...over })

const failure = (over: Partial<Notification> = {}): Notification => ({
  event: 'run.failed',
  severity: 'error',
  title: 'Sunday Service failed to run',
  summary: 'The run for Sunday, March 8 at 9:00 AM CST stopped at "enc.applyStreamTarget".',
  facts: [
    { label: 'Event', value: 'Sunday Service' },
    { label: 'Reason', value: 'Stream target did not take effect' },
  ],
  remediation: 'Check the encoder is not rebooting, then retry.',
  link: { label: 'Open the run timeline', url: 'http://127.0.0.1:8500/#/runs/r1' },
  threadKey: 'occurrence-o1',
  dedupeKey: 'run-failed:r1:1',
  ...over,
})

describe('Google Chat', () => {
  it('posts a card and threads it by the run', async () => {
    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    n.enqueue(failure())

    expect(await n.flush()).toEqual({ sent: 1, failed: 0 })
    expect(requests).toHaveLength(1)

    const [request] = requests
    expect(request!.body.cardsV2[0].card.header.title).toBe('Sunday Service failed to run')
    expect(request!.body.thread.threadKey).toBe('occurrence-o1')
    // A plain-text line rides along so the mobile push preview says
    // something useful rather than "sent a card".
    expect(request!.body.text).toContain('Sunday Service failed to run')
    // Threading needs this on the URL, not just in the body.
    expect(request!.url).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
  })

  it('falls back to plain text if Chat rejects the card', async () => {
    // The card format is the one thing here that could not be tested
    // against a real space, so a formatting mistake must not cost the alert.
    respond = (_url, body) =>
      body.cardsV2
        ? { ok: false, status: 400, text: '{"error":{"message":"Invalid card"}}' }
        : { ok: true, status: 200 }

    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    n.enqueue(failure())

    expect(await n.flush()).toEqual({ sent: 1, failed: 0 })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.body.cardsV2).toBeUndefined()
    expect(requests[1]!.body.text).toContain('Sunday Service failed to run')
    expect(requests[1]!.body.text).toContain('Check the encoder is not rebooting')
  })

  it('can be configured to send plain text only', async () => {
    const n = notifier()
    n.create({
      kind: 'google-chat',
      label: 'Tech team',
      config: { webhookUrl: CHAT_WEBHOOK, useCards: false },
    })
    n.enqueue(failure())
    await n.flush()

    expect(requests[0]!.body.cardsV2).toBeUndefined()
    expect(requests[0]!.body.text).toContain('*Sunday Service failed to run*')
  })

  it('honours a 429 and retries later rather than giving up', async () => {
    // A space allows one request per second across every webhook in it.
    respond = () => ({ ok: false, status: 429, text: 'rate limited', retryAfter: '30' })

    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    n.enqueue(failure())

    expect(await n.flush()).toEqual({ sent: 0, failed: 1 })
    expect(n.pending()).toBe(1) // still queued

    // Retry-After is obeyed: nothing goes out before it elapses.
    clock.advance(29_000)
    expect(await n.flush()).toEqual({ sent: 0, failed: 0 })

    respond = () => ({ ok: true, status: 200 })
    clock.advance(2_000)
    expect(await n.flush()).toEqual({ sent: 1, failed: 0 })
    expect(n.pending()).toBe(0)
  })

  it('paces sends so a burst does not trip the per-space limit', async () => {
    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    n.enqueue(failure({ dedupeKey: 'a' }))
    n.enqueue(failure({ dedupeKey: 'b' }))
    n.enqueue(failure({ dedupeKey: 'c' }))

    // One per flush while the channel is paced.
    expect((await n.flush()).sent).toBe(1)
    expect((await n.flush()).sent).toBe(0) // too soon

    clock.advance(1_200)
    expect((await n.flush()).sent).toBe(1)
    clock.advance(1_200)
    expect((await n.flush()).sent).toBe(1)
    expect(n.pending()).toBe(0)
  })

  it('never puts the webhook URL in an error message', async () => {
    respond = () => ({ ok: false, status: 403, text: 'forbidden' })

    const n = notifier()
    const id = n.create({
      kind: 'google-chat',
      label: 'Tech team',
      config: { webhookUrl: CHAT_WEBHOOK },
    })
    n.enqueue(failure())
    await n.flush()

    const row = db.prepare('SELECT last_error FROM notification_channel WHERE id = ?').get(id) as {
      last_error: string
    }
    // The URL carries a key and a token, so it must not end up in the log
    // or on the settings screen.
    expect(row.last_error).not.toContain('secret-token')
    expect(row.last_error).not.toContain('chat.googleapis.com')
  })

  it('stores the webhook URL encrypted, not in the row', async () => {
    const n = notifier()
    const id = n.create({
      kind: 'google-chat',
      label: 'Tech team',
      config: { webhookUrl: CHAT_WEBHOOK },
    })
    const row = db.prepare('SELECT config FROM notification_channel WHERE id = ?').get(id) as {
      config: string
    }
    expect(row.config).not.toContain('secret-token')
    expect(row.config).not.toContain('chat.googleapis.com')
  })
})

describe('the outbox', () => {
  it('announces the same failure once, however many times the tick revisits it', async () => {
    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })

    expect(n.enqueue(failure())).toBe(1)
    // The scheduler ticks every five seconds; without dedupe this would
    // announce itself forever.
    expect(n.enqueue(failure())).toBe(0)
    expect(n.enqueue(failure())).toBe(0)

    await n.flush()
    expect(requests).toHaveLength(1)
  })

  it('treats a second attempt failing as news', async () => {
    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    expect(n.enqueue(failure({ dedupeKey: 'run-failed:r1:1' }))).toBe(1)
    expect(n.enqueue(failure({ dedupeKey: 'run-failed:r1:2' }))).toBe(1)
  })

  it('survives a restart with the message still queued', async () => {
    const first = notifier()
    first.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    first.enqueue(failure())
    // The process dies here, before any flush.

    const restarted = notifier()
    expect(restarted.pending()).toBe(1)
    expect((await restarted.flush()).sent).toBe(1)
  })

  it('gives up quickly on a rejected message but keeps trying a flaky one', async () => {
    respond = () => ({ ok: false, status: 400, text: 'bad request' })
    const n = notifier()
    n.create({ kind: 'webhook', label: 'Pager', config: { url: 'https://example.invalid/hook' } })
    n.enqueue(failure())

    // A rejected message is a configuration problem; retrying it for half an
    // hour helps nobody.
    await n.flush()
    clock.advance(10 * 60_000)
    await n.flush()
    clock.advance(10 * 60_000)
    await n.flush()

    expect(n.pending()).toBe(0)
    const row = db.prepare('SELECT status, attempts FROM notification_outbox').get() as {
      status: string
      attempts: number
    }
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(2)
  })

  it('only sends to channels subscribed to the event', async () => {
    const n = notifier()
    n.create({
      kind: 'webhook',
      label: 'Failures only',
      config: { url: 'https://example.invalid/failures' },
      events: ['run.failed'],
    })
    n.create({
      kind: 'webhook',
      label: 'Pre-flight only',
      config: { url: 'https://example.invalid/preflight' },
      events: ['preflight.problem'],
    })

    expect(n.enqueue(failure())).toBe(1)
    await n.flush()
    expect(requests[0]!.url).toContain('/failures')
  })

  it('sends everything to a channel that did not narrow its events', async () => {
    const n = notifier()
    n.create({
      kind: 'webhook',
      label: 'Everything',
      config: { url: 'https://example.invalid/all' },
    })
    expect(n.enqueue(failure())).toBe(1)
    expect(n.enqueue(failure({ event: 'preflight.problem', dedupeKey: 'pf:1' }))).toBe(1)
  })
})

describe('the generic webhook', () => {
  it('posts the notification as fields, not prose', async () => {
    const n = notifier()
    n.create({ kind: 'webhook', label: 'n8n', config: { url: 'https://example.invalid/hook' } })
    n.enqueue(failure())
    await n.flush()

    expect(requests[0]!.body).toMatchObject({
      event: 'run.failed',
      severity: 'error',
      title: 'Sunday Service failed to run',
      facts: { Event: 'Sunday Service' },
    })
  })
})

describe('Slack', () => {
  it('sends blocks with a plain-text fallback for push notifications', async () => {
    const n = notifier()
    n.create({
      kind: 'slack',
      label: 'AV channel',
      config: { webhookUrl: 'https://hooks.slack.com/services/T/B/xyz' },
    })
    n.enqueue(failure())
    await n.flush()

    const body = requests[0]!.body
    expect(body.text).toContain('Sunday Service failed to run')
    expect(body.blocks[0].type).toBe('header')
    expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(true)
  })
})

describe('configuration', () => {
  it('rejects a channel missing a required field', () => {
    const n = notifier()
    expect(() => n.create({ kind: 'google-chat', label: 'Broken', config: {} })).toThrow(
      /Webhook URL is required/,
    )
  })

  it('rejects an unknown channel kind, naming the ones it has', () => {
    const n = notifier()
    expect(() => n.create({ kind: 'carrier-pigeon', label: 'x', config: {} })).toThrow(
      /google-chat/,
    )
  })

  it('sends a test message immediately, bypassing the queue', async () => {
    const n = notifier()
    const id = n.create({
      kind: 'google-chat',
      label: 'Tech team',
      config: { webhookUrl: CHAT_WEBHOOK },
    })
    await n.test(id)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.cardsV2[0].card.header.title).toContain('connected')
    expect(n.pending()).toBe(0)
  })

  it('lists channels without leaking their secrets', () => {
    const n = notifier()
    n.create({ kind: 'google-chat', label: 'Tech team', config: { webhookUrl: CHAT_WEBHOOK } })
    expect(JSON.stringify(n.list())).not.toContain('secret-token')
  })

  it('offers Google Chat, Slack, a webhook and email', () => {
    expect(
      notifier()
        .kinds()
        .map((c) => c.kind)
        .sort(),
    ).toEqual(['email', 'google-chat', 'slack', 'webhook'])
  })
})

describe('a failed run reaching a channel', () => {
  it('goes from the engine hook to the webhook, with the event named in its own timezone', async () => {
    const { RunEngine } = await import('../runs/engine.js')
    const { RunStore } = await import('../runs/store.js')
    const { immediateSleeper } = await import('../runs/steps.js')
    const { runFailedNotification } = await import('./run-events.js')

    const start = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago
    clock.set(start - 30 * 60_000)

    db.prepare(
      `INSERT INTO event_series
         (id, label, timezone, rrule, dtstart, duration_ms, prepare_lead_ms, late_start_grace_ms,
          created_at, updated_at)
       VALUES ('s1', 'Sunday Service', 'America/Chicago', NULL, ?, 5400000, 1800000, 300000, 0, 0)`,
    ).run(start)
    db.prepare(
      `INSERT INTO event_output (id, series_id, kind, label, position, offset_ms, duration_ms, created_at)
       VALUES ('out1', 's1', 'stream', 'Main', 0, 0, 5400000, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
       VALUES ('o1', 's1', ?, ?, '2026-03-08', 'pending', 1)`,
    ).run(start, start + 5_400_000)

    const n = notifier()
    n.create({
      kind: 'webhook',
      label: 'Tech team',
      config: { url: 'https://example.invalid/hook' },
    })

    const store = new RunStore(db, clock, new Scrubber())
    const engine = new RunEngine({
      db,
      store,
      clock,
      sleeper: immediateSleeper,
      planner: {
        plan: () => [
          {
            kind: 'encoder.applyStreamTarget',
            phase: 'prepare' as const,
            outputId: 'out1',
            retryable: false,
            execute: async () => {
              throw Object.assign(new Error('Stream target did not take effect'), {
                remediation: 'Check the encoder is not rebooting.',
              })
            },
          },
        ],
      },
      onFailure: (event) => {
        n.enqueue(runFailedNotification(db, event, 'http://127.0.0.1:8500'))
      },
    })

    await engine.tick()
    expect(store.getRun(store.findRunForOccurrence('o1')!.id).state).toBe('failed')

    await n.flush()
    expect(requests).toHaveLength(1)

    const body = requests[0]!.body
    expect(body.event).toBe('run.failed')
    expect(body.title).toBe('Sunday Service failed to run')
    expect(body.facts['Failed at']).toBe('encoder.applyStreamTarget')
    expect(body.remediation).toContain('rebooting')
    expect(body.link.url).toContain('/#/runs/')
    // The service's own timezone, not the server's.
    expect(body.facts.Scheduled).toMatch(/9:00\s?AM/)
    expect(body.facts.Scheduled).toMatch(/Sunday/)
  })

  it('does not let a broken alert channel take down the scheduler', async () => {
    const { RunEngine } = await import('../runs/engine.js')
    const { RunStore } = await import('../runs/store.js')
    const { immediateSleeper } = await import('../runs/steps.js')

    const start = Date.parse('2026-03-08T14:00:00Z')
    clock.set(start - 30 * 60_000)
    db.prepare(
      `INSERT INTO event_series
         (id, label, timezone, rrule, dtstart, duration_ms, prepare_lead_ms, late_start_grace_ms,
          created_at, updated_at)
       VALUES ('s1', 'Sunday Service', 'America/Chicago', NULL, ?, 5400000, 1800000, 300000, 0, 0)`,
    ).run(start)
    db.prepare(
      `INSERT INTO event_output (id, series_id, kind, label, position, offset_ms, duration_ms, created_at)
       VALUES ('out1', 's1', 'stream', 'Main', 0, 0, 5400000, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
       VALUES ('o1', 's1', ?, ?, '2026-03-08', 'pending', 1)`,
    ).run(start, start + 5_400_000)

    const store = new RunStore(db, clock, new Scrubber())
    const engine = new RunEngine({
      db,
      store,
      clock,
      sleeper: immediateSleeper,
      planner: {
        plan: () => [
          {
            kind: 'step',
            phase: 'prepare' as const,
            outputId: 'out1',
            retryable: false,
            execute: async () => {
              throw new Error('nope')
            },
          },
        ],
      },
      onFailure: () => {
        throw new Error('the notifier itself is broken')
      },
    })

    // Telling somebody is best-effort. A broken channel must not turn a
    // failed run into a crashed scheduler.
    await expect(engine.tick()).resolves.toBeDefined()
    expect(store.getRun(store.findRunForOccurrence('o1')!.id).state).toBe('failed')
  })
})
