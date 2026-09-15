import { createHash } from 'node:crypto'

/**
 * Magewell's `usapi`, as much of it as this adapter needs.
 *
 * Taken from the Ultra Encode AIO API reference (V2.4), which the
 * repository carries a copy of. The same vocabulary covers Ultra Encode,
 * Ultra Encode Plus and the older Ultra Stream — the documentation groups
 * the calls under different headings per product, but the method names,
 * the transport and the status codes are shared. Where this adapter relies
 * on something only the AIO reference states, the comment says so.
 *
 * One request shape does nearly all of it:
 *
 *     GET http://<ip>/usapi?method=<name>&param=value…
 *
 * answering JSON with a `result` field. A session comes from `login` and
 * rides in an `sid` cookie. `del-media-files` is the exception: a POST with
 * a JSON body.
 *
 * **A stream key travels in a query string.** As with vMix, that is the
 * device's interface rather than a choice available here, so the key never
 * reaches a log or an error message from this adapter — `redact` is what
 * gets logged instead — and the device belongs on a trusted network.
 */

/** Long enough for a busy encoder, short enough that a wedged one is not
 *  mistaken for a slow one. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Result codes, from the reference's own table.
 *
 * Only the ones this adapter acts on or can explain usefully. The rest are
 * reported by number, which is better than a wrong guess at a meaning.
 */
export const RESULT = {
  succeeded: 0,
  /** The same request again. Asking a running stream to start is not a
   *  failure, which matters because this adapter re-sends `start-live`
   *  every time a second destination joins. */
  repeat: 1,
  running: 2,
  /** Idle. The device's word for "nothing is happening here". */
  init: 27,
  /** A live task that is actually up. Everything between 23 and 25 is on
   *  the way there and is not yet streaming. */
  livingConnected: 22,
  livingConnecting: 23,
  livingWaiting: 24,
  livingAuthing: 25,
  livingDns: 28,
  livingNotSet: 29,
  livingAuthError: 30,
} as const

/** What went wrong, in words, where the reference gives words. */
const FAILURES = new Map<number, string>([
  [-1, 'the password was wrong'],
  [-2, 'the device is already locked by two other apps'],
  [-9, 'the device is busy'],
  [-10, 'the device rejected the parameters'],
  [-14, 'the device has no such item'],
  [-15, 'the device reported a file error'],
  [-17, 'the session has expired'],
  [-18, 'the device reported a system error'],
  [-21, 'the device could not reach the network'],
  [-25, 'no such user on the device'],
  [-27, 'that name is already in use on the device'],
  [-29, 'the device streams to six destinations at most'],
  [-35, 'the device has no input signal'],
  [-36, 'the device reported an SD card error'],
])

/** The session expired. Worth its own name: it is the one failure that is
 *  fixed by logging in again rather than by telling anybody. */
export const NEEDS_AUTH = -17

export class MagewellError extends Error {
  constructor(
    readonly result: number,
    message: string,
  ) {
    super(message)
    this.name = 'MagewellError'
  }
}

export function describeResult(result: number): string {
  return FAILURES.get(result) ?? `the device answered ${result}`
}

/**
 * Live status for one destination, from `get-status`.
 *
 * `result` is the interesting one and is not a boolean: a destination can
 * be enabled, trying, and not up. Reporting "streaming" for anything but
 * `livingConnected` would put a green light on a stream that is still
 * resolving DNS — or one that a wrong key just bounced.
 */
export interface LiveEntry {
  id: number
  type: number
  'is-use': number
  name?: string
  result: number
  'run-ms'?: number
  'main-inst-bps'?: number
}

export interface RecEntry {
  id: number
  type: number
  'is-use': number
  result: number
  'run-ms'?: number
}

export interface MagewellStatus {
  result: number
  'box-name'?: string
  'cur-status'?: number
  'live-status'?: { live?: LiveEntry[] }
  'rec-status'?: { rec?: RecEntry[] }
}

/** One configured destination, from `get-settings`. Type-specific fields
 *  vary; only the ones common to the RTMP family are named. */
export interface StreamServer {
  id: number
  type: number
  name?: string
  'is-use'?: number
  url?: string
  key?: string
}

export interface MagewellSettings {
  result: number
  name?: string
  'stream-server'?: StreamServer[]
}

export interface RecChannel {
  id: number
  /** Storage medium: 0 USB, 1 SD card, 2 NAS. */
  type: number
  'is-use'?: number
  'dir-name'?: string
  'prefix-name'?: string
}

export interface MagewellRecChannels {
  result: number
  'rec-channels'?: RecChannel[]
}

/** One file on the media, from `get-media-files`. */
export interface MagewellMediaFile {
  name: string
  /** 0 while the file is being written, 1 normal, 2 error, 3 lost. The
   *  zero is load-bearing: it is the file the device is recording into
   *  right now, and nothing may offer it up for deletion. */
  status: number
  'create-time'?: string
  'size-bytes'?: number
  /** Seconds, per the reference. */
  duration?: number
}

export interface MagewellMedia {
  result: number
  path?: string
  'media-files'?: MagewellMediaFile[]
}

export interface MagewellInfo {
  result: number
  'box-name'?: string
  'firmware-ver'?: string
  'hardware-ver'?: string
  sn?: string
  'product-name'?: string
}

export interface MagewellApi {
  /** `GET /usapi?method=…`. Throws on a non-zero result. */
  call<T extends { result: number }>(method: string, params?: Record<string, string>): Promise<T>
  /** `POST /usapi?method=…` with a JSON body. */
  post<T extends { result: number }>(method: string, body: unknown): Promise<T>
  /** Drops the session, so the next call logs in again. */
  forget(): void
}

/**
 * One HTTP round trip, so a test can answer without an encoder.
 *
 * The seam is here rather than at `MagewellApi` on purpose. Everything
 * worth getting wrong — signing in, carrying the session, noticing it has
 * expired and signing in again, reading `result` — lives above this line,
 * and a fake that replaced `MagewellApi` would replace all of it with
 * something that agrees with itself.
 */
export interface HttpReply {
  ok: boolean
  status: number
  text: string
  /** The `Set-Cookie` header, where the device sent one. */
  setCookie?: string
}

export type HttpRequest = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpReply>

export type CreateMagewellApi = (options: {
  host: string
  port: number
  user: string
  password: string
  /** Injected in tests. Defaults to `fetch`. */
  http?: HttpRequest
}) => MagewellApi

/** The device wants the password MD5'd, not the plain text. */
export function passwordHash(password: string): string {
  return createHash('md5').update(password).digest('hex')
}

/**
 * The destinations that take a URL and a stream key.
 *
 * The device's `type` covers far more than RTMP — NDI, SRT, RTSP, HLS,
 * TS over UDP and several more — and most of those are configured by
 * ports and stream names rather than by a URL and a key. Only these can
 * honestly answer `applyStreamTarget`, so only these claim to.
 */
const URL_AND_KEY_TYPES = new Set([
  0, // custom RTMP
  1, // Twitch
  2, // YouTube
  3, // Facebook
  4, // Wowza over RTMP
  143, // YouTube HLS
])

export function takesUrlAndKey(type: number): boolean {
  return URL_AND_KEY_TYPES.has(type)
}

/** What the device calls this kind of destination, for a node label. */
export function describeServerType(type: number): string {
  const names = new Map<number, string>([
    [0, 'RTMP'],
    [1, 'Twitch'],
    [2, 'YouTube'],
    [3, 'Facebook'],
    [4, 'Wowza'],
    [100, 'RTSP'],
    [120, 'SRT caller'],
    [121, 'SRT listener'],
    [122, 'Wowza over SRT'],
    [130, 'NDI HX'],
    [131, 'HLS'],
    [132, 'TS over UDP'],
    [133, 'TS over RTP'],
    [140, 'TVU ISS'],
    [143, 'YouTube HLS'],
    [144, 'ZIXI'],
    [150, 'RIST caller'],
    [151, 'RIST listener'],
  ])
  return names.get(type) ?? `type ${type}`
}

/** What the device calls a storage medium, for a node label. */
export function describeDisk(type: number): string {
  return type === 0 ? 'USB' : type === 1 ? 'SD card' : type === 2 ? 'NAS' : `disk ${type}`
}

/** A request fit to appear in a log: the method, never what it carried. */
export function redact(method: string, params: Record<string, string> = {}): string {
  const shown = Object.keys(params)
    .map((name) => `${name}=…`)
    .join('&')
  return shown ? `${method}?${shown}` : method
}

/** Over `fetch`, with a timeout, which is all the real transport is. */
const overFetch: HttpRequest = async (url, init) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      ...(response.headers.get('set-cookie') === null
        ? {}
        : { setCookie: response.headers.get('set-cookie') as string }),
    }
  } finally {
    clearTimeout(timer)
  }
}

export const createMagewellApi: CreateMagewellApi = ({
  host,
  port,
  user,
  password,
  http = overFetch,
}) => {
  const base = `http://${host}:${port}/usapi`
  let sid: string | undefined

  async function send(
    query: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Record<string, unknown>> {
    const response = await http(`${base}?${query}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(sid === undefined ? {} : { cookie: `sid=${sid}` }),
      },
    })
    if (!response.ok) {
      // Without the query: it may be carrying a stream key.
      throw new MagewellError(response.status, `the device answered HTTP ${response.status}`)
    }
    // A login hands the session back in a Set-Cookie; everything after it
    // rides on that. Read on every reply, because the device is entitled
    // to roll it.
    const rolled = response.setCookie?.match(/sid=([^;]+)/)?.[1]
    if (rolled) sid = rolled
    return response.text ? (JSON.parse(response.text) as Record<string, unknown>) : { result: 0 }
  }

  async function ensureSession(): Promise<void> {
    if (sid !== undefined) return
    const answer = await send(
      new URLSearchParams({
        method: 'login',
        id: user,
        pass: passwordHash(password),
      }).toString(),
    )
    const result = Number(answer.result ?? -1)
    if (result !== RESULT.succeeded) {
      throw new MagewellError(result, `could not sign in: ${describeResult(result)}`)
    }
  }

  /** Runs `attempt`, and once more behind a fresh login if the session had
   *  quietly gone. A device left alone all week expires its session, and a
   *  Sunday morning is the wrong time to find that out. */
  async function withSession<T extends { result: number }>(
    attempt: () => Promise<Record<string, unknown>>,
  ): Promise<T> {
    await ensureSession()
    let answer = await attempt()
    if (Number(answer.result) === NEEDS_AUTH) {
      sid = undefined
      await ensureSession()
      answer = await attempt()
    }
    return answer as T
  }

  return {
    async call<T extends { result: number }>(method: string, params = {}) {
      const query = new URLSearchParams({ method, ...params }).toString()
      return withSession<T>(() => send(query))
    },
    async post<T extends { result: number }>(method: string, body: unknown) {
      const query = new URLSearchParams({ method }).toString()
      return withSession<T>(() =>
        send(query, {
          method: 'POST',
          headers: { 'content-type': 'application/json;charset=UTF-8' },
          body: JSON.stringify(body),
        }),
      )
    },
    forget() {
      sid = undefined
    },
  }
}
