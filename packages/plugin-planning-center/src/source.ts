import { SDK_API_VERSION } from '@scheduler/plugin-sdk'
import type { PlanGroup, PlannedService, PlanSource, PlanSourceStatus } from '@scheduler/plugin-sdk'
import {
  CredentialRejectedError,
  PlanningCenterApi,
  RateLimitedError,
  type Credentials,
  type Fetch,
} from './api.js'

export interface PlanningCenterOptions {
  /**
   * Reads the stored token, or undefined when none is saved.
   *
   * Injected rather than read here for the same reason the destination
   * providers do it: a plugin never touches the database or the vault, it
   * asks and is given.
   */
  resolveCredentials: () => Promise<Credentials | undefined>
  fetchImpl?: Fetch
}

/**
 * Planning Center Services as a plan source.
 *
 * Deliberately thin. Everything about *what the schedule means* — which
 * occurrence a service becomes, what happens when a plan disappears — is the
 * scheduler's business and lives in core. This only answers "what has been
 * published", which is the only question Planning Center can answer.
 */
export function planningCenterSource(options: PlanningCenterOptions): PlanSource {
  const api = async (): Promise<PlanningCenterApi | undefined> => {
    const credentials = await options.resolveCredentials()
    if (!credentials?.applicationId || !credentials.secret) return undefined
    return new PlanningCenterApi(credentials, options.fetchImpl)
  }

  const required = async (): Promise<PlanningCenterApi> => {
    const client = await api()
    if (!client) {
      throw new Error('No Planning Center token is saved. Add one on the Services screen.')
    }
    return client
  }

  return {
    id: 'planning-center',
    displayName: 'Planning Center',
    apiVersion: SDK_API_VERSION,

    async isConfigured(): Promise<boolean> {
      return (await api()) !== undefined
    },

    async check(): Promise<PlanSourceStatus> {
      const client = await api()
      if (!client) return { state: 'not_configured' }
      try {
        const types = await client.serviceTypes()
        return {
          state: 'ok',
          // What the token can actually see, which is the useful answer:
          // a token belonging to a volunteer with one service type looks
          // identical to a broken one until you say this.
          message: `${types.length} service type${types.length === 1 ? '' : 's'} visible.`,
        }
      } catch (error) {
        if (error instanceof CredentialRejectedError) {
          return { state: 'credentials_rejected', message: error.remediation }
        }
        if (error instanceof RateLimitedError) {
          return {
            state: 'error',
            message: 'Planning Center asked us to slow down. Try again shortly.',
          }
        }
        return { state: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    },

    async listGroups(): Promise<PlanGroup[]> {
      return (await required()).serviceTypes()
    },

    async listServices(groupId: string): Promise<PlannedService[]> {
      const times = await (await required()).serviceTimes(groupId)
      return times.map(({ plan, time }) => ({
        externalId: time.id,
        startsAt: time.startsAt,
        ...(time.endsAt === undefined ? {} : { endsAt: time.endsAt }),
        detail: {
          ...(plan.title === undefined ? {} : { planTitle: plan.title }),
          ...(plan.seriesTitle === undefined ? {} : { seriesTitle: plan.seriesTitle }),
          ...(time.name === undefined ? {} : { timeName: time.name }),
          ...(plan.dates === undefined ? {} : { planDate: plan.dates }),
          ...(plan.url === undefined ? {} : { planUrl: plan.url }),
        },
      }))
    },
  }
}
