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
const CHAT_WEBHOOK =
  'https://chat.googleapis.invalid/v1/spaces/AAA/messages?key=k&token=smoke-chat-token'
const UI_PASSWORD = 'smoke-test-ui-password'

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
  return apiAt(BASE, method, path, body)
}

async function apiAt(base, method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    // Fastify rejects a JSON content-type with an empty body, so bodyless
    // POSTs still send `{}`.
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`)
  return json
}

/** Status only, for the routes whose whole point is refusing. */
async function statusAt(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers })
  return response.status
}

async function waitForHealth(timeoutMs = 20_000, base = BASE, process_ = () => child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const running = process_()
    if (running?.exitCode !== null && running?.exitCode !== undefined) {
      throw new Error(`host exited early with code ${running.exitCode}`)
    }
    try {
      const response = await fetch(`${base}/healthz`)
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
  check(
    'plugins are registered',
    plugins.some((p) => p.id === 'mock'),
  )
  check(
    'ATEM, HyperDeck and Streaming Encoder adapters are loaded',
    ['atem', 'hyperdeck', 'streaming-encoder'].every((id) => plugins.some((p) => p.id === id)),
    plugins.map((p) => p.id).join(', '),
  )
  check(
    // A Web Presenter owner has no other way to know this adapter drives
    // their unit: the dropdown label is the whole signal.
    'the encoder adapter says it covers the Web Presenter too',
    plugins.find((p) => p.id === 'streaming-encoder')?.displayName.includes('Web Presenter'),
    plugins.find((p) => p.id === 'streaming-encoder')?.displayName,
  )

  const favicon = await fetch(`${BASE}/favicon.svg`)
  check(
    'the favicon is served rather than falling through to the SPA',
    favicon.ok && (favicon.headers.get('content-type') ?? '').includes('svg'),
    `${favicon.status} ${favicon.headers.get('content-type')}`,
  )

  const device = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Smoke encoder',
    config: { kind: 'encoder', password: DEVICE_PASSWORD },
  })
  const connected = await api('POST', `/api/devices/${device.id}/connect`)
  check(
    'device probes its model',
    connected.capabilities.model === 'Mock encoder',
    JSON.stringify(connected.capabilities),
  )

  const devices = await api('GET', '/api/devices')
  check('device password is never returned', !JSON.stringify(devices).includes(DEVICE_PASSWORD))

  const credential = await api('POST', '/api/credentials', {
    label: 'Smoke ingest',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    key: STREAM_KEY,
  })
  const credentials = await api('GET', '/api/credentials')
  check('stream key is never returned', !JSON.stringify(credentials).includes(STREAM_KEY))

  // Two minutes out, so the scheduler would not pick it up on its own and
  // "start now" is genuinely exercising the operator override.
  const start = Date.now() + 120_000
  const series = await api('POST', '/api/series', {
    label: 'Smoke Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY',
    dtstart: start,
    durationMs: 3_600_000,
    templates: { title: '{{event.name}} - {{date "yyyy-MM-dd"}}' },
  })
  const firstOutput = await api('POST', `/api/series/${series.id}/outputs`, {
    kind: 'stream',
    label: 'Main',
    durationMs: 3_600_000,
    credentialId: credential.id,
    deviceId: device.id,
    nodeId: 'stream',
  })
  check(
    'an output is attached with no clashes',
    firstOutput.conflicts.length === 0,
    JSON.stringify(firstOutput.conflicts),
  )

  // A second stream on the same encoder, overlapping the first: one
  // Blackmagic encoder cannot do both, and saying so now beats finding out
  // on a Sunday.
  const clashing = await api('POST', `/api/series/${series.id}/outputs`, {
    kind: 'stream',
    label: 'Worship',
    offsetMs: 600_000,
    durationMs: 1_800_000,
    credentialId: credential.id,
    deviceId: device.id,
    nodeId: 'stream',
  })
  check(
    'two streams fighting over one encoder are reported',
    clashing.conflicts.length === 1 && clashing.conflicts[0].detail.includes('Smoke encoder'),
    JSON.stringify(clashing.conflicts),
  )
  await api('DELETE', `/api/outputs/${clashing.id}`)

  let wrongKindRefused = false
  try {
    await api('POST', `/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive',
      durationMs: 3_600_000,
      deviceId: device.id,
      nodeId: 'stream',
    })
  } catch (error) {
    wrongKindRefused = String(error).includes('does not record')
  }
  check('a recording cannot be put on a node that only streams', wrongKindRefused)

  const preview = await api('GET', `/api/series/${series.id}/preview`)
  const firstTitle = preview[0]?.outputs?.[0]?.title
  check(
    'name templates render',
    typeof firstTitle === 'string' && firstTitle.startsWith('Smoke Service - '),
    JSON.stringify(preview[0]),
  )

  const occurrences = await api(
    'GET',
    `/api/occurrences?from=${Date.now()}&to=${Date.now() + 40 * 86_400_000}`,
  )
  check('occurrences are materialized', occurrences.length >= 4, `got ${occurrences.length}`)

  const started = await api('POST', `/api/occurrences/${occurrences[0].id}/start-now`)
  check(
    'an operator can start an event ahead of its window',
    started.state === 'running',
    `state was ${started.state}`,
  )

  const run = await api('GET', `/api/runs/${started.runId}`)
  const steps = run.steps.map((s) => `${s.label ?? s.kind}:${s.state}`).join(', ')
  check('stream target was applied and verified', run.steps[0]?.state === 'done', steps)
  check('streaming was started', run.steps[1]?.state === 'done', steps)
  check('the run timeline contains no stream key', !JSON.stringify(run).includes(STREAM_KEY))

  const cancelled = await api('POST', `/api/runs/${started.runId}/cancel`, { reason: 'smoke test' })
  check('an operator can stop a live run', cancelled.state === 'cancelled')

  const afterCancel = await api('GET', `/api/runs/${started.runId}`)
  const stopStep = afterCancel.steps.find((s) => s.label === 'Main: stop streaming')
  check(
    'cancelling really told the encoder to stop',
    stopStep?.state === 'done',
    JSON.stringify(stopStep),
  )

  // -- driving a device by hand ---------------------------------------------

  const deck = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Smoke deck',
    config: { kind: 'recorder' },
  })
  await api('POST', `/api/devices/${deck.id}/connect`)

  const idle = await api('GET', `/api/devices/${deck.id}/nodes/record/state`)
  check(
    'a node reports its state on demand',
    idle.state.recording.active === false,
    JSON.stringify(idle),
  )

  const rolling = await api('POST', `/api/devices/${deck.id}/nodes/record/startRecording`, {
    filename: 'smoke/rehearsal: take 1',
  })
  check('an operator can start a recording by hand', rolling.state.recording.active === true)
  check(
    '...under a name made safe for a filesystem',
    !rolling.state.recording.filename.includes('/') &&
      rolling.state.recording.filename.includes('rehearsal'),
    rolling.state.recording.filename,
  )

  const halted = await api('POST', `/api/devices/${deck.id}/nodes/record/stopRecording`)
  check('...and stop it again', halted.state.recording.active === false)

  let ignoredReported = false
  const deafDeck = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Smoke deaf deck',
    config: { kind: 'recorder', fault: 'ignores-writes' },
  })
  await api('POST', `/api/devices/${deafDeck.id}/connect`)
  try {
    await api('POST', `/api/devices/${deafDeck.id}/nodes/record/startRecording`, {
      filename: 'take 1',
    })
  } catch (error) {
    ignoredReported = String(error).includes('did not take effect')
  }
  // A button that goes green without the device doing anything is worse than
  // no button at all.
  check('a device that accepts a manual command and ignores it is caught', ignoredReported)

  let keyRefused = false
  try {
    await api('POST', `/api/devices/${device.id}/nodes/stream/applyStreamTarget`, {
      url: 'rtmps://elsewhere.invalid/live',
      key: 'live_not-going-through-here',
    })
  } catch (error) {
    keyRefused = String(error).includes('400')
  }
  check('a stream key cannot be pushed at a device through the manual controls', keyRefused)

  const index = await fetch(`${BASE}/`)
  check('the web UI is served', index.ok && (await index.text()).includes('<div id="root">'))

  // -- streaming services ---------------------------------------------------

  const providers = await api('GET', '/api/destination-providers')
  const yt = providers.find((p) => p.id === 'youtube')
  check('the YouTube provider is registered', yt !== undefined && yt.supportsOAuth === true)

  const instructions = await api('GET', '/api/oauth/youtube/instructions')
  check(
    'setup instructions warn about the 7-day Testing expiry',
    instructions.warnings.some((warning) => warning.includes('Testing')) &&
      instructions.steps.length >= 5,
    instructions.warnings.join(' / '),
  )
  check(
    // Bites at connect time: a Brand Account channel is not a member of the
    // Workspace, so an Internal client refuses it and only the setter-up's
    // own channel works.
    'setup instructions warn that an Internal client cannot connect a Brand Account',
    instructions.warnings.some((warning) => warning.includes('org_internal')),
    instructions.warnings.join(' / '),
  )
  check(
    'the redirect URI is a loopback address',
    instructions.redirectUri.startsWith('http://127.0.0.1:') &&
      instructions.redirectUri.endsWith('/oauth/callback'),
    instructions.redirectUri,
  )

  const oauthClient = await api('POST', '/api/oauth/clients', {
    provider: 'youtube',
    label: 'Smoke project',
    clientId: 'smoke-client-id',
    clientSecret: OAUTH_SECRET,
  })
  const clients = await api('GET', '/api/oauth/clients')
  check(
    'the OAuth client secret is never returned',
    !JSON.stringify(clients).includes(OAUTH_SECRET),
  )

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
  check(
    'the Chat webhook URL is never returned',
    !JSON.stringify(listed).includes('smoke-chat-token'),
  )
  check(
    'the channel is listed',
    listed.channels.some((c) => c.id === channel.id),
  )

  // An unreachable webhook must fail loudly at the button, not silently later.
  let testFailed = false
  try {
    await api('POST', `/api/notifications/channels/${channel.id}/test`)
  } catch {
    testFailed = true
  }
  check('a test to an unreachable webhook reports the failure', testFailed)

  const preflight = await api('GET', `/api/occurrences/${occurrences[0].id}/preflight`)
  check(
    'pre-flight checks an occurrence on demand',
    Array.isArray(preflight.problems),
    JSON.stringify(preflight),
  )

  // -- setting the app up through the UI's own endpoints --------------------
  //
  // Everything above was reachable only with curl until the setup screens
  // landed. These are exactly the calls those screens make, in the order a
  // person makes them, so an install that cannot be configured fails here.

  const discovered = await api('POST', '/api/plugins/mock/discover')
  check(
    'a plugin that can scan the network returns candidates',
    discovered.length >= 1,
    JSON.stringify(discovered),
  )
  check(
    'a discovered candidate carries config the form can use as-is',
    typeof discovered[0]?.config?.host === 'string',
    JSON.stringify(discovered[0]),
  )

  const shown = (await api('GET', '/api/devices')).find((d) => d.id === device.id)
  check(
    'the edit form is given the stored config',
    shown?.config?.kind === 'encoder',
    JSON.stringify(shown?.config),
  )
  check(
    '...with the password masked rather than absent',
    shown?.config?.password === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022',
  )

  // Re-saving the form without retyping the password must keep the stored
  // one, or every edit would silently break the device.
  await api('PATCH', `/api/devices/${device.id}`, { label: 'Smoke encoder', config: shown.config })
  const reconnected = await api('POST', `/api/devices/${device.id}/connect`)
  check(
    're-saving a device without retyping its password keeps it working',
    reconnected.health.state === 'connected',
    JSON.stringify(reconnected.health),
  )

  const dryRun = await api('POST', '/api/schedule/preview', {
    label: 'Preview Service',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstartLocal: { date: '2026-03-01', time: '09:00' },
    durationMs: 5_400_000,
    templates: { title: '{{event.name}} - {{date "MMMM d"}}' },
    count: 3,
  })
  check(
    'a rule can be previewed before anything is saved',
    dryRun.occurrences.length === 3,
    JSON.stringify(dryRun),
  )
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
  check(
    'a bad template token is reported while typing',
    typeof badTemplate === 'string' && badTemplate.includes('no_such_token'),
    String(badTemplate),
  )

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

  let deviceLocked = false
  try {
    await api('DELETE', `/api/devices/${device.id}`)
  } catch (error) {
    deviceLocked = String(error).includes('Smoke Service')
  }
  check('a device an output still runs on cannot be deleted, and it says which event', deviceLocked)

  let keyLocked = false
  try {
    await api('DELETE', `/api/credentials/${credential.id}`)
  } catch (error) {
    keyLocked = String(error).includes('Smoke Service')
  }
  check('a stream key an output still points at cannot be deleted', keyLocked)

  const reordered = await api('POST', `/api/series/${series.id}/outputs/order`, {
    order: [firstOutput.id],
  })
  check(
    'outputs can be reordered in one call',
    reordered.outputs.length === 1,
    JSON.stringify(reordered.outputs),
  )

  await api('DELETE', `/api/series/${uiSeries.id}`)
}

/**
 * The lock, against the built artifact.
 *
 * A second host with a password on it, because the thing that went wrong
 * last time was not the checking — it was that nothing outside the unit
 * suite ever asked the running app for a page.
 */
async function passwordChecks() {
  const port = PORT + 1
  const base = `http://127.0.0.1:${port}`
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-smoke-auth-'))
  const locked = spawn(process.execPath, ['packages/host/dist/main.js'], {
    env: {
      ...process.env,
      SCHEDULER_CONFIG_DIR: dir,
      SCHEDULER_SECRET: 'smoke-test-master-secret',
      SCHEDULER_PORT: String(port),
      SCHEDULER_LOG_LEVEL: 'warn',
      SCHEDULER_UI_PASSWORD: UI_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  locked.stdout.on('data', () => {})
  locked.stderr.on('data', () => {})

  try {
    await waitForHealth(20_000, base, () => locked)

    // The health check has no way to sign in, and a container restarting in
    // a loop because of that would be worse than the exposure.
    check('a locked host still answers /healthz', (await statusAt(base, '/healthz')) === 200)
    check('a locked host refuses the API', (await statusAt(base, '/api/devices')) === 401)
    check(
      'a locked host still serves the page, so there is something to log in with',
      (await statusAt(base, '/')) === 200,
    )

    const signedIn = await apiAt(base, 'POST', '/api/login', { password: UI_PASSWORD })
    check('the password is taken and a session comes back', typeof signedIn.token === 'string')
    check(
      'the session opens the API',
      (await statusAt(base, '/api/devices', { authorization: `Bearer ${signedIn.token}` })) === 200,
    )
    check('the password is never echoed back', !JSON.stringify(signedIn).includes(UI_PASSWORD))

    let refused = false
    try {
      await apiAt(base, 'POST', '/api/login', { password: 'not the password' })
    } catch (error) {
      refused = String(error).includes('401')
    }
    check('a wrong password is refused', refused)
  } finally {
    locked.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  await main()
  await passwordChecks()
} catch (error) {
  failures++
  process.stdout.write(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  child?.kill('SIGTERM')
  rmSync(configDir, { recursive: true, force: true })
}

process.stdout.write(
  failures === 0 ? '\nsmoke: all checks passed\n' : `\nsmoke: ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
