import type { NodeState } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import type { Connection } from '../devices/connection-manager.js'
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
  /** So a screen can send somebody to the device this runs on. */
  deviceId: string | null
  deviceLabel: string | null
  watchUrl?: string
  /** What the device last reported. Absent until it has said anything. */
  telemetry?: {
    at: number
    bitrateBps?: number
    /** Media left on the card being written to. */
    remainingMs?: number
    /** How long it has been running, as the device counts it. */
    elapsedMs?: number
    /** How full the device's own buffer is, 0–100. */
    cachePercent?: number
    /** Recording held in a deck's cache, not yet written to the card. */
    cacheBufferedMs?: number
    cacheStatus?: string
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
  /**
   * What it is doing, which is the question being asked.
   *
   * Whether the socket is open is plumbing: five rows of "connected" tell
   * an operator nothing about whether the morning is being recorded. The
   * connection only becomes the headline when it is broken, and then it is
   * reported as `unreachable`.
   */
  activity: 'streaming' | 'recording' | 'streaming and recording' | 'idle' | 'unreachable'
  health: string
  lastError: string | null
  /** One line about what it is doing, in the device's own terms. */
  detail: string | null
  /** The numbers worth seeing without opening the device. */
  facts: DeviceFact[]
}

export interface DeviceFact {
  /** What it is, shown on hover: the value alone has to be short. */
  label: string
  value: string
  /** Set when the reading is the reason somebody should look. */
  tone?: 'bad'
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
  return app.store.listActiveRuns().map((run) => {
    const timeline = timelineFor(app.db, run.occurrence_id)
    return {
      runId: run.id,
      occurrenceId: run.occurrence_id,
      seriesLabel: timeline.label,
      state: run.state,
      windowStart: timeline.windowStart,
      windowEnd: timeline.windowEnd,
      timezone: timeline.timezone,
      outputs: outputsOf(app, run.id, run.occurrence_id),
    }
  })
}

/**
 * What each of a run's outputs is doing, with the last thing its device
 * said about itself.
 *
 * Shared with the run's own page, which is the detailed view: the two would
 * otherwise each grow their own idea of what an output is, and disagree
 * about it in front of somebody trying to work out what went wrong.
 */
export function outputsOf(
  app: Application,
  runId: string,
  occurrenceId: string,
): DashboardOutput[] {
  const telemetry = telemetryOf(app)
  const steps = app.store.steps(runId)

  return timelineFor(app.db, occurrenceId).outputs.map((entry) => {
    const mine = steps.filter((step) => step.kind.startsWith(`${entry.output.id}.`))
    const watchUrl = mine
      .map((step) =>
        step.response ? (JSON.parse(step.response) as { watchUrl?: unknown }).watchUrl : undefined,
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
      deviceId: device ?? null,
      deviceLabel: device ? (labelOf(app, device) ?? null) : null,
      ...(watchUrl === undefined ? {} : { watchUrl }),
      ...(reading === undefined ? {} : { telemetry: reading }),
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
      const elapsedMs = state.recording?.durationMs ?? state.streaming?.durationMs
      byNode.set(nodeId, {
        at,
        ...(state.streaming?.bitrateBps === undefined
          ? {}
          : { bitrateBps: state.streaming.bitrateBps }),
        ...(state.recording?.remainingMs === undefined
          ? {}
          : { remainingMs: state.recording.remainingMs }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        ...(state.cache?.percent === undefined ? {} : { cachePercent: state.cache.percent }),
        ...(state.cache?.bufferedMs === undefined
          ? {}
          : { cacheBufferedMs: state.cache.bufferedMs }),
        ...(state.cache?.status === undefined ? {} : { cacheStatus: state.cache.status }),
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
    activity: activityOf(app, connection.deviceId, connection.health.state),
    detail: describeDevice(app, connection.deviceId),
    facts: factsOf(app, connection),
  }))
}

function activityOf(
  app: Application,
  deviceId: string,
  health: string,
): DashboardDevice['activity'] {
  if (health !== 'connected' && health !== 'degraded') return 'unreachable'
  let streaming = false
  let recording = false
  for (const { state } of app.connections.lastStates(deviceId)) {
    if (state.streaming?.active) streaming = true
    if (state.recording?.active) recording = true
  }
  if (streaming && recording) return 'streaming and recording'
  if (streaming) return 'streaming'
  if (recording) return 'recording'
  return 'idle'
}

/**
 * The few things worth showing beside a device without opening it.
 *
 * A row that says only "idle" is a row nobody reads. Every device can say
 * something about itself even when it is doing nothing — what is on its
 * input, what is in its card slot, what quality it is set to — and those
 * are exactly the things that are wrong on the Sunday a service fails to
 * record. Kept to a handful and ordered most-urgent first: this is a
 * glance, and the device's own page is where the full picture lives.
 */
function factsOf(app: Application, connection: Connection): DeviceFact[] {
  const facts: DeviceFact[] = []
  const seen = new Set<string>()
  const add = (fact: DeviceFact): void => {
    // Several nodes on one device report overlapping state; the same
    // reading twice in a row reads as a bug.
    if (seen.has(fact.label)) return
    seen.add(fact.label)
    facts.push(fact)
  }

  for (const { state } of app.connections.lastStates(connection.deviceId)) {
    if (state.streaming?.active && state.streaming.bitrateBps !== undefined) {
      add({
        label: 'Bitrate',
        value: `${Math.round(state.streaming.bitrateBps / 1000)} kbps`,
      })
    }
    if (state.cache?.percent !== undefined && state.cache.percent >= 1) {
      add({
        label: 'Cache',
        value: `cache ${Math.round(state.cache.percent)}%`,
        ...(state.cache.percent >= app.thresholds.get().cacheWarningPercent
          ? { tone: 'bad' as const }
          : {}),
      })
    } else if (state.cache?.status !== undefined && !QUIET_CACHE.has(state.cache.status)) {
      // A deck writing out its cache has nothing to do with being full,
      // and is worth seeing before somebody pulls the card.
      add({ label: 'Cache', value: `cache ${state.cache.status}` })
    }

    const storage = storageFact(state)
    if (storage) add(storage)

    const signal = signalFact(state)
    if (signal) add(signal)

    // What it is set to record or stream at. Wrong on the day is a whole
    // service in the wrong codec, and it is invisible until then.
    const quality = state.options?.quality?.current
    if (quality !== undefined) add({ label: 'Quality', value: quality })
  }

  // Always something, even for a device that reports nothing at all.
  add({ label: 'Type', value: pluginName(app, connection.pluginId) })
  return facts
}

/** Cache states that mean "nothing is happening", and so are not worth a line. */
const QUIET_CACHE = new Set(['ready', 'idle', 'none', 'stopped'])

/** What the plugin calls itself, minus the maker, which every row shares. */
function pluginName(app: Application, pluginId: string): string {
  try {
    return app.registry.get(pluginId).displayName.replace(/^Blackmagic /, '')
  } catch {
    return pluginId
  }
}

/**
 * The card, and whether there is one.
 *
 * `remainingMs` is what the device says about the slot it would record to,
 * and is the best answer when it is there. Failing that the slot list can
 * still say whether anything is mounted — and "no card" is the single most
 * useful thing this screen can tell somebody on a Saturday.
 */
function storageFact(state: NodeState): DeviceFact | undefined {
  const recording = state.recording
  if (recording === undefined) return undefined

  if (recording.remainingMs !== undefined) {
    return { label: 'Media left', value: `${describeSpan(recording.remainingMs)} left` }
  }

  const slots = recording.slots ?? []
  if (slots.length === 0) return undefined

  const mounted = slots.filter((slot) => MOUNTED.has(slot.status.toLowerCase()))
  if (mounted.length === 0) {
    return { label: 'Media left', value: 'no card', tone: 'bad' }
  }

  // The one it would write to, else the emptiest, which is the one it
  // would roll onto.
  const best = mounted.find((slot) => slot.active) ?? mounted[0]
  if (best?.remainingMs === undefined) {
    return {
      label: 'Media left',
      value: `${mounted.length} card${mounted.length === 1 ? '' : 's'}`,
    }
  }
  return { label: 'Media left', value: `${describeSpan(best.remainingMs)} left` }
}

const MOUNTED = new Set(['mounted', 'ready', 'ok'])

/** What is arriving on the input, or that nothing is. */
function signalFact(state: NodeState): DeviceFact | undefined {
  const input = state.input
  if (input === undefined) return undefined
  if (!input.present) return { label: 'Input', value: 'no signal', tone: 'bad' }
  const source = input.source ? ` on ${input.source}` : ''
  return { label: 'Input', value: `${input.format ?? 'signal'}${source}` }
}

/** `3h 12m`, for a fact that has no room for a sentence. */
function describeSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`
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
  const limits = app.thresholds.get()
  const mediaWarningMs = app.thresholds.mediaWarningMs

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
        // The card being written to, with less on it than somebody decided
        // is enough — an hour by default, which is a service and a bit.
        if (slot.active !== true || slot.remainingMs === undefined) continue
        if (slot.remainingMs > mediaWarningMs) continue
        items.push({
          kind: 'media',
          message: `${connection.label} has ${Math.round(slot.remainingMs / 60_000)} minutes left on slot ${slot.id}`,
          href: '/devices',
        })
      }
    }
  }

  // A cache filling up is the one failure that gives warning: an encoder
  // whose uplink cannot keep up buffers, climbs, and drops the stream some
  // minutes later. Said here as well as in a notification, because this is
  // the screen somebody is already looking at.
  for (const connection of app.connections.list()) {
    for (const { state } of app.connections.lastStates(connection.deviceId)) {
      const percent = state.cache?.percent
      if (percent === undefined || percent < limits.cacheWarningPercent) continue
      if (state.streaming?.active !== true && state.recording?.active !== true) continue
      items.push({
        kind: 'device',
        message: `${connection.label} has its cache ${Math.round(percent)}% full — it is not keeping up, and the stream will drop if it stays there.`,
        href: '/devices',
      })
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
