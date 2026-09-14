import type { FastifyRequest } from 'fastify'

/**
 * The address a browser used to reach this app.
 *
 * Behind Tailscale Serve or any reverse proxy, the request this process sees
 * is plain HTTP to an internal name, so the forwarded headers are the only
 * record of what the person actually typed. Used for the OAuth callback,
 * which must match Google exactly, and for the links in alerts.
 */
export function originOf(request: FastifyRequest): string {
  // A chain of proxies appends to these; the first entry is the client's.
  const forwardedProto = header(request, 'x-forwarded-proto')?.split(',')[0]?.trim()
  const scheme = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http'
  const host = header(request, 'x-forwarded-host')?.split(',')[0]?.trim() || request.headers.host
  return `${scheme}://${host ?? '127.0.0.1:8500'}`
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
