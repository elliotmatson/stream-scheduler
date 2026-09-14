import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ConfigValues } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import { NOTIFICATION_EVENTS } from '../notify/types.js'

export function registerNotifyRoutes(fastify: FastifyInstance, app: Application): void {
  fastify.get('/api/notifications/kinds', async () =>
    app.notifier.kinds().map((kind) => ({
      kind: kind.kind,
      displayName: kind.displayName,
      configSchema: kind.configSchema,
    })),
  )

  fastify.get('/api/notifications/events', async () => NOTIFICATION_EVENTS)

  fastify.get('/api/notifications/channels', async () => ({
    channels: app.notifier.list(),
    // Surfaced so a quietly failing channel is visible before it matters.
    pending: app.notifier.pending(),
  }))

  fastify.post('/api/notifications/channels', async (request, reply) => {
    const body = z
      .object({
        kind: z.string().min(1),
        label: z.string().min(1),
        config: z.record(z.unknown()).default({}),
        events: z.array(z.enum(NOTIFICATION_EVENTS)).default([]),
      })
      .parse(request.body)

    const id = app.notifier.create({
      kind: body.kind,
      label: body.label,
      config: body.config as ConfigValues,
      events: body.events,
    })
    return reply.code(201).send({ id })
  })

  fastify.delete('/api/notifications/channels/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    app.notifier.remove(id)
    return { ok: true }
  })

  /**
   * Sends immediately rather than queueing, so the person clicking the
   * button finds out now whether the webhook URL is right.
   */
  fastify.post('/api/notifications/channels/:id/test', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    await app.notifier.test(id)
    return { ok: true }
  })

  /** Runs the checks for one occurrence on demand, without notifying. */
  fastify.get('/api/occurrences/:id/preflight', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    return app.preflight.check(id)
  })
}
