import OBSWebSocket from 'obs-websocket-js'

/**
 * The slice of obs-websocket this adapter uses.
 *
 * Narrow on purpose, and an interface rather than the library type, so the
 * tests can drive a fake that speaks the same protocol without a copy of
 * OBS running. That is the same trade the ATEM and HyperDeck adapters make,
 * and it is the one that catches protocol mistakes — a fake shaped like
 * the real thing disagrees with a wrong adapter, and a convenient fake
 * agrees with everything.
 */
export interface ObsClient {
  connect(address: string, password?: string): Promise<{ obsWebSocketVersion: string }>
  disconnect(): Promise<void>
  call<T = unknown>(request: string, args?: Record<string, unknown>): Promise<T>
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  off(event: string, handler: (data: Record<string, unknown>) => void): void
}

export type CreateObsClient = () => ObsClient

/** What `GetVersion` answers with, of the parts worth reporting. */
export interface ObsVersion {
  obsVersion: string
  obsWebSocketVersion: string
  platformDescription?: string
}

/** `GetRecordStatus`. OBS does not name the file here — see `index.ts`. */
export interface ObsRecordStatus {
  outputActive: boolean
  outputPaused?: boolean
  outputDuration?: number
}

/** `GetStreamStatus`. */
export interface ObsStreamStatus {
  outputActive: boolean
  outputReconnecting?: boolean
  outputDuration?: number
  outputCongestion?: number
  outputSkippedFrames?: number
  outputTotalFrames?: number
}

/** `GetStreamServiceSettings`, for reading a target back after writing it. */
export interface ObsStreamService {
  streamServiceType: string
  streamServiceSettings: { server?: string; key?: string; service?: string }
}

/** The real one. Swapped out in tests, which have no OBS to talk to. */
export const createObsClient: CreateObsClient = () => {
  const socket = new OBSWebSocket()
  return {
    connect: async (address, password) =>
      (await socket.connect(address, password)) as { obsWebSocketVersion: string },
    disconnect: () => socket.disconnect(),
    call: async <T>(request: string, args?: Record<string, unknown>) =>
      // The library's types are generated per request name; this adapter
      // addresses them by string, so the cast is where that meets the
      // narrow interface above rather than being spread through the code.
      (await (
        socket as unknown as {
          call(request: string, args?: Record<string, unknown>): Promise<unknown>
        }
      ).call(request, args)) as T,
    on: (event, handler) =>
      (socket as unknown as { on(e: string, h: (d: Record<string, unknown>) => void): void }).on(
        event,
        handler,
      ),
    off: (event, handler) =>
      (socket as unknown as { off(e: string, h: (d: Record<string, unknown>) => void): void }).off(
        event,
        handler,
      ),
  }
}
