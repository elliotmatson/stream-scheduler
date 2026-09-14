import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import {
  API_PREFIX,
  type ActivePlatform,
  type LivestreamStatus,
  type PlatformConfig,
} from './api.js'

/**
 * A Streaming Encoder, implemented from the REST API document and served
 * over a real HTTP socket.
 *
 * Tests hit it with the adapter's own `fetch`, so paths, verbs, status codes
 * and JSON shapes are all exercised rather than mocked. What it cannot prove
 * is that the document matches the firmware — only real hardware does that.
 */

export interface FakeOptions {
  /** Answer 501 to /system/product, as the document says some devices do. */
  productUnimplemented?: boolean
  /** Drop the platform that accepts an arbitrary URL. */
  noCustomizablePlatform?: boolean
  /** Fail every request with this status, for the unreachable/error paths. */
  failWith?: number
}

export class FakeStreamingEncoder {
  readonly requests: string[] = []
  options: FakeOptions

  status: LivestreamStatus = 'Idle'
  bitrate = 0
  duration: number | undefined
  cache = 0
  active: ActivePlatform | undefined

  platforms: PlatformConfig[] = [
    {
      platform: 'YouTube',
      servers: [
        { server: 'Primary', url: 'rtmp://a.rtmp.youtube.com/live2', group: 'Primary' },
        { server: 'Backup', url: 'rtmp://b.rtmp.youtube.com/live2?backup=1', group: 'Backup' },
      ],
      profiles: [
        {
          profile: 'Streaming High',
          lowLatency: false,
          configs: [{ resolution: '1080p', fps: '30', bitrate: 9_000_000 }],
        },
        {
          profile: 'Streaming Medium',
          lowLatency: false,
          configs: [{ resolution: '720p', fps: '30', bitrate: 4_500_000 }],
        },
      ],
      defaultProfile: 'Streaming High',
      customizableUrlEnabled: false,
    },
    {
      platform: 'Custom RTMP',
      servers: [{ server: 'Custom', url: '' }],
      profiles: [
        {
          profile: 'Streaming High',
          lowLatency: false,
          configs: [{ resolution: '1080p', fps: '30', bitrate: 9_000_000 }],
        },
      ],
      defaultProfile: 'Streaming High',
      customizableUrlEnabled: true,
    },
  ]

  private server: Server | undefined
  private port = 0

  constructor(options: FakeOptions = {}) {
    this.options = options
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get host(): string {
    return '127.0.0.1'
  }

  get boundPort(): number {
    return this.port
  }

  async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length)
        : url.pathname
      this.requests.push(`${request.method} ${path}`)

      if (this.options.failWith) {
        response.writeHead(this.options.failWith).end('simulated failure')
        return
      }

      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body =
          chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown) : undefined
        this.route(request.method ?? 'GET', path, body, response)
      })
    })

    await new Promise<void>((resolve) => {
      // Port 0: the OS picks a free one, so tests never collide.
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  private route(method: string, path: string, body: unknown, response: ServerResponse): void {
    const json = (status: number, value?: unknown): void => {
      if (value === undefined) {
        response.writeHead(status).end()
        return
      }
      const payload = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json' }).end(payload)
    }

    if (method === 'GET' && path === '/system/product') {
      if (this.options.productUnimplemented) return json(501)
      return json(200, {
        deviceName: 'Sanctuary',
        productName: 'Blackmagic Streaming Encoder HD',
        softwareVersion: '3.4',
      })
    }

    if (method === 'GET' && path === '/livestreams/0') {
      return json(200, {
        status: this.status,
        bitrate: this.bitrate,
        effectiveVideoFormat: '1920x1080p30',
        ...(this.duration === undefined ? {} : { duration: this.duration }),
        cache: this.cache,
      })
    }

    if (method === 'GET' && path === '/livestreams/0/activePlatform') {
      return this.active ? json(200, this.active) : json(404)
    }

    if (method === 'PUT' && path === '/livestreams/0/activePlatform') {
      const wanted = body as ActivePlatform
      const platform = this.visiblePlatforms().find((p) => p.platform === wanted?.platform)
      if (!platform) return json(400, { error: 'unknown platform' })

      const knownServer = platform.servers.some((s) => s.server === wanted.server)
      const custom = platform.customizableUrlEnabled === true && wanted.server === 'Custom'
      if (!knownServer && !custom) return json(400, { error: 'unknown server' })
      if (!platform.profiles.some((p) => p.profile === wanted.quality)) {
        return json(400, { error: 'unknown quality' })
      }

      this.active = { ...wanted }
      return json(204)
    }

    if (method === 'PUT' && path === '/livestreams/0/start') {
      if (!this.active) return json(400, { error: 'no platform' })
      this.status = 'Streaming'
      this.bitrate = 6_000_000
      this.duration = 0
      return json(204)
    }

    if (method === 'PUT' && path === '/livestreams/0/stop') {
      // Real hardware drains its cache before going idle, and the adapter
      // must treat that as stopped rather than waiting it out.
      this.status = 'Flushing'
      this.bitrate = 0
      this.duration = undefined
      return json(204)
    }

    if (method === 'GET' && path === '/livestreams/platforms') {
      return json(
        200,
        this.visiblePlatforms().map((p) => p.platform),
      )
    }

    if (method === 'GET' && path.startsWith('/livestreams/platforms/')) {
      const name = decodeURIComponent(path.slice('/livestreams/platforms/'.length))
      const platform = this.visiblePlatforms().find((p) => p.platform === name)
      return platform ? json(200, platform) : json(404)
    }

    if (method === 'GET' && path === '/system/videoFormat') {
      return json(200, {
        name: '1920x1080p30',
        width: 1920,
        height: 1080,
        frameRate: '30',
        interlaced: false,
      })
    }

    json(404, { error: `the fake does not implement ${method} ${path}` })
  }

  private visiblePlatforms(): PlatformConfig[] {
    return this.options.noCustomizablePlatform
      ? this.platforms.filter((p) => p.customizableUrlEnabled !== true)
      : this.platforms
  }
}
