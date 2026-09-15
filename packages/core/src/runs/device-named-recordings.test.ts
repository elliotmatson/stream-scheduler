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

/**
 * A device that records under a name of its own choosing.
 *
 * Asking for a name and recording the answer are two different things, and
 * for a growing number of devices they are different strings. OBS,
 * ProPresenter and any audio console writing a dated session own their
 * output naming: they take the request, ignore it, and say afterwards what
 * they actually used.
 *
 * Everything downstream keys off the ledger's filename — retention matches
 * it against the card, and sweeping deletes by it — so storing the name we
 * asked for instead of the one that exists means the recording can be made
 * and then never swept. These tests are about that chain end to end.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-named-'))
  clock = new ManualClock(START)
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

const post = (url: string, body?: unknown) =>
  server.inject({ method: 'POST', url, payload: (body ?? {}) as object })
const get = (url: string) => server.inject({ method: 'GET', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

/** An event that records onto a device with the given simulated behaviour. */
async function recordingEvent(fault: string): Promise<{ outputId: string; deviceId: string }> {
  const device = json(
    await post('/api/devices', {
      pluginId: 'mock',
      label: 'Stage recorder',
      config: { kind: 'recorder', fault },
    }),
  )
  await post(`/api/devices/${device.id}/connect`)

  const series = json(
    await post('/api/series', {
      label: 'Sunday Service',
      timezone: 'America/Chicago',
      rrule: null,
      dtstart: START,
      durationMs: 60 * MINUTE,
    }),
  )
  const output = json(
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive copy',
      durationMs: 60 * MINUTE,
      deviceId: device.id,
      nodeId: 'record',
      templates: { filename: 'sunday-service' },
      settings: { retention: { keepDays: 1, keepLast: 0 } },
    }),
  )
  return { outputId: output.id, deviceId: device.id }
}

/** Runs the event and returns what the ledger ended up holding. */
async function runIt(): Promise<void> {
  const occurrences = json(
    await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`),
  )
  await post(`/api/occurrences/${occurrences[0].id}/start-now`)
  await app.tick()
}

describe('a device that names its own recordings', () => {
  it('stores the name the device used, not the one we asked for', async () => {
    const { outputId } = await recordingEvent('names-its-own-files')
    await runIt()

    const [artifact] = app.ledger.forOutput(outputId)
    expect(artifact).toBeDefined()
    // The template rendered "sunday-service"; the device stamped its own.
    expect(artifact!.filename).not.toBe('sunday-service')
    expect(artifact!.filename).toMatch(/Recording$/)
  })

  it('still uses ours when the device has no name to give back', async () => {
    // A HyperDeck indexes clips by position and reports no filename at
    // all. The requested name stays the best anybody has.
    const { outputId } = await recordingEvent('none')
    await runIt()

    expect(app.ledger.forOutput(outputId)[0]?.filename).toBe('sunday-service')
  })

  it('matches the file on the card, so retention can see it', async () => {
    // The point of all of it. A ledger holding a name the card has never
    // heard of produces a report with nothing in it, and a recording that
    // quietly accumulates forever.
    const { outputId } = await recordingEvent('names-its-own-files')
    await runIt()

    const report = json(await get('/api/retention')).outputs.find(
      (entry: { outputId: string }) => entry.outputId === outputId,
    )
    expect(report.kept).toHaveLength(1)
    expect(report.kept[0].onDevice).toBe(true)
    // And the deck's own spelling of it, which is what a delete is issued
    // against.
    expect(report.kept[0].deviceName).toMatch(/\.mov$/)
    expect(report.unknownToUs).toEqual([])
  })

  it('can be swept, which is the whole reason this matters', async () => {
    const { outputId, deviceId } = await recordingEvent('names-its-own-files')
    await runIt()

    // Let the event finish: a card being written to is never swept, and a
    // recording still open is not a candidate for anything.
    clock.advance(90 * MINUTE)
    await app.tick()
    expect(app.ledger.forOutput(outputId)[0]?.endedAt).not.toBeNull()

    // And old enough for a one-day policy.
    clock.advance(3 * 86_400_000)

    const plan = json(await post('/api/retention/sweep', { outputId }))
    expect(plan.files).toHaveLength(1)
    const done = json(await post('/api/retention/sweep', { outputId, confirm: plan.confirm }))
    expect(done.removed).toHaveLength(1)
    expect(done.failed).toEqual([])

    // Actually gone from the card, not just marked gone in the ledger.
    const listed = await app.connections.invoke(deviceId, 'record', 'listMedia')
    expect(((listed?.raw?.media ?? []) as unknown[]).length).toBe(0)
  })

  it('says on the timeline what was asked for and what was used', async () => {
    // When the two differ, the difference is the whole story — an operator
    // looking for "sunday-service" on the card needs to know it is not
    // there under that name.
    const { outputId } = await recordingEvent('names-its-own-files')
    await runIt()

    const runs = json(await get('/api/runs'))
    const steps = json(await get(`/api/runs/${runs[0].id}`)).steps as {
      kind: string
      response: { filename?: string; requested?: string } | null
    }[]
    const start = steps.find((step) => step.kind === `${outputId}.startRecording`)
    expect(start?.response?.requested).toBe('sunday-service')
    expect(start?.response?.filename).toMatch(/Recording$/)
  })
})
