#!/usr/bin/env node
/**
 * Boots the built host and drives one event end to end over HTTP.
 *
 * The unit suite runs through Vitest, which bundles; that hides problems that
 * only appear in the shipped artifact under native ESM (a CommonJS dependency
 * imported by name, a missing file in the build output, a bad entrypoint).
 * This runs `node packages/host/dist/main.js` exactly as Docker does.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.SMOKE_PORT ?? 8599)
const BASE = `http://127.0.0.1:${PORT}`
const configDir = mkdtempSync(join(tmpdir(), 'scheduler-smoke-'))

const STREAM_KEY = 'live_smoke-test-secret-key'
const DEVICE_PASSWORD = 'smoke-test-device-password'
const OAUTH_SECRET = 'smoke-test-oauth-client-secret'
const CHAT_WEBHOOK = 'https://chat.googleapis.invalid/v1/spaces/AAA/messages?key=k&token=smoke-chat-token'

let child
let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`)
  }
}

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    // Fastify rejects a JSON content-type with an empty body, so bodyless
    // POSTs still send `{}`.
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`)
  return json
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited early with code ${child.exitCode}`)
    try {
      const response = await fetch(`${BASE}/healthz`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('host did not become healthy in time')
}

async function main() {
  child = spawn(process.execPath, ['packages/host/dist/main.js'], {
    env: {
      ...process.env,
      SCHEDULER_CONFIG_DIR: configDir,
      SCHEDULER_SECRET: 'smoke-test-master-secret',
      SCHEDULER_PORT: String(PORT),
      SCHEDULER_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))

  try {
    await waitForHealth()
  } catch (error) {
    process.stdout.write(output)
    throw error
  }
  check('host starts and answers /healthz', true)

  const plugins = await api('GET', '/api/plugins')
  check('plugins are registered', plugins.some((p) => p.id === 'mock'))
  check(
    'ATEM, HyperDeck and Streaming Encoder adapters are loaded',
    ['atem', 'hyperdeck', 'streaming-encoder'].every((id) => plugins.some((p) => p.id === id)),
    plugins.map((p) => p.id).join(', '),
  )

  const device = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Smoke encoder',
    config: { kind: 'encoder', password: DEVICE_PASSWORD },
  })
  const connected = await api('POST', `/api/devices/${device.id}/connect`)
  check('device probes its model', connected.capabilities.model === 'Mock encoder', JSON.stringify(connected.capabilities))

  const devices = await api('GET', '/api/devices')
  check('device password is never returned', !JSON.stringify(devices).includes(DEVICE_PASSWORD))

  const credential = await api('POST', '/api/credentials', {
    label: 'Smoke ingest',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    key: STREAM_KEY,
  })
  const credentials = await api('GET', '/api/credentials')
  check('stream key is never returned', !JSON.stringify(credentials).includes(STREAM_KEY))

  const pipeline = await api('POST', '/api/pipelines', {
    label: 'Smoke pipeline',
    graph: { nodes: [{ id: 'enc', deviceId: device.id, nodeId: 'stream', credentialId: credential.id }] },
  })

  // Two minutes out, so the scheduler would not pick it up on its own and
  // "start now" is genuinely exercising the operator override.
  const start = Date.now() + 120_000
  const series = await api('POST', '/api/series', {
    label: 'Smoke Service',
    pipelineId: pipeline.id,
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY',
    dtstart: start,
    durationMs: 3_600_000,
    templates: { title: '{{event.name}} - {{date "yyyy-MM-dd"}}' },
  })

  const preview = await api('GET', `/api/series/${series.id}/preview`)
  check('name templates render', typeof preview[0]?.title === 'string' && preview[0].title.startsWith('Smoke Service - '), JSON.stringify(preview[0]))

  const occurrences = await api('GET', `/api/occurrences?from=${Date.now()}&to=${Date.now() + 40 * 86_400_000}`)
  check('occurrences are materialized', occurrences.length >= 4, `got ${occurrences.length}`)

  const started = await api('POST', `/api/occurrences/${occurrences[0].id}/start-now`)
  check('an operator can start an event ahead of its window', started.state === 'live', `state was ${started.state}`)

  const run = await api('GET', `/api/runs/${started.runId}`)
  const steps = run.steps.map((s) => `${s.kind}:${s.state}`).join(', ')
  check('stream target was applied and verified', run.steps[0]?.state === 'done', steps)
  check('streaming was started', run.steps[1]?.state === 'done', steps)
  check('the run timeline contains no stream key', !JSON.stringify(run).includes(STREAM_KEY))

  const cancelled = await api('POST', `/api/runs/${started.runId}/cancel`, { reason: 'smoke test' })
  check('an operator can stop a live run', cancelled.state === 'cancelled')

  const afterCancel = await api('GET', `/api/runs/${started.runId}`)
  const stopStep = afterCancel.steps.find((s) => s.kind === 'enc.stopStreaming')
  check('cancelling really told the encoder to stop', stopStep?.state === 'done', JSON.stringify(stopStep))

  const index = await fetch(`${BASE}/`)
  check('the web UI is served', index.ok && (await index.text()).includes('<div id="root">'))

  // -- streaming services ---------------------------------------------------

  const providers = await api('GET', '/api/destination-providers')
  const yt = providers.find((p) => p.id === 'youtube')
  check('the YouTube provider is registered', yt !== undefined && yt.supportsOAuth === true)

  const instructions = await api('GET', '/api/oauth/youtube/instructions')
  check(
    'setup instructions warn about the 7-day Testing expiry',
    instructions.warning.includes('Testing') && instructions.steps.length >= 5,
    instructions.warning,
  )
  check(
    'the redirect URI is a loopback address',
    instructions.redirectUri.startsWith('http://127.0.0.1:') && instructions.redirectUri.endsWith('/oauth/callback'),
    instructions.redirectUri,
  )

  const oauthClient = await api('POST', '/api/oauth/clients', {
    provider: 'youtube',
    label: 'Smoke project',
    clientId: 'smoke-client-id',
    clientSecret: OAUTH_SECRET,
  })
  const clients = await api('GET', '/api/oauth/clients')
  check('the OAuth client secret is never returned', !JSON.stringify(clients).includes(OAUTH_SECRET))

  const authorization = await api('POST', '/api/oauth/youtube/start', { clientRef: oauthClient.id })
  const authUrl = new URL(authorization.url)
  check(
    'the authorization URL uses PKCE and asks for offline access',
    authUrl.searchParams.get('code_challenge_method') === 'S256' &&
      authUrl.searchParams.get('access_type') === 'offline',
    authorization.url,
  )

  const expired = await fetch(`${BASE}/oauth/callback?code=x&state=not-a-real-state`)
  check('a callback with an unknown state is rejected', (await expired.text()).includes('expired'))

  // -- alerts ---------------------------------------------------------------

  const kinds = await api('GET', '/api/notifications/kinds')
  check(
    'Google Chat, Slack, webhook and email channels are available',
    ['google-chat', 'slack', 'webhook', 'email'].every((k) => kinds.some((c) => c.kind === k)),
    kinds.map((k) => k.kind).join(', '),
  )

  const chat = kinds.find((k) => k.kind === 'google-chat')
  check(
    'the Google Chat webhook URL is a secret field',
    chat?.configSchema.find((f) => f.id === 'webhookUrl')?.type === 'secret',
  )

  const channel = await api('POST', '/api/notifications/channels', {
    kind: 'google-chat',
    label: 'Smoke space',
    config: { webhookUrl: CHAT_WEBHOOK },
  })
  const listed = await api('GET', '/api/notifications/channels')
  check('the Chat webhook URL is never returned', !JSON.stringify(listed).includes('smoke-chat-token'))
  check('the channel is listed', listed.channels.some((c) => c.id === channel.id))

  // An unreachable webhook must fail loudly at the button, not silently later.
  let testFailed = false
  try {
    await api('POST', `/api/notifications/channels/${channel.id}/test`)
  } catch {
    testFailed = true
  }
  check('a test to an unreachable webhook reports the failure', testFailed)

  const preflight = await api('GET', `/api/occurrences/${occurrences[0].id}/preflight`)
  check('pre-flight checks an occurrence on demand', Array.isArray(preflight.problems), JSON.stringify(preflight))

  // -- setting the app up through the UI's own endpoints --------------------
  //
  // Everything above was reachable only with curl until the setup screens
  // landed. These are exactly the calls those screens make, in the order a
  // person makes them, so an install that cannot be configured fails here.

  const discovered = await api('POST', '/api/plugins/mock/discover')
  check('a plugin that can scan the network returns candidates', discovered.length >= 1, JSON.stringify(discovered))
  check(
    'a discovered candidate carries config the form can use as-is',
    typeof discovered[0]?.config?.host === 'string',
    JSON.stringify(discovered[0]),
  )

  const shown = (await api('GET', '/api/devices')).find((d) => d.id === device.id)
  check('the edit form is given the stored config', shown?.config?.kind === 'encoder', JSON.stringify(shown?.config))
  check('...with the password masked rather than absent', shown?.config?.password === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022')

  // Re-saving the form without retyping the password must keep the stored
  // one, or every edit would silently break the device.
  await api('PATCH', `/api/devices/${device.id}`, { label: 'Smoke encoder', config: shown.config })
  const reconnected = await api('POST', `/api/devices/${device.id}/connect`)
  check('re-saving a device without retyping its password keeps it working', reconnected.health.state === 'connected', JSON.stringify(reconnected.health))

  const dryRun = await api('POST', '/api/schedule/preview', {
    label: 'Preview Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstartLocal: { date: '2026-03-01', time: '09:00' },
    durationMs: 5_400_000,
    templates: { title: '{{event.name}} - {{date "MMMM d"}}' },
    count: 3,
  })
  check('a rule can be previewed before anything is saved', dryRun.occurrences.length === 3, JSON.stringify(dryRun))
  check('...described in plain language', /week/i.test(dryRun.describes), dryRun.describes)
  check(
    '...with each name rendered against its own occurrence',
    dryRun.occurrences[0].title === 'Preview Service - March 1' &&
      dryRun.occurrences[1].title === 'Preview Service - March 8',
    JSON.stringify(dryRun.occurrences.map((o) => o.title)),
  )
  check(
    '...and the 9am service still at 9am after the clocks go forward',
    dryRun.occurrences[0].start === Date.parse('2026-03-01T15:00:00Z') &&
      dryRun.occurrences[1].start === Date.parse('2026-03-08T14:00:00Z'),
    JSON.stringify(dryRun.occurrences.map((o) => new Date(o.start).toISOString())),
  )

  const brokenPreview = await api('POST', '/api/schedule/preview', {
    label: 'Preview Service',
    timezone: 'America/Chicago',
    rrule: null,
    dtstartLocal: { date: '2026-03-01', time: '09:00' },
    durationMs: 5_400_000,
    templates: { title: '{{no_such_token}}' },
    count: 1,
  })
  const badTemplate = brokenPreview.occurrences[0]?.error
  check('a bad template token is reported while typing', typeof badTemplate === 'string' && badTemplate.includes('no_such_token'), String(badTemplate))

  let skippedRejected = false
  try {
    await api('POST', '/api/schedule/preview', {
      label: 'Preview Service',
      timezone: 'America/Chicago',
      rrule: null,
      // 02:30 never happens on the morning the clocks go forward.
      dtstartLocal: { date: '2026-03-08', time: '02:30' },
      durationMs: 5_400_000,
    })
  } catch (error) {
    skippedRejected = String(error).includes('does not exist')
  }
  check('a start time the clocks skip over is refused, not shifted', skippedRejected)

  const uiSeries = await api('POST', '/api/series', {
    label: 'Form Service',
    pipelineId: pipeline.id,
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstartLocal: { date: '2026-03-01', time: '09:00' },
    durationMs: 5_400_000,
    prepareLeadMs: 1_800_000,
    templates: { title: '{{event.name}} - {{date "yyyy-MM-dd"}}' },
  })
  const savedSeries = (await api('GET', '/api/series')).find((row) => row.id === uiSeries.id)
  check(
    'an event created from wall-clock time lands on the right instant',
    savedSeries?.dtstart === Date.parse('2026-03-01T15:00:00Z'),
    new Date(savedSeries?.dtstart ?? 0).toISOString(),
  )

  let pipelineLocked = false
  try {
    await api('DELETE', `/api/pipelines/${pipeline.id}`)
  } catch (error) {
    pipelineLocked = String(error).includes('Form Service')
  }
  check('a pipeline an event still runs cannot be deleted, and says which event', pipelineLocked)

  let keyLocked = false
  try {
    await api('DELETE', `/api/credentials/${credential.id}`)
  } catch (error) {
    keyLocked = String(error).includes('Smoke pipeline')
  }
  check('a stream key a pipeline still points at cannot be deleted', keyLocked)

  await api('DELETE', `/api/series/${uiSeries.id}`)
  await api('PATCH', `/api/pipelines/${pipeline.id}`, { label: 'Renamed pipeline' })
  check(
    'a pipeline can be renamed in place',
    (await api('GET', '/api/pipelines')).some((row) => row.label === 'Renamed pipeline'),
  )
}

try {
  await main()
} catch (error) {
  failures++
  process.stdout.write(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  child?.kill('SIGTERM')
  rmSync(configDir, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\nsmoke: all checks passed\n' : `\nsmoke: ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
