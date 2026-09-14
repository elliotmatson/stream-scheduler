import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import type { ConfigValues } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import { InvalidScheduleError, validateSchedule } from '../schedule/recurrence.js'
import { bumpSeriesVersion, materializeSeries } from '../schedule/materialize.js'
import { isValidTimeZone } from '../schedule/zoned.js'
import { ConfigInvalidError, UnknownPluginError } from '../plugins/registry.js'
import { TemplateError } from '../template/render.js'

export interface ServerOptions {
  app: Application
  port?: number
  /**
   * Defaults to loopback. Exposing the UI on a LAN is an explicit choice:
   * an unauthenticated page that can start broadcasts and reveal stream keys
   * is a worse hole than the unauthenticated device protocols themselves.
   */
  host?: string
  /** Directory of built web assets, served at `/` when present. */
  webRoot?: string
}

export class InsecureBindError extends Error {
  constructor(host: string) {
    super(
      `Refusing to listen on ${host} without SCHEDULER_UI_PASSWORD set.\n` +
        `Anyone who can reach this port could start broadcasts and read stream keys. ` +
        `Set a password, or bind to 127.0.0.1 (the default).`,
    )
    this.name = 'InsecureBindError'
  }
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { app } = options
  const host = options.host ?? '127.0.0.1'
  const password = process.env.SCHEDULER_UI_PASSWORD

  if (!isLoopback(host) && !password) throw new InsecureBindError(host)

  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  await fastify.register(websocket)

  if (password) {
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.url === '/healthz') return
      const header = request.headers.authorization ?? ''
      const expected = `Bearer ${password}`
      if (header !== expected) {
        await reply.code(401).send({ error: 'Unauthorized' })
      }
    })
  }

  fastify.setErrorHandler(async (raw, _request, reply) => {
    const error = raw instanceof Error ? raw : new Error(String(raw))
    const status = statusFor(error)
    if (status >= 500) {
      app.logger.error('request failed', { error: error.message })
    }
    await reply.code(status).send({ error: error.message, ...detailsFor(error) })
  })

  registerRoutes(fastify, app)
  registerWebsocket(fastify, app)

  if (options.webRoot && existsSync(options.webRoot)) {
    await fastify.register(fastifyStatic, { root: options.webRoot })
    // The UI is a single-page app: unknown paths are routes, not 404s.
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' })
      return reply.sendFile('index.html')
    })
  }

  return fastify
}

function registerRoutes(fastify: FastifyInstance, app: Application): void {
  const { db } = app

  fastify.get('/healthz', async () => ({ ok: true }))

  fastify.get('/api/plugins', async () =>
    app.registry.list().map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      configSchema: plugin.configSchema,
      canDiscover: typeof plugin.discover === 'function',
    })),
  )

  fastify.post('/api/plugins/:id/discover', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const plugin = app.registry.get(id)
    if (!plugin.discover) return []
    return plugin.discover()
  })

  // -- devices ------------------------------------------------------------

  fastify.get('/api/devices', async () => {
    const rows = db.prepare('SELECT * FROM device ORDER BY label').all() as DeviceRowShape[]
    return rows.map((row) => {
      const connection = app.connections.get(row.id)
      return {
        id: row.id,
        pluginId: row.plugin_id,
        label: row.label,
        // Secret fields are returned as a masked marker, never the value.
        config: maskSecrets(app, row.plugin_id, JSON.parse(row.config) as ConfigValues),
        probedModel: row.probed_model,
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
        health: row.health,
        lastError: row.last_error,
        lastSeenAt: row.last_seen_at,
        enabled: row.enabled === 1,
        nodes: connection?.nodes ?? [],
      }
    })
  })

  const deviceBody = z.object({
    pluginId: z.string().min(1),
    label: z.string().min(1),
    config: z.record(z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })

  fastify.post('/api/devices', async (request, reply) => {
    const body = deviceBody.parse(request.body)
    const config = storeSecrets(app, body.pluginId, body.config as ConfigValues, {})
    app.registry.assertValidConfig(body.pluginId, config)

    const id = randomUUID()
    db.prepare(
      'INSERT INTO device (id, plugin_id, label, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, body.pluginId, body.label, JSON.stringify(config), body.enabled ? 1 : 0, app.clock.now())
    return reply.code(201).send({ id })
  })

  fastify.patch('/api/devices/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = deviceBody.partial().parse(request.body)
    const row = deviceOr404(db, id)
    const existing = JSON.parse(row.config) as ConfigValues

    const config = body.config
      ? storeSecrets(app, row.plugin_id, body.config as ConfigValues, existing)
      : existing
    app.registry.assertValidConfig(row.plugin_id, config)

    db.prepare('UPDATE device SET label = ?, config = ?, enabled = ? WHERE id = ?').run(
      body.label ?? row.label,
      JSON.stringify(config),
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      id,
    )
    // Config changed, so the live connection is stale.
    await app.connections.close(id)
    return { ok: true }
  })

  fastify.delete('/api/devices/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await app.connections.close(id)
    db.prepare('DELETE FROM device WHERE id = ?').run(id)
    return { ok: true }
  })

  fastify.post('/api/devices/:id/connect', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const connection = await app.connections.open(id)
    return { capabilities: connection.capabilities, nodes: connection.nodes, health: connection.health }
  })

  // -- credentials --------------------------------------------------------

  fastify.get('/api/credentials', async () =>
    (
      db.prepare('SELECT id, label, source, ingest_url, external_id FROM stream_credential ORDER BY label').all() as {
        id: string
        label: string
        source: string
        ingest_url: string | null
        external_id: string | null
      }[]
    ).map((row) => ({
      id: row.id,
      label: row.label,
      source: row.source,
      ingestUrl: row.ingest_url,
      externalId: row.external_id,
      // The key itself is write-only: the UI shows a placeholder and a
      // "replace" action, and there is no endpoint that returns it.
      key: '••••••••',
    })),
  )

  fastify.post('/api/credentials', async (request, reply) => {
    const body = z
      .object({ label: z.string().min(1), ingestUrl: z.string().min(1), key: z.string().min(1) })
      .parse(request.body)
    const id = randomUUID()
    db.prepare(
      'INSERT INTO stream_credential (id, label, source, ingest_url, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, body.label, 'manual', body.ingestUrl, app.vault.store(body.key), app.clock.now())
    return reply.code(201).send({ id })
  })

  // -- pipelines ----------------------------------------------------------

  fastify.get('/api/pipelines', async () =>
    (db.prepare('SELECT id, label, graph FROM pipeline ORDER BY label').all() as {
      id: string
      label: string
      graph: string
    }[]).map((row) => ({ id: row.id, label: row.label, graph: JSON.parse(row.graph) })),
  )

  fastify.post('/api/pipelines', async (request, reply) => {
    const body = z.object({ label: z.string().min(1), graph: z.record(z.unknown()).default({ nodes: [] }) }).parse(
      request.body,
    )
    const id = randomUUID()
    db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      body.label,
      JSON.stringify(body.graph),
      app.clock.now(),
    )
    return reply.code(201).send({ id })
  })

  // -- series -------------------------------------------------------------

  const seriesBody = z.object({
    label: z.string().min(1),
    pipelineId: z.string().min(1),
    timezone: z.string().min(1),
    rrule: z.string().nullable().default(null),
    dtstart: z.number().int(),
    durationMs: z.number().int().positive(),
    prepareLeadMs: z.number().int().nonnegative().default(30 * 60_000),
    prerollMs: z.number().int().nonnegative().default(0),
    postrollMs: z.number().int().nonnegative().default(0),
    lateStartGraceMs: z.number().int().nonnegative().default(5 * 60_000),
    templates: z.record(z.string()).default({}),
    exdates: z.array(z.number().int()).default([]),
    enabled: z.boolean().default(true),
  })

  fastify.get('/api/series', async () =>
    (db.prepare('SELECT * FROM event_series ORDER BY label').all() as SeriesRowShape[]).map(toSeriesDto),
  )

  fastify.post('/api/series', async (request, reply) => {
    const body = seriesBody.parse(request.body)
    assertSchedulable(body)

    const id = randomUUID()
    const now = app.clock.now()
    db.prepare(
      `INSERT INTO event_series
         (id, label, pipeline_id, timezone, rrule, dtstart, duration_ms, exdates, prepare_lead_ms, preroll_ms,
          postroll_ms, late_start_grace_ms, templates, version, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      body.label,
      body.pipelineId,
      body.timezone,
      body.rrule,
      body.dtstart,
      body.durationMs,
      JSON.stringify(body.exdates),
      body.prepareLeadMs,
      body.prerollMs,
      body.postrollMs,
      body.lateStartGraceMs,
      JSON.stringify(body.templates),
      body.enabled ? 1 : 0,
      now,
      now,
    )
    materializeSeries(db, id, { clock: app.clock })
    return reply.code(201).send({ id })
  })

  fastify.patch('/api/series/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = seriesBody.partial().parse(request.body)
    const row = db.prepare('SELECT * FROM event_series WHERE id = ?').get(id) as SeriesRowShape | undefined
    if (!row) throw new NotFoundError(`No series with id "${id}".`)

    const merged = { ...toSeriesDto(row), ...body }
    assertSchedulable(merged)

    db.prepare(
      `UPDATE event_series SET label = ?, pipeline_id = ?, timezone = ?, rrule = ?, dtstart = ?, duration_ms = ?,
         exdates = ?, prepare_lead_ms = ?, preroll_ms = ?, postroll_ms = ?, late_start_grace_ms = ?, templates = ?,
         enabled = ? WHERE id = ?`,
    ).run(
      merged.label,
      merged.pipelineId,
      merged.timezone,
      merged.rrule,
      merged.dtstart,
      merged.durationMs,
      JSON.stringify(merged.exdates),
      merged.prepareLeadMs,
      merged.prerollMs,
      merged.postrollMs,
      merged.lateStartGraceMs,
      JSON.stringify(merged.templates),
      merged.enabled ? 1 : 0,
      id,
    )
    bumpSeriesVersion(db, id, app.clock)
    // Reconciles future occurrences while leaving edited ones detached.
    return materializeSeries(db, id, { clock: app.clock })
  })

  fastify.delete('/api/series/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    db.prepare('DELETE FROM event_series WHERE id = ?').run(id)
    return { ok: true }
  })

  fastify.get('/api/series/:id/preview', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    // Renders the next few occurrences so a template mistake — including a
    // timezone one — is visible while typing rather than after it airs.
    const upcoming = db
      .prepare("SELECT id FROM occurrence WHERE series_id = ? AND status = 'pending' ORDER BY scheduled_start LIMIT 3")
      .all(id) as { id: string }[]
    return upcoming.map((row) => {
      try {
        return { occurrenceId: row.id, ...app.planner.previewNames(row.id) }
      } catch (error) {
        return { occurrenceId: row.id, error: error instanceof Error ? error.message : String(error) }
      }
    })
  })

  // -- occurrences --------------------------------------------------------

  fastify.get('/api/occurrences', async (request) => {
    const query = z
      .object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() })
      .parse(request.query)
    const from = query.from ?? app.clock.now() - 7 * 86_400_000
    const to = query.to ?? app.clock.now() + 60 * 86_400_000

    return (
      db
        .prepare(
          `SELECT o.*, s.label AS series_label, s.timezone AS timezone,
                  (SELECT r.id FROM run r WHERE r.occurrence_id = o.id ORDER BY r.attempt DESC LIMIT 1) AS run_id,
                  (SELECT r.state FROM run r WHERE r.occurrence_id = o.id ORDER BY r.attempt DESC LIMIT 1) AS run_state
             FROM occurrence o JOIN event_series s ON s.id = o.series_id
            WHERE o.scheduled_start BETWEEN ? AND ?
            ORDER BY o.scheduled_start`,
        )
        .all(from, to) as OccurrenceRowShape[]
    ).map((row) => ({
      id: row.id,
      seriesId: row.series_id,
      seriesLabel: row.series_label,
      timezone: row.timezone,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      localDate: row.local_date,
      status: row.status,
      detached: row.overrides !== null,
      overrides: row.overrides ? JSON.parse(row.overrides) : null,
      runId: row.run_id,
      runState: row.run_state,
    }))
  })

  fastify.post('/api/occurrences/:id/skip', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    db.prepare("UPDATE occurrence SET status = 'skipped' WHERE id = ? AND status = 'pending'").run(id)
    return { ok: true }
  })

  fastify.post('/api/occurrences/:id/unskip', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    db.prepare("UPDATE occurrence SET status = 'pending' WHERE id = ? AND status = 'skipped'").run(id)
    return { ok: true }
  })

  fastify.post('/api/occurrences/:id/start-now', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const runId = await app.engine.startNow(id)
    await app.engine.advance(runId)
    return { runId, state: app.store.getRun(runId).state }
  })

  // -- runs ---------------------------------------------------------------

  fastify.get('/api/runs', async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) }).parse(request.query)
    return (
      db
        .prepare(
          `SELECT r.*, o.scheduled_start, s.label AS series_label
             FROM run r JOIN occurrence o ON o.id = r.occurrence_id JOIN event_series s ON s.id = o.series_id
            ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(limit) as (RunRowShape & { scheduled_start: number; series_label: string })[]
    ).map(toRunDto)
  })

  fastify.get('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const run = db
      .prepare(
        `SELECT r.*, o.scheduled_start, s.label AS series_label
           FROM run r JOIN occurrence o ON o.id = r.occurrence_id JOIN event_series s ON s.id = o.series_id
          WHERE r.id = ?`,
      )
      .get(id) as (RunRowShape & { scheduled_start: number; series_label: string }) | undefined
    if (!run) throw new NotFoundError(`No run with id "${id}".`)

    // The step timeline is the most valuable debugging surface in the app,
    // and it is safe to screenshot: requests and responses were scrubbed
    // before they were ever written.
    return {
      ...toRunDto(run),
      steps: app.store.steps(id).map((step) => ({
        seq: step.seq,
        kind: step.kind,
        state: step.state,
        attempts: step.attempts,
        externalId: step.external_id,
        request: step.request ? JSON.parse(step.request) : null,
        response: step.response ? JSON.parse(step.response) : null,
        error: step.error,
        startedAt: step.started_at,
        endedAt: step.ended_at,
        durationMs: step.started_at && step.ended_at ? step.ended_at - step.started_at : null,
      })),
    }
  })

  fastify.post('/api/runs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const { reason } = z.object({ reason: z.string().optional() }).parse(request.body ?? {})
    const state = await app.engine.cancel(id, reason ?? 'Stopped by an operator')
    return { state }
  })
}

function registerWebsocket(fastify: FastifyInstance, app: Application): void {
  const clients = new Set<{ send(data: string): void }>()

  const broadcast = (payload: unknown): void => {
    const data = JSON.stringify(payload)
    for (const client of clients) {
      try {
        client.send(data)
      } catch {
        clients.delete(client)
      }
    }
  }

  app.connections.on((event) => broadcast({ channel: 'device', ...event }))
  app.onTick(() =>
    broadcast({
      channel: 'runs',
      runs: app.store.listActiveRuns().map((run) => ({ id: run.id, state: run.state })),
      devices: app.connections.list().map((c) => ({ id: c.deviceId, health: c.health.state })),
    }),
  )

  fastify.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
  })
}

// -- helpers --------------------------------------------------------------

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function statusFor(error: Error): number {
  if (error instanceof NotFoundError || error instanceof UnknownPluginError) return 404
  if (error instanceof ConfigInvalidError || error instanceof InvalidScheduleError || error instanceof TemplateError) {
    return 400
  }
  if (error instanceof z.ZodError) return 400
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return 500
}

function detailsFor(error: Error): Record<string, unknown> {
  if (error instanceof z.ZodError) return { issues: error.issues }
  if (error instanceof ConfigInvalidError) return { issues: error.issues }
  if (error instanceof TemplateError) return { issues: error.issues }
  return {}
}

interface DeviceRowShape {
  id: string
  plugin_id: string
  label: string
  config: string
  probed_model: string | null
  capabilities: string | null
  health: string
  last_error: string | null
  last_seen_at: number | null
  enabled: number
}

interface SeriesRowShape {
  id: string
  label: string
  pipeline_id: string
  timezone: string
  rrule: string | null
  dtstart: number
  duration_ms: number
  exdates: string
  prepare_lead_ms: number
  preroll_ms: number
  postroll_ms: number
  late_start_grace_ms: number
  templates: string
  version: number
  enabled: number
}

interface OccurrenceRowShape {
  id: string
  series_id: string
  series_label: string
  timezone: string
  scheduled_start: number
  scheduled_end: number
  local_date: string
  status: string
  overrides: string | null
  run_id: string | null
  run_state: string | null
}

interface RunRowShape {
  id: string
  occurrence_id: string
  state: string
  attempt: number
  created_at: number
  started_at: number | null
  ended_at: number | null
  failure: string | null
}

function toSeriesDto(row: SeriesRowShape) {
  return {
    id: row.id,
    label: row.label,
    pipelineId: row.pipeline_id,
    timezone: row.timezone,
    rrule: row.rrule,
    dtstart: row.dtstart,
    durationMs: row.duration_ms,
    exdates: JSON.parse(row.exdates) as number[],
    prepareLeadMs: row.prepare_lead_ms,
    prerollMs: row.preroll_ms,
    postrollMs: row.postroll_ms,
    lateStartGraceMs: row.late_start_grace_ms,
    templates: JSON.parse(row.templates) as Record<string, string>,
    version: row.version,
    enabled: row.enabled === 1,
  }
}

function toRunDto(row: RunRowShape & { scheduled_start: number; series_label: string }) {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    seriesLabel: row.series_label,
    scheduledStart: row.scheduled_start,
    state: row.state,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    failure: row.failure ? JSON.parse(row.failure) : null,
  }
}

function assertSchedulable(series: {
  timezone: string
  rrule: string | null
  dtstart: number
  durationMs: number
}): void {
  if (!isValidTimeZone(series.timezone)) {
    throw new InvalidScheduleError(`"${series.timezone}" is not a known IANA time zone.`)
  }
  validateSchedule({
    timezone: series.timezone,
    rrule: series.rrule,
    dtstart: series.dtstart,
    durationMs: series.durationMs,
  })
}

function deviceOr404(db: Application['db'], id: string): DeviceRowShape {
  const row = db.prepare('SELECT * FROM device WHERE id = ?').get(id) as DeviceRowShape | undefined
  if (!row) throw new NotFoundError(`No device with id "${id}".`)
  return row
}

/** Replaces submitted secret values with vault references. */
function storeSecrets(
  app: Application,
  pluginId: string,
  submitted: ConfigValues,
  existing: ConfigValues,
): ConfigValues {
  const out: ConfigValues = { ...submitted }
  for (const field of app.registry.configSchema(pluginId)) {
    if (field.type !== 'secret') continue
    const value = submitted[field.id]
    if (value === undefined || value === MASKED) {
      // Left untouched in the form: keep whatever is already stored.
      const previous = existing[field.id]
      if (previous === undefined) delete out[field.id]
      else out[field.id] = previous
      continue
    }
    if (typeof value !== 'string' || value === '') {
      delete out[field.id]
      continue
    }
    out[field.id] = app.vault.store(value)
  }
  return out
}

const MASKED = '••••••••'

/** Secret fields leave as a marker, never a value — there is no read path. */
function maskSecrets(app: Application, pluginId: string, config: ConfigValues): ConfigValues {
  const out: ConfigValues = { ...config }
  try {
    for (const field of app.registry.configSchema(pluginId)) {
      if (field.type !== 'secret') continue
      if (out[field.id] !== undefined) out[field.id] = MASKED
    }
  } catch {
    // A device whose plugin is no longer loaded: mask nothing we cannot
    // identify, but never return raw config we cannot reason about.
    return {}
  }
  return out
}
