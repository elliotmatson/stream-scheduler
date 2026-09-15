import { XMLParser } from 'fast-xml-parser'

/**
 * vMix's Web Controller API, as much of it as this adapter needs.
 *
 * Everything here was checked against a working integration rather than
 * recalled: the function names, the 0-based channel numbering, and the
 * shape of the status XML all come from reading code that drives real
 * vMix installs in the field. Where that code carries a workaround, this
 * file carries the reason.
 *
 * One request shape does all of it. `GET /api/` answers the whole state as
 * XML; `GET /api/?Function=Name&Value=...` performs a function and answers
 * plain text. There is no session, no handshake, and nothing to keep open.
 *
 * **A stream key travels in a query string.** That is vMix's interface, not
 * a choice available to this adapter — there is no documented POST form for
 * these functions. It means the key can land in an HTTP proxy log or a
 * reverse-proxy access log on the way, so vMix belongs on a trusted control
 * network. This adapter never logs a URL it has put a key into; `redact`
 * below is what it logs instead.
 */

/** Long enough for a busy production PC, short enough that a wedged vMix
 *  is not mistaken for a slow one. */
export const REQUEST_TIMEOUT_MS = 10_000

/** vMix has five RTMP destinations, and they start and stop separately. */
export const MAX_STREAM_CHANNELS = 5

export class VmixApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'VmixApiError'
  }
}

/** What `GET /api/` says, reduced to what this adapter acts on. */
export interface VmixStatus {
  version: string
  edition: string
  recording: boolean
  /** vMix writes up to two files at once, in two formats. It names them
   *  itself from its own Recording Settings; there is no API to set them,
   *  which is the whole reason the run ledger records what came back. */
  recordingFilenames: string[]
  /** Seconds of the current recording, when vMix reports it. Seconds, not
   *  milliseconds — checked, because the difference is a stopwatch that
   *  reads 41 minutes as 2 seconds. */
  recordingSeconds?: number
  /** True when any destination is live. */
  streaming: boolean
  /** Per-destination, index 0 being the one vMix's own UI calls 1. */
  channels: boolean[]
  external: boolean
}

export interface VmixApi {
  /** `GET /api/?Function=...`. Resolves when vMix accepts it. */
  call(fn: string, params?: Record<string, string>): Promise<void>
  /** `GET /api/`, parsed. */
  status(): Promise<VmixStatus>
}

export type CreateVmixApi = (options: { host: string; port: number }) => VmixApi

/**
 * The one field vMix will not take on its own.
 *
 * `StreamingSetURL` and `StreamingSetKey` apply to the first destination
 * unless the value is prefixed with the 0-based channel and a comma —
 * `0,rtmp://…`. It is a value-level convention rather than a parameter,
 * which is easy to miss and silently points every channel at the same
 * place when it is missed.
 */
export function channelValue(channel: number, value: string): string {
  return `${channel},${value}`
}

/** A URL fit to appear in a log: the function, never what it carried. */
export function redact(fn: string, params: Record<string, string> = {}): string {
  const shown = Object.keys(params)
    .map((name) => `${name}=…`)
    .join('&')
  return shown ? `${fn}?${shown}` : fn
}

/**
 * Reads the bits of `<vmix>` this adapter acts on.
 *
 * Attribute-aware on purpose. `<recording>` is bare text on older vMix and
 * carries `filename1`, `filename2` and `duration` on newer, and
 * `<streaming>` carries `channel1`…`channel5`; a reader that took only the
 * text would quietly lose the recording's name on every install that has
 * one, and report a machine as streaming without knowing where.
 */
export function parseStatus(xml: string): VmixStatus {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    // Every value stays a string. vMix writes True/False, and a parser
    // that helpfully coerced "0954" in a filename to a number would be
    // corrupting the one thing here that has to survive intact.
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  })

  const root = (parser.parse(xml) as Record<string, unknown>)?.vmix
  if (!isRecord(root)) {
    throw new VmixApiError(200, 'vMix answered something that was not its status XML.')
  }

  const recording = root.recording
  const streaming = root.streaming

  return {
    version: textOf(root.version) ?? '',
    edition: textOf(root.edition) ?? '',
    recording: isTrue(textOf(recording)),
    recordingFilenames: ['@filename1', '@filename2']
      .map((name) => (isRecord(recording) ? textOf(recording[name]) : undefined))
      .filter((name): name is string => name !== undefined && name !== ''),
    ...(isRecord(recording) ? seconds(textOf(recording['@duration'])) : {}),
    streaming: isTrue(textOf(streaming)),
    channels: Array.from({ length: MAX_STREAM_CHANNELS }, (_, index) =>
      isRecord(streaming) ? isTrue(textOf(streaming[`@channel${index + 1}`])) : false,
    ),
    external: isTrue(textOf(root.external)),
  }
}

/**
 * The text of an element, whether or not it had attributes.
 *
 * With attributes the parser nests the text under `#text`; without them the
 * element *is* its text. Both spellings are the same element on two vMix
 * versions, so both have to read the same.
 */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value['#text'] === 'string') return value['#text']
  return undefined
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function seconds(value: string | undefined): { recordingSeconds?: number } {
  const parsed = Number(value)
  return value === undefined || value === '' || !Number.isFinite(parsed)
    ? {}
    : { recordingSeconds: parsed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The real one. Swapped out in tests, which have no vMix to talk to. */
export const createVmixApi: CreateVmixApi = ({ host, port }) => {
  const base = `http://${host}:${port}/api/`

  async function get(query: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${base}${query}`, { signal: controller.signal })
      if (!response.ok) {
        // Deliberately without the query: it may be carrying a stream key.
        throw new VmixApiError(response.status, `vMix answered ${response.status}`)
      }
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async call(fn, params = {}) {
      const query = new URLSearchParams({ Function: fn, ...params })
      // Whether vMix *did* the thing is not decided here. Its reply body
      // is not documented well enough to pattern-match on, and guessing at
      // one would be a check that passes for the wrong reason. The engine
      // already reads the state back after every command, which is a real
      // answer rather than a hopeful one.
      await get(`?${query.toString()}`)
    },
    async status() {
      return parseStatus(await get(''))
    },
  }
}
