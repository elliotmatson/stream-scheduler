/**
 * ProPresenter's HTTP API, as much of it as this adapter needs.
 *
 * Shapes taken from the published 7.9 OpenAPI specification rather than
 * from memory, because guessing at an integration is how a whole adapter
 * turns out to be for something the product does not do.
 */

/** `GET /version`. */
export interface ProVersion {
  name: string
  platform: string
  os_version: string
  host_description: string
  api_version: string
}

/** `GET /v1/capture/status`. */
export interface ProCaptureStatus {
  capturing: boolean
  capture_time?: string
}

/**
 * `GET`/`PUT /v1/capture/settings`.
 *
 * One capture, whose shape decides where it goes. `source` and
 * `audio_routing` are required on the way in, which is why every write
 * here is a read-modify-write rather than a bare set: this adapter is not
 * entitled to invent which screen somebody is capturing.
 */
export interface ProCaptureSettings {
  source?: string
  audio_routing?: number[][]
  disk?: ProDiskSettings
  rtmp?: ProRtmpSettings
  resi?: Record<string, unknown>
  /**
   * Which of the three the capture actually goes to.
   *
   * ProPresenter's own settings screen has this as a dropdown, but the
   * published schema for this body lists only `source`, `audio_routing`
   * and the three sub-objects — so it is read when the app reports it and
   * never invented when it does not. `destinationOf` is the only reader.
   */
  destination?: string
}

export interface ProDiskSettings {
  /** A folder. ProPresenter names the file itself and never says what it
   *  called it, which is why a capture to disk cannot be swept. */
  file_location?: string
  codec?: string
  encoding?: string
  resolution?: { width: number; height: number }
  frame_rate?: number
}

export interface ProRtmpSettings {
  /**
   * Where the stream goes.
   *
   * The specification names this `url` in its schema and `server` in every
   * one of its examples. Rather than pick one and be wrong on half the
   * installs, the adapter reads the running app's own settings and writes
   * back whichever key it already uses — see `targetKeyOf`.
   */
  url?: string
  server?: string
  key?: string
  encoding?: string
  save_local?: boolean
  file_location?: string
}

/** The transport, so tests can answer without a copy of ProPresenter. */
export interface ProApi {
  /** Returns the parsed body, or undefined for a 204. */
  request<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T | undefined>
}

export type CreateProApi = (options: { host: string; port: number }) => ProApi

/** Long enough for a machine mid-service, short enough that a wedged
 *  ProPresenter is not mistaken for a slow one. */
export const REQUEST_TIMEOUT_MS = 10_000

export class ProApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ProApiError'
  }
}

/** The real one. Swapped out in tests, which have no ProPresenter. */
export const createProApi: CreateProApi = ({ host, port }) => {
  const base = `http://${host}:${port}`
  return {
    async request<T>(method: 'GET' | 'PUT', path: string, body?: unknown) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          signal: controller.signal,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        })
        if (!response.ok) {
          throw new ProApiError(response.status, `${method} ${path} answered ${response.status}`)
        }
        // Every capture operation answers 204 with no body.
        if (response.status === 204) return undefined
        const text = await response.text()
        return text ? (JSON.parse(text) as T) : undefined
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Which spelling of the RTMP destination this install uses.
 *
 * The published spec disagrees with itself: the schema says `url`, the
 * examples say `server`. The app itself is the authority, so whatever it
 * already has is what gets written back. `server` is the fallback only
 * because every worked example in the spec uses it.
 */
export function targetKeyOf(rtmp: ProRtmpSettings | undefined): 'url' | 'server' {
  if (rtmp?.url !== undefined) return 'url'
  if (rtmp?.server !== undefined) return 'server'
  return 'server'
}

/**
 * Where this install says the capture goes, if it says at all.
 *
 * Reported by the app on the firmware that has the field, absent on the
 * firmware that does not, which is why every caller has a fallback.
 */
export function destinationOf(
  settings: ProCaptureSettings | undefined,
): 'disk' | 'rtmp' | 'resi' | undefined {
  const value = settings?.destination?.trim().toLowerCase()
  return value === 'disk' || value === 'rtmp' || value === 'resi' ? value : undefined
}

/**
 * The RTMP server this install is pointed at, or nothing.
 *
 * An idle ProPresenter keeps the last stream's settings, and an install
 * that has never streamed carries the field as an empty string. Neither is
 * a destination, and treating them as one reports a machine as streaming
 * while it is quietly recording to disk.
 */
export function rtmpTargetOf(rtmp: ProRtmpSettings | undefined): string | undefined {
  const value = rtmp?.url ?? rtmp?.server
  return value === undefined || value.trim() === '' ? undefined : value
}
