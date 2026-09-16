import { beforeEach, describe, expect, it } from 'vitest'
import {
  API_VERSION,
  CredentialRejectedError,
  PlanningCenterApi,
  RateLimitedError,
  USER_AGENT,
} from './api.js'
import { FakePlanningCenter } from './fake-planning-center.js'
import { planningCenterSource } from './source.js'

let pco: FakePlanningCenter

const api = (over: { applicationId?: string; secret?: string } = {}) =>
  new PlanningCenterApi(
    { applicationId: over.applicationId ?? 'app-id', secret: over.secret ?? 'app-secret' },
    pco.fetch,
  )

beforeEach(() => {
  pco = new FakePlanningCenter()
})

describe('credentials', () => {
  it('reads the service types this account can see', async () => {
    const types = await api().serviceTypes()
    expect(types.map((type) => type.name)).toEqual([
      'Sunday Morning',
      'Sunday Evening',
      'Students',
      'Midweek',
    ])
  })

  it('presents the token as HTTP basic', async () => {
    await api().serviceTypes()
    const auth = pco.calls[0]?.auth
    expect(auth).toMatch(/^Basic /)
    expect(Buffer.from(auth!.slice(6), 'base64').toString()).toBe('app-id:app-secret')
  })

  it('identifies itself and pins the API version', async () => {
    // Planning Center answers badly without a User-Agent, and an unpinned
    // client gets whatever is current — which breaks on a morning nobody
    // deployed anything.
    await api().serviceTypes()
    expect(pco.calls[0]?.userAgent).toBe(USER_AGENT)
    expect(API_VERSION).toBe('2018-11-01')
  })

  it('names a bad token as something to re-enter, not something to retry', async () => {
    await expect(api({ secret: 'wrong' }).serviceTypes()).rejects.toBeInstanceOf(
      CredentialRejectedError,
    )
  })

  it('says where to make a new token when one is rejected', async () => {
    const error = await api({ secret: 'wrong' })
      .serviceTypes()
      .catch((e: unknown) => e as CredentialRejectedError)
    expect(error.remediation).toContain('personal_access_tokens')
  })
})

describe('reading the schedule', () => {
  it('pairs each service time with the plan it came from', async () => {
    const times = await api().serviceTimes('1024')

    expect(times).toHaveLength(2)
    expect(times[0]?.plan.title).toBe('The Weight of Glory')
    expect(times[0]?.plan.seriesTitle).toBe('Romans')
    expect(times[0]?.time.name).toBe('9:00 Service')
    expect(times[1]?.time.name).toBe('11:00 Service')
  })

  it('leaves rehearsals out of the schedule', async () => {
    // A plan carries rehearsals and "other" times beside the services.
    // Broadcasting Saturday's rehearsal would be memorable.
    const times = await api().serviceTimes('1024')
    expect(times.map((entry) => entry.time.id)).toEqual(['time-1', 'time-2'])
  })

  it('returns times in order, whatever order Planning Center listed them', async () => {
    pco.plans.set('1024', [
      {
        id: 'plan-x',
        times: [
          { id: 'late', startsAt: '2026-09-20T16:00:00Z' },
          { id: 'early', startsAt: '2026-09-20T14:00:00Z' },
        ],
      },
    ])
    const times = await api().serviceTimes('1024')
    expect(times.map((entry) => entry.time.id)).toEqual(['early', 'late'])
  })

  it('reads the times as real instants, so a moved service lands correctly', async () => {
    const times = await api().serviceTimes('1024')
    expect(times[0]?.time.startsAt).toBe(Date.parse('2026-09-20T14:00:00Z'))
    expect(times[0]?.time.endsAt).toBe(Date.parse('2026-09-20T15:15:00Z'))
  })

  it('carries a plan with no end time rather than inventing one', async () => {
    pco.plans.set('1024', [
      { id: 'plan-x', times: [{ id: 'only', startsAt: '2026-09-20T14:00:00Z' }] },
    ])
    const times = await api().serviceTimes('1024')
    expect(times[0]?.time.endsAt).toBeUndefined()
  })

  it('drops a time with no start rather than scheduling it in 1970', async () => {
    pco.plans.set('1024', [
      {
        id: 'plan-x',
        times: [
          { id: 'broken', startsAt: '' },
          { id: 'good', startsAt: '2026-09-20T14:00:00Z' },
        ],
      },
    ])
    const times = await api().serviceTimes('1024')
    expect(times.map((entry) => entry.time.id)).toEqual(['good'])
  })

  it('handles a week with one service and a week with three', async () => {
    // The case that decided the whole design: the number of services is not
    // fixed, so it cannot come from a recurrence rule.
    pco.plans.set('1024', [
      {
        id: 'single',
        times: [{ id: 'a', startsAt: '2026-12-24T22:00:00Z', name: '4:00 Christmas Eve' }],
      },
      {
        id: 'triple',
        times: [
          { id: 'b', startsAt: '2026-12-25T18:00:00Z' },
          { id: 'c', startsAt: '2026-12-25T20:00:00Z' },
          { id: 'd', startsAt: '2026-12-25T22:00:00Z' },
        ],
      },
    ])
    const times = await api().serviceTimes('1024')
    expect(times).toHaveLength(4)
  })

  it('treats a plan with no title as untitled rather than empty string', async () => {
    pco.plans.set('1024', [
      { id: 'plan-x', title: '', times: [{ id: 'a', startsAt: '2026-09-20T14:00:00Z' }] },
    ])
    const times = await api().serviceTimes('1024')
    expect(times[0]?.plan.title).toBeUndefined()
  })

  it('links back to the plan, for a description or a notification', async () => {
    const times = await api().serviceTimes('1024')
    expect(times[0]?.plan.url).toBe('https://services.planningcenteronline.com/plans/plan-1')
  })

  it('reports a service type it cannot see rather than returning nothing', async () => {
    // An empty list and "you typed the wrong id" are different problems, and
    // a scheduler that confuses them shows an empty calendar and no reason.
    await expect(api().serviceTimes('9999')).rejects.toThrow(/not found/i)
  })
})

describe('rate limits', () => {
  it('reports a limit as temporary, with how long to wait', async () => {
    pco.rateLimitNext = { retryAfter: '12' }
    const error = await api()
      .serviceTypes()
      .catch((e: unknown) => e as RateLimitedError)
    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.retryAfterMs).toBe(12_000)
  })

  it('waits a sane default when Planning Center does not say how long', async () => {
    pco.rateLimitNext = {}
    const error = await api()
      .serviceTypes()
      .catch((e: unknown) => e as RateLimitedError)
    expect(error.retryAfterMs).toBe(20_000)
  })

  it('never waits absurdly long on a nonsense header', async () => {
    pco.rateLimitNext = { retryAfter: '999999' }
    const error = await api()
      .serviceTypes()
      .catch((e: unknown) => e as RateLimitedError)
    expect(error.retryAfterMs).toBe(300_000)
  })
})

describe('as a plan source', () => {
  const source = (credentials?: { applicationId: string; secret: string }) =>
    planningCenterSource({
      resolveCredentials: async () => credentials,
      fetchImpl: pco.fetch,
    })

  const good = { applicationId: 'app-id', secret: 'app-secret' }

  it('knows it is not set up before a token is saved', async () => {
    expect(await source().isConfigured()).toBe(false)
    expect((await source().check()).state).toBe('not_configured')
  })

  it('tells "not set up" apart from "set up and failing"', async () => {
    // Different problems with different fixes. A UI that shows one message
    // for both sends somebody to re-paste a token that was never the issue.
    const wrong = source({ applicationId: 'app-id', secret: 'nope' })
    expect(await wrong.isConfigured()).toBe(true)
    expect((await wrong.check()).state).toBe('credentials_rejected')
  })

  it('says what the token can actually see', async () => {
    const status = await source(good).check()
    expect(status.state).toBe('ok')
    expect(status.message).toContain('4 service types')
  })

  it('offers the service types to pair with', async () => {
    expect(await source(good).listGroups()).toEqual([
      { id: '1024', name: 'Sunday Morning', path: ['Sunday'] },
      { id: '4096', name: 'Sunday Evening', path: ['Sunday'] },
      { id: '8192', name: 'Students', path: ['Midweek', 'Youth'] },
      { id: '2048', name: 'Midweek' },
    ])
  })

  it('reports each service with what a template can reach', async () => {
    const services = await source(good).listServices('1024')
    expect(services).toHaveLength(2)
    expect(services[0]).toEqual({
      externalId: 'time-1',
      startsAt: Date.parse('2026-09-20T14:00:00Z'),
      endsAt: Date.parse('2026-09-20T15:15:00Z'),
      detail: {
        planTitle: 'The Weight of Glory',
        seriesTitle: 'Romans',
        timeName: '9:00 Service',
        planDate: 'September 20, 2026',
        planUrl: 'https://services.planningcenteronline.com/plans/plan-1',
      },
    })
  })

  it('leaves a detail out rather than inventing it', async () => {
    pco.plans.set('1024', [
      { id: 'plan-x', times: [{ id: 'a', startsAt: '2026-09-20T14:00:00Z' }] },
    ])
    const services = await source(good).listServices('1024')
    expect(services[0]?.detail).toEqual({
      planUrl: 'https://services.planningcenteronline.com/plans/plan-x',
    })
  })

  it('asks for a token rather than returning an empty schedule', async () => {
    // An unconfigured source and a church with no services look identical
    // from a list of zero, and only one of them is a problem to fix.
    await expect(source().listServices('1024')).rejects.toThrow(/token/i)
  })
})

describe('folders', () => {
  const source = () =>
    planningCenterSource({
      resolveCredentials: async () => ({ applicationId: 'app-id', secret: 'app-secret' }),
      fetchImpl: pco.fetch,
    })

  it('reports where each service type sits, outermost folder first', async () => {
    // A church with thirty service types has them in folders, and three of
    // them are called "9:00". Flattened, that list cannot be picked from.
    const groups = await source().listGroups()
    expect(groups.find((g) => g.id === '8192')?.path).toEqual(['Midweek', 'Youth'])
  })

  it('leaves a top-level service type with no path at all', async () => {
    const groups = await source().listGroups()
    expect(groups.find((g) => g.id === '2048')?.path).toBeUndefined()
  })

  it('reads the parent whether it is a relationship or an attribute', async () => {
    // Which one Planning Center uses is documented rather than guessable,
    // and the documentation is not reachable from here. The wrong guess
    // would silently flatten everybody's folders.
    const asRelationship = await source().listGroups()
    pco.parentAsAttribute = true
    const asAttribute = await source().listGroups()
    expect(asAttribute).toEqual(asRelationship)
  })

  it('still lists the service types when the folders cannot be read', async () => {
    // An unfoldered list is what this did before folders existed at all,
    // and it is far better than no list.
    pco.foldersFail = true
    const groups = await source().listGroups()
    expect(groups).toHaveLength(4)
    expect(groups.every((group) => group.path === undefined)).toBe(true)
  })

  it('does not hang on a folder that is its own ancestor', async () => {
    // A wrong path is a much smaller problem than a wedged scheduler tick.
    pco.folders = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ]
    pco.serviceTypes = [{ id: '1', name: 'Odd', parentId: 'a' }]
    const groups = await source().listGroups()
    expect(groups[0]?.path).toEqual(['B', 'A'])
  })

  it('names a folder Planning Center did not return rather than inventing one', async () => {
    pco.serviceTypes = [{ id: '1', name: 'Orphan', parentId: 'missing' }]
    const groups = await source().listGroups()
    expect(groups[0]?.path).toBeUndefined()
  })

  it('reads every page, so a big church does not lose half its list', async () => {
    // Planning Center pages at 100. A church with more would silently lose
    // the ones past the first page — a bug that only appears at the one
    // place big enough to hit it.
    pco.serviceTypes = Array.from({ length: 150 }, (_, index) => ({
      id: String(index),
      name: `Service ${index}`,
    }))
    expect(await source().listGroups()).toHaveLength(150)
  })
})
