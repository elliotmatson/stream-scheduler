import type { FastifyInstance } from 'fastify'
import type { Application } from '../app.js'

/**
 * Connecting a schedule source, and reading what it offers.
 *
 * Deliberately smaller than the OAuth routes next door, because a Personal
 * Access Token needs no dance: two fields go in, and everything after that
 * is reading. There is no redirect, no callback, and nothing to expire.
 *
 * The secret is write-only across this boundary. It goes in, it is stored
 * encrypted, and no route hands it back — the UI shows whether a token is
 * saved and whether it works, never what it is.
 */
export function registerPlanRoutes(fastify: FastifyInstance, app: Application): void {
  /** Every source, whether it is set up, and whether it currently works. */
  fastify.get('/api/plan-sources', async () => {
    return { sources: await app.planSources.statuses() }
  })

  /** What to do in Planning Center before any of this will connect. */
  fastify.get('/api/plan-sources/:id/instructions', async (request) => {
    const { id } = request.params as { id: string }
    return instructionsFor(id)
  })

  fastify.put('/api/plan-sources/:id/credentials', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { applicationId?: string; secret?: string }

    const applicationId = (body.applicationId ?? '').trim()
    const secret = (body.secret ?? '').trim()
    if (!applicationId || !secret) {
      return reply.code(400).send({ error: 'Both the application ID and the secret are needed.' })
    }

    app.planSources.get(id)
    app.planSources.saveCredentials(id, { applicationId, secret })

    // Checked immediately rather than saved and left: a token that does not
    // work is worth knowing about now, while the person who made it is
    // still looking at the screen.
    const status = await app.planSources.get(id).check()
    app.logger.info('saved plan source credentials', { source: id, state: status.state })
    return { status }
  })

  fastify.delete('/api/plan-sources/:id/credentials', async (request) => {
    const { id } = request.params as { id: string }
    app.planSources.get(id)
    app.planSources.clearCredentials(id)
    app.logger.info('cleared plan source credentials', { source: id })
    return { ok: true }
  })

  /** The service types to pair a series with. */
  fastify.get('/api/plan-sources/:id/groups', async (request) => {
    const { id } = request.params as { id: string }
    return { groups: await app.planSources.get(id).listGroups() }
  })

  /**
   * What is actually scheduled in one group.
   *
   * Exposed on its own so somebody can see what the app can see before
   * pairing anything to it — which is the difference between trusting this
   * and hoping.
   */
  fastify.get('/api/plan-sources/:id/groups/:groupId/services', async (request) => {
    const { id, groupId } = request.params as { id: string; groupId: string }
    return { services: await app.planSources.get(id).listServices(groupId) }
  })
}

function instructionsFor(sourceId: string): { steps: string[]; warnings: string[] } {
  if (sourceId !== 'planning-center') return { steps: [], warnings: [] }
  return {
    steps: [
      'Sign in to Planning Center as somebody who can see the service types you want to schedule.',
      'Open api.planningcenteronline.com/personal_access_tokens.',
      'Create a token, describing what it is for — "Stream scheduler", say.',
      'Copy the Application ID and the Secret, and paste both here.',
    ],
    warnings: [
      // The one that looks fine for months and then is not.
      'The token carries that person’s permissions, so it stops working if their Planning Center ' +
        'account is deactivated. For something a church depends on every Sunday, make it from an ' +
        'account that will outlast whoever set this up.',
      'The secret is shown once, when you make it. This app stores it encrypted and never shows it ' +
        'again either — if you lose it, make a new token.',
    ],
  }
}
