import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ConfigValues } from '@scheduler/plugin-sdk'
import type { Application } from '../app.js'
import { EVENT_SEVERITY, NOTIFICATION_EVENTS } from '../notify/types.js'

export function registerNotifyRoutes(fastify: FastifyInstance, app: Application): void {
  fastify.get('/api/notifications/kinds', async () =>
    app.notifier.kinds().map((kind) => ({
      kind: kind.kind,
      displayName: kind.displayName,
      configSchema: kind.configSchema,
    })),
  )

  /**
   * Every event, with how bad it is.
   *
   * The severity travels with the list rather than being a table the UI
   * keeps its own copy of: a new event kind should appear grouped
   * correctly without anybody remembering to edit the web package.
   */
  fastify.get('/api/notifications/events', async () =>
    NOTIFICATION_EVENTS.map((event) => ({ event, severity: EVENT_SEVERITY[event] })),
  )

  /** When the scheduler decides something is worth telling somebody about. */
  fastify.get('/api/notifications/settings', async () => app.thresholds.get())

  fastify.patch('/api/notifications/settings', async (request) => {
    const body = z
      .object({
        cacheWarningPercent: z.number().optional(),
        mediaWarningMinutes: z.number().optional(),
      })
      .parse(request.body)
    return app.thresholds.set(body)
  })

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

  fastify.patch('/api/notifications/channels/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z
      .object({
        label: z.string().min(1).optional(),
        config: z.record(z.unknown()).optional(),
        events: z.array(z.enum(NOTIFICATION_EVENTS)).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(request.body)

    app.notifier.update(id, {
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.config === undefined ? {} : { config: body.config as ConfigValues }),
      ...(body.events === undefined ? {} : { events: body.events }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    })
    return { ok: true }
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
