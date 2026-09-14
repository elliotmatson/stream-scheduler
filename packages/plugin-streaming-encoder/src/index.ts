import { defineDevice, DeviceError, fingerprint, SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type {
  ConfigField,
  DeviceCapabilities,
  DeviceContext,
  DeviceInstance,
  HealthReport,
  NodeActions,
  NodeDefinition,
  NodeState,
  PluginDefinition,
} from '@scheduler/plugin-sdk'
import { StreamingEncoderApi, type ActivePlatform, type PlatformConfig } from './api.js'

/**
 * Blackmagic Streaming Encoder HD / 4K and Web Presenter, over the
 * documented Control REST API.
 *
 * One adapter for both because current firmware exposes the same
 * `/control/api/v1/` API on each. What decides whether a given unit works
 * is the firmware, not the model name: older Web Presenter firmware
 * predates this API and speaks a different protocol on TCP 9977, which is
 * not implemented here. Check the unit answers on `/control/api/v1/`
 * rather than going by what is printed on the box.
 *
 * The one real impedance mismatch is worth explaining up front. This
 * scheduler hands an encoder a *URL and a key*, because that is what every
 * streaming service issues. The encoder instead thinks in **platforms**: a
 * named service, one of its servers, and a quality profile. The two are
 * reconciled in `resolveTarget` below.
 */

const configSchema: ConfigField[] = [
  {
    type: 'textinput',
    id: 'host',
    label: 'IP address or hostname',
    required: true,
    tooltip:
      'A Streaming Encoder HD / 4K, or a Web Presenter on firmware new enough to serve ' +
      '/control/api/v1/. Older Web Presenter firmware speaks a different protocol and is not supported.',
  },
  { type: 'number', id: 'port', label: 'Port', default: 80, min: 1, max: 65535 },
  {
    type: 'textinput',
    id: 'platform',
    label: 'Platform',
    tooltip:
      'Leave blank to use whichever platform lets the URL be set freely, which is what a scheduled event ' +
      'needs. Name one only if you want the encoder\'s own preset for a service.',
  },
  {
    type: 'textinput',
    id: 'server',
    label: 'Server',
    tooltip: 'Only used with a named platform. Blank picks the platform\'s first server.',
  },
  {
    type: 'textinput',
    id: 'quality',
    label: 'Quality profile',
    tooltip: 'Blank uses the platform\'s default, e.g. "Streaming High".',
  },
]

/** The device reports these while it is doing something, or trying to. */
const ACTIVE_STATUSES = new Set(['Streaming', 'Connecting', 'Interrupted'])

class StreamingEncoderDevice {
  private product = { productName: 'Blackmagic encoder', softwareVersion: '' }
  private platforms: PlatformConfig[] = []
  private connectedAt = 0
  private lastError: string | undefined
  private disposed = false

  constructor(
    private readonly ctx: DeviceContext,
    private readonly api: StreamingEncoderApi,
    private readonly settings: {
      platform: string | undefined
      server: string | undefined
      quality: string | undefined
    },
    private readonly now: () => number,
  ) {}

  async connect(): Promise<void> {
    // Proves the device is both reachable and speaking this API before the
    // host considers it connected.
    await this.api.livestream()
    this.connectedAt = this.now()
  }

  async probe(): Promise<DeviceCapabilities> {
    const product = await this.api.product()
    this.product = {
      productName: product.productName ?? 'Blackmagic encoder',
      softwareVersion: product.softwareVersion ?? '',
    }

    // The platform list is the device's real capability surface: which
    // services it knows, and crucially whether any of them will take a URL
    // we choose. Read once on connect rather than assumed from the model.
    this.platforms = []
    for (const name of await this.api.platforms()) {
      const config = await this.api.platform(name)
      if (config) this.platforms.push(config)
    }

    const features = ['streaming']
    if (this.customizablePlatform()) features.push('custom-url')
    if (this.platforms.some((p) => p.servers.some((s) => s.url.startsWith('srt')))) features.push('srt')
    features.push(`platforms:${this.platforms.length}`)

    return {
      model: this.product.productName,
      firmware: this.product.softwareVersion,
      features,
    }
  }

  async health(): Promise<HealthReport> {
    if (this.disposed) return { state: 'disconnected', since: this.connectedAt }
    try {
      const state = await this.api.livestream()
      this.lastError = undefined
      if (state.status === 'Interrupted') {
        // On air but broken: the operator needs to see this, and it is not
        // the same as unreachable.
        return { state: 'degraded', message: 'The livestream was interrupted.', since: this.connectedAt }
      }
      return { state: 'connected', since: this.connectedAt }
    } catch (error) {
      this.lastError = describe(error)
      return { state: 'disconnected', message: this.lastError, since: this.connectedAt }
    }
  }

  nodes(): NodeDefinition[] {
    const transports: ('rtmp' | 'rtmps' | 'srt')[] = ['rtmp', 'rtmps']
    if (this.platforms.some((p) => p.servers.some((s) => s.url.startsWith('srt')))) transports.push('srt')

    return [
      {
        id: 'stream',
        label: `${this.product.productName} output`,
        roles: ['source'],
        ports: [
          {
            id: 'out',
            direction: 'out',
            label: 'Stream output',
            transport: transports,
            // One hardware encoder, one destination. Fanning out needs a
            // relay, and the core's link negotiation says so at design time.
            maxLinks: 1,
            requiresCredential: 'stream-key',
          },
        ],
        supports: ['applyStreamTarget', 'startStreaming', 'stopStreaming'],
      },
    ]
  }

  actionsFor(nodeId: string): NodeActions | undefined {
    if (nodeId !== 'stream') return undefined
    return {
      applyStreamTarget: async ({ url, key, quality }) => {
        // A quality named by the event beats the one in device config: the
        // device setting is the house default, the event is the exception.
        await this.api.setActivePlatform(this.resolveTarget(url, key, quality))
      },
      startStreaming: async () => {
        const platform = await this.api.activePlatform()
        if (!platform?.key && !platform?.url) {
          throw new DeviceError('no-stream-target', 'The encoder has no streaming destination set.', {
            remediation: 'Push the ingest URL and key before starting the stream.',
          })
        }
        await this.api.start()
      },
      stopStreaming: async () => {
        await this.api.stop()
      },
      readState: async () => this.readState(),
    }
  }

  async readState(): Promise<NodeState> {
    const [state, platform] = await Promise.all([this.api.livestream(), this.api.activePlatform()])
    // Profiles are per platform, so the choices only mean anything once one
    // is active. The device names them; we never invent one.
    const choices = platform ? await this.profileNames(platform.platform) : []

    return {
      ...(choices.length === 0
        ? {}
        : {
            options: {
              quality: { ...(platform?.quality ? { current: platform.quality } : {}), choices },
            },
          }),
      streaming: {
        // "Flushing" means the stop took effect and the on-device cache is
        // draining, so it counts as stopped: a stop that has been accepted
        // should verify immediately rather than waiting out the cache.
        active: ACTIVE_STATUSES.has(state.status),
        ...(platform === undefined ? {} : { targetUrl: this.urlOf(platform) }),
        ...(platform?.key ? { keyFingerprint: fingerprint(platform.key) } : {}),
        bitrateBps: state.bitrate,
        ...(state.duration === undefined ? {} : { durationMs: state.duration * 1000 }),
      },
      raw: {
        status: state.status,
        effectiveVideoFormat: state.effectiveVideoFormat,
        ...(state.cache === undefined ? {} : { cachePercent: state.cache }),
        ...(platform === undefined ? {} : { platform: platform.platform, server: platform.server }),
      },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  /** The quality profiles the named platform offers, straight off the box. */
  private async profileNames(platform: string): Promise<string[]> {
    try {
      const config = await this.api.platform(platform)
      return config?.profiles.map((profile) => profile.profile) ?? []
    } catch {
      // Reading the options must never break reading the state.
      return []
    }
  }

  /**
   * Turns a URL and key into the platform/server/quality triple the device
   * wants.
   *
   * Preferred path: a platform whose URL is customizable, which lets a
   * scheduled event point the encoder anywhere — at the ingest YouTube
   * issued this morning, for instance. Failing that, a platform whose own
   * server already points at the requested URL, where only the key changes.
   */
  private resolveTarget(url: string, key: string, quality?: string): ActivePlatform {
    const named = this.settings.platform
      ? this.platforms.find((p) => p.platform === this.settings.platform)
      : undefined

    if (this.settings.platform && !named) {
      throw new DeviceError('unknown-platform', `This encoder has no platform called "${this.settings.platform}".`, {
        remediation: `It offers: ${this.platforms.map((p) => p.platform).join(', ') || 'nothing'}.`,
      })
    }

    // A named platform that already points where we want: set the key only.
    if (named) {
      const server = this.serverFor(named, url)
      if (server) {
        return {
          platform: named.platform,
          server: server.server,
          quality: this.qualityFor(named, quality),
          key,
        }
      }
      if (named.customizableUrlEnabled) {
        return { platform: named.platform, server: 'Custom', quality: this.qualityFor(named, quality), key, url }
      }
      throw new DeviceError(
        'url-not-available',
        `The platform "${named.platform}" does not stream to ${url} and will not take a custom URL.`,
        {
          remediation:
            'Choose a platform whose URL can be customized, or leave the platform blank to let the ' +
            'scheduler pick one.',
        },
      )
    }

    const customizable = this.customizablePlatform()
    if (customizable) {
      return {
        platform: customizable.platform,
        server: 'Custom',
        quality: this.qualityFor(customizable, quality),
        key,
        url,
      }
    }

    // Falling back to uploading a custom platform XML would be the next
    // option, but the XML schema is in a different document and guessing it
    // would produce a file the encoder silently refuses. Say so instead.
    const matched = this.platforms
      .map((p) => ({ platform: p, server: this.serverFor(p, url) }))
      .find((candidate) => candidate.server)
    if (matched?.server) {
      return {
        platform: matched.platform.platform,
        server: matched.server.server,
        quality: this.qualityFor(matched.platform),
        key,
      }
    }

    throw new DeviceError('no-usable-platform', `This encoder cannot be pointed at ${url}.`, {
      remediation:
        'None of its platforms allow a custom URL or already target that address. Add a custom platform ' +
        'on the encoder, then name it in this device\'s settings.',
    })
  }

  private customizablePlatform(): PlatformConfig | undefined {
    return this.platforms.find((platform) => platform.customizableUrlEnabled === true)
  }

  private serverFor(platform: PlatformConfig, url: string): { server: string; url: string } | undefined {
    return platform.servers.find((server) => sameEndpoint(server.url, url))
  }

  private qualityFor(platform: PlatformConfig, requested?: string): string {
    if (requested) {
      const known = platform.profiles.some((profile) => profile.profile === requested)
      if (!known) {
        throw new DeviceError(
          'unknown-quality',
          `"${platform.platform}" has no quality profile called "${requested}".`,
          {
            remediation: `It offers ${platform.profiles.map((p) => p.profile).join(', ') || 'none'}.`,
          },
        )
      }
      return requested
    }
    if (this.settings.quality) return this.settings.quality
    if (platform.defaultProfile) return platform.defaultProfile
    const first = platform.profiles[0]?.profile
    if (first) return first
    throw new DeviceError('no-quality', `The platform "${platform.platform}" offers no quality profiles.`)
  }

  /** The destination, whether the device volunteered it or we know it. */
  private urlOf(active: ActivePlatform): string {
    if (active.url) return active.url
    const platform = this.platforms.find((p) => p.platform === active.platform)
    return platform?.servers.find((s) => s.server === active.server)?.url ?? ''
  }
}

/**
 * Compares ingest addresses tolerantly.
 *
 * Services publish the same endpoint with and without a trailing slash, and
 * a device's preset may differ from the URL a service hands out by exactly
 * that. Treating them as different would send a run down the "cannot point
 * the encoder there" path for no reason.
 */
function sameEndpoint(a: string, b: string): boolean {
  return normalise(a) === normalise(b)
}

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface StreamingEncoderOptions {
  now?: () => number
  timeoutMs?: number
}

export function streamingEncoderPlugin(options: StreamingEncoderOptions = {}): PluginDefinition {
  const now = options.now ?? Date.now

  return {
    id: 'streaming-encoder',
    displayName: 'Blackmagic Streaming Encoder / Web Presenter',
    apiVersion: SDK_API_VERSION,
    configSchema,
    async createDevice(ctx: DeviceContext): Promise<DeviceInstance> {
      const host = String(ctx.config.host ?? '')
      if (!host) throw new DeviceError('no-host', 'This encoder has no address configured.')
      const port = typeof ctx.config.port === 'number' ? ctx.config.port : 80
      const baseUrl = `http://${host}${port === 80 ? '' : `:${port}`}`

      const device = new StreamingEncoderDevice(
        ctx,
        new StreamingEncoderApi(baseUrl, options.timeoutMs ?? 5_000),
        {
          platform: stringOrUndefined(ctx.config.platform),
          server: stringOrUndefined(ctx.config.server),
          quality: stringOrUndefined(ctx.config.quality),
        },
        now,
      )
      await device.connect()

      return defineDevice({
        probe: () => device.probe(),
        health: () => device.health(),
        listNodes: async () => device.nodes(),
        actionsFor: (nodeId) => device.actionsFor(nodeId),
        dispose: () => device.dispose(),
      })
    },
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export * from './api.js'
