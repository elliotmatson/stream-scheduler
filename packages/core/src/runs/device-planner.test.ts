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
import { DevicePlanner, type PipelineGraph } from './device-planner.js'
import { RunEngine } from './engine.js'
import { RunStore } from './store.js'
import { immediateSleeper } from './steps.js'

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago
const DURATION = 90 * MINUTE

let db: Db
let clock: ManualClock
let vault: SecretVault
let connections: ConnectionManager
let store: RunStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-planner-'))
  db = openTestDatabase()
  clock = new ManualClock(START - 60 * MINUTE)
  vault = new SecretVault(db, resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]), new Scrubber())
  const registry = new PluginRegistry().register(mockPlugin({ now: () => clock.now() }))
  connections = new ConnectionManager({ db, registry, clock, random: () => 0.5, enforceSerialization: true })
  store = new RunStore(db, clock, new Scrubber())
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
    'Encoder',
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

function seed(graph: PipelineGraph, templates: Record<string, string> = {}): string {
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

const plannerFor = () => new DevicePlanner({ db, connections, vault, clock })

describe('DevicePlanner', () => {
  it('plans stream and record steps across the right phases', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    const recorder = addDevice({ kind: 'recorder' })
    await connections.open(encoder)
    await connections.open(recorder)

    const occurrenceId = seed({
      nodes: [
        { id: 'enc', deviceId: encoder, nodeId: 'stream', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
        { id: 'rec', deviceId: recorder, nodeId: 'record' },
      ],
    })

    const plan = plannerFor().plan(occurrenceId)
    expect(plan.map((s) => `${s.phase}:${s.kind}`)).toEqual([
      'prepare:enc.applyStreamTarget',
      'start:enc.startStreaming',
      'stop:enc.stopStreaming',
      'start:rec.startRecording',
      'stop:rec.stopRecording',
    ])
  })

  it('only plans steps the probed device actually supports', async () => {
    const recorder = addDevice({ kind: 'recorder' })
    await connections.open(recorder)
    const occurrenceId = seed({ nodes: [{ id: 'rec', deviceId: recorder, nodeId: 'record' }] })

    const kinds = plannerFor().plan(occurrenceId).map((s) => s.kind)
    expect(kinds).not.toContain('rec.startStreaming')
    expect(kinds).toContain('rec.startRecording')
  })

  it('drives a scheduled event end to end through the engine', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    const recorder = addDevice({ kind: 'recorder' })
    await connections.open(encoder)
    await connections.open(recorder)

    const occurrenceId = seed(
      {
        nodes: [
          { id: 'enc', deviceId: encoder, nodeId: 'stream', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
          { id: 'rec', deviceId: recorder, nodeId: 'record' },
        ],
      },
      { filename: '{{date "yyyy-MM-dd"}} {{event.name}}.mp4' },
    )

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })

    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')

    clock.set(START)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('live')
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming?.active).toBe(true)
    expect((await connections.invoke(recorder, 'record', 'readState'))?.recording).toMatchObject({
      active: true,
      filename: '2026-03-08 Sunday Service.mp4',
    })

    clock.set(START + DURATION)
    await engine.tick()
    expect(store.getRun(runId).state).toBe('completed')
    expect((await connections.invoke(encoder, 'stream', 'readState'))?.streaming?.active).toBe(false)
    expect((await connections.invoke(recorder, 'record', 'readState'))?.recording?.active).toBe(false)
    expect(occurrenceStatus(occurrenceId)).toBe('done')
  })

  it('fails at prepare time when the encoder ignores the stream key', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'ignores-writes' })
    await connections.open(encoder)
    const occurrenceId = seed({
      nodes: [
        { id: 'enc', deviceId: encoder, nodeId: 'stream', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    // The point of preparing early: this surfaces 30 minutes before air.
    expect(store.getRun(runId).state).toBe('failed')
    expect(JSON.parse(store.getRun(runId).failure!).message).toMatch(/did not take effect/)
    expect(occurrenceStatus(occurrenceId)).toBe('failed')
  })

  it('rides out a flaky device by retrying', async () => {
    const encoder = addDevice({ kind: 'encoder', fault: 'flaky' })
    await connections.open(encoder)
    seed({
      nodes: [
        { id: 'enc', deviceId: encoder, nodeId: 'stream', credentialId: addCredential('rtmps://x/live2', 'live_key-value-here') },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!
    expect(store.getRun(runId).state).toBe('ready')
    expect(store.step(runId, 0).attempts).toBeGreaterThan(1)
  })

  it('never writes a stream key into the run timeline', async () => {
    const encoder = addDevice({ kind: 'encoder' })
    await connections.open(encoder)
    seed({
      nodes: [
        { id: 'enc', deviceId: encoder, nodeId: 'stream', credentialId: addCredential('rtmps://x/live2', 'live_super-secret-key') },
      ],
    })

    const engine = new RunEngine({ db, store, clock, planner: plannerFor(), sleeper: immediateSleeper })
    clock.set(START - 30 * MINUTE)
    const runId = (await engine.tick()).created[0]!

    const dump = JSON.stringify(store.steps(runId))
    expect(dump).not.toContain('live_super-secret-key')
  })

  it('renders name templates against the occurrence, not the wall clock', () => {
    const occurrenceId = seed({ nodes: [] }, { title: '{{event.name}} - {{date "EEEE, MMMM d"}}' })
    clock.set(Date.parse('2027-01-01T00:00:00Z')) // rendering much later must not matter
    expect(plannerFor().previewNames(occurrenceId).title).toBe('Sunday Service - Sunday, March 8')
  })

  it('reports a bad template rather than publishing it', () => {
    const occurrenceId = seed({ nodes: [] }, { title: '{{speaker.nmae}}' })
    expect(() => plannerFor().previewNames(occurrenceId)).toThrow(/unknown token/)
  })
})

function occurrenceStatus(occurrenceId: string): string {
  return (db.prepare('SELECT status FROM occurrence WHERE id = ?').get(occurrenceId) as { status: string }).status
}
