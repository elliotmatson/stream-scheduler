import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../app.js'
import { createServer } from './server.js'
import { silentLogger } from '../log.js'

/**
 * Forgetting a run.
 *
 * Mostly about what does *not* go with it. A run's steps and readings are
 * only ever read through the run, so they are litter once it is gone; the
 * recording ledger and the quota ledger are records of things that
 * happened in the world, and deleting a row from a screen must not erase
 * either.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-delete-run-'))
  clock = new ManualClock(START)
  app = Application.create({
    configDir: dir,
    clock,
    logger: silentLogger,
    plugins: [mockPlugin({ now: () => clock.now() })],
    telemetryIntervalMs: 15_000,
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
const del = (url: string) => server.inject({ method: 'DELETE', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

/** An event, on air, recording. */
async function runningRun(): Promise<{ runId: string; outputId: string }> {
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
      dtstart: START,
      durationMs: 90 * MINUTE,
    }),
  )
  const output = json(
    await post(`/api/series/${series.id}/outputs`, {
      kind: 'recording',
      label: 'Archive copy',
      durationMs: 60 * MINUTE,
      deviceId: device.id,
      nodeId: 'record',
    }),
  )
  const occurrences = json(
    await get(`/api/occurrences?from=${START - MINUTE}&to=${START + MINUTE}`),
  )
  const started = json(await post(`/api/occurrences/${occurrences[0].id}/start-now`, {}))
  return { runId: started.runId, outputId: output.id }
}

describe('removing a run', () => {
  it('will not remove one that has not finished', async () => {
    const { runId } = await runningRun()

    const refused = await del(`/api/runs/${runId}`)
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/not finished/i)
    // And it is still there.
    expect((await get(`/api/runs/${runId}`)).statusCode).toBe(200)
  })

  it('takes its steps and readings with it', async () => {
    const { runId } = await runningRun()
    await app.telemetry.tick()
    expect(app.telemetry.read(runId).length).toBeGreaterThan(0)
    expect((await get(`/api/runs/${runId}`)).statusCode).toBe(200)

    await post(`/api/runs/${runId}/cancel`, { reason: 'done' })
    expect(json(await del(`/api/runs/${runId}`)).deleted).toBe(true)

    expect((await get(`/api/runs/${runId}`)).statusCode).toBe(404)
    expect(app.telemetry.read(runId)).toHaveLength(0)
    expect(
      app.db.prepare('SELECT COUNT(*) AS n FROM run_step WHERE run_id = ?').get(runId),
    ).toEqual({ n: 0 })
  })

  it('leaves the recordings it made, because they are still on the card', async () => {
    const { runId, outputId } = await runningRun()
    const before = app.ledger.forOutput(outputId)
    expect(before.length).toBeGreaterThan(0)

    await post(`/api/runs/${runId}/cancel`, { reason: 'done' })
    await del(`/api/runs/${runId}`)

    // This ledger is the only record that those files are ours. Dropping
    // it would make a morning's footage permanently invisible to
    // retention — nobody could sweep it, and nothing would say why.
    const after = app.ledger.forOutput(outputId)
    expect(after.map((artifact) => artifact.filename)).toEqual(
      before.map((artifact) => artifact.filename),
    )
  })

  it('refuses a run that was never there', async () => {
    expect((await del('/api/runs/nope')).statusCode).toBe(404)
  })
})
