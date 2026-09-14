import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db } from '../db/index.js'
import { ConnectionManager } from '../devices/connection-manager.js'
import { PluginRegistry } from '../plugins/registry.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import { EventPlanner } from './event-planner.js'
import { RunEngine } from './engine.js'
import { RunStore } from './store.js'
import { immediateSleeper } from './steps.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago
const WINDOW = 90 * MINUTE

let db: Db
let clock: ManualClock
let vault: SecretVault
let connections: ConnectionManager
let store: RunStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-planner-'))
  db = openTestDatabase()
  clock = new ManualClock(START - HOUR)
  vault = new SecretVault(db, resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]), new Scrubber())
  const registry = new PluginRegistry().register(mockPlugin({ now: () => clock.now() }))
  connections = new ConnectionManager({ db, registry, clock, random: () => 0.5, sleep: async () => {}, enforceSerialization: true })
  store = new RunStore(db, clock, new Scrubber())
})
afterEach(async () => {
  await connections.closeAll()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addDevice(config: Record<string, unknown>, label = 'Encoder'): string {
  const id = randomUUID()
  db.prepare('INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
    id,
    'mock',
    label,
    JSON.stringify(config),
    clock.now(),
  )
  return id
}

function addCredential(url: string, key: string): string {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO stream_credential (id, label, source, ingest_url, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, 'YouTube primary', 'manual', url, vault.store(key), clock.now())
  return id
}

interface OutputSpec {
  kind?: 'stream' | 'recording'
  label: string
  offsetMs?: number
  durationMs?: number
  credentialId?: string
  deviceId?: string
  nodeId?: string
  templates?: Record<string, string>
}

interface SeedOptions {
  source?: { deviceId: string; nodeId: string }
  templates?: Record<string, string>
  outputs?: OutputSpec[]
  durationMs?: number
}

function seed(options: SeedOptions = {}): { occurrenceId: string; seriesId: string } {
  const seriesId = randomUUID()
  const occurrenceId = randomUUID()
  const duration = options.durationMs ?? WINDOW

  db.prepare(
    `INSERT INTO event_series
       (id, label, source_device_id, source_node_id, timezone, rrule, dtstart, duration_ms, prepare_lead_ms,
        preroll_ms, postroll_ms, late_start_grace_ms, templates, created_at, updated_at)
     VALUES (?, 'Sunday Service', ?, ?, 'America/Chicago', NULL, ?, ?, ?, 0, 0, ?, ?, 0, 0)`,
  ).run(
    seriesId,
    options.source?.deviceId ?? null,
    options.source?.nodeId ?? null,
    START,
    duration,
    30 * MINUTE,
    30 * MINUTE,
    JSON.stringify(options.templates ?? {}),
  )

  const insert = db.prepare(
    `INSERT INTO event_output
       (id, series_id, kind, label, position, offset_ms, duration_ms, credential_id, device_id, node_id,
        templates, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  ;(options.outputs ?? []).forEach((spec, index) => {
    insert.run(
      randomUUID(),
      seriesId,
      spec.kind ?? 'stream',
      spec.label,
      index,
      spec.offsetMs ?? 0,
      spec.durationMs ?? duration,
      spec.credentialId ?? null,
      spec.deviceId ?? null,
      spec.nodeId ?? null,
      JSON.stringify(spec.templates ?? {}),
    )
  })

  db.prepare(
    `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, status, series_version)
     VALUES (?, ?, ?, ?, '2026-03-08', 'pending', 1)`,
  ).run(occurrenceId, seriesId, START, START + duration)
  return { occurrenceId, seriesId }
}

const plannerFor = () => new EventPlanner({ db, connections, vault, clock })

describe('EventPlanner', () => {
  it('plans stream and record steps across the right phases', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    const recorder = addDevice({ kind: 'recorder' }, 'HyperDeck')
    await connections.open(encoder)
    await connections.open(recorder)

    const { occurrenceId } = seed({
      source: { deviceId: encoder, nodeId: 'stream' },
      outputs: [
        { label: 'Main', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
        { kind: 'recording', label: 'Archive', deviceId: recorder, nodeId: 'record' },
      ],
    })

    const plan = plannerFor().plan(occurrenceId)
    expect(plan.map((s) => `${s.phase}:${s.label ?? s.kind}`)).toEqual([
      // Retargeting is part of starting, not of preparing: one encoder can
      // only hold one target, so it is applied when this output goes on.
      'start:Main: point the encoder at it',
      'start:Main: go live',
      'stop:Main: stop',
      'start:Archive: start recording',
      'stop:Archive: stop recording',
    ])
  })

  it('runs an output on the event source unless it names a device of its own', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    const other = addDevice({ kind: 'encoder' }, 'Overflow')
    await connections.open(encoder)
    await connections.open(other)

    const credentialId = addCredential('rtmps://x/live2', 'live_key-value-here')
    const { occurrenceId } = seed({
      source: { deviceId: encoder, nodeId: 'stream' },
      outputs: [
        { label: 'On the source', credentialId },
        { label: 'On its own', credentialId, deviceId: other, nodeId: 'stream' },
      ],
    })

    const plan = plannerFor().plan(occurrenceId)
    const targets = plan.filter((s) => s.label?.endsWith('point the encoder at it')).map((s) => s.request)
    expect(targets).toEqual([
      { device: encoder, node: 'stream' },
      { device: other, node: 'stream' },
    ])
  })

  it('refuses to plan an output with no device anywhere to run it', () => {
    const { occurrenceId } = seed({
      outputs: [{ label: 'Main', credentialId: addCredential('rtmps://x/live2', 'live_key') }],
    })
    expect(() => plannerFor().plan(occurrenceId)).toThrow(/no source encoder/)
  })

  it('drives a scheduled event end to end through the engine', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    const recorder = addDevice({ kind: 'recorder' }, 'HyperDeck')
    await connections.open(encoder)
    await connections.open(recorder)

    const { occurrenceId } = seed({
      source: { deviceId: encoder, nodeId: 'stream' },
      templates: { filename: '{{date "yyyy-MM-dd"}} {{event.name}}.mp4' },
      outputs: [
        { label: 'Main', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
        { kind: 'recording', label: 'Archive', deviceId: recorder, nodeId: 'record' },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    clock.set(START)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('running')
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming?.active).toBe(true)
    expect((await connections.invoke(recorder, 'record', 'readState'))?.recording).toMatchObject({
      active: true,
      filename: '2026-03-08 Sunday Service.mp4',
    })

    clock.set(START + WINDOW)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming?.active).toBe(false)
    expect((await connections.invoke(recorder, 'record', 'readState'))?.recording?.active).toBe(false)
    expect(occurrenceStatus(occurrenceId)).toBe('done')
  })

  it('hands one encoder from one service to the next inside a window', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)

    seed({
      durationMs: 4 * HOUR,
      source: { deviceId: encoder, nodeId: 'stream' },
      outputs: [
        {
          label: '9:00',
          offsetMs: 0,
          durationMs: HOUR,
          credentialId: addCredential('rtmps://x/first', 'live_first-key'),
        },
        {
          label: '11:00',
          offsetMs: 2 * HOUR,
          durationMs: HOUR,
          credentialId: addCredential('rtmps://x/second', 'live_second-key'),
        },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    clock.set(START)
    await engine.tick()
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming).toMatchObject({
      active: true,
      targetUrl: 'rtmps://x/first',
    })

    clock.set(START + HOUR)
    await engine.tick()
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming?.active).toBe(false)

    clock.set(START + 2 * HOUR)
    await engine.tick()
    // The same encoder, now pointed somewhere else.
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming).toMatchObject({
      active: true,
      targetUrl: 'rtmps://x/second',
    })

    clock.set(START + 4 * HOUR)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
  })

  it('fails only the output whose encoder ignores the stream key', async () => {
    const good = addDevice({ kind: 'encoder' })
    const deaf = addDevice({ kind: 'encoder', fault: 'ignores-writes' }, 'Deaf encoder')
    await connections.open(good)
    await connections.open(deaf)

    const { occurrenceId } = seed({
      source: { deviceId: good, nodeId: 'stream' },
      outputs: [
        { label: 'Works', credentialId: addCredential('rtmps://x/a', 'live_a') },
        { label: 'Broken', credentialId: addCredential('rtmps://x/b', 'live_b'), deviceId: deaf, nodeId: 'stream' },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START)
    const runId = (await engine.tick()).created[0]!

    const failed = store.steps(runId).find((step) => step.state === 'failed')
    expect(failed?.label).toBe('Broken: point the encoder at it')
    expect(failed?.error).toMatch(/did not take effect/)
    // The working one is unaffected and on air.
    expect((await connections.invoke(good, 'stream', 'readState'))?.streaming?.active).toBe(true)
    expect(store.getRun(runId).state).toBe('running')
    expect(occurrenceStatus(occurrenceId)).toBe('running')
  })

  it('rides out a flaky device by retrying', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'flaky' })
    await connections.open(encoder)
    seed({
      source: { deviceId: encoder, nodeId: 'stream' },
      outputs: [{ label: 'Main', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') }],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('running')
    expect(store.step(runId, 0).attempts).toBeGreaterThan(1)
  })

  it('never writes a stream key into the run timeline', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({
      source: { deviceId: encoder, nodeId: 'stream' },
      outputs: [{ label: 'Main', credentialId: addCredential('rtmps://x/live2', 'live_super-secret-key') }],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START)
    const runId = (await engine.tick()).created[0]!

    expect(JSON.stringify(store.steps(runId))).not.toContain('live_super-secret-key')
  })

  it('renders each output its own name, falling back to the event', () => {
    const recorder = addDevice({ kind: 'recorder' }, 'HyperDeck')
    const { occurrenceId } = seed({
      templates: { title: '{{event.name}} - {{date "EEEE, MMMM d"}}' },
      outputs: [
        { label: 'Main', credentialId: addCredential('rtmps://x/a', 'live_a'), deviceId: recorder, nodeId: 'record' },
        {
          label: 'Worship',
          credentialId: addCredential('rtmps://x/b', 'live_b'),
          deviceId: recorder,
          nodeId: 'record',
          templates: { title: 'Worship - {{date "MMMM d"}}' },
        },
      ],
    })

    clock.set(Date.parse('2027-01-01T00:00:00Z')) // rendering much later must not matter
    expect(plannerFor().previewOutputs(occurrenceId).map((o) => o.title)).toEqual([
      'Sunday Service - Sunday, March 8',
      'Worship - March 8',
    ])
  })

  it('reports a bad template on an output rather than publishing it', () => {
    const recorder = addDevice({ kind: 'recorder' }, 'HyperDeck')
    const { occurrenceId } = seed({
      outputs: [
        {
          label: 'Main',
          credentialId: addCredential('rtmps://x/a', 'live_a'),
          deviceId: recorder,
          nodeId: 'record',
          templates: { title: '{{speaker.nmae}}' },
        },
      ],
    })
    expect(() => plannerFor().previewNames(occurrenceId)).toThrow(/unknown token/)
  })
})

function occurrenceStatus(occurrenceId: string): string {
  return (db.prepare('SELECT status FROM occurrence WHERE id = ?').get(occurrenceId) as { status: string }).status
}
