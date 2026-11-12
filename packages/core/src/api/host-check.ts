import { isIP } from 'node:net'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Refuses requests addressed to a name this app does not answer to.
 *
 * The defence against DNS rebinding: a web page on somebody else's domain
 * points that domain at 127.0.0.1, and the browser then lets it read
 * whatever this app returns, because to the browser it is the same site.
 * The only thing that gives it away is the `Host` header, which still
 * carries the attacker's name. An install with no password — the desktop
 * app's default — is otherwise open to any page its user visits.
 *
 * Always allowed: loopback names and bare IP addresses, which DNS cannot
 * rebind. Beyond those, the names in `allowedHosts`, which include the
 * public URL when one is configured. Enforced only once some name has been
 * given — by the desktop app for itself, or by whoever set the public URL
 * or SCHEDULER_ALLOWED_HOSTS. Without one there is no telling a proxy's
 * name (Tailscale Serve, cloudflared) from an attacker's, and refusing
 * both would lock out every install behind a proxy on upgrade.
 */
export function registerHostCheck(
  fastify: FastifyInstance,
  options: { allowedHosts: string[] },
): void {
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()))
  const enforce = allowed.size > 0

  fastify.addHook('onRequest', async (request, reply) => {
    const host = hostnameOf(request.headers.host)
    if (enforce && !isTrustedName(host, allowed)) {
      await reply.code(421).send({ error: 'This app does not answer to that name.' })
      return
    }
    // The live socket is read across origins by any page that can reach
    // it — browsers do not apply the same-origin rule to WebSockets. A
    // socket opened by a page from anywhere but this app is refused.
    if (isSocket(request) && !sameSiteSocket(request)) {
      await reply.code(403).send({ error: 'Cross-site sockets are not accepted.' })
    }
  })
}

function isTrustedName(host: string | undefined, allowed: Set<string>): boolean {
  if (host === undefined) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host) !== 0) return true
  return allowed.has(host)
}

function isSocket(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === 'websocket'
}

function sameSiteSocket(request: FastifyRequest): boolean {
  const origin = request.headers.origin
  // Not a browser: a script or a test, which a rebinding page cannot be.
  if (origin === undefined) return true
  try {
    return hostnameOf(new URL(origin).host) === hostnameOf(request.headers.host)
  } catch {
    return false
  }
}

/** The name in a Host header, without its port or IPv6 brackets. */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'))
  const colon = trimmed.lastIndexOf(':')
  return colon > -1 && trimmed.indexOf(':') === colon ? trimmed.slice(0, colon) : trimmed
}
