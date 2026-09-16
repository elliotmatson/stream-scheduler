import type { Fetch } from './api.js'

/**
 * Planning Center at the HTTP round trip.
 *
 * The seam is the point. Faking `PlanningCenterApi` would leave the basic
 * auth header, the JSON:API envelope and the plan → plan_times relationship
 * untested — and those are exactly what an integration gets wrong, because
 * each one looks fine until it meets a real account. Faking the fetch means
 * all of it is the adapter's real code under test.
 *
 * It enforces Planning Center's rules rather than agreeing with whatever the
 * adapter sends: a wrong secret is a 401, a missing User-Agent is a 400, and
 * an unknown service type is a 404.
 */

export interface FakePlan {
  id: string
  title?: string
  seriesTitle?: string
  dates?: string
  times: {
    id: string
    startsAt: string
    endsAt?: string
    timeType?: string
    name?: string
  }[]
}

export class FakePlanningCenter {
  applicationId = 'app-id'
  secret = 'app-secret'

  /**
   * Service types, some of them in folders.
   *
   * `parentId` is expressed as a JSON:API relationship below, and
   * `parentAsAttribute` switches it to a plain `parent_id` attribute —
   * because which of those Planning Center actually uses is documented
   * rather than guessable, and the adapter has to survive either.
   */
  serviceTypes: { id: string; name: string; parentId?: string }[] = [
    { id: '1024', name: 'Sunday Morning', parentId: 'f-sunday' },
    { id: '4096', name: 'Sunday Evening', parentId: 'f-sunday' },
    { id: '8192', name: 'Students', parentId: 'f-midweek-youth' },
    { id: '2048', name: 'Midweek' },
  ]

  folders: { id: string; name: string; parentId?: string }[] = [
    { id: 'f-sunday', name: 'Sunday' },
    { id: 'f-midweek', name: 'Midweek' },
    { id: 'f-midweek-youth', name: 'Youth', parentId: 'f-midweek' },
  ]

  /** Spell the parent link as an attribute rather than a relationship. */
  parentAsAttribute = false
  /** Make the folders endpoint fail, leaving only the service types. */
  foldersFail = false

  /** Plans by service type id. */
  plans = new Map<string, FakePlan[]>([
    [
      '1024',
      [
        {
          id: 'plan-1',
          title: 'The Weight of Glory',
          seriesTitle: 'Romans',
          dates: 'September 20, 2026',
          times: [
            {
              id: 'time-1',
              startsAt: '2026-09-20T14:00:00Z',
              endsAt: '2026-09-20T15:15:00Z',
              name: '9:00 Service',
            },
            {
              id: 'time-2',
              startsAt: '2026-09-20T16:00:00Z',
              endsAt: '2026-09-20T17:15:00Z',
              name: '11:00 Service',
            },
            // The trap: a rehearsal sitting in the same plan. Broadcasting
            // this would be a memorable Saturday.
            {
              id: 'time-3',
              startsAt: '2026-09-19T15:00:00Z',
              timeType: 'rehearsal',
              name: 'Rehearsal',
            },
          ],
        },
      ],
    ],
  ])

  readonly calls: { method: string; url: string; auth?: string; userAgent?: string }[] = []
  /** Set to make the next request answer 429. */
  rateLimitNext: { retryAfter?: string } | undefined

  readonly fetch: Fetch = async (url, init) => {
    const headers = init?.headers ?? {}
    this.calls.push({
      method: init?.method ?? 'GET',
      url,
      ...(headers['authorization'] === undefined ? {} : { auth: headers['authorization'] }),
      ...(headers['user-agent'] === undefined ? {} : { userAgent: headers['user-agent'] }),
    })

    // Planning Center asks every caller to identify itself, and answers
    // badly when they do not. Enforced so we cannot quietly stop sending it.
    if (!headers['user-agent']) {
      return json(400, { errors: [{ detail: 'A User-Agent header is required.' }] })
    }

    const expected = `Basic ${Buffer.from(`${this.applicationId}:${this.secret}`).toString('base64')}`
    if (headers['authorization'] !== expected) {
      return json(401, { errors: [{ detail: 'Not authorized.' }] })
    }

    if (this.rateLimitNext) {
      const { retryAfter } = this.rateLimitNext
      this.rateLimitNext = undefined
      return {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? (retryAfter ?? null) : null) },
        text: async () => JSON.stringify({ errors: [{ detail: 'Rate limit exceeded.' }] }),
      }
    }

    const parsed = new URL(url)
    const path = parsed.pathname.replace('/services/v2', '')

    if (path === '/service_types') {
      return json(200, {
        data: this.page(parsed, this.serviceTypes).map((type) => ({
          type: 'ServiceType',
          id: type.id,
          ...this.parent(type.parentId, 'Folder', { name: type.name }),
        })),
      })
    }

    if (path === '/folders') {
      if (this.foldersFail) return json(500, { errors: [{ detail: 'Folders are having a day.' }] })
      return json(200, {
        data: this.page(parsed, this.folders).map((folder) => ({
          type: 'Folder',
          id: folder.id,
          ...this.parent(folder.parentId, 'Folder', { name: folder.name }),
        })),
      })
    }

    const plansMatch = /^\/service_types\/([^/]+)\/plans$/.exec(path)
    if (plansMatch) {
      const plans = this.plans.get(decodeURIComponent(plansMatch[1]!))
      if (!plans) return json(404, { errors: [{ detail: 'Resource not found.' }] })
      return json(200, {
        data: plans.map((plan) => ({
          type: 'Plan',
          id: plan.id,
          attributes: {
            title: plan.title ?? '',
            series_title: plan.seriesTitle ?? '',
            dates: plan.dates ?? '',
            planning_center_url: `https://services.planningcenteronline.com/plans/${plan.id}`,
          },
        })),
      })
    }

    const timesMatch = /^\/service_types\/([^/]+)\/plans\/([^/]+)\/plan_times$/.exec(path)
    if (timesMatch) {
      const plans = this.plans.get(decodeURIComponent(timesMatch[1]!)) ?? []
      const plan = plans.find((entry) => entry.id === decodeURIComponent(timesMatch[2]!))
      if (!plan) return json(404, { errors: [{ detail: 'Resource not found.' }] })
      return json(200, {
        data: plan.times.map((time) => ({
          type: 'PlanTime',
          id: time.id,
          attributes: {
            starts_at: time.startsAt,
            ends_at: time.endsAt ?? null,
            time_type: time.timeType ?? 'service',
            name: time.name ?? null,
          },
        })),
      })
    }

    return json(404, { errors: [{ detail: `no route ${path}` }] })
  }

  /** One page of a list, the way Planning Center pages. */
  private page<T>(url: URL, all: T[]): T[] {
    const perPage = Number(url.searchParams.get('per_page') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    return all.slice(offset, offset + (Number.isFinite(perPage) ? perPage : 100))
  }

  /** The parent link, spelled whichever way this fake is set to. */
  private parent(
    parentId: string | undefined,
    type: string,
    attributes: Record<string, unknown>,
  ): Record<string, unknown> {
    if (parentId === undefined) return { attributes }
    if (this.parentAsAttribute) return { attributes: { ...attributes, parent_id: parentId } }
    return { attributes, relationships: { parent: { data: { type, id: parentId } } } }
  }
}

function json(status: number, body: unknown): ReturnType<Fetch> {
  return Promise.resolve({
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  })
}
