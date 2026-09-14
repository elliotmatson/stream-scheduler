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
  pipelineId: string
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
  probedModel: string | null
  capabilities: { model: string; firmware?: string; features: string[] } | null
  health: string
  lastError: string | null
  lastSeenAt: number | null
  enabled: boolean
  nodes: { id: string; label: string; roles: string[]; supports: string[] }[]
}

export interface RunStep {
  seq: number
  kind: string
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
  steps?: RunStep[]
}

export interface ChannelKind {
  kind: string
  displayName: string
  configSchema: {
    type: string
    id: string
    label: string
    default?: unknown
    tooltip?: string
  }[]
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

export interface Preview {
  occurrenceId: string
  title?: string
  description?: string
  filename?: string
  error?: string
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
  runs: () => request<Run[]>('/api/runs'),
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  cancelRun: (id: string, reason: string) =>
    request<{ state: string }>(`/api/runs/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  startNow: (occurrenceId: string) =>
    request<{ runId: string; state: string }>(`/api/occurrences/${occurrenceId}/start-now`, { method: 'POST' }),
  skip: (occurrenceId: string) => request<unknown>(`/api/occurrences/${occurrenceId}/skip`, { method: 'POST' }),
  notificationKinds: () => request<ChannelKind[]>('/api/notifications/kinds'),
  notificationChannels: () =>
    request<{ channels: NotificationChannel[]; pending: number }>('/api/notifications/channels'),
  createChannel: (input: { kind: string; label: string; config: Record<string, unknown> }) =>
    request<{ id: string }>('/api/notifications/channels', { method: 'POST', body: JSON.stringify(input) }),
  testChannel: (id: string) => request<unknown>(`/api/notifications/channels/${id}/test`, { method: 'POST' }),
  deleteChannel: (id: string) => request<unknown>(`/api/notifications/channels/${id}`, { method: 'DELETE' }),
  unskip: (occurrenceId: string) => request<unknown>(`/api/occurrences/${occurrenceId}/unskip`, { method: 'POST' }),
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

export interface LiveState {
  runs: { id: string; state: string }[]
  devices: { id: string; health: string }[]
  connected: boolean
}

/**
 * Live run and device state over the WebSocket.
 *
 * The socket is a push channel, not the source of truth: every view still
 * loads from the API, so a dropped connection degrades to stale-but-correct
 * rather than blank.
 */
export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ runs: [], devices: [], connected: false })

  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
      socket.onopen = () => setState((s) => ({ ...s, connected: true }))
      socket.onclose = () => {
        setState((s) => ({ ...s, connected: false }))
        if (!closed) retry = setTimeout(connect, 2000)
      }
      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as Record<string, unknown>
        if (payload.channel === 'runs') {
          setState((s) => ({
            ...s,
            runs: (payload.runs as LiveState['runs']) ?? s.runs,
            devices: (payload.devices as LiveState['devices']) ?? s.devices,
          }))
        }
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return state
}
