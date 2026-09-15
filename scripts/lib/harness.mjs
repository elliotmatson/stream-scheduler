/**
 * Booting the built app, and driving it over HTTP.
 *
 * Shared by the smoke test and the browser checks, which both need a host
 * running out of `packages/host/dist` with a throwaway config directory and
 * some events in it. Keeping one copy is not tidiness: the seed drifted out
 * of date once already, when outputs began requiring a device and nothing
 * outside the app knew.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = new URL('../..', import.meta.url).pathname

/** Starts the built host on its own port and config directory. */
export function startHost({ port, env = {} } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'scheduler-harness-'))
  const child = spawn(process.execPath, ['packages/host/dist/main.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SCHEDULER_CONFIG_DIR: configDir,
      SCHEDULER_SECRET: 'harness-master-secret',
      SCHEDULER_PORT: String(port),
      SCHEDULER_LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Collected rather than inherited: a host that will not start should
  // print its reason once, not interleave with the checks.
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))

  return {
    child,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => {
      child.kill('SIGTERM')
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}

export async function waitForHealth(host, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null) {
      throw new Error(`host exited early with code ${host.child.exitCode}\n${host.output()}`)
    }
    try {
      if ((await fetch(`${host.base}/healthz`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`host did not become healthy in time\n${host.output()}`)
}

/** One call against a running host. Throws with the body on anything but 2xx. */
export async function apiAt(base, method, path, body, headers = {}) {
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
export async function statusAt(base, path, headers = {}) {
  return (await fetch(`${base}${path}`, { headers })).status
}

/** A tally of checks, printed as they go. */
export function reporter() {
  let failures = 0
  return {
    check(name, condition, detail = '') {
      if (condition) {
        process.stdout.write(`  ok   ${name}\n`)
      } else {
        failures++
        process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`)
      }
      return Boolean(condition)
    },
    get failures() {
      return failures
    },
    fail(message) {
      failures++
      process.stdout.write(`  FAIL ${message}\n`)
    },
  }
}

/**
 * A church's Sunday, near enough: two encoders, a deck, a morning with two
 * services and a recording across the whole of it, and somewhere for the
 * alerts to go.
 *
 * Returns the ids, because a check that wants to drive one thing should not
 * have to go looking for it.
 */
export async function seed(base) {
  const api = (method, path, body) => apiAt(base, method, path, body)

  const encoder = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Sanctuary encoder',
    config: { kind: 'encoder', host: '10.0.20.11', password: 'device-password' },
  })
  await api('POST', `/api/devices/${encoder.id}/connect`)

  const recorder = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'HyperDeck — archive',
    config: { kind: 'recorder', host: '10.0.20.14' },
  })
  await api('POST', `/api/devices/${recorder.id}/connect`)

  // One that will not answer, so the screens have a fault to render.
  const unreachable = await api('POST', '/api/devices', {
    pluginId: 'mock',
    label: 'Chapel encoder',
    config: { kind: 'encoder', host: '10.0.20.19', fault: 'unreachable' },
  })
  await api('POST', `/api/devices/${unreachable.id}/connect`).catch(() => undefined)

  const credential = await api('POST', '/api/credentials', {
    label: 'Facebook Live — house key',
    ingestUrl: 'rtmps://live-api-s.facebook.com:443/rtmp',
    key: 'FB-house-key',
  })

  const sunday = await api('POST', '/api/series', {
    label: 'Sunday // Anderson',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    dtstartLocal: { date: '2026-09-06', time: '07:00' },
    durationMs: 5 * 3600_000 + 45 * 60_000,
    templates: {
      title: '{{event.name}} — {{date "MMMM d, yyyy"}}',
      description: 'Live from Grace Bible Church.',
      filename: '{{date "yyyy-MM-dd"}} Sunday Service',
    },
  })

  const outputs = []
  for (const [label, offsetMinutes] of [
    ['Grace Anderson // 9:00', 120],
    ['Grace Anderson // 11:00', 240],
  ]) {
    outputs.push(
      await api('POST', `/api/series/${sunday.id}/outputs`, {
        kind: 'stream',
        label,
        offsetMs: offsetMinutes * 60_000,
        durationMs: 75 * 60_000,
        credentialId: credential.id,
        deviceId: encoder.id,
        nodeId: 'stream',
        templates: { title: `Sunday Service — {{date "MMMM d"}} — ${label.split('// ')[1]}` },
      }),
    )
  }
  outputs.push(
    await api('POST', `/api/series/${sunday.id}/outputs`, {
      kind: 'recording',
      label: 'Archive',
      offsetMs: 0,
      durationMs: 5 * 3600_000,
      deviceId: recorder.id,
      nodeId: 'record',
    }),
  )

  const wednesday = await api('POST', '/api/series', {
    label: 'Wednesday Prayer',
    timezone: 'America/Chicago',
    rrule: 'FREQ=WEEKLY;BYDAY=WE',
    dtstartLocal: { date: '2026-09-02', time: '18:30' },
    durationMs: 3600_000,
    templates: { title: 'Midweek Prayer — {{date "MMM d"}}' },
  })
  await api('POST', `/api/series/${wednesday.id}/outputs`, {
    kind: 'stream',
    label: 'Grace Anderson',
    durationMs: 3600_000,
    credentialId: credential.id,
    deviceId: encoder.id,
    nodeId: 'stream',
  })

  await api('POST', '/api/oauth/clients', {
    provider: 'youtube',
    label: 'Grace Bible Church project',
    clientId: '8241-example.apps.googleusercontent.com',
    clientSecret: 'oauth-client-secret',
  })
  await api('POST', '/api/notifications/channels', {
    kind: 'google-chat',
    label: 'AV Team space',
    config: { webhookUrl: 'https://chat.googleapis.invalid/v1/spaces/AAA/messages' },
  })

  return {
    encoderId: encoder.id,
    recorderId: recorder.id,
    unreachableId: unreachable.id,
    credentialId: credential.id,
    sundayId: sunday.id,
    wednesdayId: wednesday.id,
    outputIds: outputs.map((output) => output.id),
  }
}

/** Puts one occurrence on air, so the screens have something running. */
export async function startSomething(base) {
  const from = Date.now() - 86_400_000
  const to = Date.now() + 40 * 86_400_000
  const occurrences = await apiAt(base, 'GET', `/api/occurrences?from=${from}&to=${to}`)
  if (occurrences.length === 0) throw new Error('nothing was scheduled to start')
  return apiAt(base, 'POST', `/api/occurrences/${occurrences[0].id}/start-now`)
}
