import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from '../api/server.js'
import { silentLogger } from '../log.js'
import { assess, DEFAULT_KEEP_LAST, isConfigured, policyOf } from './retention.js'
import type { RecordingArtifact } from './artifacts.js'

/**
 * What a retention policy says could go.
 *
 * Nothing here deletes anything — that is the point of this phase. These
 * tests are about the decision, because the decision is the part that has
 * to be right before anything is allowed to act on it.
 */

const DAY = 86_400_000
const NOW = Date.parse('2026-03-08T14:00:00Z')

/** A finished recording, `age` days old. */
const artifact = (name: string, ageDays: number, over = {}): RecordingArtifact => ({
  id: `a-${name}`,
  runId: `r-${name}`,
  outputId: 'out-1',
  deviceId: 'dev-1',
  nodeId: 'record',
  slot: 1,
  filename: name,
  startedAt: NOW - ageDays * DAY,
  endedAt: NOW - ageDays * DAY + 3_600_000,
  deletedAt: null,
  lastError: null,
  ...over,
})

const report = (
  artifacts: RecordingArtifact[],
  policy = {},
  media?: { name: string }[],
  freeMs?: number,
) =>
  assess({
    outputId: 'out-1',
    outputLabel: 'Archive copy',
    seriesLabel: 'Sunday Service',
    deviceId: 'dev-1',
    nodeId: 'record',
    policy,
    artifacts,
    ...(media === undefined ? {} : { media }),
    ...(freeMs === undefined ? {} : { freeMs }),
    now: NOW,
  })

const names = (list: { artifact: RecordingArtifact }[]) => list.map((c) => c.artifact.filename)

describe('deciding what is past its keep-by date', () => {
  it('proposes nothing at all when no policy is set', () => {
    const old = [artifact('jan', 300), artifact('feb', 280), artifact('mar', 260)]
    const answer = report(old)

    // The default is the safe one. A scheduler that starts deleting
    // Sundays because somebody left a box unticked is not one anybody
    // keeps running.
    expect(answer.wouldDelete).toEqual([])
    expect(names(answer.kept)).toHaveLength(3)
  })

  it('proposes the ones older than the policy, newest first', () => {
    const answer = report(
      [
        artifact('this-week', 2),
        artifact('last-week', 9),
        artifact('a-month-ago', 32),
        artifact('ancient', 400),
      ],
      { keepDays: 30, keepLast: 0 },
    )

    expect(names(answer.wouldDelete)).toEqual(['a-month-ago', 'ancient'])
    // Ordering is the newest first throughout, so a screen reads the same
    // way whichever list it is showing.
    expect(names(answer.kept)).toEqual(['this-week', 'last-week', 'a-month-ago', 'ancient'])
  })

  it('keeps the newest few whatever the dates say', () => {
    // A quiet season: everything on the card is older than the policy.
    const quiet = Array.from({ length: 12 }, (_, index) =>
      artifact(`week-${index}`, 60 + index * 7),
    )
    const answer = report(quiet, { keepDays: 30 })

    // Without this rail a month off would empty the card. Ten kept, which
    // is the default nobody had to type.
    expect(names(answer.wouldDelete)).toEqual(['week-10', 'week-11'])
    expect(answer.policy.keepLast).toBeUndefined()
    expect(answer.effectiveKeepLast).toBe(DEFAULT_KEEP_LAST)
    expect(DEFAULT_KEEP_LAST).toBe(10)
  })

  it('sweeps early when the card is running out of room', () => {
    // The case a keep-for date cannot cover: a fortnight of extra services
    // fills a card long before anything on it is thirty days old.
    const recent = [
      artifact('this-week', 1),
      artifact('last-week', 8),
      artifact('the-week-before', 15),
    ]
    const policy = { keepDays: 30, keepLast: 1, minFreeHours: 4 }

    // Plenty of room: age still decides, and nothing here is old enough.
    const roomy = report(recent, policy, undefined, 20 * 3_600_000)
    expect(roomy.wouldDelete).toEqual([])
    expect(roomy.underPressure).toBe(false)

    // Under the floor: everything past the newest one is eligible, which
    // is what keeping the newest one was a promise about.
    const tight = report(recent, policy, undefined, 2 * 3_600_000)
    expect(names(tight.wouldDelete)).toEqual(['last-week', 'the-week-before'])
    expect(tight.underPressure).toBe(true)
    expect(tight.freeMs).toBe(2 * 3_600_000)
  })

  it('does not read a device that says nothing about room as nearly full', () => {
    // A deck that cannot report headroom must not have its silence taken
    // for an empty card.
    const answer = report([artifact('a', 1), artifact('b', 2)], { minFreeHours: 4, keepLast: 0 })
    expect(answer.underPressure).toBe(false)
    expect(answer.wouldDelete).toEqual([])
  })

  it('treats a free-space floor on its own as a policy', () => {
    // Somebody who only cares that the card never fills should not have to
    // invent a keep-for date to get that.
    expect(isConfigured({ minFreeHours: 4 })).toBe(true)
    expect(isConfigured({ keepDays: 30 })).toBe(true)
    expect(isConfigured({ keepLast: 3 })).toBe(false)
    expect(isConfigured({})).toBe(false)

    const answer = report(
      [artifact('a', 1), artifact('b', 2), artifact('c', 3)],
      {
        minFreeHours: 4,
        keepLast: 1,
      },
      undefined,
      60_000,
    )
    expect(names(answer.wouldDelete)).toEqual(['b', 'c'])
  })

  it('never proposes a recording that is still being written', () => {
    const answer = report(
      [
        artifact('finished', 200),
        artifact('finished-too', 210),
        artifact('still-going', 220, { endedAt: null }),
        artifact('run-died-halfway', 230, { endedAt: null }),
      ],
      { keepDays: 30, keepLast: 0 },
    )

    // An open row means the deck may still have the file open, or the run
    // died without ever closing it. Neither is a candidate for deletion —
    // but both are on the card, so both are still listed as kept.
    expect(names(answer.wouldDelete)).toEqual(['finished', 'finished-too'])
    expect(names(answer.kept)).toEqual([
      'finished',
      'finished-too',
      'still-going',
      'run-died-halfway',
    ])
  })

  it('leaves other people’s files alone, and says they are there', () => {
    const answer = report([artifact('sunday-service', 200)], { keepDays: 30, keepLast: 0 }, [
      { name: 'sunday-service.mov' },
      { name: 'CAMERA_A_0042.mov' },
      { name: 'wedding-rehearsal.mov' },
    ])

    // Only what this scheduler recorded. Half the files on a Sunday card
    // were put there by somebody with a camera.
    expect(names(answer.wouldDelete)).toEqual(['sunday-service'])
    expect(answer.unknownToUs).toEqual(['CAMERA_A_0042.mov', 'wedding-rehearsal.mov'])
  })

  it('does not propose a file the device says is already gone', () => {
    const answer = report([artifact('deleted-by-hand', 200), artifact('still-there', 210)], {
      keepDays: 30,
      keepLast: 0,
    })
    expect(names(answer.wouldDelete)).toEqual(['deleted-by-hand', 'still-there'])

    // Now with a listing that only has one of them.
    const withListing = report(
      [artifact('deleted-by-hand', 200), artifact('still-there', 210)],
      { keepDays: 30, keepLast: 0 },
      [{ name: 'still-there.mov' }],
    )
    expect(names(withListing.wouldDelete)).toEqual(['still-there'])
  })

  it('matches the name the deck gave the file, not just the one we asked for', () => {
    const answer = report([artifact('sunday', 200)], { keepDays: 30, keepLast: 0 }, [
      // A deck appends its own extension, and a suffix when a name is taken.
      { name: 'sunday_1.mov' },
    ])
    expect(names(answer.wouldDelete)).toEqual(['sunday'])
    expect(answer.unknownToUs).toEqual([])
  })
})

describe('reading a policy off an output', () => {
  it('ignores a stored number that would delete everything', () => {
    // Settings are JSON: a database written by an older version, or by
    // hand, is not bound by today's schema.
    expect(policyOf({ retention: { keepDays: 0 } })).toEqual({})
    expect(policyOf({ retention: { keepDays: -5 } })).toEqual({})
    expect(policyOf({})).toEqual({})
    expect(policyOf({ retention: { keepDays: 30, keepLast: 2 } })).toEqual({
      keepDays: 30,
      keepLast: 2,
    })

    // The free-space floor gets the same treatment: zero hours free is not
    // a floor anybody meant to type.
    expect(policyOf({ retention: { minFreeHours: 0 } })).toEqual({})
    expect(policyOf({ retention: { keepDays: 30, minFreeHours: 6 } })).toEqual({
      keepDays: 30,
      minFreeHours: 6,
    })
  })
})

describe('the whole report, over the API', () => {
  let dir: string
  let clock: ManualClock
  let app: Application
  let server: FastifyInstance

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'scheduler-retention-'))
    clock = new ManualClock(NOW)
    app = Application.create({
      configDir: dir,
      clock,
      logger: silentLogger,
      plugins: [mockPlugin({ now: () => clock.now() })],
    })
    server = await createServer({ app })
  })

  afterEach(async () => {
    await server.close()
    await app.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const post = (url: string, body: unknown) =>
    server.inject({ method: 'POST', url, payload: body as object })
  const get = (url: string) => server.inject({ method: 'GET', url })
  const json = (response: { body: string }): any => JSON.parse(response.body)

  it('reports a recording the scheduler actually made, and what is on the card', async () => {
    const device = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Stage deck',
        config: { kind: 'recorder' },
      }),
    )
    await post(`/api/devices/${device.id}/connect`, {})

    const series = json(
      await post('/api/series', {
        label: 'Sunday Service',
        timezone: 'America/Chicago',
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        dtstart: NOW,
        durationMs: 90 * 60_000,
      }),
    )
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive copy',
      durationMs: 60 * 60_000,
      deviceId: device.id,
      nodeId: 'record',
      templates: { filename: 'service-{{date}}' },
      settings: { retention: { keepDays: 30, keepLast: 0 } },
    })

    // Run it, so the ledger has a row the way it gets one in real life.
    const occurrences = json(await get(`/api/occurrences?from=${NOW - 60_000}&to=${NOW + 60_000}`))
    await post(`/api/occurrences/${occurrences[0].id}/start-now`, {})

    const body = json(await get('/api/retention'))
    expect(body.outputs).toHaveLength(1)
    const [entry] = body.outputs
    expect(entry.outputLabel).toBe('Archive copy')
    expect(entry.seriesLabel).toBe('Sunday Service')
    expect(entry.policy).toEqual({ keepDays: 30, keepLast: 0 })

    // One recording, made just now, and far too new to be eligible.
    expect(entry.kept.length + entry.wouldDelete.length).toBeGreaterThan(0)
    expect(entry.wouldDelete).toEqual([])
    // And the deck agrees the file is there.
    expect(entry.kept.every((c: { onDevice: boolean }) => c.onDevice)).toBe(true)
  })

  it('says nothing for an output with no policy on it', async () => {
    const device = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Stage deck',
        config: { kind: 'recorder' },
      }),
    )
    await post(`/api/devices/${device.id}/connect`, {})
    const series = json(
      await post('/api/series', {
        label: 'Sunday Service',
        timezone: 'America/Chicago',
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        dtstart: NOW,
        durationMs: 90 * 60_000,
      }),
    )
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive copy',
      durationMs: 60 * 60_000,
      deviceId: device.id,
      nodeId: 'record',
    })

    const body = json(await get('/api/retention'))
    expect(body.outputs).toHaveLength(1)
    expect(body.outputs[0].policy).toEqual({})
    expect(body.outputs[0].wouldDelete).toEqual([])
  })
})
