import { DeviceError } from '@scheduler/plugin-sdk'

/**
 * The Blackmagic Streaming Encoder Control REST API, as documented in
 * "Blackmagic Streaming REST API" (January 2026) for the Streaming Encoder
 * HD and 4K.
 *
 * Every path below is taken from that document. The device also exposes its
 * own YAML at `/control/documentation.html`, which is worth diffing against
 * this file when a new firmware ships.
 *
 * There is no authentication: the API is open to anyone who can reach the
 * device, which is the device's design and not something this adapter can
 * fix. Keep it on a trusted control VLAN.
 */

export const API_PREFIX = '/control/api/v1'

export type LivestreamStatus = 'Idle' | 'Connecting' | 'Streaming' | 'Flushing' | 'Interrupted'

export interface LivestreamState {
  status: LivestreamStatus
  bitrate: number
  effectiveVideoFormat: string
  /** Seconds. Absent while idle. */
  duration?: number
  /** Percentage of the on-device cache in use. */
  cache?: number
}

export interface ActivePlatform {
  platform: string
  /** A server name from the platform, or "Custom" when the URL is set by us. */
  server: string
  key?: string
  passphrase?: string
  quality: string
  /** Only present when the platform allows a custom URL. */
  url?: string
}

export interface PlatformServer {
  server: string
  url: string
  group?: string
  srtExtensions?: Record<string, string>[]
}

export interface PlatformProfile {
  profile: string
  lowLatency: boolean
  configs: { resolution: string; fps: string; bitrate: number }[]
}

export interface PlatformConfig {
  platform: string
  key?: string
  servers: PlatformServer[]
  profiles: PlatformProfile[]
  defaultProfile?: string
  credentials?: { username: string; password: string }
  customizableUrlEnabled?: boolean
}

export interface ProductInfo {
  deviceName?: string
  productName?: string
  softwareVersion?: string
}

export class StreamingEncoderApi {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async product(): Promise<ProductInfo> {
    // Documented as possibly 501 "not implemented for the device in use",
    // so a device that declines to identify itself is still usable.
    return (await this.get<ProductInfo>('/system/product', { allow501: true })) ?? {}
  }

  async videoFormat(): Promise<{ name?: string } | undefined> {
    return this.get<{ name?: string }>('/system/videoFormat', { allow501: true })
  }

  async livestream(): Promise<LivestreamState> {
    const state = await this.get<LivestreamState>('/livestreams/0')
    if (!state) throw new DeviceError('no-livestream', 'The encoder did not report a livestream state.')
    return state
  }

  async activePlatform(): Promise<ActivePlatform | undefined> {
    return this.get<ActivePlatform>('/livestreams/0/activePlatform')
  }

  async setActivePlatform(platform: ActivePlatform): Promise<void> {
    await this.put('/livestreams/0/activePlatform', platform)
  }

  async start(): Promise<void> {
    await this.put('/livestreams/0/start')
  }

  async stop(): Promise<void> {
    await this.put('/livestreams/0/stop')
  }

  async platforms(): Promise<string[]> {
    return (await this.get<string[]>('/livestreams/platforms')) ?? []
  }

  async platform(name: string): Promise<PlatformConfig | undefined> {
    return this.get<PlatformConfig>(`/livestreams/platforms/${encodeURIComponent(name)}`)
  }

  private async get<T>(path: string, options: { allow501?: boolean } = {}): Promise<T | undefined> {
    const response = await this.request('GET', path)
    if (response.status === 404) return undefined
    if (options.allow501 && response.status === 501) return undefined
    await this.assertOk(response, path)
    const text = await response.text()
    return text ? (JSON.parse(text) as T) : undefined
  }

  private async put(path: string, body?: unknown): Promise<void> {
    const response = await this.request('PUT', path, body)
    await this.assertOk(response, path)
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${API_PREFIX}${path}`
    try {
      return await fetch(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new DeviceError('unreachable', `Could not reach the encoder at ${this.baseUrl}: ${detail}`, {
        retryable: true,
        remediation: 'Check the address, that the encoder is powered on, and that port 80 is reachable.',
        cause: error,
      })
    }
  }

  private async assertOk(response: Response, path: string): Promise<void> {
    if (response.ok) return

    const body = await response.text().catch(() => '')
    if (response.status === 400) {
      // The one the operator will actually hit: a platform, server or
      // quality name the device does not recognise.
      throw new DeviceError('rejected', `The encoder rejected ${path}: ${body || 'bad request'}`, {
        remediation:
          'The platform, server or quality name is probably not one this encoder knows. ' +
          'The Devices page lists what it offers.',
      })
    }
    throw new DeviceError('http-error', `The encoder answered ${response.status} for ${path}.`, {
      retryable: response.status >= 500,
    })
  }
}
