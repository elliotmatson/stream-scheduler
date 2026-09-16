/**
 * Planning Center Services, as much of it as a schedule needs.
 *
 * Two facts shape this client.
 *
 * **It authenticates with a Personal Access Token, not OAuth.** Planning
 * Center issues a token pair you paste in, used as HTTP basic auth. That is
 * a deliberate choice rather than a shortcut: the alternative is every
 * church registering its own PCO application before anything works, and the
 * thing being read here is the church's own plans, by somebody who already
 * has an account. Two fields beats a seven-step setup nobody finishes.
 *
 * **The interesting data is one level down from the plan.** A plan is a
 * Sunday; the times it actually runs at are its `plan_times`, and there can
 * be one, two or five of them. That relationship is why this reads plans and
 * then their times rather than a single flat list — see `serviceTimes`.
 */

export const BASE = 'https://api.planningcenteronline.com/services/v2'

/**
 * Pinned, because Planning Center dates its API and an unpinned client gets
 * whatever is current — which is how an integration breaks on a morning
 * nobody deployed anything.
 */
export const API_VERSION = '2018-11-01'

/** Planning Center asks every caller to identify itself. */
export const USER_AGENT = 'stream-scheduler (https://github.com/elliotmatson/stream-scheduler)'

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  text(): Promise<string>
}>

export class PlanningCenterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PlanningCenterError'
  }
}

/**
 * The token is wrong, revoked, or belongs to a deactivated user.
 *
 * Separate from every other failure because the fix is different and
 * specific: nothing retries its way out of this, somebody has to paste a new
 * token.
 */
export class CredentialRejectedError extends PlanningCenterError {
  readonly remediation =
    'Check the application ID and secret, and that the Planning Center user they belong to is still ' +
    'active and can see this service type. Tokens are made at ' +
    'api.planningcenteronline.com/personal_access_tokens.'

  constructor(status: number) {
    super(status, 'Planning Center rejected these credentials.')
    this.name = 'CredentialRejectedError'
  }
}

/** Planning Center asked us to slow down. Clears on its own. */
export class RateLimitedError extends PlanningCenterError {
  constructor(readonly retryAfterMs: number) {
    super(429, 'Planning Center asked us to slow down.')
    this.name = 'RateLimitedError'
  }
}

export interface Credentials {
  /** The "Application ID" half of a Personal Access Token. */
  applicationId: string
  secret: string
}

export interface ServiceType {
  id: string
  name: string
  /**
   * The folder this service type sits in, where it sits in one.
   *
   * Churches with more than a handful organise them — "Sunday / Main
   * Auditorium", "Sunday / Chapel", "Midweek / Students" — and a flat list
   * of thirty names with three called "9:00" is not a list anybody can pick
   * from correctly.
   */
  folderId: string | undefined
}

/** A folder of service types. Folders nest, so this carries its own parent. */
export interface Folder {
  id: string
  name: string
  parentId: string | undefined
}

/**
 * One time a plan actually runs at.
 *
 * `timeType` matters more than it looks: a plan carries rehearsals and
 * "other" times beside the services, and treating a Thursday rehearsal as
 * something to broadcast would be a memorable failure.
 */
export interface PlanTime {
  id: string
  /** Epoch ms. */
  startsAt: number
  /** Epoch ms, or undefined when Planning Center has no end time. */
  endsAt: number | undefined
  timeType: string
  /** What it is called in Planning Center — "9:00 Service", "Español". */
  name: string | undefined
}

export interface Plan {
  id: string
  /** The sermon or plan title. Often empty; Planning Center allows it. */
  title: string | undefined
  /** The teaching series this plan belongs to. */
  seriesTitle: string | undefined
  /** Planning Center's own human date string, e.g. "September 20, 2026". */
  dates: string | undefined
  /** A link straight to the plan, for a description or a notification. */
  url: string | undefined
  times: PlanTime[]
}

/** A service time, flattened with the plan it came from. */
export interface ServiceTime {
  plan: Plan
  time: PlanTime
}

/** Planning Center's own name for a time that is a service. */
export const SERVICE_TIME_TYPE = 'service'

export class PlanningCenterApi {
  constructor(
    private readonly credentials: Credentials,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
  ) {}

  /** The service types this account can see, for the pairing dropdown. */
  async serviceTypes(): Promise<ServiceType[]> {
    const entries = await this.getAll('/service_types')
    return entries.map((entry) => ({
      id: entry.id,
      name: string(entry.attributes?.name) ?? 'Untitled',
      folderId: parentIdOf(entry),
    }))
  }

  /**
   * The folders service types are organised into.
   *
   * Fetched whole rather than per service type: a church has a few folders
   * and many service types, so one list beats a request each. They nest, so
   * the caller walks `parentId` to build a path.
   */
  async folders(): Promise<Folder[]> {
    const entries = await this.getAll('/folders')
    return entries.map((entry) => ({
      id: entry.id,
      name: string(entry.attributes?.name) ?? 'Untitled',
      parentId: parentIdOf(entry),
    }))
  }

  /**
   * Service types with the folder path they sit under.
   *
   * The path is names, outermost first, and empty for one at the top level.
   * Built here rather than in the UI because it is the source that knows
   * how its own things are organised.
   *
   * A folder listing that fails is not allowed to take the service types
   * with it: an unfoldered list is the behaviour this had before folders
   * were read at all, and it is far better than no list.
   */
  async serviceTypeTree(): Promise<(ServiceType & { path: string[] })[]> {
    const types = await this.serviceTypes()
    let folders: Folder[] = []
    try {
      folders = await this.folders()
    } catch {
      return types.map((type) => ({ ...type, path: [] }))
    }

    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    return types.map((type) => ({ ...type, path: pathOf(type.folderId, byId) }))
  }

  /**
   * Upcoming plans for one service type, with their times.
   *
   * Two round trips per plan rather than one for the lot: `plan_times` is a
   * child of a plan, and asking for each plan's times is the shape Planning
   * Center actually documents. A handful of plans is a handful of requests,
   * which is the right trade against guessing at an `include` that may not
   * be supported and failing on somebody else's account.
   */
  async upcomingPlans(serviceTypeId: string, limit = 25): Promise<Plan[]> {
    const path =
      `/service_types/${encodeURIComponent(serviceTypeId)}/plans` +
      `?filter=future&order=sort_date&per_page=${Math.max(1, Math.min(limit, 100))}`
    const body = await this.get(path)

    const plans: Plan[] = []
    for (const entry of resources(body)) {
      plans.push({
        id: entry.id,
        title: string(entry.attributes?.title),
        seriesTitle: string(entry.attributes?.series_title),
        dates: string(entry.attributes?.dates),
        url: string(entry.attributes?.planning_center_url),
        times: await this.planTimes(serviceTypeId, entry.id),
      })
    }
    return plans
  }

  /** The times one plan runs at, services and rehearsals alike. */
  async planTimes(serviceTypeId: string, planId: string): Promise<PlanTime[]> {
    const body = await this.get(
      `/service_types/${encodeURIComponent(serviceTypeId)}/plans/` +
        `${encodeURIComponent(planId)}/plan_times?per_page=100`,
    )

    const times: PlanTime[] = []
    for (const entry of resources(body)) {
      const startsAt = instant(entry.attributes?.starts_at)
      // A time with no start cannot schedule anything. Dropped rather than
      // carried as a zero, which would put a broadcast in 1970.
      if (startsAt === undefined) continue
      times.push({
        id: entry.id,
        startsAt,
        endsAt: instant(entry.attributes?.ends_at),
        timeType: string(entry.attributes?.time_type) ?? 'service',
        name: string(entry.attributes?.name),
      })
    }
    return times.sort((a, b) => a.startsAt - b.startsAt)
  }

  /**
   * Every upcoming *service* time, flattened and in order.
   *
   * The one call the scheduler actually wants: rehearsals and "other" times
   * filtered out, each remaining time paired with its plan so a template can
   * reach the sermon title.
   */
  async serviceTimes(serviceTypeId: string, limit?: number): Promise<ServiceTime[]> {
    const plans = await this.upcomingPlans(serviceTypeId, limit)
    return plans
      .flatMap((plan) => plan.times.map((time) => ({ plan, time })))
      .filter(({ time }) => time.timeType === SERVICE_TIME_TYPE)
      .sort((a, b) => a.time.startsAt - b.time.startsAt)
  }

  /**
   * Every page of a collection.
   *
   * Planning Center pages at 100, and a church with more service types than
   * that would silently lose the ones past the first page — which is the
   * kind of bug that only appears at the one place big enough to hit it.
   * The page count is bounded so a paging bug cannot spin forever.
   */
  private async getAll(path: string): Promise<Resource[]> {
    const out: Resource[] = []
    for (let offset = 0; offset < 2_000; offset += PAGE) {
      const join = path.includes('?') ? '&' : '?'
      const body = await this.get(`${path}${join}per_page=${PAGE}&offset=${offset}`)
      const page = resources(body)
      out.push(...page)
      if (page.length < PAGE) break
    }
    return out
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${BASE}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Basic ${basic(this.credentials)}`,
        'user-agent': USER_AGENT,
        'x-pco-api-version': API_VERSION,
        accept: 'application/json',
      },
    })

    if (response.status === 401 || response.status === 403) {
      throw new CredentialRejectedError(response.status)
    }
    if (response.status === 429) {
      throw new RateLimitedError(retryAfterMs(response.headers?.get('retry-after')))
    }

    const text = await response.text()
    if (!response.ok)
      throw new PlanningCenterError(response.status, describe(text, response.status))

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new PlanningCenterError(
        response.status,
        'Planning Center returned something unreadable.',
      )
    }
  }
}

/** Planning Center's own page size, and its maximum. */
const PAGE = 100

/**
 * The id of a resource's parent, however this endpoint spells it.
 *
 * Read two ways on purpose. JSON:API puts a link under `relationships`, and
 * Planning Center also exposes ids as plain attributes on some vertices;
 * which one a given endpoint uses is documented rather than guessable, and
 * the documentation is not reachable from here. Reading both costs nothing
 * and the wrong guess would silently flatten everybody's folders.
 */
function parentIdOf(entry: Resource): string | undefined {
  const link = entry.relationships?.parent
  const data = link && typeof link === 'object' ? (link as { data?: unknown }).data : undefined
  if (data && typeof data === 'object') {
    const id = (data as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
  }
  const attribute = entry.attributes?.parent_id
  if (typeof attribute === 'string' && attribute !== '') return attribute
  if (typeof attribute === 'number') return String(attribute)
  return undefined
}

/**
 * Folder names from the outside in.
 *
 * Guards against a cycle rather than trusting the data: a folder that is
 * somehow its own ancestor would otherwise hang the scheduler loop, and a
 * wrong path is a far smaller problem than a wedged tick.
 */
function pathOf(folderId: string | undefined, byId: Map<string, Folder>): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let current = folderId
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder = byId.get(current)
    if (!folder) break
    path.unshift(folder.name)
    current = folder.parentId
  }
  return path
}

/** HTTP basic, which is how a Personal Access Token is presented. */
export function basic(credentials: Credentials): string {
  return Buffer.from(`${credentials.applicationId}:${credentials.secret}`).toString('base64')
}

interface Resource {
  id: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, unknown>
}

/**
 * The `data` array of a JSON:API document.
 *
 * Forgiving on purpose: a shape this does not recognise yields no rows
 * rather than an exception, because the caller's useful answer to "Planning
 * Center sent something odd" is an empty list it can report, not a crash in
 * the scheduler loop.
 */
function resources(body: unknown): Resource[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []

  const out: Resource[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') continue
    const attributes = (entry as { attributes?: unknown }).attributes
    const relationships = (entry as { relationships?: unknown }).relationships
    out.push({
      id,
      ...(attributes && typeof attributes === 'object'
        ? { attributes: attributes as Record<string, unknown> }
        : {}),
      ...(relationships && typeof relationships === 'object'
        ? { relationships: relationships as Record<string, unknown> }
        : {}),
    })
  }
  return out
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * An ISO 8601 instant from Planning Center, as epoch ms.
 *
 * Planning Center sends UTC with an offset, so this is a real instant and
 * not a local time needing a zone — which is what makes a service moved to
 * 4pm on Christmas Eve land correctly without this code knowing anything
 * about the church's timezone.
 */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** `Retry-After` is seconds, and absent often enough to need a default. */
function retryAfterMs(header: string | null | undefined): number {
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return 20_000
  return Math.min(seconds, 300) * 1000
}

/** JSON:API puts the readable part in `errors[].detail`. */
function describe(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { errors?: { detail?: string; title?: string }[] }
    const first = body.errors?.[0]
    return first?.detail ?? first?.title ?? `Planning Center answered ${status}.`
  } catch {
    return `Planning Center answered ${status}.`
  }
}
