import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock, SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type { DestinationProvider } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { DestinationRegistry } from '../destinations/registry.js'
import { ConnectionManager } from '../devices/connection-manager.js'
import { PluginRegistry } from '../plugins/registry.js'
import { EventPlanner } from '../runs/event-planner.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import { Notifier } from './notifier.js'
import { PreflightChecker } from './preflight.js'
import type { Fetch } from './types.js'

/** Sunday 09:00 America/Chicago. */
const START = Date.parse('2026-03-08T14:00:00Z')
const SATURDAY_AFTERNOON = START - 18 * 3_600_000

let db: Db
let clock: ManualClock
let vault: SecretVault
let connections: ConnectionManager
let destinations: DestinationRegistry
let notifier: Notifier
let dir: string
let sent: { url: string; body: any }[]

let destinationState: { state: string; message?: string; quotaRemaining?: number } = { state: 'ok' }

const fetchImpl: Fetch = async (url, init) => {
  sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
  return { ok: true, status: 200, text: async () => '', headers: { get: () => null } }
}

/** A destination whose status is whatever the test says it is. */
const fakeProvider: DestinationProvider = {
  id: 'fake',
  displayName: 'Fake service',
  apiVersion: SDK_API_VERSION,
  configSchema: [],
  providesIngest: true,
  createDestination: async () => ({
    prepare: async () => ({ externalId: 'x', ingest: { url: 'rtmps://x', key: 'k' } }),
    reconcile: async () => undefined,
    discard: async () => {},
    finalize: async () => {},
    status: async () => destinationState as never,
    dispose: async () => {},
  }),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-preflight-'))
  db = openTestDatabase()
  clock = new ManualClock(SATURDAY_AFTERNOON)
  vault = new SecretVault(db, resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]), new Scrubber())
  sent = []
  destinationState = { state: 'ok' }

  const plugins = new PluginRegistry().register(mockPlugin({ now: () => clock.now() }))
  connections = new ConnectionManager({ db, registry: plugins, clock, random: () => 0.5, sleep: async () => {} })
  destinations = new DestinationRegistry({ db, clock, vault })
  destinations.register(fakeProvider)
  notifier = new Notifier({ db, clock, vault, fetchImpl })
  notifier.create({ kind: 'webhook', label: 'Tech team', config: { url: 'https://example.invalid/hook' } })
})

afterEach(async () => {
  await connections.closeAll()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addDevice(config: Record<string, unknown>): string {
  const id = randomUUID()
  db.prepare('INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
    id,
    'mock',
    'Sanctuary encoder',
    JSON.stringify(config),
    clock.now(),
  )
  return id
}

function addDestination(): string {
  const id = randomUUID()
  db.prepare('INSERT INTO destination (id, plugin_id, label, account_id, config, created_at) VALUES (?, ?, ?, NULL, ?, ?)').run(
    id,
    'fake',
    'Church YouTube',
    '{}',
    clock.now(),
  )
  return id
}

interface SeedOptions {
  source?: string
  destinationId?: string
  credentialId?: string
  templates?: Record<string, string>
  /** For the "nothing attached" case. */
  outputs?: 'none'
}

function seed(options: SeedOptions = {}): string {
  const seriesId = randomUUID()
  const occurrenceId = randomUUID()
  db.prepare(
    `INSERT INTO event_series
       (id, label, source_device_id, source_node_id, timezone, rrule, dtstart, duration_ms, templates,
        created_at, updated_at)
     VALUES (?, 'Sunday Service', ?, 'stream', 'America/Chicago', NULL, ?, 5400000, ?, 0, 0)`,
  ).run(seriesId, options.source ?? null, START, JSON.stringify(options.templates ?? {}))

  if (options.outputs !== 'none') {
    db.prepare(
      `INSERT INTO event_output
         (id, series_id, kind, label, position, offset_ms, duration_ms, destination_id, credential_id, created_at)
       VALUES (?, ?, 'stream', 'Main', 0, 0, 5400000, ?, ?, 0)`,
    ).run(randomUUID(), seriesId, options.destinationId ?? null, options.credentialId ?? null)
  }

  db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, '2026-03-08', 'pending', 1)`,
  ).run(occurrenceId, seriesId, START, START + 5_400_000)
  return occurrenceId
}

/** A hand-entered key, so an output has somewhere to go. */
function addCredential(): string {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO stream_credential (id, label, source, ingest_url, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, 'Manual key', 'manual', 'rtmps://x/live2', vault.store('live_key'), clock.now())
  return id
}

const checker = (over: Partial<ConstructorParameters<typeof PreflightChecker>[0]> = {}) =>
  new PreflightChecker({ db, clock, planner: new EventPlanner({ db, connections, vault, clock, destinations }), connections, destinations, notifier, ...over })

describe('pre-flight', () => {
  it('says nothing when everything is in order', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({ source: encoder, credentialId: addCredential() })

    const [result] = await checker().run()
    expect(result?.problems).toEqual([])
    await notifier.flush()
    expect(sent).toHaveLength(0)
  })

  it('catches an expired YouTube authorization the day before', async () => {
    // The whole reason this exists: the 7-day Testing expiry is invisible
    // until a stream fails, and Saturday afternoon is when it can be fixed.
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({ source: encoder, destinationId: addDestination() })
    destinationState = { state: 'reauth_required', message: 'Token has been expired or revoked.' }

    const [result] = await checker().run()
    expect(result?.problems).toHaveLength(1)
    expect(result?.problems[0]?.what).toBe('Church YouTube')
    expect(result?.problems[0]?.remediation).toMatch(/Testing/)

    await notifier.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.event).toBe('preflight.problem')
    expect(sent[0]!.body.title).toContain('may not run')
  })

  it('catches an encoder that has been unplugged since last week', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'unreachable' })
    seed({ source: encoder, credentialId: addCredential() })

    const [result] = await checker().run()
    expect(result?.problems[0]?.what).toBe('Sanctuary encoder')
    expect(result?.problems[0]?.detail).toMatch(/Could not reach/)
  })

  it('catches a template someone broke on Tuesday', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({ source: encoder, credentialId: addCredential(), templates: { title: '{{speaker.nmae}}' } })

    const [result] = await checker().run()
    expect(result?.problems.some((p) => p.what === 'Name templates')).toBe(true)
  })

  it('warns when the day\'s API budget is nearly gone', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({ source: encoder, destinationId: addDestination() })
    destinationState = { state: 'ok', quotaRemaining: 120 }

    const [result] = await checker().run()
    expect(result?.problems[0]?.detail).toMatch(/120 API units/)
  })

  it('notices an event that would do nothing at all', async () => {
    seed({ source: addDevice({ kind: 'encoder' }), outputs: 'none' })
    const [result] = await checker().run()
    expect(result?.problems.some((p) => p.detail.includes('would do nothing'))).toBe(true)
  })

  it('ignores events beyond the window and events already past', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'unreachable' })
    seed({ source: encoder, credentialId: addCredential() })

    clock.set(START - 5 * 86_400_000) // five days out
    expect(await checker().run()).toHaveLength(0)

    clock.set(START + 86_400_000) // the day after
    expect(await checker().run()).toHaveLength(0)
  })

  it('reports an event once, not on every hourly check', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'unreachable' })
    seed({ source: encoder, credentialId: addCredential() })

    const preflight = checker()
    await preflight.run()
    await notifier.flush()
    expect(sent).toHaveLength(1)

    clock.advance(3_600_000)
    await preflight.run()
    await notifier.flush()
    expect(sent).toHaveLength(1)
  })

  it('speaks up again when the set of problems changes', async () => {
    // Fixing one of two problems should say so rather than going quiet.
    const encoder = addDevice({ kind: 'encoder', fault: 'unreachable' })
    seed({ source: encoder, credentialId: addCredential(), templates: { title: '{{nope}}' } })

    const preflight = checker()
    await preflight.run()
    await notifier.flush()
    expect(sent).toHaveLength(1)

    db.prepare("UPDATE event_series SET templates = '{}'").run()
    clock.advance(3_600_000)
    await preflight.run()
    await notifier.flush()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body.summary).toContain('One problem')
  })

  it('only says all-clear when asked to', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({ source: encoder, credentialId: addCredential() })

    await checker({ announceReady: true }).run()
    await notifier.flush()
    expect(sent[0]!.body.event).toBe('preflight.ready')
  })

  it('names the time in the event\'s own timezone', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'unreachable' })
    seed({ source: encoder, credentialId: addCredential() })

    await checker().run()
    await notifier.flush()
    // 09:00 in Chicago, whatever the server or the reader is set to.
    expect(sent[0]!.body.facts.Starts).toMatch(/9:00/)
    expect(sent[0]!.body.facts.Starts).toMatch(/Sunday/)
  })
})
