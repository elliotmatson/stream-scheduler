import { Atem, AtemConnectionStatus } from 'atem-connection'
import type { AtemState } from 'atem-connection'

/**
 * The slice of `atem-connection` this adapter uses.
 *
 * Extracted as an interface so the mapping logic — model to capabilities,
 * device state to NodeState, error to remediation — can be tested without
 * hardware. Unlike the HyperDeck, the ATEM protocol has no emulator to point
 * at, and it is reverse-engineered rather than published, so the seam is
 * where the testable behaviour lives.
 */
export interface AtemClient {
  readonly status: AtemConnectionStatus
  readonly state: Readonly<AtemState> | undefined
  connect(address: string, port?: number): Promise<void>
  disconnect(): Promise<void>
  destroy(): Promise<void>
  on(event: 'connected' | 'disconnected', handler: () => void): void
  on(event: 'error', handler: (message: string) => void): void
  on(event: 'stateChanged', handler: (state: Readonly<AtemState>, paths: string[]) => void): void
  off(event: string, handler: (...args: never[]) => void): void
  setStreamingService(props: { serviceName?: string; url?: string; key?: string }): Promise<void>
  startStreaming(): Promise<void>
  stopStreaming(): Promise<void>
  setRecordingSettings(props: { filename?: string }): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  setAuxSource(source: number, bus?: number): Promise<void>
}

export function createAtemClient(): AtemClient {
  return new Atem() as unknown as AtemClient
}

export { AtemConnectionStatus }
