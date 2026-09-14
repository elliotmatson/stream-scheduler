import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import { DeviceError, VerificationError } from '@scheduler/plugin-sdk'
import type { ConfigValues, JsonObject, NodeDefinition, NodeState } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import type { Db } from '../db/index.js'
import {
  describeSchedule,
  expandOccurrences,
  InvalidScheduleError,
  validateSchedule,
} from '../schedule/recurrence.js'
import { bumpSeriesVersion, materializeSeries } from '../schedule/materialize.js'
import { isValidTimeZone, zonedWallTimeToUtc } from '../schedule/zoned.js'
import { ConfigInvalidError, UnknownPluginError } from '../plugins/registry.js'
import { renderTemplate, TemplateError } from '../template/render.js'
import { sanitizeFilename } from '../template/index.js'
import { outputsForSeries, toOutput, type EventOutput } from '../events/outputs.js'
import { describeConflict, overlapsForSeries } from '../events/overlap.js'
import { assertUnreferenced, ConflictError, NotFoundError } from './errors.js'
import { registerNotifyRoutes } from './notify-routes.js'
import { registerOAuthRoutes } from './oauth-routes.js'

export interface ServerOptions {
  app: Application
  port?: number
  /**
   * Defaults to loopback, so a plain `node main.js` is not reachable from
   * anywhere else. Binding elsewhere is an explicit act, and there is no
   * authentication yet — see the warning below.
   */
  host?: string
  /** Directory of built web assets, served at `/` when present. */
  webRoot?: string
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { app } = options
  const host = options.host ?? '127.0.0.1'

  // There is no authentication. There was a bearer-token check here, but no
  // browser can send that header — it 401'd the HTML page itself, so the UI
  // was unreachable whenever it was switched on. A lock nobody can open is
  // not security, and it made the container check look like it proved
  // something. Removed until there is a login that works; tracked as an
  // issue.
  //
  // What protects the app today is where it listens. Loopback is the
  // default, and anything else is something the operator chose.
  if (!isLoopback(host)) {
    app.logger.warn(
      `Listening on ${host} with no authentication. Anyone who can reach this ` +
        `port can start broadcasts and read stream keys. In Docker, publish to ` +
        `127.0.0.1 (-p 127.0.0.1:8500:8500) unless you mean to share it.`,
    )
  }

  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  await fastify.register(websocket)

  fastify.setErrorHandler(async (raw, _request, reply) => {
    const error = raw instanceof Error ? raw : new Error(String(raw))
    const status = statusFor(error)
    if (status >= 500) {
      app.logger.error('request failed', { error: error.message })
    }
    await reply.code(status).send({ error: error.message, ...detailsFor(error) })
  })

  registerRoutes(fastify, app)
  registerOAuthRoutes(fastify, app)
  registerNotifyRoutes(fastify, app)
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
    // Which events are mid-run on each device, so the manual controls can
    // say whose stream they are about to interfere with.
    const busy = db.prepare(
      `SELECT DISTINCT r.id AS run_id, s.label AS label, s.source_device_id AS source_device_id,
              o.id AS occurrence_id
         FROM run r
         JOIN occurrence o ON o.id = r.occurrence_id
         JOIN event_series s ON s.id = o.series_id
        WHERE r.state NOT IN ('completed', 'failed', 'cancelled')`,
    ).all() as { run_id: string; label: string; source_device_id: string | null; occurrence_id: string }[]
    const usesDevice = db.prepare(
      `SELECT 1 FROM event_output eo
         JOIN occurrence o ON o.series_id = eo.series_id
        WHERE o.id = ? AND eo.device_id = ? AND eo.enabled = 1
        LIMIT 1`,
    )

    return rows.map((row) => {
      const connection = app.connections.get(row.id)
      return {
        inUseBy: busy
          .filter(
            (run) =>
              run.source_device_id === row.id ||
              usesDevice.get(run.occurrence_id, row.id) !== undefined,
          )
          .map((run) => ({ runId: run.run_id, label: run.label })),
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
    assertUnreferenced(db, 'device_id', id, 'device')
    await app.connections.close(id)
    db.prepare('DELETE FROM device WHERE id = ?').run(id)
    return { ok: true }
  })

  fastify.post('/api/devices/:id/connect', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const connection = await app.connections.open(id)
    return { capabilities: connection.capabilities, nodes: connection.nodes, health: connection.health }
  })


  /**
   * Drive a device by hand.
   *
   * The scheduler must never be the only way to control the hardware: an
   * operator standing in a control room at 09:02 needs a stop button, not a
   * support ticket.
   *
   * Every action here is one the node declared it supports, and every write
   * is read back and checked, for the same reason the run engine does it — a
   * Blackmagic device will accept a command and quietly ignore it, and a
   * button that lies is worse than no button.
   *
   * Two actions a node may declare are deliberately not offered.
   *
   * `applyStreamTarget` takes a stream key, so exposing it here would mean
   * posting a key in the clear to be pushed at a device outside any run,
   * with nothing to clean it up afterwards. Getting a key onto an encoder is
   * what stream credentials and the prepare phase are for.
   *
   * `route` is a live-production control — what is on an ATEM's aux bus is
   * the operator's call at the desk, second by second, not something worth
   * reaching through a scheduler to set. Its arguments are the device's own
   * vocabulary too (the ATEM wants numeric source and bus ids), and there is
   * nothing here that could turn those into something an operator recognises.
   * The current routing is readable through the state endpoint below; it
   * just cannot be written. See docs/plan/04-plugin-sdk.md.
   */
  // The settle windows match the scheduled path's, and for the same reason:
  // going live means opening an RTMP session across the internet, and an
  // encoder sits part-way through that for several seconds. A button that
  // gives up in four is a button that reports failure on a stream which is
  // coming up perfectly.
  const MANUAL_ACTIONS = {
    startStreaming: {
      what: 'Streaming',
      expected: 'active',
      satisfiedBy: (state: NodeState) => state.streaming?.active === true,
      settleMs: 25_000,
    },
    stopStreaming: {
      what: 'Streaming',
      expected: 'stopped',
      satisfiedBy: (state: NodeState) => state.streaming?.active === false,
      settleMs: 10_000,
    },
    startRecording: {
      what: 'Recording',
      expected: 'active',
      satisfiedBy: (state: NodeState) => state.recording?.active === true,
      settleMs: 10_000,
    },
    stopRecording: {
      what: 'Recording',
      expected: 'stopped',
      satisfiedBy: (state: NodeState) => state.recording?.active === false,
      settleMs: 10_000,
    },
  } as const

  fastify.get('/api/devices/:id/nodes/:nodeId/state', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    nodeOr404(app, id, nodeId)
    return { state: await app.connections.invoke(id, nodeId, 'readState') }
  })

  fastify.post('/api/devices/:id/nodes/:nodeId/:action', async (request) => {
    const { id, nodeId, action } = z
      .object({
        id: z.string(),
        nodeId: z.string(),
        action: z.enum(['startStreaming', 'stopStreaming', 'startRecording', 'stopRecording']),
      })
      .parse(request.params)
    const body = z.object({ filename: z.string().min(1).max(200).optional() }).parse(request.body ?? {})

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes(action)) {
      throw new ConflictError(`"${node.label}" does not do ${action}.`)
    }

    const check = MANUAL_ACTIONS[action]
    // A recording has to be called something: the node contract takes a
    // filename, and the device would otherwise refuse with a message about
    // arguments rather than about what the operator left blank.
    if (action === 'startRecording' && !body.filename) {
      throw new ConflictError('Give the recording a name before starting it.')
    }
    const args: JsonObject =
      action === 'startRecording' ? { filename: sanitizeFilename(body.filename!) } : {}
    const state = await app.connections.applyAndVerify(id, nodeId, action, args, check)

    app.logger.info('an operator drove a device by hand', { deviceId: id, nodeId, action })
    return { state }
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

  fastify.delete('/api/credentials/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    assertUnreferenced(db, 'credential_id', id, 'stream key')
    db.prepare('DELETE FROM stream_credential WHERE id = ?').run(id)
    return { ok: true }
  })

  // -- schedule preview ---------------------------------------------------

  /**
   * Answers "what would this actually do?" before anything is saved.
   *
   * The two mistakes this catches are the two that are invisible until they
   * air: a recurrence that lands on the wrong day once the timezone is
   * applied, and a name template that renders yesterday's date. Both are
   * obvious the moment you see the next few occurrences written out, and
   * essentially undetectable from the rule text alone.
   */
  fastify.post('/api/schedule/preview', async (request) => {
    const body = z
      .object({
        label: z.string().default('Untitled event'),
        timezone: z.string().min(1),
        rrule: z.string().nullable().default(null),
        dtstart: z.number().int().optional(),
        dtstartLocal: LOCAL_START.optional(),
        durationMs: z.number().int().positive(),
        templates: z.record(z.string()).default({}),
        count: z.number().int().positive().max(20).default(5),
      })
      .parse(request.body)

    const dtstart = resolveDtstart(body)
    assertSchedulable({ ...body, dtstart })

    const from = Math.min(dtstart, app.clock.now())
    const expanded = expandOccurrences(
      { timezone: body.timezone, rrule: body.rrule, dtstart, durationMs: body.durationMs },
      from,
      // Two years is enough to show something for an annual rule without
      // expanding a daily one into thousands of rows first.
      from + 730 * 86_400_000,
      { limit: body.count },
    )

    return {
      describes: describeSchedule({
        timezone: body.timezone,
        rrule: body.rrule,
        dtstart,
        durationMs: body.durationMs,
      }),
      occurrences: expanded.map((occurrence, offset) => ({
        start: occurrence.start,
        end: occurrence.end,
        localDate: occurrence.localDate,
        // 'skipped' or 'ambiguous' means this one falls in a DST gap or
        // repeat, and the UI flags it rather than quietly shifting the time.
        resolution: occurrence.resolution,
        ...renderNames(body.templates, {
          occurrenceStart: occurrence.start,
          timezone: body.timezone,
          event: { name: body.label },
          series: { name: body.label },
          // Counts from this preview, not from the database: an unsaved
          // series has no history, and an edited one is re-materialized.
          occurrence: { index: offset + 1 },
        }),
      })),
    }
  })

  // -- series -------------------------------------------------------------

  const seriesBody = z.object({
    label: z.string().min(1),
    /** The one encoder this event's outputs run on, unless an output names
     *  its own. Nullable so an event can be written before the hardware is
     *  added. */
    sourceDeviceId: z.string().nullable().default(null),
    sourceNodeId: z.string().nullable().default(null),
    timezone: z.string().min(1),
    rrule: z.string().nullable().default(null),
    dtstart: z.number().int().optional(),
    /** The wall time the operator actually means, resolved in `timezone`. */
    dtstartLocal: LOCAL_START.optional(),
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
    const parsed = seriesBody.parse(request.body)
    const body = { ...parsed, dtstart: resolveDtstart(parsed) }
    assertSchedulable(body)

    const id = randomUUID()
    const now = app.clock.now()
    db.prepare(
      `INSERT INTO event_series
         (id, label, source_device_id, source_node_id, timezone, rrule, dtstart, duration_ms, exdates,
          prepare_lead_ms, preroll_ms, postroll_ms, late_start_grace_ms, templates, version, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      body.label,
      body.sourceDeviceId,
      body.sourceNodeId,
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

    const merged = { ...toSeriesDto(row), ...body, dtstart: body.dtstart ?? row.dtstart }
    // A local start only makes sense against a timezone, and an edit may be
    // changing both at once, so it is resolved against the merged pair.
    if (body.dtstartLocal) merged.dtstart = resolveDtstart({ ...merged, dtstartLocal: body.dtstartLocal })
    assertSchedulable(merged)

    db.prepare(
      `UPDATE event_series SET label = ?, source_device_id = ?, source_node_id = ?, timezone = ?, rrule = ?,
         dtstart = ?, duration_ms = ?, exdates = ?, prepare_lead_ms = ?, preroll_ms = ?, postroll_ms = ?,
         late_start_grace_ms = ?, templates = ?, enabled = ? WHERE id = ?`,
    ).run(
      merged.label,
      merged.sourceDeviceId,
      merged.sourceNodeId,
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
        // Per output, not just the event: with four streams carrying four
        // different titles, the event-level template is no longer what
        // anybody actually sees on a channel.
        return { occurrenceId: row.id, outputs: app.planner.previewOutputs(row.id) }
      } catch (error) {
        return { occurrenceId: row.id, error: error instanceof Error ? error.message : String(error) }
      }
    })
  })


  // -- outputs ------------------------------------------------------------

  /**
   * An event's outputs: what it streams and records, and when inside its
   * window each of those happens.
   *
   * Every response carries `conflicts` alongside the outputs. The clash that
   * matters — two streams wanting the same encoder at the same time — is a
   * property of the set, not of the one you just edited, so it has to be
   * recomputed and shown after every change rather than validated on the way
   * in. Saving is not blocked: an operator part-way through rearranging a
   * morning would otherwise be stopped by a clash they are about to fix.
   */
  const outputBody = z.object({
    kind: z.enum(['stream', 'recording']),
    label: z.string().min(1),
    offsetMs: z.number().int().nonnegative().default(0),
    durationMs: z.number().int().positive(),
    destinationId: z.string().nullable().default(null),
    credentialId: z.string().nullable().default(null),
    /** Null means the event's source encoder. */
    deviceId: z.string().nullable().default(null),
    nodeId: z.string().nullable().default(null),
    templates: z.record(z.string()).default({}),
    enabled: z.boolean().default(true),
    position: z.number().int().nonnegative().optional(),
  })

  const outputsResponse = (seriesId: string) => ({
    outputs: outputsForSeries(db, seriesId),
    conflicts: overlapsForSeries(db, seriesId).map((conflict) => ({
      ...conflict,
      detail: describeConflict(conflict),
    })),
  })

  fastify.get('/api/series/:id/outputs', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    seriesOr404(db, id)
    return outputsResponse(id)
  })

  fastify.post('/api/series/:id/outputs', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    seriesOr404(db, id)
    const body = outputBody.parse(request.body)
    assertDeliverable(body)

    const next =
      body.position ??
      ((db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_output WHERE series_id = ?').get(id) as {
        p: number
      }).p +
        1)

    const outputId = randomUUID()
    db.prepare(
      `INSERT INTO event_output
         (id, series_id, kind, label, position, offset_ms, duration_ms, destination_id, credential_id,
          device_id, node_id, templates, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      outputId,
      id,
      body.kind,
      body.label,
      next,
      body.offsetMs,
      body.durationMs,
      body.destinationId,
      body.credentialId,
      body.deviceId,
      body.nodeId,
      JSON.stringify(body.templates),
      body.enabled ? 1 : 0,
      app.clock.now(),
    )
    // An output changes what the event does, so occurrences already
    // materialized are now out of date in the same way a schedule edit
    // makes them.
    bumpSeriesVersion(db, id, app.clock)
    return reply.code(201).send({ id: outputId, ...outputsResponse(id) })
  })

  fastify.patch('/api/outputs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = db.prepare('SELECT * FROM event_output WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) throw new NotFoundError(`No output with id "${id}".`)

    const current = toOutput(row as never)
    const body = outputBody.partial().parse(request.body)
    const merged = { ...current, ...body }
    assertDeliverable(merged)

    db.prepare(
      `UPDATE event_output SET kind = ?, label = ?, position = ?, offset_ms = ?, duration_ms = ?,
         destination_id = ?, credential_id = ?, device_id = ?, node_id = ?, templates = ?, enabled = ?
       WHERE id = ?`,
    ).run(
      merged.kind,
      merged.label,
      merged.position,
      merged.offsetMs,
      merged.durationMs,
      merged.destinationId,
      merged.credentialId,
      merged.deviceId,
      merged.nodeId,
      JSON.stringify(merged.templates),
      merged.enabled ? 1 : 0,
      id,
    )
    bumpSeriesVersion(db, current.seriesId, app.clock)
    return outputsResponse(current.seriesId)
  })

  fastify.delete('/api/outputs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = db.prepare('SELECT series_id FROM event_output WHERE id = ?').get(id) as
      | { series_id: string }
      | undefined
    if (!row) throw new NotFoundError(`No output with id "${id}".`)
    db.prepare('DELETE FROM event_output WHERE id = ?').run(id)
    bumpSeriesVersion(db, row.series_id, app.clock)
    return outputsResponse(row.series_id)
  })

  /** Reorders in one call, so dragging a list does not fire N patches. */
  fastify.post('/api/series/:id/outputs/order', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    seriesOr404(db, id)
    const body = z.object({ order: z.array(z.string()) }).parse(request.body)

    const update = db.prepare('UPDATE event_output SET position = ? WHERE id = ? AND series_id = ?')
    db.transaction(() => {
      body.order.forEach((outputId, index) => update.run(index, outputId, id))
    })()
    return outputsResponse(id)
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
        // The kind carries an output id so it stays stable across an edit;
        // the label is the half a human can read.
        label: step.label,
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


/** Renders whichever name templates are set, reporting a bad one inline. */
function renderNames(
  templates: Record<string, string>,
  context: Parameters<typeof renderTemplate>[1],
): { title?: string; description?: string; filename?: string; error?: string } {
  const out: { title?: string; description?: string; filename?: string; error?: string } = {}
  for (const key of ['title', 'description', 'filename'] as const) {
    const pattern = templates[key]
    if (!pattern) continue
    const result = renderTemplate(pattern, context)
    if (result.issues.length > 0) {
      // One bad token is worth reporting immediately; the rest of the
      // preview is still useful, so this does not throw.
      out.error = result.issues.map((issue) => `${issue.token} — ${issue.message}`).join('; ')
      continue
    }
    out[key] = key === 'filename' ? sanitizeFilename(result.text) : result.text
  }
  return out
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function statusFor(error: Error): number {
  if (error instanceof NotFoundError || error instanceof UnknownPluginError) return 404
  if (error instanceof ConflictError) return 409
  // The device accepted the command and then did not do it. That is a
  // failure upstream of this app, and calling it a 500 tells an operator to
  // look in the wrong place.
  if (error instanceof VerificationError) return 502
  // The device refused: busy, not pointed anywhere, wrong mode. Its own
  // message is the useful one.
  if (error instanceof DeviceError) return 409
  if (error instanceof ConfigInvalidError || error instanceof InvalidScheduleError || error instanceof TemplateError) {
    return 400
  }
  if (error instanceof z.ZodError) return 400
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return 500
}

function detailsFor(error: Error): Record<string, unknown> {
  if (error instanceof DeviceError) {
    return { code: error.code, ...(error.remediation === undefined ? {} : { remediation: error.remediation }) }
  }
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
  source_device_id: string | null
  source_node_id: string | null
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
    sourceDeviceId: row.source_device_id,
    sourceNodeId: row.source_node_id,
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

const LOCAL_START = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:mm'),
})

/**
 * Turns the wall time an operator typed into the UTC instant we store.
 *
 * This conversion stays on the server so there is exactly one implementation
 * of it: "9am on the 8th, in Chicago" is not a subtraction, and a browser
 * doing its own arithmetic is how an event ends up an hour out twice a year.
 */
function resolveDtstart(body: {
  dtstart?: number
  dtstartLocal?: { date: string; time: string }
  timezone: string
}): number {
  if (body.dtstartLocal === undefined) {
    if (body.dtstart === undefined) throw new InvalidScheduleError('The event needs a start time.')
    return body.dtstart
  }
  if (!isValidTimeZone(body.timezone)) {
    throw new InvalidScheduleError(`"${body.timezone}" is not a known IANA time zone.`)
  }

  const [year, month, day] = body.dtstartLocal.date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = body.dtstartLocal.time.split(':').map(Number) as [number, number]
  const resolved = zonedWallTimeToUtc({ year, month, day, hour, minute, second: 0 }, body.timezone)
  if (resolved.resolution === 'skipped') {
    // 2:30am on the morning the clocks go forward does not exist.
    throw new InvalidScheduleError(
      `${body.dtstartLocal.date} ${body.dtstartLocal.time} does not exist in ${body.timezone}: ` +
        'the clocks go forward over that time. Pick another start.',
    )
  }
  return resolved.instant
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

function seriesOr404(db: Db, id: string): void {
  const row = db.prepare('SELECT id FROM event_series WHERE id = ?').get(id)
  if (!row) throw new NotFoundError(`No event with id "${id}".`)
}

/**
 * A stream has to know where it is going, and cannot be told twice.
 *
 * Refused at the API rather than left to fail in the prepare phase: an
 * output with both a service and a hand-typed key is not a preference the
 * app gets to resolve, and one with neither is a stream that would silently
 * do nothing at 09:00.
 */
function assertDeliverable(output: Pick<EventOutput, 'kind' | 'destinationId' | 'credentialId' | 'label'>): void {
  if (output.kind !== 'stream') return
  if (output.destinationId && output.credentialId) {
    throw new ConflictError(
      `"${output.label}" has both a streaming service and a stream key. Pick one: the service issues its own key.`,
    )
  }
  if (!output.destinationId && !output.credentialId) {
    throw new ConflictError(`"${output.label}" has nowhere to stream to. Pick a streaming service or a stream key.`)
  }
}

/**
 * The node as the device actually reported it, not as something was
 * configured to expect.
 *
 * A device that has never connected has no nodes, and saying so beats a
 * command that fails somewhere inside a plugin.
 */
function nodeOr404(app: Application, deviceId: string, nodeId: string): NodeDefinition {
  const connection = app.connections.get(deviceId)
  if (!connection) {
    throw new NotFoundError(
      `"${deviceId}" is not connected. Press Connect first, so the app knows what this device can do.`,
    )
  }
  const node = connection.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new NotFoundError(`This device has no "${nodeId}".`)
  return node
}
