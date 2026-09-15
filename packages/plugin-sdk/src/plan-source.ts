/**
 * A place that already knows when the services are.
 *
 * The third kind of extension, beside a device plugin and a destination
 * provider, and it exists because of one fact about churches: **the number
 * of services is not fixed.** A normal Sunday has a 9:00 and an 11:00;
 * Christmas Eve is a single 4:00; Easter is three. A recurrence rule cannot
 * express that, because shifting a time can never add or remove a service.
 *
 * So a plan source does not adjust a schedule — it *is* the schedule, for
 * any series paired with one. Planning Center is the first implementation;
 * the contract is deliberately narrow enough that another church management
 * system is a package rather than a rewrite.
 */

/** A group of services somebody would pair a series with: a Planning Center
 *  Service Type, and whatever the equivalent is elsewhere. */
export interface PlanGroup {
  id: string
  name: string
}

/**
 * One service that is actually going to happen, at a time somebody has
 * published.
 *
 * `externalId` is the source's own identifier for this *time*, not for the
 * day or the plan — two services on one Sunday are two of these, and the
 * scheduler matches them across syncs by this id. A source that reuses ids
 * between services would silently merge them.
 */
export interface PlannedService {
  externalId: string
  /** Epoch ms. A real instant, so a moved service needs no timezone. */
  startsAt: number
  /** Epoch ms. Absent where the source has no end time, in which case the
   *  series' own duration is used. */
  endsAt?: number
  /** What a name template can reach. Every field optional: a source that
   *  cannot supply one must leave it out rather than invent it. */
  detail?: PlannedServiceDetail
}

export interface PlannedServiceDetail {
  /** The sermon or plan title. */
  planTitle?: string
  /** The teaching series the plan belongs to. */
  seriesTitle?: string
  /** What this particular time is called — "9:00 Service", "Español". */
  timeName?: string
  /** The source's human date string for the plan. */
  planDate?: string
  /** A link back to the plan, for a description or a notification. */
  planUrl?: string
}

export interface PlanSource {
  id: string
  displayName: string
  apiVersion: '1'
  /**
   * Whether credentials are stored and usable.
   *
   * Asked before anything else so the UI can tell "not set up yet" from
   * "set up and failing", which are different problems with different fixes.
   */
  isConfigured(): Promise<boolean>
  /** Proves the stored credentials work, for a "Test connection" button. */
  check(): Promise<PlanSourceStatus>
  /** The groups available to pair with, for the dropdown. */
  listGroups(): Promise<PlanGroup[]>
  /** Upcoming services in one group, soonest first. */
  listServices(groupId: string): Promise<PlannedService[]>
}

export interface PlanSourceStatus {
  state: 'ok' | 'not_configured' | 'credentials_rejected' | 'error'
  message?: string
  /** Who the credentials belong to, where the source can say. */
  account?: string
}
