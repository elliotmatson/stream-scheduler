import type { Clock } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { DestinationRegistry } from '../destinations/registry.js'
import { silentLogger, type Logger } from '../log.js'
import { deviceFor } from '../events/outputs.js'
import { describeConflict, overlapsForSeries } from '../events/overlap.js'
import type { EventPlanner } from '../runs/event-planner.js'
import { timelineFor, type EventTimeline } from '../runs/timeline.js'
import { localDateAt } from '../schedule/zoned.js'
import type { Notifier } from './notifier.js'
import type { Notification } from './types.js'

/** How far ahead an event is checked. A Sunday 09:00 is checked Saturday afternoon. */
export const DEFAULT_PREFLIGHT_LEAD_MS = 18 * 3_600_000

export interface PreflightProblem {
  what: string
  detail: string
  remediation?: string
}

export interface PreflightResult {
  occurrenceId: string
  label: string
  scheduledStart: number
  timezone: string
  problems: PreflightProblem[]
}

export interface PreflightDeps {
  db: Db
  clock: Clock
  planner: EventPlanner
  connections: ConnectionManager
  destinations?: DestinationRegistry
  notifier: Notifier
  logger?: Logger
  leadMs?: number
  /** Also say so when everything is fine. Off by default: a weekly "all
   *  good" is read for a month and then ignored. */
  announceReady?: boolean
}

/**
 * Checks an event can actually run, while there is still time to fix it.
 *
 * Everything here is read-only and cheap. The point is not to catch every
 * possible failure — the prepare phase at T-30m does that — but to catch the
 * slow ones a human needs notice of: an expired YouTube authorization, an
 * encoder that has been unplugged since last week, a template someone broke
 * on Tuesday.
 */
export class PreflightChecker {
  private readonly logger: Logger

  constructor(private readonly deps: PreflightDeps) {
    this.logger = deps.logger ?? silentLogger
  }

  /** Checks anything entering the window. Called from the scheduler loop. */
  async run(): Promise<PreflightResult[]> {
    const now = this.deps.clock.now()
    const horizon = now + (this.deps.leadMs ?? DEFAULT_PREFLIGHT_LEAD_MS)

    const upcoming = this.deps.db
      .prepare(
        `SELECT o.id, o.scheduled_start, s.label, s.timezone
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
          WHERE o.status = 'pending' AND s.enabled = 1
            AND o.scheduled_start > ? AND o.scheduled_start <= ?
          ORDER BY o.scheduled_start`,
      )
      .all(now, horizon) as {
      id: string
      scheduled_start: number
      label: string
      timezone: string
    }[]

    const results: PreflightResult[] = []
    for (const row of upcoming) {
      const result = await this.check(row.id)
      results.push(result)

      // The dedupe key carries the occurrence, so each event is reported at
      // most once no matter how many times the tick revisits it.
      if (result.problems.length > 0) {
        this.deps.notifier.enqueue(problemNotification(result))
      } else if (this.deps.announceReady) {
        this.deps.notifier.enqueue(readyNotification(result))
      }
    }
    return results
  }

  /** Runs the checks for one occurrence, without notifying. */
  async check(occurrenceId: string): Promise<PreflightResult> {
    const row = this.deps.db
      .prepare(
        `SELECT o.scheduled_start, s.label, s.timezone
           FROM occurrence o JOIN event_series s ON s.id = o.series_id
          WHERE o.id = ?`,
      )
      .get(occurrenceId) as { scheduled_start: number; label: string; timezone: string } | undefined
    if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)

    const timeline = timelineFor(this.deps.db, occurrenceId)

    const problems: PreflightProblem[] = []
    problems.push(...this.checkTemplates(occurrenceId))
    problems.push(...this.checkOutputs(timeline))
    problems.push(...this.checkOverlaps(timeline))
    problems.push(...(await this.checkDevices(timeline)))
    problems.push(...(await this.checkDestinations(timeline)))
    problems.push(...this.checkPlan(occurrenceId, timeline))

    return {
      occurrenceId,
      label: row.label,
      scheduledStart: row.scheduled_start,
      timezone: row.timezone,
      problems,
    }
  }

  private checkTemplates(occurrenceId: string): PreflightProblem[] {
    try {
      this.deps.planner.previewNames(occurrenceId)
      return []
    } catch (error) {
      return [
        {
          what: 'Name templates',
          detail: describe(error),
          remediation:
            'Fix the template on the event; the preview on the Events screen shows what it renders to.',
        },
      ]
    }
  }

  /** Every output has to have hardware to run on, or it cannot air. */
  private checkOutputs(timeline: EventTimeline): PreflightProblem[] {
    if (timeline.outputs.length === 0) {
      return [
        {
          what: 'Outputs',
          detail: 'This event would do nothing: it has no enabled streams or recordings.',
          remediation: 'Add a stream or a recording to the event.',
        },
      ]
    }

    const problems: PreflightProblem[] = []
    for (const entry of timeline.outputs) {
      const output = entry.output
      if (!deviceFor(output)) {
        problems.push({
          what: output.label,
          detail: 'No device chosen: this output has nothing to run on.',
          remediation: 'Pick an encoder or a recorder for it on the event.',
        })
      }
      if (output.kind === 'stream' && !output.destinationId && !output.credentialId) {
        problems.push({
          what: output.label,
          detail: 'Nowhere to stream to: no streaming service and no stream key.',
          remediation: 'Pick a service or paste a stream key on this output.',
        })
      }
    }
    return problems
  }

  /**
   * One encoder cannot feed two services at once, and finding that out at
   * 09:00 is the whole problem. Reported here as well as at save time,
   * because the clash may have been introduced by editing a *different*
   * output since.
   */
  private checkOverlaps(timeline: EventTimeline): PreflightProblem[] {
    return overlapsForSeries(this.deps.db, timeline.seriesId).map((conflict) => ({
      what: 'Overlapping outputs',
      detail: describeConflict(conflict),
    }))
  }

  private async checkDevices(timeline: EventTimeline): Promise<PreflightProblem[]> {
    const problems: PreflightProblem[] = []
    const seen = new Set<string>()

    for (const entry of timeline.outputs) {
      const device = deviceFor(entry.output)
      if (!device) continue // already reported by checkOutputs
      const key = `${device.deviceId}/${device.nodeId}`
      if (seen.has(key)) continue
      seen.add(key)

      const label = this.deviceLabel(device.deviceId)
      try {
        const connection = await this.deps.connections.open(device.deviceId)
        const definition = connection.nodes.find((n) => n.id === device.nodeId)
        if (!definition) {
          problems.push({
            what: label,
            detail: `The device is reachable but does not offer "${device.nodeId}".`,
            remediation: 'The event points at a node this model does not have. Re-check the event.',
          })
        }
      } catch (error) {
        problems.push({
          what: label,
          detail: describe(error),
          ...(remediationOf(error) === undefined ? {} : { remediation: remediationOf(error)! }),
        })
      }
    }
    return problems
  }

  private async checkDestinations(timeline: EventTimeline): Promise<PreflightProblem[]> {
    const registry = this.deps.destinations
    if (!registry) return []

    const problems: PreflightProblem[] = []
    const seen = new Set<string>()
    for (const entry of timeline.outputs) {
      const destinationId = entry.output.destinationId
      if (!destinationId || seen.has(destinationId)) continue
      seen.add(destinationId)

      const label = this.destinationLabel(destinationId)
      try {
        const destination = await registry.open(destinationId)
        try {
          const status = await destination.status()
          if (status.state === 'reauth_required') {
            problems.push({
              what: label,
              detail: status.message ?? 'The stored authorization was rejected.',
              // The 7-day Testing expiry is the usual cause and is invisible
              // until it bites, so it gets named here too.
              remediation:
                'Reconnect the account. If it stopped working about a week after you set it up, the Google ' +
                'Cloud consent screen is probably still on "Testing".',
            })
          } else if (status.state === 'quota_exhausted') {
            problems.push({
              what: label,
              detail: 'The daily API budget is spent.',
              remediation:
                'It resets at midnight Pacific. If this keeps happening, request a higher quota.',
            })
          } else if (status.state === 'error') {
            problems.push({
              what: label,
              detail: status.message ?? 'The service reported a problem.',
            })
          } else if (status.quotaRemaining !== undefined && status.quotaRemaining < 500) {
            problems.push({
              what: label,
              detail: `Only ${status.quotaRemaining} API units left today.`,
              remediation:
                'Enough for one more event at most. The budget resets at midnight Pacific.',
            })
          }
        } finally {
          await destination.dispose()
        }
      } catch (error) {
        problems.push({
          what: label,
          detail: describe(error),
          ...(remediationOf(error) === undefined ? {} : { remediation: remediationOf(error)! }),
        })
      }
    }
    return problems
  }

  private checkPlan(occurrenceId: string, timeline: EventTimeline): PreflightProblem[] {
    // An event with nothing on it has already been reported, more
    // usefully, by checkOutputs. Reporting it twice turns one mistake into
    // two problems.
    if (timeline.outputs.length === 0) return []
    try {
      this.deps.planner.plan(occurrenceId)
      return []
    } catch (error) {
      return [{ what: 'Event', detail: describe(error) }]
    }
  }

  private deviceLabel(deviceId: string): string {
    const row = this.deps.db.prepare('SELECT label FROM device WHERE id = ?').get(deviceId) as
      { label: string } | undefined
    return row?.label ?? `Device ${deviceId}`
  }

  private destinationLabel(destinationId: string): string {
    const row = this.deps.db
      .prepare('SELECT label FROM destination WHERE id = ?')
      .get(destinationId) as { label: string } | undefined
    return row?.label ?? `Destination ${destinationId}`
  }
}

export function problemNotification(result: PreflightResult): Notification {
  const when = describeWhen(result.scheduledStart, result.timezone)
  const remediation = result.problems.find((problem) => problem.remediation)?.remediation

  return {
    event: 'preflight.problem',
    severity: 'warning',
    title: `${result.label} may not run`,
    summary:
      result.problems.length === 1
        ? `One problem was found ahead of ${when}.`
        : `${result.problems.length} problems were found ahead of ${when}.`,
    facts: [
      { label: 'Starts', value: when },
      ...result.problems.map((problem) => ({ label: problem.what, value: problem.detail })),
    ],
    ...(remediation === undefined ? {} : { remediation }),
    threadKey: `occurrence-${result.occurrenceId}`,
    dedupeKey: `preflight:${result.occurrenceId}:${fingerprintProblems(result)}`,
  }
}

export function readyNotification(result: PreflightResult): Notification {
  const when = describeWhen(result.scheduledStart, result.timezone)
  return {
    event: 'preflight.ready',
    severity: 'info',
    title: `${result.label} is ready`,
    summary: `Everything checked out for ${when}.`,
    facts: [{ label: 'Starts', value: when }],
    threadKey: `occurrence-${result.occurrenceId}`,
    dedupeKey: `preflight-ready:${result.occurrenceId}`,
  }
}

/**
 * Part of the dedupe key, so a *different* set of problems is reported again
 * while the same set stays quiet. Fixing one of three problems should tell
 * somebody there are still two.
 */
function fingerprintProblems(result: PreflightResult): string {
  return result.problems
    .map((problem) => problem.what)
    .sort()
    .join('|')
}

export function describeWhen(instant: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant)
  return date
}

export function localDay(instant: number, timeZone: string): string {
  return localDateAt(instant, timeZone)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function remediationOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'remediation' in error) {
    const value = (error as { remediation: unknown }).remediation
    if (typeof value === 'string') return value
  }
  return undefined
}
