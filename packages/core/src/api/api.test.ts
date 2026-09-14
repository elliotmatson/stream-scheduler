import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { silentLogger } from '../log.js'
import { createServer } from './server.js'

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
async function patch(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await server.inject({ method: 'PATCH', url, payload: body as object })
  return { status: response.statusCode, json: safeJson(response.body) }
}
async function del(url: string): Promise<{ status: number; json: any }> {
  const response = await server.inject({ method: 'DELETE', url })
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

/** Builds an encoder and a weekly event that streams from it. */
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

  const series = await post('/api/series', {
    label: 'Sunday Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstart: START,
    durationMs: 90 * MINUTE,
    templates,
  })
  const output = await post(`/api/series/${series.json.id}/outputs`, {
    kind: 'stream',
    label: 'Main',
    durationMs: 90 * MINUTE,
    credentialId: credential.json.id,
    deviceId: device.json.id,
    nodeId: 'stream',
  })
  return {
    deviceId: device.json.id,
    seriesId: series.json.id,
    credentialId: credential.json.id,
    outputId: output.json.id,
  }
}

describe('server binding', () => {
  it('answers healthz', async () => {
    expect(await get('/healthz')).toMatchObject({ status: 200, json: { ok: true } })
  })

  it('serves the API with no credentials, on a LAN bind as well as loopback', async () => {
    // There is no authentication yet. The bearer check that used to live
    // here rejected every browser request including the HTML page, so the UI
    // was unusable exactly where it was enabled. Asserting the unauthenticated
    // path works is what keeps a half-built login from shipping in that state
    // again.
    const exposed = await createServer({ app, host: '0.0.0.0' })
    try {
      const response = await exposed.inject({ method: 'GET', url: '/api/devices' })
      expect(response.statusCode).toBe(200)
    } finally {
      await exposed.close()
    }
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
    const base = { label: 'S', dtstart: START, durationMs: 90 * MINUTE }
    expect((await post('/api/series', { ...base, timezone: 'America/Chicgao', rrule: null })).status).toBe(400)
    expect((await post('/api/series', { ...base, timezone: 'UTC', rrule: 'FREQ=NEVER' })).status).toBe(400)
  })

  it('previews rendered names for the next occurrences', async () => {
    const { seriesId } = await seedEverything({ title: '{{event.name}} - {{date "EEEE, MMMM d, yyyy"}}' })
    const preview = await get(`/api/series/${seriesId}/preview`)
    expect(preview.json).toHaveLength(3)
    // Per output, because with several streams in a window the event-level
    // template is no longer what anybody sees on a channel.
    expect(preview.json[0].outputs[0].title).toBe('Sunday Service - Sunday, March 8, 2026')
    expect(preview.json[1].outputs[0].title).toBe('Sunday Service - Sunday, March 15, 2026')
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
    expect(started.json.state).toBe('running')

    const run = await get(`/api/runs/${started.json.runId}`)
    expect(run.json.steps.map((s: { label: string; state: string }) => `${s.label}:${s.state}`)).toEqual([
      'Main: point the encoder at it:done',
      'Main: go live:done',
      'Main: stop:pending',
    ])
    // The timeline is safe to screenshot and attach to a bug report.
    expect(JSON.stringify(run.json)).not.toContain('live_super-secret-key')
  })

  it('prepares early without putting anything on air', async () => {
    // What this is for: an unlisted broadcast has to exist before its link
    // can be sent round, and that is days before the service.
    const { deviceId } = await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json

    // Well before the event, and before its prepare lead would have fired.
    clock.set(START - 3 * 60 * MINUTE)
    const prepared = await post(`/api/occurrences/${first.id}/prepare-now`, {})
    expect(prepared.status).toBe(200)

    const run = await get(`/api/runs/${prepared.json.runId}`)
    expect(run.json.state).toBe('ready')
    const states = run.json.steps.map((step: { label: string; state: string }) => `${step.label}:${step.state}`)
    // Everything that puts it on air is still to come at its own time:
    // preparing is not starting. Pointing the encoder is part of going on
    // air rather than of preparing, so that one encoder can carry the 9:00
    // service and then the 11:00 one.
    expect(states).toEqual([
      'Main: point the encoder at it:pending',
      'Main: go live:pending',
      'Main: stop:pending',
    ])

    const state = await get(`/api/devices/${deviceId}/nodes/stream/state`)
    expect(state.json.state.streaming.active).toBe(false)
  })

  it('hands back where to watch, once something has prepared', async () => {
    // A stub service rather than YouTube: what is under test is that the
    // link a provider reports in prepare comes back out of the run, not
    // anybody's API.
    app.destinations.register({
      id: 'stub',
      displayName: 'Stub service',
      apiVersion: '1',
      configSchema: [],
      providesIngest: true,
      createDestination: async () => ({
        prepare: async () => ({
          externalId: 'bc-1',
          ingest: { url: 'rtmps://stub.invalid/live', key: 'stub_key-value' },
          watchUrl: 'https://watch.invalid/bc-1',
        }),
        reconcile: async () => undefined,
        finalize: async () => {},
        compensate: async () => {},
        health: () => ({ state: 'connected' as const, since: 0 }),
        dispose: async () => {},
      }),
    })
    app.db
      .prepare(
        `INSERT INTO account (id, provider, external_id, display_name, secret_ref, scopes, created_at)
         VALUES ('acct-stub', 'stub', 'x', 'Stub channel', 'ref', '', 0)`,
      )
      .run()
    const destination = await post('/api/destinations', {
      providerId: 'stub',
      label: 'Stub channel',
      accountId: 'acct-stub',
      config: {},
    })

    const { seriesId, deviceId, outputId } = await seedEverything()
    await del(`/api/series/${seriesId}/outputs/${outputId}`)
    await post(`/api/series/${seriesId}/outputs`, {
      kind: 'stream',
      label: 'Main',
      durationMs: 90 * MINUTE,
      destinationId: destination.json.id,
      deviceId,
      nodeId: 'stream',
    })

    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START - 3 * 60 * MINUTE)
    const prepared = await post(`/api/occurrences/${first.id}/prepare-now`, {})

    expect(prepared.json.links).toEqual([{ label: 'Main', url: 'https://watch.invalid/bc-1' }])
    const run = await get(`/api/runs/${prepared.json.runId}`)
    expect(run.json.links).toEqual([{ label: 'Main', url: 'https://watch.invalid/bc-1' }])
    // And no key came back with it.
    expect(JSON.stringify(run.json)).not.toContain('stub_key-value')
  })

  it('cancels a live run through the API', async () => {
    await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START)
    const started = await post(`/api/occurrences/${first.id}/start-now`, {})

    const cancelled = await post(`/api/runs/${started.json.runId}/cancel`, { reason: 'Service ended early' })
    expect(cancelled.json.state).toBe('cancelled')

    const run = await get(`/api/runs/${started.json.runId}`)
    expect(run.json.steps.find((s: { label: string }) => s.label === 'Main: stop').state).toBe('done')
  })

  it('404s for an unknown run', async () => {
    expect((await get('/api/runs/nope')).status).toBe(404)
  })
})

describe('driving a device by hand', () => {
  it('starts and stops, reading the device back each time', async () => {
    const deviceId = await connectRecorder()

    const before = await get(`/api/devices/${deviceId}/nodes/record/state`)
    expect(before.json.state.recording.active).toBe(false)

    const started = await post(`/api/devices/${deviceId}/nodes/record/startRecording`, { filename: 'take 1' })
    expect(started.status).toBe(200)
    // The state comes back from a read, not from the command being accepted.
    expect(started.json.state.recording.active).toBe(true)

    const stopped = await post(`/api/devices/${deviceId}/nodes/record/stopRecording`, {})
    expect(stopped.json.state.recording.active).toBe(false)
  })

  it('passes on the device\'s own refusal rather than calling it a server error', async () => {
    // An encoder that has never been pointed anywhere cannot stream, and
    // saying so is the single most likely thing to happen on this screen.
    const { deviceId } = await seedEverything()
    const refused = await post(`/api/devices/${deviceId}/nodes/stream/startStreaming`, {})

    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/No stream target/)
    expect(refused.json.code).toBe('no-stream-target')
    expect(refused.json.remediation).toBeTruthy()
  })

  it('fails loudly when the device accepts the command and ignores it', async () => {
    // A HyperDeck mid-reboot. The whole reason every write is read back: a
    // button that goes green without the device doing anything is worse
    // than no button.
    const device = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Deaf deck',
      config: { kind: 'recorder', fault: 'ignores-writes' },
    })
    await post(`/api/devices/${device.json.id}/connect`, {})

    const attempt = await post(`/api/devices/${device.json.id}/nodes/record/startRecording`, {
      filename: 'take 1',
    })
    expect(attempt.status).toBe(502)
    expect(attempt.json.error).toMatch(/did not take effect/)
  })

  it('will not start a recording with no name', async () => {
    const deviceId = await connectRecorder()
    const refused = await post(`/api/devices/${deviceId}/nodes/record/startRecording`, {})
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/name/)
  })

  it('records under the name an operator typed, made safe for a filesystem', async () => {
    const deviceId = await connectRecorder()
    const started = await post(`/api/devices/${deviceId}/nodes/record/startRecording`, {
      filename: 'rehearsal/2026: take 1',
    })
    expect(started.json.state.recording.active).toBe(true)
    expect(started.json.state.recording.filename).not.toContain('/')
    expect(started.json.state.recording.filename).toContain('rehearsal')
  })

  it('refuses an action the node does not have', async () => {
    const deviceId = await connectRecorder()
    const refused = await post(`/api/devices/${deviceId}/nodes/record/startStreaming`, {})
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/does not do startStreaming/)
  })

  it('says to connect first rather than failing somewhere inside a plugin', async () => {
    const device = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Never connected',
      config: { kind: 'encoder' },
    })
    const refused = await post(`/api/devices/${device.json.id}/nodes/stream/startStreaming`, {})
    expect(refused.status).toBe(404)
    expect(refused.json.error).toMatch(/not connected/)
  })

  it('offers no way to route signal, which is the desk\'s job and not the scheduler\'s', async () => {
    // The ATEM adapter implements `route` and nothing above the plugin
    // drives it. Pinned so that stays a decision rather than drifting back
    // in because the action happens to exist.
    const { deviceId } = await seedEverything()
    const refused = await post(`/api/devices/${deviceId}/nodes/stream/route`, { input: '3', output: '0' })
    expect(refused.status).toBe(400)
  })

  it('points an encoder at a saved target by id, so no key crosses this API', async () => {
    const { deviceId, credentialId } = await seedEverything()

    const pointed = await post(`/api/devices/${deviceId}/nodes/stream/stream-target`, { credentialId })
    expect(pointed.status).toBe(200)
    expect(pointed.json.state.streaming.targetUrl).toBe('rtmps://a.rtmp.youtube.com/live2')
    // Read back as a fingerprint: the key went to the device and nowhere else.
    expect(pointed.json.state.streaming.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(pointed.json)).not.toContain('live_super-secret-key')

    // And now it can actually go live, which it could not before.
    const live = await post(`/api/devices/${deviceId}/nodes/stream/startStreaming`, {})
    expect(live.json.state.streaming.active).toBe(true)
  })

  it('will not re-point an encoder out from under a running event', async () => {
    const { deviceId, credentialId } = await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START)
    await post(`/api/occurrences/${first.id}/start-now`, {})

    const refused = await post(`/api/devices/${deviceId}/nodes/stream/stream-target`, { credentialId })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/Sunday Service/)
  })

  it('records onto the card an operator picked rather than the deck default', async () => {
    const deviceId = await connectRecorder()
    const started = await post(`/api/devices/${deviceId}/nodes/record/startRecording`, {
      filename: 'take 1',
      slot: 2,
    })
    expect(started.status).toBe(200)
    expect(started.json.state.recording.active).toBe(true)
    const slots = started.json.state.recording.slots as { id: number; active?: boolean }[]
    expect(slots.find((slot) => slot.active)?.id).toBe(2)
  })

  it('offers no way to push a stream key at a device', async () => {
    const { deviceId } = await seedEverything()
    const attempt = await post(`/api/devices/${deviceId}/nodes/stream/applyStreamTarget`, {
      url: 'rtmps://evil.invalid/live',
      key: 'live_someone-elses-key',
    })
    // Not in the allow-list: a key would otherwise cross this endpoint in
    // the clear, outside any run and with nothing to clean it up.
    expect(attempt.status).toBe(400)
  })

  it('names the event mid-run on a device, so a manual stop is not a surprise', async () => {
    const { deviceId } = await seedEverything()
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START)
    await post(`/api/occurrences/${first.id}/start-now`, {})

    const device = (await get('/api/devices')).json.find((row: { id: string }) => row.id === deviceId)
    expect(device.inUseBy).toEqual([{ runId: expect.any(String), label: 'Sunday Service' }])
  })

  it('says nothing is using a device when nothing is', async () => {
    const { deviceId } = await seedEverything()
    const device = (await get('/api/devices')).json.find((row: { id: string }) => row.id === deviceId)
    expect(device.inUseBy).toEqual([])
  })

  it('erases a card only when the token the device handed out comes back', async () => {
    const deviceId = await connectRecorder()

    const prepared = await post(`/api/devices/${deviceId}/nodes/record/format`, { slot: 2 })
    expect(prepared.status).toBe(200)
    expect(prepared.json).toMatchObject({ formatted: false, confirm: expect.any(String) })

    // Preparing asks the device and erases nothing.
    const untouched = await get(`/api/devices/${deviceId}/nodes/record/state`)
    expect(untouched.json.state.recording.slots[1].volumeName).toBe('Sunday B')

    const done = await post(`/api/devices/${deviceId}/nodes/record/format`, {
      slot: 2,
      confirm: prepared.json.confirm,
    })
    expect(done.json).toEqual({ formatted: true })

    const after = await get(`/api/devices/${deviceId}/nodes/record/state`)
    expect(after.json.state.recording.slots[1].volumeName).toBe('Untitled')
  })

  it('passes on the device refusing a confirmation it never gave out', async () => {
    const deviceId = await connectRecorder()
    const refused = await post(`/api/devices/${deviceId}/nodes/record/format`, {
      slot: 1,
      confirm: 'guessed',
    })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('invalid-token')
  })

  it('will not erase a card an event is recording onto', async () => {
    const { seriesId } = await seedEverything()
    const deck = await post('/api/devices', { pluginId: 'mock', label: 'Deck', config: { kind: 'recorder' } })
    await post(`/api/devices/${deck.json.id}/connect`, {})
    await post(`/api/series/${seriesId}/outputs`, {
      kind: 'recording',
      label: 'Archive',
      durationMs: 90 * MINUTE,
      deviceId: deck.json.id,
      nodeId: 'record',
    })
    const [first] = (await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`)).json
    clock.set(START)
    await post(`/api/occurrences/${first.id}/start-now`, {})

    const refused = await post(`/api/devices/${deck.json.id}/nodes/record/format`, { slot: 1 })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/Sunday Service/)
  })

  it('refuses to format a node with no storage to format', async () => {
    const { deviceId } = await seedEverything()
    const refused = await post(`/api/devices/${deviceId}/nodes/stream/format`, { slot: 1 })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/cannot format/)
  })
})

async function connectRecorder(): Promise<string> {
  const device = await post('/api/devices', { pluginId: 'mock', label: 'Deck', config: { kind: 'recorder' } })
  await post(`/api/devices/${device.json.id}/connect`, {})
  return device.json.id as string
}

describe('the OAuth callback address', () => {
  // The route asks the registry for the provider before it answers, so the
  // test needs one registered, and a destination needs an account to hang
  // off. Nothing here touches Google.
  beforeEach(() => {
    app.db
      .prepare(
        `INSERT INTO account (id, provider, external_id, display_name, secret_ref, scopes, created_at)
         VALUES ('acct-1', 'youtube', 'chan-1', 'Grace Bible Church', 'ref', '', 0)`,
      )
      .run()
    app.destinations.register({
      id: 'youtube',
      displayName: 'YouTube',
      apiVersion: '1',
      configSchema: [],
      providesIngest: true,
      oauth: {
        begin: () => ({ url: 'https://accounts.google.invalid/o/oauth2/v2/auth', state: 'state', verifier: 'v' }),
        complete: async () => {
          throw new Error('not exercised here')
        },
      },
      createDestination: async (ctx) => ({
        listPlaylists: async () => [{ id: `PL-${ctx.config.accountRef as string}`, title: 'Sunday Services' }],
        prepare: async () => {
          throw new Error('not exercised here')
        },
        reconcile: async () => undefined,
        finalize: async () => {},
        compensate: async () => {},
        health: () => ({ state: 'connected' as const, since: 0 }),
        dispose: async () => {},
      }),
    })
  })

  // Google matches this character for character and says only
  // "redirect_uri_mismatch" when it does not, so what the app advertises has
  // to be what a browser actually reaches.
  const instructions = async (headers: Record<string, string>) =>
    JSON.parse(
      (await server.inject({ method: 'GET', url: '/api/oauth/youtube/instructions', headers })).body,
    )

  it('points alert links at the address a browser actually used', async () => {
    // A link in an alert has no request to work from, and the loopback
    // default sends everyone to their own machine. Opening the UI is what
    // teaches it where it really is.
    await server.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { host: 'stream.example.org', 'x-forwarded-proto': 'https', accept: 'text/html' },
    })
    expect(app.publicOrigin).toBe('https://stream.example.org')

    // A health check curling loopback must not undo that: it is not a page
    // load, and it happens every thirty seconds forever.
    await server.inject({ method: 'GET', url: '/healthz', headers: { host: '127.0.0.1:8500' } })
    expect(app.publicOrigin).toBe('https://stream.example.org')
  })

  it('offers the channel\u2019s own playlists, before any destination exists', async () => {
    // The form that needs the list is the one creating the destination, so
    // the list is asked of the account rather than of a saved destination.
    const answer = await get('/api/destination-providers/youtube/playlists?accountRef=acct-1')
    expect(answer.status).toBe(200)
    expect(answer.json.playlists).toEqual([{ id: 'PL-acct-1', title: 'Sunday Services' }])
  })

  it('edits a destination in place, rather than making you delete and rebuild it', async () => {
    const created = await post('/api/destinations', {
      providerId: 'youtube',
      label: 'Main channel',
      accountId: 'acct-1',
      config: { privacy: 'public' },
    })
    expect(created.status).toBe(201)

    const changed = await patch(`/api/destinations/${created.json.id}`, {
      label: 'Main channel (unlisted)',
      config: { privacy: 'unlisted', playlistId: 'PL-services' },
    })
    expect(changed.status).toBe(200)

    const [after] = (await get('/api/destinations')).json
    expect(after).toMatchObject({
      label: 'Main channel (unlisted)',
      config: { privacy: 'unlisted', playlistId: 'PL-services' },
    })
  })

  it('says so rather than 500ing when a service has no such notion', async () => {
    app.destinations.register({
      id: 'rtmp',
      displayName: 'Plain RTMP',
      apiVersion: '1',
      configSchema: [],
      providesIngest: false,
      createDestination: async () => ({
        prepare: async () => {
          throw new Error('not exercised here')
        },
        reconcile: async () => undefined,
        finalize: async () => {},
        compensate: async () => {},
        health: () => ({ state: 'connected' as const, since: 0 }),
        dispose: async () => {},
      }),
    })
    const refused = await get('/api/destination-providers/rtmp/playlists?accountRef=acct-1')
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/no playlists/)
  })

  it('uses the host the browser asked for', async () => {
    const body = await instructions({ host: 'scheduler.local:8500' })
    expect(body.redirectUri).toBe('http://scheduler.local:8500/oauth/callback')
  })

  it('follows a proxy that terminated TLS, rather than advertising http', async () => {
    // Tailscale Serve and every reverse proxy hand this process a plain
    // HTTP request. Advertising `http://` for a name like this is not just
    // wrong, it is a URI Google refuses to register at all.
    const body = await instructions({
      host: 'stream.tail48658.ts.net',
      'x-forwarded-proto': 'https',
    })
    expect(body.redirectUri).toBe('https://stream.tail48658.ts.net/oauth/callback')
    expect(body.warnings.some((warning: string) => warning.includes('localhost'))).toBe(false)
  })

  it('takes the first hop when a chain of proxies appends to the header', async () => {
    const body = await instructions({
      host: 'inner:8500',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'stream.example.org, inner:8500',
    })
    expect(body.redirectUri).toBe('https://stream.example.org/oauth/callback')
  })

  it('says so when the address it would advertise is one Google will not take', async () => {
    const body = await instructions({ host: 'stream.tail48658.ts.net' })
    expect(body.redirectUri).toBe('http://stream.tail48658.ts.net/oauth/callback')
    expect(body.warnings.some((warning: string) => warning.includes('localhost'))).toBe(true)
  })

  it('does not warn about http on loopback, where it is the correct flow', async () => {
    const body = await instructions({ host: '127.0.0.1:8500' })
    expect(body.warnings.some((warning: string) => warning.includes('localhost'))).toBe(false)
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

describe('schedule preview', () => {
  const base = {
    label: 'Sunday Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    // 09:00 America/Chicago, the day the clocks go forward.
    dtstart: START,
    durationMs: 90 * MINUTE,
  }

  it('shows what a rule would do before anything is saved', async () => {
    const preview = await post('/api/schedule/preview', { ...base, count: 3 })
    expect(preview.status).toBe(200)
    expect(preview.json.describes).toMatch(/week/i)
    expect(preview.json.occurrences).toHaveLength(3)
    expect(preview.json.occurrences.map((o: { localDate: string }) => o.localDate)).toEqual([
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
    ])
  })

  it('holds a 9am service at 9am local across the DST boundary', async () => {
    // The whole reason the engine expands in wall time: the clocks go
    // forward between these two Sundays, so the UTC instant has to move by
    // an hour for the local time to stay put.
    const preview = await post('/api/schedule/preview', {
      ...base,
      dtstart: Date.parse('2026-03-01T15:00:00Z'), // 09:00 CST
      count: 2,
    })
    const [first, second] = preview.json.occurrences
    expect(second.start - first.start).toBe(7 * 24 * 60 * MINUTE - 60 * MINUTE)
    expect(second.start).toBe(Date.parse('2026-03-08T14:00:00Z')) // 09:00 CDT
  })

  it('renders the name templates against each occurrence, not today', async () => {
    const preview = await post('/api/schedule/preview', {
      ...base,
      count: 2,
      templates: { title: '{{event.name}} — {{date "MMMM d, yyyy"}}' },
    })
    expect(preview.json.occurrences[0].title).toBe('Sunday Service — March 8, 2026')
    expect(preview.json.occurrences[1].title).toBe('Sunday Service — March 15, 2026')
  })

  it('reports a bad token inline rather than failing the whole preview', async () => {
    const preview = await post('/api/schedule/preview', { ...base, count: 1, templates: { title: '{{nonsense}}' } })
    expect(preview.status).toBe(200)
    expect(preview.json.occurrences[0].error).toMatch(/nonsense/)
    // Still shows when it would air, which is the other half of the answer.
    expect(preview.json.occurrences[0].localDate).toBe('2026-03-08')
  })

  it('rejects a rule it cannot parse, with a reason', async () => {
    const preview = await post('/api/schedule/preview', { ...base, rrule: 'FREQ=FORTNIGHTLY' })
    expect(preview.status).toBe(400)
  })

  it('rejects a timezone that does not exist', async () => {
    expect((await post('/api/schedule/preview', { ...base, timezone: 'America/Nowhere' })).status).toBe(400)
  })
})

describe('unpicking a setup', () => {
  it('refuses to delete a stream key an output still points at, naming the event', async () => {
    const { credentialId, seriesId } = await seedEverything()
    const refused = await del(`/api/credentials/${credentialId}`)
    expect(refused.status).toBe(409)
    // Otherwise the dangling id surfaces at T-30m on Sunday.
    expect(refused.json.error).toContain('Sunday Service')

    // ...and allows it once nothing depends on it.
    await del(`/api/series/${seriesId}`)
    expect((await del(`/api/credentials/${credentialId}`)).status).toBe(200)
  })

  it('refuses to delete a device an output still runs on', async () => {
    const { deviceId } = await seedEverything()
    const refused = await del(`/api/devices/${deviceId}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('Sunday Service')
  })
})

describe('outputs', () => {
  it('reports two outputs that would fight over the same encoder', async () => {
    const { seriesId, credentialId, deviceId } = await seedEverything()
    // A second stream on the same source, overlapping the first.
    const added = await post(`/api/series/${seriesId}/outputs`, {
      kind: 'stream',
      label: 'Worship',
      offsetMs: 30 * MINUTE,
      durationMs: 60 * MINUTE,
      credentialId,
      deviceId,
      nodeId: 'stream',
    })

    expect(added.status).toBe(201)
    // Saving is not blocked — somebody rearranging a morning would be
    // stopped by a clash they are about to fix — but it is reported.
    expect(added.json.conflicts).toHaveLength(1)
    expect(added.json.conflicts[0].detail).toContain('Sanctuary encoder')
    expect(added.json.conflicts[0].detail).toContain('only do one at a time')
  })

  it('does not call a recording and a stream on one device a clash', async () => {
    const { seriesId } = await seedEverything()
    const deck = await post('/api/devices', { pluginId: 'mock', label: 'Deck', config: { kind: 'recorder' } })
    await post(`/api/devices/${deck.json.id}/connect`, {})
    const added = await post(`/api/series/${seriesId}/outputs`, {
      kind: 'recording',
      label: 'Archive',
      durationMs: 90 * MINUTE,
      deviceId: deck.json.id,
      nodeId: 'record',
    })
    expect(added.json.conflicts).toEqual([])
  })

  it('refuses a stream with nowhere to go, and one told twice', async () => {
    const { seriesId, credentialId, deviceId } = await seedEverything()
    const nowhere = await post(`/api/series/${seriesId}/outputs`, {
      kind: 'stream',
      label: 'Lost',
      durationMs: 90 * MINUTE,
      deviceId,
      nodeId: 'stream',
    })
    expect(nowhere.status).toBe(409)
    expect(nowhere.json.error).toContain('nowhere to stream to')

    const destination = await post('/api/destinations', {
      providerId: 'mock',
      label: 'Somewhere',
      config: {},
    })
    if (destination.status === 201) {
      const both = await post(`/api/series/${seriesId}/outputs`, {
        kind: 'stream',
        label: 'Both',
        durationMs: 90 * MINUTE,
        credentialId,
        destinationId: destination.json.id,
        deviceId,
        nodeId: 'stream',
      })
      expect(both.status).toBe(409)
    }
  })

  it('reorders in one call rather than one patch per row', async () => {
    const { seriesId, outputId } = await seedEverything()
    const deck = await post('/api/devices', { pluginId: 'mock', label: 'Deck', config: { kind: 'recorder' } })
    await post(`/api/devices/${deck.json.id}/connect`, {})
    const second = await post(`/api/series/${seriesId}/outputs`, {
      kind: 'recording',
      label: 'Archive',
      durationMs: 90 * MINUTE,
      deviceId: deck.json.id,
      nodeId: 'record',
    })

    const reordered = await post(`/api/series/${seriesId}/outputs/order`, {
      order: [second.json.id, outputId],
    })
    expect(reordered.json.outputs.map((o: { label: string }) => o.label)).toEqual(['Archive', 'Main'])
  })

  it('removes an output and leaves the event alone', async () => {
    const { outputId } = await seedEverything()
    const after = await del(`/api/outputs/${outputId}`)
    expect(after.json.outputs).toEqual([])
    expect((await get('/api/series')).json).toHaveLength(1)
  })
})

describe('wall-clock start times', () => {
  it('resolves the time an operator typed in the event\'s own zone', async () => {
    const preview = await post('/api/schedule/preview', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: null,
      dtstartLocal: { date: '2026-03-01', time: '09:00' },
      durationMs: 90 * MINUTE,
    })
    expect(preview.status).toBe(200)
    // 09:00 CST, not 09:00 in the browser's zone or the container's.
    expect(preview.json.occurrences[0].start).toBe(Date.parse('2026-03-01T15:00:00Z'))
  })

  it('refuses a start time that the clocks skip over', async () => {
    // 02:30 on 8 March 2026 never happens in Chicago. Silently shifting it
    // to 01:30 or 03:30 is how an event airs an hour out.
    const preview = await post('/api/schedule/preview', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: null,
      dtstartLocal: { date: '2026-03-08', time: '02:30' },
      durationMs: 90 * MINUTE,
    })
    expect(preview.status).toBe(400)
    expect(preview.json.error).toMatch(/does not exist/)
  })

  it('creates a series from a wall time, and keeps it on edit', async () => {
    const device = await post('/api/devices', {
      pluginId: 'mock',
      label: 'Encoder',
      config: { kind: 'encoder', password: 'pw' },
    })
    await post(`/api/devices/${device.json.id}/connect`, {})
    const pipeline = await post('/api/pipelines', { label: 'Main', graph: { nodes: [] } })

    const series = await post('/api/series', {
      label: 'Sunday Service',
      pipelineId: pipeline.json.id,
      timezone: 'America/Chicago',
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstartLocal: { date: '2026-03-01', time: '09:00' },
      durationMs: 90 * MINUTE,
    })
    expect(series.status).toBe(201)
    expect((await get('/api/series')).json[0].dtstart).toBe(Date.parse('2026-03-01T15:00:00Z'))

    // An edit that only changes the zone re-reads the same wall time there.
    const patched = await server.inject({
      method: 'PATCH',
      url: `/api/series/${series.json.id}`,
      payload: { timezone: 'America/New_York', dtstartLocal: { date: '2026-03-01', time: '09:00' } },
    })
    expect(patched.statusCode).toBe(200)
    expect((await get('/api/series')).json[0].dtstart).toBe(Date.parse('2026-03-01T14:00:00Z'))
  })
})
