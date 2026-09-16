import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import type { PlannedService, PlanSource } from '@scheduler/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../db/index.js'
import { Scrubber } from '../secrets/scrubber.js'
import { SecretVault } from '../secrets/vault.js'
import { keyFileSource, resolveMasterKey } from '../secrets/master-key.js'
import { materializeSeries } from '../schedule/materialize.js'
import { PlanSourceRegistry } from './registry.js'
import { syncAll, syncSeries } from './sync.js'

/**
 * Turning published service times into occurrences.
 *
 * The cases worth pinning are all about *not* doing damage. Reading a plan
 * is easy; the hard part is that this runs unattended every hour against a
 * schedule people depend on, and the ways it could go wrong are all quiet:
 * a moved service losing its history, a network blip emptying a calendar,
 * somebody tidying plan times cancelling a broadcast that is already
 * preparing.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-09-14T12:00:00Z')
const SUNDAY_9 = Date.parse('2026-09-20T14:00:00Z')
const SUNDAY_11 = Date.parse('2026-09-20T16:00:00Z')

let dir: string
let db: Db
let clock: ManualClock
let sources: PlanSourceRegistry
let seriesId: string
/** What the fake source will answer with. */
let published: PlannedService[]
/** Set to make the next read fail. */
let failWith: string | undefined

const source: PlanSource = {
  id: 'planning-center',
  displayName: 'Planning Center',
  apiVersion: '1',
  isConfigured: async () => true,
  check: async () => ({ state: 'ok' }),
  listGroups: async () => [{ id: '1024', name: 'Sunday Morning' }],
  listServices: async () => {
    if (failWith) throw new Error(failWith)
    return published
  },
}

const deps = () => ({ db, clock, sources })

function service(over: Partial<PlannedService> & { externalId: string }): PlannedService {
  return { startsAt: SUNDAY_9, ...over }
}

function occurrences(): {
  id: string
  scheduled_start: number
  scheduled_end: number
  status: string
  external_ref: string | null
  external_detail: string | null
  overrides: string | null
}[] {
  return db
    .prepare('SELECT * FROM occurrence WHERE series_id = ? ORDER BY scheduled_start')
    .all(seriesId) as never
}

function pair(sourceId: string | null = 'planning-center', groupId: string | null = '1024'): void {
  db.prepare('UPDATE event_series SET plan_source_id = ?, plan_group_id = ? WHERE id = ?').run(
    sourceId,
    groupId,
    seriesId,
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-sync-'))
  db = openDatabase(join(dir, 'test.db'))
  clock = new ManualClock(NOW)
  const vault = new SecretVault(
    db,
    resolveMasterKey([keyFileSource(join(dir, 'k'), { create: true })]),
    new Scrubber(),
  )
  sources = new PlanSourceRegistry({ db, vault })
  sources.register(source)
  published = []
  failWith = undefined

  seriesId = randomUUID()
  db.prepare(
    `INSERT INTO event_series
       (id, label, timezone, rrule, dtstart, duration_ms, prepare_lead_ms,
        version, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  ).run(
    seriesId,
    'Sunday Service',
    'America/Chicago',
    'FREQ=WEEKLY;BYDAY=SU',
    SUNDAY_9,
    90 * 60_000,
    30 * 60_000,
    NOW,
    NOW,
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('an unpaired series', () => {
  it('is not touched', async () => {
    published = [service({ externalId: 'a' })]
    const result = await syncSeries(deps(), seriesId)
    expect(result.created).toBe(0)
    expect(occurrences()).toHaveLength(0)
  })

  it('treats half a pairing as no pairing', async () => {
    // A source with no group is not a pairing. Reading it as one would
    // empty a calendar on the strength of a bad write.
    pair('planning-center', null)
    published = [service({ externalId: 'a' })]
    expect((await syncSeries(deps(), seriesId)).created).toBe(0)
  })

  it('is left out of a sync of everything', async () => {
    published = [service({ externalId: 'a' })]
    expect((await syncAll(deps())).size).toBe(0)
  })
})

describe('the number of services is whatever the plan says', () => {
  beforeEach(() => pair())

  it('makes one occurrence per service time', async () => {
    published = [
      service({ externalId: 'nine', startsAt: SUNDAY_9 }),
      service({ externalId: 'eleven', startsAt: SUNDAY_11 }),
    ]
    const result = await syncSeries(deps(), seriesId)

    expect(result.created).toBe(2)
    expect(occurrences().map((o) => o.scheduled_start)).toEqual([SUNDAY_9, SUNDAY_11])
  })

  it('drops to one when the plan has one', async () => {
    published = [
      service({ externalId: 'nine' }),
      service({ externalId: 'eleven', startsAt: SUNDAY_11 }),
    ]
    await syncSeries(deps(), seriesId)

    // The Christmas Eve case: a single 4:00 where there are normally two.
    published = [service({ externalId: 'christmas', startsAt: SUNDAY_9 + HOUR })]
    const result = await syncSeries(deps(), seriesId)

    expect(result.removed).toBe(2)
    expect(result.created).toBe(1)
    expect(occurrences()).toHaveLength(1)
  })

  it('grows to three when the plan has three', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    published = [
      service({ externalId: 'nine' }),
      service({ externalId: 'one', startsAt: SUNDAY_9 + 4 * HOUR }),
      service({ externalId: 'three', startsAt: SUNDAY_9 + 6 * HOUR }),
    ]
    const result = await syncSeries(deps(), seriesId)

    expect(result.created).toBe(2)
    expect(occurrences()).toHaveLength(3)
  })

  it('uses the series duration when the source has no end time', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    expect(occurrences()[0]?.scheduled_end).toBe(SUNDAY_9 + 90 * 60_000)
  })

  it('prefers the source end time when it has one', async () => {
    published = [service({ externalId: 'nine', endsAt: SUNDAY_9 + 75 * 60_000 })]
    await syncSeries(deps(), seriesId)
    expect(occurrences()[0]?.scheduled_end).toBe(SUNDAY_9 + 75 * 60_000)
  })

  it('never schedules a service in the past', async () => {
    // The source filters to future plans, but one can move backwards
    // between the fetch and here — and a broadcast in the past runs
    // immediately and fails.
    published = [service({ externalId: 'old', startsAt: NOW - HOUR })]
    expect((await syncSeries(deps(), seriesId)).created).toBe(0)
  })
})

describe('a service that moves', () => {
  beforeEach(() => pair())

  it('stays the same occurrence', async () => {
    // The reason occurrences are matched on the source's id for the time
    // rather than on the clock: a move must not read as a delete and a
    // create, which would lose the run history and any edit.
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    const before = occurrences()[0]!

    published = [service({ externalId: 'nine', startsAt: SUNDAY_9 + HOUR })]
    const result = await syncSeries(deps(), seriesId)

    expect(result).toMatchObject({ created: 0, removed: 0, updated: 1 })
    const after = occurrences()[0]!
    expect(after.id).toBe(before.id)
    expect(after.scheduled_start).toBe(SUNDAY_9 + HOUR)
  })

  it('carries its end time with it', async () => {
    published = [service({ externalId: 'nine', endsAt: SUNDAY_9 + HOUR })]
    await syncSeries(deps(), seriesId)

    published = [
      service({ externalId: 'nine', startsAt: SUNDAY_9 + HOUR, endsAt: SUNDAY_9 + 2 * HOUR }),
    ]
    await syncSeries(deps(), seriesId)

    expect(occurrences()[0]?.scheduled_end).toBe(SUNDAY_9 + 2 * HOUR)
  })

  it('does nothing at all when nothing changed', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    const result = await syncSeries(deps(), seriesId)
    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0 })
  })

  it('leaves it where it is rather than colliding with another service', async () => {
    published = [
      service({ externalId: 'nine' }),
      service({ externalId: 'eleven', startsAt: SUNDAY_11 }),
    ]
    await syncSeries(deps(), seriesId)

    // Both plan times set to the same instant. One of them cannot be
    // scheduled there, and the sync has to say so rather than throw.
    published = [
      service({ externalId: 'nine' }),
      service({ externalId: 'eleven', startsAt: SUNDAY_9 }),
    ]
    const result = await syncSeries(deps(), seriesId)

    expect(result.issues).toHaveLength(1)
    expect(occurrences()).toHaveLength(2)
  })
})

describe('what must not be disturbed', () => {
  beforeEach(() => pair())

  it('leaves an occurrence alone once it is preparing', async () => {
    // Somebody rearranging plan times at 08:55 must not cancel a broadcast
    // that is already getting ready to go out.
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    clock.set(SUNDAY_9 - 20 * 60_000) // inside the 30-minute prepare lead
    published = []
    const result = await syncSeries(deps(), seriesId)

    expect(result.frozen).toBe(1)
    expect(result.removed).toBe(0)
    expect(occurrences()).toHaveLength(1)
  })

  it('will not move one that is preparing either', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    clock.set(SUNDAY_9 - 20 * 60_000)
    published = [service({ externalId: 'nine', startsAt: SUNDAY_9 + 3 * HOUR })]
    const result = await syncSeries(deps(), seriesId)

    expect(result.frozen).toBe(1)
    expect(occurrences()[0]?.scheduled_start).toBe(SUNDAY_9)
  })

  it('still follows the plan right up to the prepare point', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    // Saturday night tidying still counts.
    clock.set(SUNDAY_9 - 40 * 60_000)
    published = [service({ externalId: 'nine', startsAt: SUNDAY_9 + 2 * HOUR })]
    const result = await syncSeries(deps(), seriesId)

    expect(result.updated).toBe(1)
    expect(occurrences()[0]?.scheduled_start).toBe(SUNDAY_9 + 2 * HOUR)
  })

  it('leaves an occurrence somebody edited alone', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    db.prepare('UPDATE occurrence SET overrides = ? WHERE series_id = ?').run(
      JSON.stringify({ label: 'Carols by candlelight' }),
      seriesId,
    )

    published = [service({ externalId: 'nine', startsAt: SUNDAY_9 + HOUR })]
    const result = await syncSeries(deps(), seriesId)

    expect(result.detached).toBe(1)
    expect(occurrences()[0]?.scheduled_start).toBe(SUNDAY_9)
  })

  it('never deletes an edited occurrence the plan dropped', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    db.prepare('UPDATE occurrence SET overrides = ? WHERE series_id = ?').run(
      '{"label":"x"}',
      seriesId,
    )

    published = []
    const result = await syncSeries(deps(), seriesId)

    expect(result.removed).toBe(0)
    expect(result.detached).toBe(1)
    expect(occurrences()).toHaveLength(1)
  })

  it('leaves history alone whatever the plan says now', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)
    db.prepare("UPDATE occurrence SET status = 'completed' WHERE series_id = ?").run(seriesId)

    published = []
    const result = await syncSeries(deps(), seriesId)

    expect(result.removed).toBe(0)
    expect(occurrences()).toHaveLength(1)
  })

  it('does not empty the calendar when the source is unreachable', async () => {
    // The failure that would turn a network blip into a Sunday with
    // nothing scheduled.
    published = [
      service({ externalId: 'nine' }),
      service({ externalId: 'eleven', startsAt: SUNDAY_11 }),
    ]
    await syncSeries(deps(), seriesId)

    failWith = 'getaddrinfo ENOTFOUND api.planningcenteronline.com'
    const result = await syncSeries(deps(), seriesId)

    expect(result.removed).toBe(0)
    expect(result.issues[0]).toContain('ENOTFOUND')
    expect(occurrences()).toHaveLength(2)
  })

  it('stops updating a disabled series without discarding it', async () => {
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    db.prepare('UPDATE event_series SET enabled = 0 WHERE id = ?').run(seriesId)
    published = []
    const result = await syncSeries(deps(), seriesId)

    expect(result.removed).toBe(0)
    expect(occurrences()).toHaveLength(1)
  })
})

describe('what the templates can reach', () => {
  beforeEach(() => pair())

  it('stores what the source said about the service', async () => {
    published = [
      service({
        externalId: 'nine',
        detail: {
          planTitle: 'The Weight of Glory',
          seriesTitle: 'Romans',
          timeName: '9:00 Service',
        },
      }),
    ]
    await syncSeries(deps(), seriesId)

    expect(JSON.parse(occurrences()[0]!.external_detail!)).toEqual({
      planTitle: 'The Weight of Glory',
      seriesTitle: 'Romans',
      timeName: '9:00 Service',
    })
  })

  it('picks up a sermon title that was filled in later', async () => {
    published = [service({ externalId: 'nine', detail: { timeName: '9:00 Service' } })]
    await syncSeries(deps(), seriesId)

    published = [
      service({
        externalId: 'nine',
        detail: { timeName: '9:00 Service', planTitle: 'Named at last' },
      }),
    ]
    const result = await syncSeries(deps(), seriesId)

    expect(result.updated).toBe(1)
    expect(JSON.parse(occurrences()[0]!.external_detail!).planTitle).toBe('Named at last')
  })
})

describe('the sync own state', () => {
  beforeEach(() => pair())

  const seriesRow = () =>
    db
      .prepare('SELECT plan_synced_at, plan_error FROM event_series WHERE id = ?')
      .get(seriesId) as {
      plan_synced_at: number | null
      plan_error: string | null
    }

  it('records when it last read cleanly', async () => {
    await syncSeries(deps(), seriesId)
    expect(seriesRow().plan_synced_at).toBe(NOW)
    expect(seriesRow().plan_error).toBeNull()
  })

  it('does not claim a clean read when the read failed', async () => {
    // "Read two minutes ago" beside an error message would be worse than
    // saying nothing.
    await syncSeries(deps(), seriesId)
    clock.advance(HOUR)
    failWith = 'boom'
    await syncSeries(deps(), seriesId)

    expect(seriesRow().plan_synced_at).toBe(NOW)
    expect(seriesRow().plan_error).toBe('boom')
  })

  it('clears the error once it works again', async () => {
    failWith = 'boom'
    await syncSeries(deps(), seriesId)
    failWith = undefined
    await syncSeries(deps(), seriesId)
    expect(seriesRow().plan_error).toBeNull()
  })

  it('keeps going when one series fails', async () => {
    const other = randomUUID()
    db.prepare(
      `INSERT INTO event_series
         (id, label, timezone, rrule, dtstart, duration_ms, prepare_lead_ms,
          version, enabled, created_at, updated_at, plan_source_id, plan_group_id)
       SELECT ?, 'Second', timezone, rrule, dtstart, duration_ms, prepare_lead_ms,
              1, 1, ?, ?, 'nope', '1024'
       FROM event_series WHERE id = ?`,
    ).run(other, NOW, NOW, seriesId)

    published = [service({ externalId: 'nine' })]
    const results = await syncAll(deps())

    expect(results.get(seriesId)?.created).toBe(1)
    expect(results.get(other)?.issues).toHaveLength(1)
  })
})

describe('pairing a series that already had a rule', () => {
  it('clears the guesses the rule left behind', async () => {
    // Past the last published plan the calendar is deliberately empty.
    // Leaving rule-made occurrences beside real ones would put guesses on
    // the calendar with nothing to tell them apart.
    materializeSeries(db, seriesId, { clock })
    expect(occurrences().length).toBeGreaterThan(0)

    pair()
    const result = materializeSeries(db, seriesId, { clock })

    expect(result.removed).toBeGreaterThan(0)
    expect(occurrences()).toHaveLength(0)
  })

  it('leaves what the plan made alone', async () => {
    pair()
    published = [service({ externalId: 'nine' })]
    await syncSeries(deps(), seriesId)

    materializeSeries(db, seriesId, { clock })
    expect(occurrences()).toHaveLength(1)
  })

  it('keeps an edited one even when the rule made it', async () => {
    materializeSeries(db, seriesId, { clock })
    db.prepare('UPDATE occurrence SET overrides = ? WHERE series_id = ?').run(
      '{"label":"x"}',
      seriesId,
    )
    const before = occurrences().length

    pair()
    const result = materializeSeries(db, seriesId, { clock })

    expect(result.detached).toBe(before)
    expect(occurrences()).toHaveLength(before)
  })
})
