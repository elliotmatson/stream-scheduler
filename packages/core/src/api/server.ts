import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyCookie from '@fastify/cookie'
import { z } from 'zod'
import { DeviceError, fingerprint, VerificationError } from '@scheduler/plugin-sdk'
import type {
  ConfigValues,
  JsonObject,
  MediaItem,
  NodeDefinition,
  NodeState,
} from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import type { Db } from '../db/index.js'
import type { VerifyCheck } from '../devices/connection-manager.js'
import {
  describeSchedule,
  expandOccurrences,
  InvalidScheduleError,
  nextOccurrenceAfter,
  validateSchedule,
} from '../schedule/recurrence.js'
import { bumpSeriesVersion, materializeSeries } from '../schedule/materialize.js'
import { isValidTimeZone, zonedWallTimeToUtc } from '../schedule/zoned.js'
import { ConfigInvalidError, UnknownPluginError } from '../plugins/registry.js'
import { eventMidRunOn as midRunOn, reportAll } from '../runs/retention.js'
import { SweepRefused } from '../runs/sweep.js'
import { renderTemplate, TemplateError } from '../template/render.js'
import { sanitizeFilename } from '../template/index.js'
import {
  outputsForSeries,
  requiredAction,
  toOutput,
  type EventOutput,
  type OutputKind,
} from '../events/outputs.js'
import { describeConflict, overlapsForSeries } from '../events/overlap.js'
import { assertUnreferenced, ConflictError, NotFoundError } from './errors.js'
import { buildDashboard, outputsOf } from './dashboard.js'
import { registerAuthGate, registerAuthRoutes } from './auth-routes.js'
import { registerNotifyRoutes } from './notify-routes.js'
import { registerOAuthRoutes } from './oauth-routes.js'
import { originOf } from './origin.js'

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

const DELETE_CONFIRM_TTL_MS = 5 * 60_000

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { app } = options
  const host = options.host ?? '127.0.0.1'

  // A password is optional, and where it listens still matters. Loopback
  // with no password is a fine single-booth install; anything wider without
  // one is worth saying out loud, once, at startup — and on the status
  // screen, which is what `setExposed` is for.
  app.setExposed(!isLoopback(host))
  if (!isLoopback(host) && !app.auth.required) {
    app.logger.warn(
      `Listening on ${host} with no password. Anyone who can reach this port ` +
        `can start broadcasts and drive your devices. Set one in the app, or ` +
        `with SCHEDULER_UI_PASSWORD, or publish to 127.0.0.1 ` +
        `(-p 127.0.0.1:8500:8500) instead.`,
    )
  }

  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })

  // Learn where people actually reach this app, for the links in alerts.
  // Only page loads count: a container health check curling loopback every
  // thirty seconds would otherwise keep resetting it to an address that
  // works on one machine and nowhere else.
  fastify.addHook('onRequest', async (request) => {
    if (request.headers.accept?.includes('text/html')) app.setPublicOrigin(originOf(request))
  })

  // Before every route, including the WebSocket upgrade and the static
  // assets: a gate registered later would leave whatever came first open.
  await fastify.register(fastifyCookie)
  registerAuthGate(fastify, app)

  await fastify.register(websocket)

  fastify.setErrorHandler(async (raw, _request, reply) => {
    const error = raw instanceof Error ? raw : new Error(String(raw))
    const status = statusFor(error)
    if (status >= 500) {
      app.logger.error('request failed', { error: error.message })
    }
    await reply.code(status).send({ error: error.message, ...detailsFor(error) })
  })

  registerAuthRoutes(fastify, app)
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
    const busy = db
      .prepare(
        `SELECT DISTINCT r.id AS run_id, s.label AS label, eo.device_id AS device_id
         FROM run r
         JOIN occurrence o ON o.id = r.occurrence_id
         JOIN event_series s ON s.id = o.series_id
         JOIN event_output eo ON eo.series_id = s.id AND eo.enabled = 1
        WHERE r.state NOT IN ('completed', 'failed', 'cancelled')`,
      )
      .all() as { run_id: string; label: string; device_id: string | null }[]

    return rows.map((row) => {
      const connection = app.connections.get(row.id)
      return {
        inUseBy: busy
          .filter((run) => run.device_id === row.id)
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
    ).run(
      id,
      body.pluginId,
      body.label,
      JSON.stringify(config),
      body.enabled ? 1 : 0,
      app.clock.now(),
    )
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
    return {
      capabilities: connection.capabilities,
      nodes: connection.nodes,
      health: connection.health,
    }
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

  /** Verifying a slot selection needs the slot, so it is built per request. */
  const selectedSlotCheck = (slot: number): VerifyCheck => ({
    what: 'Selected card',
    expected: `slot ${slot}`,
    satisfiedBy: (state: NodeState) =>
      state.recording?.slots?.find((entry) => entry.active)?.id === slot,
    settleMs: 10_000,
  })

  fastify.get('/api/devices/:id/nodes/:nodeId/state', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    nodeOr404(app, id, nodeId)
    return { state: await app.connections.invoke(id, nodeId, 'readState') }
  })

  /** Shared with the sweeper, which refuses for the same reason. */
  const eventMidRunOn = (deviceId: string): string | undefined => midRunOn(db, deviceId)

  /**
   * Point an encoder at a stored stream target by hand.
   *
   * Takes the id of a saved credential, never a key. The key is read out of
   * the vault on this side and handed straight to the device, so no secret
   * crosses this API in either direction — which is what the action
   * allow-list above refuses to allow and this route does not change.
   *
   * Quality rides along because the device takes both in one command: an
   * encoder is told its platform, server, key and profile together, and
   * there is no way to set the profile on its own. Leaving it out leaves
   * the device on whatever profile it is already set to.
   */
  fastify.post('/api/devices/:id/nodes/:nodeId/stream-target', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    const body = z
      .object({ credentialId: z.string(), quality: z.string().min(1).max(100).optional() })
      .parse(request.body)

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes('applyStreamTarget')) {
      throw new ConflictError(`"${node.label}" cannot be pointed at a stream target.`)
    }

    // Re-pointing an encoder that is live sends the stream somewhere else
    // mid-service, and the scheduler will not put it back until the next
    // event starts.
    const busy = eventMidRunOn(id)
    if (busy) {
      throw new ConflictError(
        `"${busy}" is mid-run on this device. Stop the run before re-pointing it.`,
      )
    }

    const credential = db
      .prepare('SELECT label, ingest_url, secret_ref FROM stream_credential WHERE id = ?')
      .get(body.credentialId) as
      { label: string; ingest_url: string | null; secret_ref: string } | undefined
    if (!credential) throw new NotFoundError(`No stream credential with id "${body.credentialId}".`)
    if (!credential.ingest_url) {
      throw new ConflictError(`"${credential.label}" has no ingest URL to point anything at.`)
    }

    const key = app.vault.reveal(credential.secret_ref)
    const state = await app.connections.applyAndVerify(
      id,
      nodeId,
      'applyStreamTarget',
      { url: credential.ingest_url, key, ...(body.quality ? { quality: body.quality } : {}) },
      {
        what: 'Stream target',
        expected: `${credential.ingest_url} with key ${fingerprint(key)}`,
        // The device reports the key back as a fingerprint, so the check is
        // that the right key landed without the value making the trip.
        satisfiedBy: (state: NodeState) =>
          state.streaming?.targetUrl === credential.ingest_url &&
          state.streaming?.keyFingerprint === fingerprint(key),
        settleMs: 10_000,
      },
    )

    app.logger.info('an operator pointed a device at a stream target by hand', {
      deviceId: id,
      nodeId,
      credentialId: body.credentialId,
    })
    return { state }
  })

  /**
   * Erase a card.
   *
   * On its own route rather than in the action allow-list above, because
   * it is the one thing here that destroys something and it does not share
   * their shape: it answers with a token instead of state, and it is
   * refused outright while the device is mid-run. The deck's own protocol
   * is already a two-step handshake and this passes that through rather
   * than inventing a confirmation of its own.
   */
  fastify.post('/api/devices/:id/nodes/:nodeId/format', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    const body = z
      .object({ slot: z.number().int().positive(), confirm: z.string().min(1).optional() })
      .parse(request.body)

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes('formatStorage')) {
      throw new ConflictError(`"${node.label}" cannot format its storage.`)
    }

    // Erasing the card an event is recording onto is not a thing to find
    // out about afterwards.
    const busy = eventMidRunOn(id)
    if (busy) {
      throw new ConflictError(
        `"${busy}" is mid-run on this device. Stop the run before formatting.`,
      )
    }

    const state = await app.connections.invoke(id, nodeId, 'formatStorage', {
      slot: body.slot,
      ...(body.confirm ? { confirm: body.confirm } : {}),
    })
    const confirm = (state?.raw as { confirm?: unknown } | undefined)?.confirm
    if (body.confirm) {
      app.logger.warn('an operator formatted device storage', {
        deviceId: id,
        nodeId,
        slot: body.slot,
      })
      return { formatted: true }
    }
    return { formatted: false, confirm: typeof confirm === 'string' ? confirm : undefined }
  })

  fastify.post('/api/devices/:id/nodes/:nodeId/:action', async (request) => {
    const { id, nodeId, action } = z
      .object({
        id: z.string(),
        nodeId: z.string(),
        action: z.enum([
          'startStreaming',
          'stopStreaming',
          'startRecording',
          'stopRecording',
          'selectSlot',
        ]),
      })
      .parse(request.params)
    const body = z
      .object({
        filename: z.string().min(1).max(200).optional(),
        // Which card to record onto. Absent means the deck's own setting,
        // which is what an operator who has not thought about it wants.
        slot: z.number().int().positive().optional(),
        // For a recorder that shares its encoder with the streaming side,
        // where there is no stream target to carry the quality.
        quality: z.string().min(1).max(100).optional(),
      })
      .parse(request.body ?? {})

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes(action)) {
      throw new ConflictError(`"${node.label}" does not do ${action}.`)
    }

    if (action === 'selectSlot') {
      if (body.slot === undefined) throw new ConflictError('Say which card to select.')
      const state = await app.connections.applyAndVerify(
        id,
        nodeId,
        'selectSlot',
        { slot: body.slot },
        selectedSlotCheck(body.slot),
      )
      app.logger.info('an operator selected a card by hand', {
        deviceId: id,
        nodeId,
        slot: body.slot,
      })
      return { state }
    }

    const check = MANUAL_ACTIONS[action]
    // A recording has to be called something: the node contract takes a
    // filename, and the device would otherwise refuse with a message about
    // arguments rather than about what the operator left blank.
    if (action === 'startRecording' && !body.filename) {
      throw new ConflictError('Give the recording a name before starting it.')
    }
    const args: JsonObject =
      action === 'startRecording'
        ? {
            filename: sanitizeFilename(body.filename!),
            ...(body.slot === undefined ? {} : { slot: body.slot }),
            ...(body.quality ? { quality: body.quality } : {}),
          }
        : {}
    const state = await app.connections.applyAndVerify(id, nodeId, action, args, check)

    app.logger.info('an operator drove a device by hand', { deviceId: id, nodeId, action })
    return { state }
  })

  // -- credentials --------------------------------------------------------

  fastify.get('/api/credentials', async () =>
    (
      db
        .prepare(
          'SELECT id, label, source, ingest_url, external_id FROM stream_credential ORDER BY label',
        )
        .all() as {
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
    timezone: z.string().min(1),
    rrule: z.string().nullable().default(null),
    dtstart: z.number().int().optional(),
    /** The wall time the operator actually means, resolved in `timezone`. */
    dtstartLocal: LOCAL_START.optional(),
    durationMs: z.number().int().positive(),
    prepareLeadMs: z
      .number()
      .int()
      .nonnegative()
      .default(30 * 60_000),
    prerollMs: z.number().int().nonnegative().default(0),
    postrollMs: z.number().int().nonnegative().default(0),
    lateStartGraceMs: z
      .number()
      .int()
      .nonnegative()
      .default(5 * 60_000),
    templates: z.record(z.string()).default({}),
    exdates: z.array(z.number().int()).default([]),
    enabled: z.boolean().default(true),
  })

  fastify.get('/api/series', async () => {
    const now = app.clock.now()
    return (db.prepare('SELECT * FROM event_series ORDER BY label').all() as SeriesRowShape[]).map(
      (row) => ({
        ...toSeriesDto(row),
        // When it next runs, or null if it never does again. Answered from
        // the rule rather than the occurrence table: the table only reaches
        // the materialization horizon, and an event beyond it has not
        // stopped, it just has not been written down yet.
        nextAt: nextOccurrenceAfter(
          {
            timezone: row.timezone,
            rrule: row.rrule,
            dtstart: row.dtstart,
            durationMs: row.duration_ms,
            exdates: JSON.parse(row.exdates) as number[],
          },
          now,
        ),
      }),
    )
  })

  fastify.post('/api/series', async (request, reply) => {
    const parsed = seriesBody.parse(request.body)
    const body = { ...parsed, dtstart: resolveDtstart(parsed) }
    assertSchedulable(body)

    const id = randomUUID()
    const now = app.clock.now()
    db.prepare(
      `INSERT INTO event_series
         (id, label, timezone, rrule, dtstart, duration_ms, exdates,
          prepare_lead_ms, preroll_ms, postroll_ms, late_start_grace_ms, templates, version, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      body.label,
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
    const row = db.prepare('SELECT * FROM event_series WHERE id = ?').get(id) as
      SeriesRowShape | undefined
    if (!row) throw new NotFoundError(`No series with id "${id}".`)

    const merged = { ...toSeriesDto(row), ...body, dtstart: body.dtstart ?? row.dtstart }
    // A local start only makes sense against a timezone, and an edit may be
    // changing both at once, so it is resolved against the merged pair.
    if (body.dtstartLocal)
      merged.dtstart = resolveDtstart({ ...merged, dtstartLocal: body.dtstartLocal })
    assertSchedulable(merged)

    db.prepare(
      `UPDATE event_series SET label = ?, timezone = ?, rrule = ?,
         dtstart = ?, duration_ms = ?, exdates = ?, prepare_lead_ms = ?, preroll_ms = ?, postroll_ms = ?,
         late_start_grace_ms = ?, templates = ?, enabled = ? WHERE id = ?`,
    ).run(
      merged.label,
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
      .prepare(
        "SELECT id FROM occurrence WHERE series_id = ? AND status = 'pending' ORDER BY scheduled_start LIMIT 3",
      )
      .all(id) as { id: string }[]
    return upcoming.map((row) => {
      try {
        // Per output, not just the event: with four streams carrying four
        // different titles, the event-level template is no longer what
        // anybody actually sees on a channel.
        return { occurrenceId: row.id, outputs: app.planner.previewOutputs(row.id) }
      } catch (error) {
        return {
          occurrenceId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }
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
    /** Where it runs. Required: an output with no hardware is an event that
     *  does nothing at 09:00, and a silent default is how that happens. */
    deviceId: z.string().min(1),
    nodeId: z.string().min(1),
    templates: z.record(z.string()).default({}),
    /** Absent keys mean "leave the device as it is". */
    settings: z
      .object({
        quality: z.string().min(1).optional(),
        slot: z.number().int().positive().optional(),
        // Bounded rather than free: a keepDays of 0 would make every
        // recording eligible the moment it finished.
        retention: z
          .object({
            keepDays: z.number().int().min(1).max(3650).optional(),
            keepLast: z.number().int().min(0).max(100).optional(),
          })
          .optional(),
      })
      .default({}),
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
    assertRightKindOfDevice(app, body)

    const next =
      body.position ??
      (
        db
          .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM event_output WHERE series_id = ?')
          .get(id) as {
          p: number
        }
      ).p + 1

    const outputId = randomUUID()
    db.prepare(
      `INSERT INTO event_output
         (id, series_id, kind, label, position, offset_ms, duration_ms, destination_id, credential_id,
          device_id, node_id, templates, settings, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(body.settings),
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
      Record<string, unknown> | undefined
    if (!row) throw new NotFoundError(`No output with id "${id}".`)

    const current = toOutput(row as never)
    const body = outputBody.partial().parse(request.body)
    const merged = { ...current, ...body }
    assertDeliverable(merged)
    assertRightKindOfDevice(app, merged)

    db.prepare(
      `UPDATE event_output SET kind = ?, label = ?, position = ?, offset_ms = ?, duration_ms = ?,
         destination_id = ?, credential_id = ?, device_id = ?, node_id = ?, templates = ?, settings = ?,
         enabled = ?
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
      JSON.stringify(merged.settings),
      merged.enabled ? 1 : 0,
      id,
    )
    bumpSeriesVersion(db, current.seriesId, app.clock)
    return outputsResponse(current.seriesId)
  })

  fastify.delete('/api/outputs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = db.prepare('SELECT series_id FROM event_output WHERE id = ?').get(id) as
      { series_id: string } | undefined
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
    db.prepare("UPDATE occurrence SET status = 'skipped' WHERE id = ? AND status = 'pending'").run(
      id,
    )
    return { ok: true }
  })

  fastify.post('/api/occurrences/:id/unskip', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    db.prepare("UPDATE occurrence SET status = 'pending' WHERE id = ? AND status = 'skipped'").run(
      id,
    )
    return { ok: true }
  })

  /**
   * Prepare an event early, so the broadcast exists and can be linked to.
   *
   * An unlisted stream has to be sent round before the day, and the link
   * does not exist until the broadcast does. This runs the prepare phase
   * and stops: every output still goes on air at its own time.
   */
  fastify.post('/api/occurrences/:id/prepare-now', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const runId = await app.engine.prepareNow(id)
    // Deliberately not advanced: advancing an event whose window has already
    // opened would put it on air, and this button does not do that.
    return { runId, state: app.store.getRun(runId).state, links: watchLinks(app, runId) }
  })

  fastify.post('/api/occurrences/:id/start-now', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const runId = await app.engine.startNow(id)
    await app.engine.advance(runId)
    return { runId, state: app.store.getRun(runId).state }
  })

  /**
   * One screen: what is on air, what is next, what needs somebody.
   *
   * One endpoint rather than the page stitching four together, so every
   * number on it comes from the same instant — a dashboard whose halves
   * disagree is worse than no dashboard.
   */
  fastify.get('/api/dashboard', async () => buildDashboard(app))

  // -- runs ---------------------------------------------------------------

  fastify.get('/api/runs', async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
      .parse(request.query)
    return (
      db
        .prepare(
          `SELECT r.*, o.scheduled_start, s.label AS series_label, s.timezone AS timezone
             FROM run r JOIN occurrence o ON o.id = r.occurrence_id JOIN event_series s ON s.id = o.series_id
            ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(limit) as RunJoinShape[]
    ).map(toRunDto)
  })

  fastify.get('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const run = db
      .prepare(
        `SELECT r.*, o.scheduled_start, s.label AS series_label, s.timezone AS timezone
           FROM run r JOIN occurrence o ON o.id = r.occurrence_id JOIN event_series s ON s.id = o.series_id
          WHERE r.id = ?`,
      )
      .get(id) as RunJoinShape | undefined
    if (!run) throw new NotFoundError(`No run with id "${id}".`)

    // The step timeline is the most valuable debugging surface in the app,
    // and it is safe to screenshot: requests and responses were scrubbed
    // before they were ever written.
    return {
      ...toRunDto(run),
      // The same view of an output the status screen has. This page is the
      // detailed one, so it carries the numbers as well as the steps.
      outputs: outputsOf(app, id, run.occurrence_id),
      // Where each prepared stream can be watched. Pulled out of the step
      // responses because that is where it lands, and buried in a timeline
      // is no use to somebody who needs to send the link round.
      links: watchLinks(app, id),
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

  /**
   * What the devices were doing, over the whole run.
   *
   * Decimated to at most `points` readings per output: a chart is six
   * hundred pixels wide and a four-hour service is a thousand samples, so
   * sending all of them costs bandwidth to draw the same line.
   */
  fastify.get('/api/runs/:id/telemetry', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const { points, windowMs } = z
      .object({
        points: z.coerce.number().int().min(10).max(2000).default(240),
        // The last stretch of the run rather than all of it. A four-hour
        // service drawn into six hundred pixels hides the ninety seconds
        // somebody is actually looking for.
        windowMs: z.coerce.number().int().min(60_000).optional(),
      })
      .parse(request.query ?? {})

    const all = app.telemetry.read(id)
    // Measured from the last reading, not from now: a finished run would
    // otherwise narrow to nothing as the day went on.
    const latest = all.length === 0 ? 0 : Math.max(...all.map((sample) => sample.at))
    const cutoff = windowMs === undefined ? undefined : latest - windowMs

    const byOutput = new Map<string, ReturnType<typeof app.telemetry.read>>()
    for (const sample of all) {
      if (cutoff !== undefined && sample.at < cutoff) continue
      const key = sample.outputId ?? `${sample.deviceId}/${sample.nodeId}`
      const list = byOutput.get(key) ?? []
      list.push(sample)
      byOutput.set(key, list)
    }

    return {
      outputs: [...byOutput.entries()].map(([outputId, samples]) => ({
        outputId,
        samples: decimate(samples, points),
      })),
    }
  })

  /**
   * What each recording output's policy says could go.
   *
   * Nothing is deleted here, and nothing is deleted anywhere yet: this
   * answers the question so somebody can look at the answer before the
   * ability to act on it exists. Asking the devices is the slow part — one
   * listing per node however many outputs write to it — and it is a screen
   * somebody opens deliberately, not one that polls.
   */
  fastify.get('/api/retention', async () => {
    const reports = await reportAll({
      db,
      ledger: app.ledger,
      clock: app.clock,
      listMedia: async (deviceId, nodeId) => {
        try {
          const state = await app.connections.invoke(deviceId, nodeId, 'listMedia')
          const media = state?.raw?.media
          return Array.isArray(media) ? (media as unknown as MediaItem[]) : undefined
        } catch {
          // A deck that is off, or one that cannot list its media at all,
          // is not an error here: the ledger still knows what we put on it,
          // and the report says so without the device's corroboration.
          return undefined
        }
      },
    })
    return { outputs: reports }
  })

  /**
   * Prepares a sweep: the exact list, and a token to run it with.
   *
   * Two steps, like formatting a card, and for a stronger reason: the
   * confirm removes precisely the files this call named. A sweep that
   * re-derived "what is old" at the moment it deleted could remove
   * something the operator never saw, because a recording finished in the
   * seconds between looking and pressing.
   */
  /**
   * Bulk deletes that have been described but not yet agreed to.
   *
   * In memory and short-lived on purpose. A confirmation is a record of
   * what somebody was shown, not a durable grant, and a restart losing
   * one costs a second look at the list — which is the right thing to
   * lose.
   */
  const pendingDeletes = new Map<
    string,
    { deviceId: string; nodeId: string; names: string[]; slot?: number; at: number }
  >()

  /**
   * What is on one recorder's media.
   *
   * Straight from the device, not the ledger: this screen is about the
   * card as it actually is, including everything somebody else put there.
   * The ledger's view of the same card is retention's business.
   */
  fastify.get('/api/devices/:id/nodes/:nodeId/media', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    const { slot } = z
      .object({ slot: z.coerce.number().int().positive().optional() })
      .parse(request.query ?? {})

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes('listMedia')) {
      throw new ConflictError(`"${node.label}" cannot list what is on its media.`)
    }

    const state = await app.connections.invoke(id, nodeId, 'listMedia', {
      ...(slot === undefined ? {} : { slot }),
    })
    const media = state?.raw?.media
    return { files: Array.isArray(media) ? (media as unknown as MediaItem[]) : [] }
  })

  /**
   * Removes files somebody has picked, one call, two steps.
   *
   * The same handshake as a sweep and as formatting, because it is the
   * same kind of act: the first call answers with exactly what would go
   * and a token, and the second removes precisely that. Bulk selection is
   * the reason it matters here — ticking twelve boxes and pressing a
   * button is far easier to do by accident than deleting twelve files one
   * at a time.
   */
  fastify.post('/api/devices/:id/nodes/:nodeId/media/delete', async (request) => {
    const { id, nodeId } = z.object({ id: z.string(), nodeId: z.string() }).parse(request.params)
    const body = z
      .object({
        names: z.array(z.string().min(1)).min(1).max(500),
        slot: z.number().int().positive().optional(),
        confirm: z.string().min(1).optional(),
      })
      .parse(request.body)

    const node = nodeOr404(app, id, nodeId)
    if (!node.supports.includes('deleteMedia')) {
      throw new ConflictError(`"${node.label}" cannot remove files.`)
    }

    // The same rail as the sweep: a card being written to is not one to be
    // tidying up, whatever the hardware would allow.
    const busy = eventMidRunOn(id)
    if (busy) {
      throw new ConflictError(
        `"${busy}" is mid-run on this device. Deleting waits until it is done.`,
      )
    }
    if (app.connections.lastStates(id).some(({ state }) => state.recording?.active === true)) {
      throw new ConflictError('This device is recording. Deleting waits until it stops.')
    }

    if (body.confirm === undefined) {
      const token = randomUUID()
      pendingDeletes.set(token, {
        deviceId: id,
        nodeId,
        names: body.names,
        ...(body.slot === undefined ? {} : { slot: body.slot }),
        at: app.clock.now(),
      })
      return { deleted: false, confirm: token, files: body.names }
    }

    const plan = pendingDeletes.get(body.confirm)
    // One use, and only for the device it was issued against: a token that
    // could be replayed, or pointed at another deck, is a worse button
    // than no button.
    pendingDeletes.delete(body.confirm)
    if (!plan || plan.deviceId !== id || plan.nodeId !== nodeId) {
      throw new ConflictError('That confirmation is no longer valid. Look at the list again.')
    }
    if (app.clock.now() - plan.at > DELETE_CONFIRM_TTL_MS) {
      throw new ConflictError('That confirmation is more than five minutes old. Look again.')
    }

    const removed: string[] = []
    const failed: { name: string; reason: string }[] = []
    for (const name of plan.names) {
      try {
        await app.connections.invoke(id, nodeId, 'deleteMedia', {
          name,
          ...(plan.slot === undefined ? {} : { slot: plan.slot }),
        })
        removed.push(name)
      } catch (error) {
        failed.push({ name, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    app.logger.warn('an operator deleted files from a device', {
      deviceId: id,
      nodeId,
      removed,
      failed: failed.map((entry) => entry.name),
    })
    return { deleted: true, removed, failed }
  })

  fastify.post('/api/retention/sweep', async (request) => {
    const body = z
      .object({ outputId: z.string().min(1), confirm: z.string().min(1).optional() })
      .parse(request.body ?? {})

    try {
      if (body.confirm === undefined) {
        const plan = await app.sweeper.prepare(body.outputId)
        return {
          swept: false,
          confirm: plan.token,
          outputLabel: plan.outputLabel,
          seriesLabel: plan.seriesLabel,
          files: plan.files.map((file) => ({ filename: file.filename, slot: file.slot })),
        }
      }

      const outcome = await app.sweeper.confirm(body.confirm)
      // Loud in the log whatever the UI does with it: this is the one
      // operation in the app that destroys somebody's footage.
      app.logger.warn('an operator swept recordings', {
        outputId: body.outputId,
        removed: outcome.removed.map((file) => file.filename),
        failed: outcome.failed.map((file) => file.filename),
      })
      return { swept: true, ...outcome }
    } catch (error) {
      // Mapped rather than hand-rolled: every other refusal in this API is
      // a ConflictError, and one endpoint answering in its own shape is a
      // client that has to special-case it.
      if (error instanceof SweepRefused) throw new ConflictError(error.message)
      throw error
    }
  })

  /**
   * Forgets a run.
   *
   * Its steps go with it, and so do its telemetry samples — both are only
   * ever read through the run, so leaving them would be litter nobody can
   * see.
   *
   * Two things deliberately survive. The recording ledger keeps its rows,
   * because the files are still on the card: that ledger is the only
   * record that they are ours, and dropping it would make a morning's
   * footage permanently invisible to retention. And the quota ledger
   * keeps its rows, because it is an account of units actually spent
   * against a daily limit, and an account that can be erased by deleting
   * the thing that spent them is not an account.
   */
  fastify.delete('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const run = db.prepare('SELECT state FROM run WHERE id = ?').get(id) as
      { state: string } | undefined
    if (!run) throw new NotFoundError(`No run with id "${id}".`)

    // A run still going is driving devices. Deleting the record of it
    // while it does that leaves the engine working from something that no
    // longer exists.
    if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
      throw new ConflictError('This run has not finished. Stop it before removing it.')
    }

    db.prepare('DELETE FROM telemetry_sample WHERE run_id = ?').run(id)
    // Steps cascade from the run's own foreign key.
    db.prepare('DELETE FROM run WHERE id = ?').run(id)
    return { deleted: true }
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

/**
 * The watch links a run has produced so far.
 *
 * A prepare step records where the broadcast can be seen, so a stream that
 * has finished preparing has a link whether or not it has gone live yet.
 */
function watchLinks(app: Application, runId: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = []
  for (const step of app.store.steps(runId)) {
    if (!step.response) continue
    const response = JSON.parse(step.response) as { watchUrl?: unknown }
    if (typeof response.watchUrl !== 'string') continue
    // The step label reads "Main: create the broadcast"; the half before
    // the colon is the output an operator named.
    links.push({
      label: (step.label ?? '').split(':')[0]?.trim() || 'Stream',
      url: response.watchUrl,
    })
  }
  return links
}

/**
 * Thins a series to at most `limit` readings, keeping the first and the last.
 *
 * Every nth rather than an average: an averaged bitrate hides the dip that
 * is the whole reason somebody opened the chart.
 */
function decimate<T>(samples: T[], limit: number): T[] {
  if (samples.length <= limit) return samples
  const step = (samples.length - 1) / (limit - 1)
  const out: T[] = []
  for (let i = 0; i < limit; i++) out.push(samples[Math.round(i * step)]!)
  return out
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
  if (
    error instanceof ConfigInvalidError ||
    error instanceof InvalidScheduleError ||
    error instanceof TemplateError
  ) {
    return 400
  }
  if (error instanceof z.ZodError) return 400
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return 500
}

function detailsFor(error: Error): Record<string, unknown> {
  if (error instanceof DeviceError) {
    return {
      code: error.code,
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    }
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
    timezone: row.timezone,
    rrule: row.rrule,
    // The rule in plain language, said once here rather than by every
    // screen that shows a series growing its own half-translation of
    // FREQ=WEEKLY;BYDAY=SU.
    describes: describeSchedule({
      timezone: row.timezone,
      rrule: row.rrule,
      dtstart: row.dtstart,
      durationMs: row.duration_ms,
    }),
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

/** A run joined to the occurrence and series it belongs to. */
type RunJoinShape = RunRowShape & {
  scheduled_start: number
  series_label: string
  timezone: string
}

function toRunDto(row: RunJoinShape) {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    seriesLabel: row.series_label,
    // Every time on the run's page is shown in the event's zone, not the
    // browser's, the same way the schedule is.
    timezone: row.timezone,
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

  const [year, month, day] = body.dtstartLocal.date.split('-').map(Number) as [
    number,
    number,
    number,
  ]
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
 * A stream needs an encoder and a recording needs a recorder.
 *
 * Checked against what the device actually reported it can do, not against
 * what it is called: the point of probing is that a model name is a guess
 * and `supports` is not. An unconnected device cannot be checked, so it is
 * allowed through and pre-flight catches it the evening before — refusing
 * would mean you could not write next month's events with the rack powered
 * down.
 */
function assertRightKindOfDevice(
  app: Application,
  output: { kind: OutputKind; label: string; deviceId: string | null; nodeId: string | null },
): void {
  if (!output.deviceId || !output.nodeId) return
  const connection = app.connections.get(output.deviceId)
  if (!connection) return

  const node = connection.nodes.find((candidate) => candidate.id === output.nodeId)
  if (!node) {
    throw new ConflictError(`"${connection.label}" has no "${output.nodeId}".`)
  }

  const needed = requiredAction(output.kind)
  if (node.supports.includes(needed)) return

  throw new ConflictError(
    output.kind === 'stream'
      ? `"${output.label}" is a stream, but "${node.label}" does not stream. Pick an encoder.`
      : `"${output.label}" is a recording, but "${node.label}" does not record. Pick a recorder.`,
  )
}

/**
 * A stream has to know where it is going, and cannot be told twice.
 *
 * Refused at the API rather than left to fail in the prepare phase: an
 * output with both a service and a hand-typed key is not a preference the
 * app gets to resolve, and one with neither is a stream that would silently
 * do nothing at 09:00.
 */
function assertDeliverable(
  output: Pick<EventOutput, 'kind' | 'destinationId' | 'credentialId' | 'label'>,
): void {
  if (output.kind !== 'stream') return
  if (output.destinationId && output.credentialId) {
    throw new ConflictError(
      `"${output.label}" has both a streaming service and a stream key. Pick one: the service issues its own key.`,
    )
  }
  if (!output.destinationId && !output.credentialId) {
    throw new ConflictError(
      `"${output.label}" has nowhere to stream to. Pick a streaming service or a stream key.`,
    )
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
