import { useCallback, useEffect, useRef, useState } from 'react'

export interface Occurrence {
  id: string
  seriesId: string
  seriesLabel: string
  timezone: string
  scheduledStart: number
  scheduledEnd: number
  localDate: string
  status: string
  detached: boolean
  runId: string | null
  runState: string | null
}

export interface Series {
  id: string
  label: string
  timezone: string
  rrule: string | null
  dtstart: number
  durationMs: number
  prepareLeadMs: number
  lateStartGraceMs: number
  templates: Record<string, string>
  enabled: boolean
}

export interface Device {
  id: string
  pluginId: string
  label: string
  /** Secret fields arrive as a masked marker; there is no read path for them. */
  config: Record<string, unknown>
  probedModel: string | null
  capabilities: {
    model: string
    firmware?: string
    features: string[]
    /** Ways to reach the device outside this app, as the plugin builds them. */
    links?: { label: string; url: string; note?: string }[]
  } | null
  health: string
  lastError: string | null
  lastSeenAt: number | null
  enabled: boolean
  nodes: DeviceNode[]
  /** Events mid-run on this device right now. Empty almost always. */
  inUseBy: { runId: string; label: string }[]
}

export interface DeviceNode {
  id: string
  label: string
  roles: string[]
  supports: string[]
}

/** What a node reports about itself. Never carries a key, only a fingerprint. */
export interface NodeState {
  streaming?: {
    active: boolean
    targetUrl?: string
    keyFingerprint?: string
    bitrateBps?: number
    durationMs?: number
  }
  recording?: {
    active: boolean
    filename?: string
    remainingMs?: number
    slots?: StorageSlot[]
    rollover?: boolean
  }
  input?: { present: boolean; format?: string; source?: string }
  routing?: Record<string, string>
  /**
   * Settings the device says it will accept, and what it is on now.
   *
   * Three ways a device spells quality, and it declares which one it takes:
   * named profiles it can list, a bitrate where it stores only numbers, or a
   * name it takes but will not enumerate. `current` is always in the same
   * vocabulary as the value to send back.
   */
  options?: {
    quality?: {
      current?: string
      /** Other spellings of `current` that mean the same setting. */
      aliases?: string[]
      choices: string[]
      bitrate?: { minMbps: number; maxMbps: number; note?: string }
      freeform?: { note?: string; examples?: string[] }
    }
  }
}

export interface StorageSlot {
  id: number
  status: string
  volumeName?: string
  remainingMs?: number
  active?: boolean
}

export type ManualAction =
  | 'startStreaming'
  | 'stopStreaming'
  | 'startRecording'
  | 'stopRecording'
  | 'selectSlot'

export interface RunStep {
  seq: number
  kind: string
  /** The readable half; the kind carries an output id so it stays stable. */
  label: string | null
  state: string
  attempts: number
  externalId: string | null
  request: unknown
  response: unknown
  error: string | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
}

export interface Run {
  id: string
  occurrenceId: string
  seriesLabel: string
  scheduledStart: number
  state: string
  attempt: number
  startedAt: number | null
  endedAt: number | null
  failure: { code: string; message: string; step?: string; remediation?: string } | null
  /** Where each prepared stream can be watched. Present once it has
   *  prepared, whether or not it has gone live. */
  links?: { label: string; url: string }[]
  steps?: RunStep[]
}

export interface ChannelKind {
  kind: string
  displayName: string
  configSchema: ConfigField[]
}

export interface NotificationChannel {
  id: string
  kind: string
  label: string
  events: string[]
  enabled: boolean
  lastError: string | null
  lastSentAt: number | null
}

export interface OutputPreview {
  outputId: string
  label: string
  kind: 'stream' | 'recording'
  startsAt: number
  endsAt: number
  title?: string
  description?: string
  filename?: string
}

export interface Preview {
  occurrenceId: string
  outputs?: OutputPreview[]
  error?: string
}

/** Mirrors `ConfigField` in the SDK: the host renders whatever a plugin declares. */
export type ConfigField =
  | { type: 'textinput'; id: string; label: string; default?: string; required?: boolean; tooltip?: string }
  | { type: 'number'; id: string; label: string; default?: number; min?: number; max?: number; required?: boolean; tooltip?: string }
  | { type: 'checkbox'; id: string; label: string; default?: boolean; tooltip?: string }
  | {
      type: 'dropdown'
      id: string
      label: string
      choices: { id: string; label: string }[]
      default?: string
      required?: boolean
      tooltip?: string
      /** Names a list the service supplies at runtime, e.g. 'playlists'. */
      choicesFrom?: 'playlists'
    }
  | { type: 'secret'; id: string; label: string; required?: boolean; tooltip?: string }
  | { type: 'static-text'; id: string; label: string; value: string }

export interface Plugin {
  id: string
  displayName: string
  configSchema: ConfigField[]
  canDiscover: boolean
}

export interface DiscoveredDevice {
  label: string
  config: Record<string, unknown>
  detail?: Record<string, unknown>
}

export interface DestinationProvider {
  id: string
  displayName: string
  configSchema: ConfigField[]
  providesIngest: boolean
  supportsOAuth: boolean
}

export interface OAuthInstructions {
  steps: string[]
  redirectUri: string
  warning: string
  warnings: string[]
}

export interface OAuthClient {
  id: string
  provider: string
  label: string
  clientId: string
}

export interface Account {
  id: string
  provider: string
  externalId: string
  displayName: string
  status: string
  scopes: string[]
}

export interface Destination {
  id: string
  providerId: string
  label: string
  accountId: string | null
  config: Record<string, unknown>
}

export interface Credential {
  id: string
  label: string
  source: string
  ingestUrl: string | null
  externalId: string | null
  key: string
}

/**
 * One thing an event does: a stream to a service or a recording on a deck,
 * with its own slot inside the event's window.
 */
export interface EventOutput {
  id: string
  seriesId: string
  kind: 'stream' | 'recording'
  label: string
  position: number
  /** From the start of the event's window. */
  offsetMs: number
  durationMs: number
  destinationId: string | null
  credentialId: string | null
  /** Where it runs. Required in practice; null only on rows written before
   *  outputs owned their device. */
  deviceId: string | null
  nodeId: string | null
  templates: Record<string, string>
  /** Absent keys mean "leave the device as it is". */
  settings: OutputSettings
  enabled: boolean
}

export interface OutputSettings {
  quality?: string
  slot?: number
}

/** Two outputs that would need the same thing at the same time. */
export interface OutputConflict {
  kind?: 'device' | 'setting' | 'destination'
  /** The thing being fought over: a device, or a destination. */
  deviceLabel: string
  first: { id: string; label: string }
  second: { id: string; label: string }
  from: number
  to: number
  detail: string
}

export interface OutputsResponse {
  outputs: EventOutput[]
  conflicts: OutputConflict[]
}

export type OutputInput = Partial<Omit<EventOutput, 'id' | 'seriesId' | 'position'>> &
  Pick<EventOutput, 'kind' | 'label' | 'durationMs'> & { deviceId: string; nodeId: string }

export interface PreviewOccurrence {
  start: number
  end: number
  localDate: string
  resolution: 'exact' | 'ambiguous' | 'skipped'
  title?: string
  description?: string
  filename?: string
  error?: string
}

export interface SchedulePreview {
  describes: string
  occurrences: PreviewOccurrence[]
}

export interface SeriesInput {
  label: string
  timezone: string
  rrule: string | null
  /** The wall time as typed. The server resolves it in `timezone`. */
  dtstartLocal: { date: string; time: string }
  durationMs: number
  prepareLeadMs?: number
  templates: Record<string, string>
  enabled?: boolean
}

export class ApiError extends Error {
  readonly status: number
  readonly issues: { field?: string; message: string }[]
  constructor(status: number, message: string, issues: { field?: string; message: string }[] = []) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    // Fastify rejects a JSON content-type with an empty body, so action
    // endpoints that take no arguments still send `{}`.
    ...(method === 'GET' || init?.body !== undefined ? {} : { body: '{}' }),
  })
  const text = await response.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body.error === 'string' ? body.error : response.statusText,
      Array.isArray(body.issues) ? (body.issues as { field?: string; message: string }[]) : [],
    )
  }
  return body as T
}

export const api = {
  occurrences: (from: number, to: number) => request<Occurrence[]>(`/api/occurrences?from=${from}&to=${to}`),
  series: () => request<Series[]>('/api/series'),
  preview: (seriesId: string) => request<Preview[]>(`/api/series/${seriesId}/preview`),
  devices: () => request<Device[]>('/api/devices'),
  connectDevice: (id: string) => request<unknown>(`/api/devices/${id}/connect`, { method: 'POST' }),
  nodeState: (deviceId: string, nodeId: string) =>
    request<{ state: NodeState | null }>(`/api/devices/${deviceId}/nodes/${nodeId}/state`),
  /** Erase a card. Call once to get a confirmation token, then again with
   *  it — the deck's own protocol works that way and this passes it
   *  through rather than inventing a confirmation. */
  formatStorage: (deviceId: string, nodeId: string, slot: number, confirm?: string) =>
    request<{ formatted: boolean; confirm?: string }>(
      `/api/devices/${deviceId}/nodes/${nodeId}/format`,
      { method: 'POST', body: JSON.stringify({ slot, ...(confirm ? { confirm } : {}) }) },
    ),
  /** Drive a device by hand. The server reads the write back before it
   *  answers, so a resolved promise means the device really did it. */
  /** Point an encoder at a saved target by hand. The credential is named by
   *  id: the key is read out of the vault on the server and never travels
   *  through the browser. */
  pointAtTarget: (deviceId: string, nodeId: string, body: { credentialId: string; quality?: string }) =>
    request<{ state: NodeState | null }>(`/api/devices/${deviceId}/nodes/${nodeId}/stream-target`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  driveNode: (
    deviceId: string,
    nodeId: string,
    action: ManualAction,
    body: { filename?: string; slot?: number } = {},
  ) =>
    request<{ state: NodeState | null }>(`/api/devices/${deviceId}/nodes/${nodeId}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  runs: () => request<Run[]>('/api/runs'),
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  cancelRun: (id: string, reason: string) =>
    request<{ state: string }>(`/api/runs/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  startNow: (occurrenceId: string) =>
    request<{ runId: string; state: string }>(`/api/occurrences/${occurrenceId}/start-now`, { method: 'POST' }),
  /** Runs the prepare phase early, so an unlisted stream's link exists in
   *  time to be sent round. Every output still starts at its own time. */
  prepareNow: (occurrenceId: string) =>
    request<{ runId: string; state: string; links: { label: string; url: string }[] }>(
      `/api/occurrences/${occurrenceId}/prepare-now`,
      { method: 'POST' },
    ),
  skip: (occurrenceId: string) => request<unknown>(`/api/occurrences/${occurrenceId}/skip`, { method: 'POST' }),
  notificationKinds: () => request<ChannelKind[]>('/api/notifications/kinds'),
  notificationChannels: () =>
    request<{ channels: NotificationChannel[]; pending: number }>('/api/notifications/channels'),
  createChannel: (input: { kind: string; label: string; config: Record<string, unknown> }) =>
    request<{ id: string }>('/api/notifications/channels', { method: 'POST', body: JSON.stringify(input) }),
  testChannel: (id: string) => request<unknown>(`/api/notifications/channels/${id}/test`, { method: 'POST' }),
  deleteChannel: (id: string) => request<unknown>(`/api/notifications/channels/${id}`, { method: 'DELETE' }),
  unskip: (occurrenceId: string) => request<unknown>(`/api/occurrences/${occurrenceId}/unskip`, { method: 'POST' }),

  // -- setup --------------------------------------------------------------

  plugins: () => request<Plugin[]>('/api/plugins'),
  discover: (pluginId: string) =>
    request<DiscoveredDevice[]>(`/api/plugins/${pluginId}/discover`, { method: 'POST' }),
  createDevice: (input: { pluginId: string; label: string; config: Record<string, unknown> }) =>
    request<{ id: string }>('/api/devices', { method: 'POST', body: JSON.stringify(input) }),
  updateDevice: (id: string, input: { label?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
    request<unknown>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteDevice: (id: string) => request<unknown>(`/api/devices/${id}`, { method: 'DELETE' }),

  destinationProviders: () => request<DestinationProvider[]>('/api/destination-providers'),
  oauthInstructions: (provider: string) => request<OAuthInstructions>(`/api/oauth/${provider}/instructions`),
  oauthClients: () => request<OAuthClient[]>('/api/oauth/clients'),
  createOAuthClient: (input: { provider: string; label: string; clientId: string; clientSecret: string }) =>
    request<{ id: string }>('/api/oauth/clients', { method: 'POST', body: JSON.stringify(input) }),
  /** `clientRef` is the stored client's row id, not Google's client ID. */
  startOAuth: (provider: string, clientRef: string) =>
    request<{ url: string }>(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify({ clientRef }) }),
  accounts: () => request<Account[]>('/api/accounts'),
  deleteAccount: (id: string) => request<unknown>(`/api/accounts/${id}`, { method: 'DELETE' }),

  destinations: () => request<Destination[]>('/api/destinations'),
  /** What a connected channel can file finished videos in. */
  playlists: (provider: string, accountRef: string) =>
    request<{ playlists: { id: string; title: string }[] }>(
      `/api/destination-providers/${provider}/playlists?accountRef=${encodeURIComponent(accountRef)}`,
    ),
  createDestination: (input: {
    providerId: string
    label: string
    accountId: string
    config: Record<string, unknown>
  }) => request<{ id: string }>('/api/destinations', { method: 'POST', body: JSON.stringify(input) }),
  updateDestination: (id: string, input: { label?: string; config?: Record<string, unknown> }) =>
    request<{ ok: true }>(`/api/destinations/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteDestination: (id: string) => request<unknown>(`/api/destinations/${id}`, { method: 'DELETE' }),

  credentials: () => request<Credential[]>('/api/credentials'),
  createCredential: (input: { label: string; ingestUrl: string; key: string }) =>
    request<{ id: string }>('/api/credentials', { method: 'POST', body: JSON.stringify(input) }),
  deleteCredential: (id: string) => request<unknown>(`/api/credentials/${id}`, { method: 'DELETE' }),

  outputs: (seriesId: string) => request<OutputsResponse>(`/api/series/${seriesId}/outputs`),
  createOutput: (seriesId: string, input: OutputInput) =>
    request<OutputsResponse & { id: string }>(`/api/series/${seriesId}/outputs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateOutput: (id: string, input: Partial<OutputInput>) =>
    request<OutputsResponse>(`/api/outputs/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteOutput: (id: string) => request<OutputsResponse>(`/api/outputs/${id}`, { method: 'DELETE' }),
  reorderOutputs: (seriesId: string, order: string[]) =>
    request<OutputsResponse>(`/api/series/${seriesId}/outputs/order`, {
      method: 'POST',
      body: JSON.stringify({ order }),
    }),

  schedulePreview: (input: {
    label: string
    timezone: string
    rrule: string | null
    dtstartLocal: { date: string; time: string }
    durationMs: number
    templates: Record<string, string>
    count?: number
  }) => request<SchedulePreview>('/api/schedule/preview', { method: 'POST', body: JSON.stringify(input) }),
  createSeries: (input: SeriesInput) =>
    request<{ id: string }>('/api/series', { method: 'POST', body: JSON.stringify(input) }),
  updateSeries: (id: string, input: Partial<SeriesInput>) =>
    request<unknown>(`/api/series/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteSeries: (id: string) => request<unknown>(`/api/series/${id}`, { method: 'DELETE' }),
}

/** Loads once, then again whenever `deps` change or `reload` is called. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadRef
      .current()
      .then((value) => {
        if (cancelled) return
        setData(value)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) }
}

export interface DashboardOutput {
  id: string
  label: string
  kind: 'stream' | 'recording'
  state: 'waiting' | 'live' | 'done' | 'failed'
  startsAt: number
  endsAt: number
  deviceLabel: string | null
  watchUrl?: string
  telemetry?: { at: number; bitrateBps?: number; remainingMs?: number; inputPresent?: boolean }
}

export interface Dashboard {
  /** The server's clock: a countdown must not inherit a wrong one from the
   *  browser. */
  now: number
  onAir: {
    runId: string
    occurrenceId: string
    seriesLabel: string
    state: string
    windowStart: number
    windowEnd: number
    timezone: string
    outputs: DashboardOutput[]
  }[]
  next: {
    occurrenceId: string
    seriesLabel: string
    timezone: string
    scheduledStart: number
    scheduledEnd: number
    status: string
    runId: string | null
    runState: string | null
    outputs: number
  }[]
  devices: { id: string; label: string; health: string; lastError: string | null; detail: string | null }[]
  attention: { kind: string; message: string; href: string }[]
}

export interface LiveState {
  runs: { id: string; state: string }[]
  devices: { id: string; health: string }[]
  /**
   * Counts the server's ticks.
   *
   * A number rather than the arrays above, because those are rebuilt on
   * every message and a screen that depended on their identity would
   * re-render whether or not anything changed.
   */
  tick: number
  /** The last state each node pushed, keyed `deviceId/nodeId`. Devices send
   *  these as they change, so a panel can follow one without polling it. */
  nodeStates: Record<string, NodeState>
  connected: boolean
}

/**
 * Live run and device state over the WebSocket.
 *
 * The socket is a push channel, not the source of truth: every view still
 * loads from the API, so a dropped connection degrades to stale-but-correct
 * rather than blank.
 */
/**
 * One socket for the whole app, shared by every screen that wants it.
 *
 * Each `useLive` used to open its own, so a page that both read the tick
 * and refreshed on it held two connections and did its work twice. The
 * socket is a single subscription now: components come and go, and the
 * last one to leave closes it.
 */
let socket: WebSocket | undefined
let retry: ReturnType<typeof setTimeout> | undefined
let shared: LiveState = { runs: [], devices: [], tick: 0, nodeStates: {}, connected: false }
const subscribers = new Set<(state: LiveState) => void>()

function publish(next: (current: LiveState) => LiveState): void {
  shared = next(shared)
  for (const subscriber of subscribers) subscriber(shared)
}

function openSocket(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
  socket.onopen = () => publish((s) => ({ ...s, connected: true }))
  socket.onclose = () => {
    publish((s) => ({ ...s, connected: false }))
    // Only while somebody is still listening: a closed tab must not keep
    // reconnecting in the background.
    if (subscribers.size > 0) retry = setTimeout(openSocket, 2000)
  }
  socket.onmessage = (event) => {
    const payload = JSON.parse(String(event.data)) as Record<string, unknown>
    if (payload.channel === 'runs') {
      publish((s) => ({
        ...s,
        runs: (payload.runs as LiveState['runs']) ?? s.runs,
        devices: (payload.devices as LiveState['devices']) ?? s.devices,
        tick: s.tick + 1,
      }))
    }
    if (payload.channel === 'device' && payload.type === 'state') {
      const key = `${String(payload.deviceId)}/${String(payload.nodeId)}`
      publish((s) => ({ ...s, nodeStates: { ...s.nodeStates, [key]: payload.state as NodeState } }))
    }
  }
}

function subscribe(listener: (state: LiveState) => void): () => void {
  subscribers.add(listener)
  if (subscribers.size === 1) openSocket()
  return () => {
    subscribers.delete(listener)
    if (subscribers.size > 0) return
    if (retry) clearTimeout(retry)
    retry = undefined
    socket?.close()
    socket = undefined
  }
}

export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>(shared)
  useEffect(() => subscribe(setState), [])
  return state
}

/**
 * Re-reads a screen whenever the server says something happened.
 *
 * The socket is the pulse, not the data: every screen still loads from the
 * API, so a dropped connection leaves it stale-but-correct rather than
 * blank, and reconnecting catches it up on the next tick.
 */
export function useLiveRefresh(reload: () => void, when = true): void {
  const { tick } = useLive()
  useEffect(() => {
    if (when) reload()
    // Keyed on the tick alone: `reload` is rebuilt by its own hook and
    // depending on it would fire this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, when])
}
