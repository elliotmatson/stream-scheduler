import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import { FakeYouTube, youtubeProvider } from '@scheduler/plugin-youtube'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { DestinationRegistry } from '../destinations/registry.js'
import { ConnectionManager } from '../devices/connection-manager.js'
import { PluginRegistry } from '../plugins/registry.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import { RunEngine } from './engine.js'
import { PipelinePlanner } from './pipeline-planner.js'
import { RunStore } from './store.js'
import { immediateSleeper } from './steps.js'
import { idempotencyKey } from './store.js'

/**
 * The whole product in one test: a recurring event that creates its own
 * YouTube broadcast, points an encoder at the key YouTube issued, goes live,
 * stops, and finishes — with no hardware and no Google account.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago
const DURATION = 90 * MINUTE

let db: Db
let clock: ManualClock
let vault: SecretVault
let connections: ConnectionManager
let destinations: DestinationRegistry
let store: RunStore
let youtube: FakeYouTube
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-yt-'))
  db = openTestDatabase()
  clock = new ManualClock(START - 60 * MINUTE)
  vault = new SecretVault(db, resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]), new Scrubber())
  youtube = new FakeYouTube()

  const plugins = new PluginRegistry().register(mockPlugin({ now: () => clock.now() }))
  connections = new ConnectionManager({ db, registry: plugins, clock, random: () => 0.5, enforceSerialization: true })

  destinations = new DestinationRegistry({ db, clock, vault })
  destinations.register(
    youtubeProvider({
      now: () => clock.now(),
      fetchImpl: withTokenEndpoint(youtube.fetch),
      resolveClient: async (accountRef) => {
        const { clientId, clientSecret, refreshToken } = destinations.resolveOAuthClient(accountRef)
        return { client: { clientId, clientSecret }, refreshToken }
      },
    }),
  )

  store = new RunStore(db, clock, new Scrubber())
})

afterEach(async () => {
  await connections.closeAll()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function withTokenEndpoint(inner: typeof youtube.fetch): typeof youtube.fetch {
  return async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' }),
      }
    }
    return inner(url, init)
  }
}

/** A connected account with its own BYO OAuth client, as the setup wizard makes. */
function connectAccount(): string {
  const clientRowId = randomUUID()
  db.prepare(
    'INSERT INTO oauth_client (id, provider, label, client_id, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(clientRowId, 'youtube', 'My Google Cloud project', 'client-id', vault.store('client-secret'), clock.now())

  const accountId = randomUUID()
  db.prepare(
    `INSERT INTO account (id, provider, external_id, display_name, secret_ref, oauth_client_ref, scopes, created_at)
     VALUES (?, 'youtube', 'UC123', 'Test Church', ?, ?, ?, ?)`,
  ).run(accountId, vault.store('refresh-token-value'), clientRowId, 'youtube.force-ssl', clock.now())
  return accountId
}

function addDestination(accountId: string, config: Record<string, unknown> = {}): string {
  const id = randomUUID()
  db.prepare('INSERT INTO destination (id, plugin_id, label, account_id, config, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    'youtube',
    'Church YouTube',
    accountId,
    JSON.stringify({ privacy: 'public', reusableStream: true, streamTitle: 'Scheduler', ...config }),
    clock.now(),
  )
  return id
}

function addEncoder(): string {
  const id = randomUUID()
  db.prepare('INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
    id,
    'mock',
    'Sanctuary encoder',
    JSON.stringify({ kind: 'encoder' }),
    clock.now(),
  )
  return id
}

function seedEvent(graph: unknown, templates: Record<string, string>): string {
  const pipelineId = randomUUID()
  const seriesId = randomUUID()
  const occurrenceId = randomUUID()
  db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run(
    pipelineId,
    'Main',
    JSON.stringify(graph),
    clock.now(),
  )
  db.prepare(
    `INSERT INTO event_series
       (id, label, pipeline_id, timezone, rrule, dtstart, duration_ms, prepare_lead_ms, preroll_ms, postroll_ms,
        late_start_grace_ms, templates, created_at, updated_at)
     VALUES (?, 'Sunday Service', ?, 'America/Chicago', NULL, ?, ?, ?, 0, 0, ?, ?, 0, 0)`,
  ).run(seriesId, pipelineId, START, DURATION, 30 * MINUTE, 30 * MINUTE, JSON.stringify(templates))
  db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, '2026-03-08', 'pending', 1)`,
  ).run(occurrenceId, seriesId, START, START + DURATION)
  return occurrenceId
}

async function fullPipeline(destinationConfig: Record<string, unknown> = {}) {
  const accountId = connectAccount()
  const destinationId = addDestination(accountId, destinationConfig)
  const encoderId = addEncoder()
  await connections.open(encoderId)

  const occurrenceId = seedEvent(
    {
      destinations: [{ id: 'yt', destinationId }],
      nodes: [{ id: 'enc', deviceId: encoderId, nodeId: 'stream', ingestFrom: 'yt' }],
    },
    { title: '{{event.name}} - {{date "MMMM d, yyyy"}}' },
  )

  const planner = new PipelinePlanner({ db, connections, vault, clock, destinations })
  const engine = new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })
  return { engine, planner, occurrenceId, encoderId, destinationId }
}

describe('a scheduled event delivering to YouTube', () => {
  it('creates the broadcast, feeds the encoder and completes', async () => {
    const { engine, encoderId } = await fullPipeline()

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    // The broadcast exists with the rendered title, in the series timezone.
    expect(youtube.liveBroadcastCount).toBe(1)
    const broadcast = [...youtube.broadcasts.values()][0]!
    expect(broadcast.title).toBe('Sunday Service - March 8, 2026')
    expect(broadcast.boundStreamId).toBeDefined()

    // And the encoder is pointed at the key YouTube issued, verified by a
    // read-back rather than assumed.
    const encoderState = await connections.invoke(encoderId, 'stream', 'readState')
    expect(encoderState?.streaming?.targetUrl).toMatch(/^rtmps:\/\//)
    expect(encoderState?.streaming?.active).toBe(false)

    clock.set(START)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('live')
    expect((await connections.invoke(encoderId, 'stream', 'readState'))?.streaming?.active).toBe(true)

    clock.set(START + DURATION)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
    expect((await connections.invoke(encoderId, 'stream', 'readState'))?.streaming?.active).toBe(false)
  })

  it('never writes the issued stream key into the run timeline', async () => {
    const { engine } = await fullPipeline()
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    const issuedKey = [...youtube.streams.values()][0]!.streamName
    expect(issuedKey).toMatch(/^live_/)
    // The timeline carries a vault reference, never the value.
    expect(JSON.stringify(store.steps(runId))).not.toContain(issuedKey)
  })

  it('cleans up the per-run key once the event is finished', async () => {
    const { engine } = await fullPipeline()
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    const ref = `run-ingest:${runId}:yt`
    expect(vault.has(ref)).toBe(true)

    clock.set(START)
    await engine.tick()
    clock.set(START + DURATION)
    await engine.tick()

    expect(store.getRun(runId).state).toBe('completed')
    expect(vault.has(ref)).toBe(false)
  })

  it('adds the broadcast to the configured playlist', async () => {
    const { engine } = await fullPipeline({ playlistId: 'PLsundays' })
    clock.set(START - 30 * MINUTE)
    await engine.tick()

    expect(youtube.playlistItems).toHaveLength(1)
    expect(youtube.playlistItems[0]?.playlistId).toBe('PLsundays')
  })

  it('records what the day cost against the account, not the destination', async () => {
    const { engine } = await fullPipeline()
    clock.set(START - 30 * MINUTE)
    await engine.tick()

    const spend = db
      .prepare('SELECT COALESCE(SUM(units), 0) AS used, COUNT(*) AS calls FROM quota_ledger')
      .get() as { used: number; calls: number }
    expect(spend.calls).toBeGreaterThan(0)
    expect(spend.used).toBeGreaterThan(100)
    expect(spend.used).toBeLessThanOrEqual(260)
  })
})

describe('failure and recovery', () => {
  it('deletes the orphan broadcast when the encoder cannot be prepared', async () => {
    const accountId = connectAccount()
    const destinationId = addDestination(accountId)

    // An encoder that accepts the key and silently ignores it: the classic
    // Web Presenter mid-reboot case.
    const encoderId = randomUUID()
    db.prepare('INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
      encoderId,
      'mock',
      'Broken encoder',
      JSON.stringify({ kind: 'encoder', fault: 'ignores-writes' }),
      clock.now(),
    )
    await connections.open(encoderId)

    const occurrenceId = seedEvent(
      {
        destinations: [{ id: 'yt', destinationId }],
        nodes: [{ id: 'enc', deviceId: encoderId, nodeId: 'stream', ingestFrom: 'yt' }],
      },
      { title: '{{event.name}}' },
    )
    void occurrenceId

    const planner = new PipelinePlanner({ db, connections, vault, clock, destinations })
    const engine = new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    expect(store.getRun(runId).state).toBe('failed')
    // The channel is left clean rather than accumulating an empty public
    // broadcast for an event that never happened.
    expect(youtube.liveBroadcastCount).toBe(0)
    expect(vault.has(`run-ingest:${runId}:yt`)).toBe(false)
  })

  it('adopts the broadcast a crashed prepare had already created', async () => {
    const { engine, planner, occurrenceId } = await fullPipeline()

    clock.set(START - 30 * MINUTE)
    const plan = planner.plan(occurrenceId)
    const run = store.createRun(occurrenceId, plan)
    db.prepare("UPDATE occurrence SET status = 'running' WHERE id = ?").run(occurrenceId)

    // The process died mid-call: YouTube created the broadcast, we never
    // recorded its id.
    store.markStepRunning(run.id, 0)
    const destination = await destinations.open(
      (db.prepare('SELECT id FROM destination').get() as { id: string }).id,
    )
    await destination.prepare({
      idempotencyKey: idempotencyKey(run.id, 0, plan[0]!.kind),
      metadata: {
        title: 'Sunday Service - March 8, 2026',
        description: '',
        scheduledStart: START,
        scheduledEnd: START + DURATION,
        privacy: 'public',
      },
    })
    await destination.dispose()
    expect(youtube.liveBroadcastCount).toBe(1)

    await engine.recover()
    clock.set(START)
    await engine.tick()
    clock.set(START + DURATION)
    await engine.tick()

    expect(store.getRun(run.id).state).toBe('completed')
    // One broadcast for one service, which is the entire point.
    expect(youtube.liveBroadcastCount).toBe(1)
  })

  it('fails the run cleanly when the stored authorization is rejected', async () => {
    const { engine } = await fullPipeline()
    // Google refusing the refresh token is what a consent screen left in
    // "Testing" looks like a week after setup.
    destinations = new DestinationRegistry({ db, clock, vault })
    destinations.register(
      youtubeProvider({
        now: () => clock.now(),
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        }),
        resolveClient: async () => ({ client: { clientId: 'c', clientSecret: 's' }, refreshToken: 'rt' }),
      }),
    )
    const planner = new PipelinePlanner({ db, connections, vault, clock, destinations })
    const freshEngine = new RunEngine({ db, store, clock, planner, sleeper: immediateSleeper })
    void engine

    clock.set(START - 30 * MINUTE)
    const runId = (await freshEngine.tick()).created[0]!

    const failure = JSON.parse(store.getRun(runId).failure!)
    expect(failure.code).toBe('reauth-required')
    expect(failure.remediation).toMatch(/Testing/)
  })
})
