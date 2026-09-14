import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { silentLogger } from '../log.js'
import { createServer, InsecureBindError } from './server.js'

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z') // 09:00 America/Chicago

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-api-'))
  clock = new ManualClock(START - 2 * 60 * MINUTE)
  app = Application.create({
    configDir: dir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
  })
  server = await createServer({ app })
})

afterEach(async () => {
  await server.close()
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await server.inject({ method: 'POST', url, payload: body as object })
  return { status: response.statusCode, json: safeJson(response.body) }
}
async function get(url: string): Promise<{ status: number; json: any }> {
  const response = await server.inject({ method: 'GET', url })
  return { status: response.statusCode, json: safeJson(response.body) }
}
function safeJson(body: string): any {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/** Builds an encoder, a pipeline pointing at it, and a weekly series. */
async function seedEverything(templates: Record<string, string> = {}) {
  const device = await post('/api/devices', {
    pluginId: 'mock',
    label: 'Sanctuary encoder',
    config: { kind: 'encoder', password: 'device-password-value' },
  })
  const credential = await post('/api/credentials', {
    label: 'YouTube primary',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    key: 'live_super-secret-key',
  })
  await post(`/api/devices/${device.json.id}/connect`, {})

  const pipeline = await post('/api/pipelines', {
    label: 'Main',
    graph: {
      nodes: [
        { id: 'enc', deviceId: device.json.id, nodeId: 'stream', credentialId: credential.json.id },
      ],
    },
  })
  const series = await post('/api/series', {
    label: 'Sunday Service',
    pipelineId: pipeline.json.id,
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstart: START,
    durationMs: 90 * MINUTE,
    templates,
  })
  return { deviceId: device.json.id, seriesId: series.json.id, credentialId: credential.json.id }
}

describe('server binding', () => {
  it('refuses to expose the UI on a LAN without a password', async () => {
    await expect(createServer({ app, host: '0.0.0.0' })).rejects.toBeInstanceOf(InsecureBindError)
  })

  it('answers healthz', async () => {
    expect(await get('/healthz')).toMatchObject({ status: 200, json: { ok: true } })
  })
})

describe('devices', () => {
  it('creates a device and never returns its secret', async () => {
    const created = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Encoder',
      config: { kind: 'encoder', password: 'device-password-value' },
    })
    expect(created.status).toBe(201)

    const list = await get('/api/devices')
    expect(list.json[0].label).toBe('Encoder')
    expect(list.json[0].config.password).toBe('••••••••')
    expect(JSON.stringify(list.json)).not.toContain('device-password-value')
  })

  it('rejects config the plugin schema does not accept', async () => {
    const created = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Encoder',
      config: { kind: 'toaster' },
    })
    expect(created.status).toBe(400)
    expect(created.json.issues[0].field).toBe('kind')
  })

  it('404s for an unknown plugin', async () => {
    expect((await post('/api/devices', { pluginId: 'atem', label: 'x', config: {} })).status).toBe(404)
  })

  it('reports probed capabilities on connect', async () => {
    const created = await post('/api/devices', { pluginId: 'mock', label: 'Encoder', config: { kind: 'encoder' } })
    const connected = await post(`/api/devices/${created.json.id}/connect`, {})
    expect(connected.json.capabilities.model).toBe('Mock encoder')
    expect(connected.json.nodes.map((n: { id: string }) => n.id)).toEqual(['stream'])
  })

  it('keeps the stored secret when an edit leaves the field masked', async () => {
    const created = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Encoder',
      config: { kind: 'encoder', password: 'device-password-value' },
    })
    const before = (await get('/api/devices')).json[0].config

    const patched = await server.inject({
      method: 'PATCH',
      url: `/api/devices/${created.json.id}`,
      payload: { label: 'Renamed', config: { ...before, kind: 'encoder' } },
    })
    expect(patched.statusCode).toBe(200)

    const after = (await get('/api/devices')).json[0]
    expect(after.label).toBe('Renamed')
    expect(after.config.password).toBe('••••••••')
    // Still decryptable, i.e. the masked marker did not overwrite the secret.
    const ref = JSON.parse(
      (app.db.prepare('SELECT config FROM device WHERE id = ?').get(created.json.id) as { config: string }).config,
    ).password as string
    expect(app.vault.reveal(ref)).toBe('device-password-value')
  })
})

describe('series and occurrences', () => {
  it('materializes occurrences when a series is created', async () => {
    await seedEverything()
    const occurrences = await get(`/api/occurrences?from=${START - MINUTE}&to=${START + 21 * 86_400_000}`)
    expect(occurrences.json.map((o: { localDate: string }) => o.localDate)).toEqual([
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
      '2026-03-29',
    ])
  })

  it('rejects an invalid timezone and an invalid rule', async () => {
    const pipeline = await post('/api/pipelines', { label: 'Main', graph: { nodes: [] } })
    const base = {
      label: 'S',
      pipelineId: pipeline.json.id,
      dtstart: START,
      durationMs: 90 * MINUTE,
    }
    expect((await post('/api/series', { ...base, timezone: 'America/Chicgao', rrule: null })).status).toBe(400)
    expect((await post('/api/series', { ...base, timezone: 'UTC', rrule: 'FREQ=NEVER' })).status).toBe(400)
  })

  it('previews rendered names for the next occurrences', async () => {
    const { seriesId } = await seedEverything({ title: '{{event.name}} - {{date "EEEE, MMMM d, yyyy"}}' })
    const preview = await get(`/api/series/${seriesId}/preview`)
    expect(preview.json).toHaveLength(3)
    expect(preview.json[0].title).toBe('Sunday Service - Sunday, March 8, 2026')
    expect(preview.json[1].title).toBe('Sunday Service - Sunday, March 15, 2026')
  })

  it('reports a template mistake in the preview instead of failing the request', async () => {
    const { seriesId } = await seedEverything({ title: '{{speaker.nmae}}' })
    const preview = await get(`/api/series/${seriesId}/preview`)
    expect(preview.status).toBe(200)
    expect(preview.json[0].error).toMatch(/unknown token/)
  })

  it('skips and unskips an occurrence', async () => {
    await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    await post(`/api/occurrences/${first.id}/skip`, {})
    expect((await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json[0].status).toBe('skipped')
    await post(`/api/occurrences/${first.id}/unskip`, {})
    expect((await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json[0].status).toBe('pending')
  })

  it('reconciles occurrences when the rule changes', async () => {
    const { seriesId } = await seedEverything()
    const patched = await server.inject({
      method: 'PATCH',
      url: `/api/series/${seriesId}`,
      payload: { rrule: 'FREQ=WEEKLY;BYDAY=WE' },
    })
    expect(patched.statusCode).toBe(200)
    const occurrences = await get(`/api/occurrences?from=${START}&to=${START + 14 * 86_400_000}`)
    expect(occurrences.json.every((o: { localDate: string }) => o.localDate !== '2026-03-15')).toBe(true)
  })
})

describe('runs', () => {
  it('starts an occurrence on demand and exposes a step timeline', async () => {
    await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json

    clock.set(START)
    const started = await post(`/api/occurrences/${first.id}/start-now`, {})
    expect(started.status).toBe(200)
    expect(started.json.state).toBe('live')

    const run = await get(`/api/runs/${started.json.runId}`)
    expect(run.json.steps.map((s: { kind: string; state: string }) => `${s.kind}:${s.state}`)).toEqual([
      'enc.applyStreamTarget:done',
      'enc.startStreaming:done',
      'enc.stopStreaming:pending',
    ])
    // The timeline is safe to screenshot and attach to a bug report.
    expect(JSON.stringify(run.json)).not.toContain('live_super-secret-key')
  })

  it('cancels a live run through the API', async () => {
    await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START)
    const started = await post(`/api/occurrences/${first.id}/start-now`, {})

    const cancelled = await post(`/api/runs/${started.json.runId}/cancel`, { reason: 'Service ended early' })
    expect(cancelled.json.state).toBe('cancelled')

    const run = await get(`/api/runs/${started.json.runId}`)
    expect(run.json.steps.find((s: { kind: string }) => s.kind === 'enc.stopStreaming').state).toBe('done')
  })

  it('404s for an unknown run', async () => {
    expect((await get('/api/runs/nope')).status).toBe(404)
  })
})

describe('credentials', () => {
  it('never exposes a stored stream key', async () => {
    await post('/api/credentials', {
      label: 'YouTube primary',
      ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
      key: 'live_super-secret-key',
    })
    const list = await get('/api/credentials')
    expect(list.json[0].key).toBe('••••••••')
    expect(JSON.stringify(list.json)).not.toContain('live_super-secret-key')
  })
})
