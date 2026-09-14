import type { Application } from '../app.js'
import { outputsForSeries } from '../events/outputs.js'
import { timelineFor } from '../runs/timeline.js'

/**
 * What a booth wants on one screen: what is on air, what is next, and what
 * needs somebody.
 *
 * Assembled here rather than by the page stitching four endpoints together,
 * so the screen is one round trip and every number on it comes from the
 * same instant.
 *
 * Nothing here talks to a device. Telemetry is the last thing each node
 * said about itself, which devices push as it changes — asking five boxes
 * what they are doing every few seconds is traffic they do not need while
 * they are recording.
 */

export interface DashboardOutput {
  id: string
  label: string
  kind: 'stream' | 'recording'
  /** Where it has got to, read from the run's own step rows. */
  state: 'waiting' | 'live' | 'done' | 'failed'
  startsAt: number
  endsAt: number
  deviceLabel: string | null
  watchUrl?: string
  /** What the device last reported. Absent until it has said anything. */
  telemetry?: {
    at: number
    bitrateBps?: number
    /** Media left on the card being written to. */
    remainingMs?: number
    inputPresent?: boolean
  }
}

export interface DashboardRun {
  runId: string
  occurrenceId: string
  seriesLabel: string
  state: string
  windowStart: number
  windowEnd: number
  timezone: string
  outputs: DashboardOutput[]
}

export interface DashboardNext {
  occurrenceId: string
  seriesLabel: string
  timezone: string
  scheduledStart: number
  scheduledEnd: number
  status: string
  runId: string | null
  runState: string | null
  outputs: number
}

export interface DashboardDevice {
  id: string
  label: string
  health: string
  lastError: string | null
  /** One line about what it is doing, in the device's own terms. */
  detail: string | null
}

export interface DashboardAttention {
  kind: 'run-failed' | 'device' | 'account' | 'media' | 'security'
  message: string
  /** Where to go to do something about it. */
  href: string
}

export interface Dashboard {
  /** The server's clock, so a countdown does not inherit a wrong one from
   *  the browser. */
  now: number
  onAir: DashboardRun[]
  next: DashboardNext[]
  devices: DashboardDevice[]
  attention: DashboardAttention[]
}

const WEEK_MS = 7 * 86_400_000

export function buildDashboard(app: Application, options: { horizonMs?: number } = {}): Dashboard {
  const now = app.clock.now()
  const running = onAir(app)
  return {
    now,
    onAir: running,
    // Whatever is on air is shown above in full; repeating it under "up
    // next" with a start time in the past is a page arguing with itself.
    next: upcoming(app, now, options.horizonMs ?? WEEK_MS).filter(
      (entry) => !running.some((run) => run.occurrenceId === entry.occurrenceId),
    ),
    devices: devices(app),
    attention: attention(app, now),
  }
}

function onAir(app: Application): DashboardRun[] {
  const telemetry = telemetryOf(app)

  return app.store.listActiveRuns().map((run) => {
    const timeline = timelineFor(app.db, run.occurrence_id)
    const steps = app.store.steps(run.id)

    return {
      runId: run.id,
      occurrenceId: run.occurrence_id,
      seriesLabel: timeline.label,
      state: run.state,
      windowStart: timeline.windowStart,
      windowEnd: timeline.windowEnd,
      timezone: timeline.timezone,
      outputs: timeline.outputs.map((entry) => {
        const mine = steps.filter((step) => step.kind.startsWith(`${entry.output.id}.`))
        const watchUrl = mine
          .map((step) =>
            step.response
              ? (JSON.parse(step.response) as { watchUrl?: unknown }).watchUrl
              : undefined,
          )
          .find((value): value is string => typeof value === 'string')
        const device = entry.output.deviceId
        const node = entry.output.nodeId
        const reading = device && node ? telemetry.get(device)?.get(node) : undefined

        return {
          id: entry.output.id,
          label: entry.output.label,
          kind: entry.output.kind,
          state: progressOf(mine),
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          deviceLabel: device ? (labelOf(app, device) ?? null) : null,
          ...(watchUrl === undefined ? {} : { watchUrl }),
          ...(reading === undefined ? {} : { telemetry: reading }),
        }
      }),
    }
  })
}

/**
 * Where an output has got to, from its step rows alone.
 *
 * The same reading the engine takes, and for the same reason: the steps are
 * the durable record of what was attempted and what landed, so a second
 * copy of that fact is a second thing that can be wrong after a crash.
 */
function progressOf(steps: { kind: string; state: string }[]): DashboardOutput['state'] {
  if (steps.some((step) => step.state === 'failed')) return 'failed'
  const done = (suffix: string): boolean =>
    steps.some((step) => step.kind.endsWith(suffix) && step.state === 'done')
  if (done('.stopStreaming') || done('.stopRecording')) return 'done'
  if (done('.startStreaming') || done('.startRecording')) return 'live'
  return 'waiting'
}

function telemetryOf(app: Application): Map<string, Map<string, DashboardOutput['telemetry']>> {
  const byDevice = new Map<string, Map<string, DashboardOutput['telemetry']>>()
  for (const connection of app.connections.list()) {
    const byNode = new Map<string, DashboardOutput['telemetry']>()
    for (const { nodeId, state, at } of app.connections.lastStates(connection.deviceId)) {
      byNode.set(nodeId, {
        at,
        ...(state.streaming?.bitrateBps === undefined
          ? {}
          : { bitrateBps: state.streaming.bitrateBps }),
        ...(state.recording?.remainingMs === undefined
          ? {}
          : { remainingMs: state.recording.remainingMs }),
        ...(state.input?.present === undefined ? {} : { inputPresent: state.input.present }),
      })
    }
    byDevice.set(connection.deviceId, byNode)
  }
  return byDevice
}

function upcoming(app: Application, now: number, horizonMs: number): DashboardNext[] {
  const rows = app.db
    .prepare(
      `SELECT o.id, o.series_id, o.scheduled_start, o.scheduled_end, o.status, s.label, s.timezone,
              r.id AS run_id, r.state AS run_state
         FROM occurrence o
         JOIN event_series s ON s.id = o.series_id
         LEFT JOIN run r ON r.occurrence_id = o.id
        WHERE o.scheduled_end >= ? AND o.scheduled_start <= ?
          AND o.status NOT IN ('cancelled', 'skipped')
          AND s.enabled = 1
        ORDER BY o.scheduled_start
        LIMIT 8`,
    )
    .all(now, now + horizonMs) as {
    id: string
    series_id: string
    scheduled_start: number
    scheduled_end: number
    status: string
    label: string
    timezone: string
    run_id: string | null
    run_state: string | null
  }[]

  return rows.map((row) => ({
    occurrenceId: row.id,
    seriesLabel: row.label,
    timezone: row.timezone,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    status: row.status,
    runId: row.run_id,
    runState: row.run_state,
    outputs: outputsForSeries(app.db, row.series_id).filter((output) => output.enabled).length,
  }))
}

function devices(app: Application): DashboardDevice[] {
  return app.connections.list().map((connection) => ({
    id: connection.deviceId,
    label: connection.label,
    health: connection.health.state,
    lastError: connection.health.message ?? null,
    detail: describeDevice(app, connection.deviceId),
  }))
}

/** What the box is doing, in a line, from what it last reported. */
function describeDevice(app: Application, deviceId: string): string | null {
  const parts: string[] = []
  for (const { state } of app.connections.lastStates(deviceId)) {
    if (state.streaming?.active) {
      const rate = state.streaming.bitrateBps
      parts.push(rate ? `streaming at ${Math.round(rate / 1000)} kbps` : 'streaming')
    }
    if (state.recording?.active) parts.push('recording')
    if (state.input?.present === false) parts.push('no signal on the input')
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * Everything worth somebody's attention, worst first. Empty is the answer
 * this screen should usually give.
 */
function attention(app: Application, now: number): DashboardAttention[] {
  const items: DashboardAttention[] = []

  // A step that failed inside a run still going: one output is down and the
  // rest are carrying on, which is exactly what the failure isolation is
  // for and exactly what somebody needs to be told.
  for (const run of app.store.listActiveRuns()) {
    for (const step of app.store.steps(run.id)) {
      if (step.state !== 'failed') continue
      items.push({
        kind: 'run-failed',
        message: `${step.label ?? step.kind} failed: ${step.error ?? 'no reason recorded'}`,
        href: `/runs/${run.id}`,
      })
    }
  }

  const recentlyFailed = app.db
    .prepare(
      `SELECT r.id, s.label FROM run r
         JOIN occurrence o ON o.id = r.occurrence_id
         JOIN event_series s ON s.id = o.series_id
        WHERE r.state = 'failed' AND r.ended_at >= ?
        ORDER BY r.ended_at DESC LIMIT 5`,
    )
    .all(now - 86_400_000) as { id: string; label: string }[]
  for (const row of recentlyFailed) {
    items.push({ kind: 'run-failed', message: `"${row.label}" failed`, href: `/runs/${row.id}` })
  }

  for (const connection of app.connections.list()) {
    if (connection.health.state === 'connected') continue
    items.push({
      kind: 'device',
      message: `${connection.label} is ${connection.health.state}${
        connection.health.message ? `: ${connection.health.message}` : ''
      }`,
      href: '/devices',
    })
  }

  for (const connection of app.connections.list()) {
    for (const { state } of app.connections.lastStates(connection.deviceId)) {
      for (const slot of state.recording?.slots ?? []) {
        // The card being written to, with less than an hour on it: not
        // enough for a service, and the sort of thing nobody checks.
        if (slot.active !== true || slot.remainingMs === undefined) continue
        if (slot.remainingMs > 3_600_000) continue
        items.push({
          kind: 'media',
          message: `${connection.label} has ${Math.round(slot.remainingMs / 60_000)} minutes left on slot ${slot.id}`,
          href: '/devices',
        })
      }
    }
  }

  // Only where it is actually a problem: a booth machine on loopback with
  // no password is a reasonable way to run this, and nagging about it there
  // would teach people to ignore this list.
  if (app.exposed && !app.auth.required) {
    items.push({
      kind: 'security',
      message:
        'No password is set, and this is reachable from the network. Anyone who can open this page can start a broadcast.',
      href: '/settings',
    })
  }

  const accounts = app.db
    .prepare("SELECT display_name FROM account WHERE status = 'reauth_required'")
    .all() as { display_name: string }[]
  for (const account of accounts) {
    items.push({
      kind: 'account',
      message: `${account.display_name} needs reconnecting before it can stream`,
      href: '/services',
    })
  }

  return items
}

function labelOf(app: Application, deviceId: string): string | undefined {
  const row = app.db.prepare('SELECT label FROM device WHERE id = ?').get(deviceId) as
    { label: string } | undefined
  return row?.label
}
