import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManualClock } from '@scheduler/plugin-sdk'
import { mockPlugin } from '@scheduler/plugin-mock'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application, TICK_DEADLINE_MS } from '../app.js'
import { createServer } from '../api/server.js'
import { silentLogger } from '../log.js'

/**
 * One device must not be able to stop the scheduler.
 *
 * This is a regression test for a real outage. A HyperDeck told to format
 * a card accepts the socket and then stops answering while it remounts.
 * The adapter had no deadline on a command, the connection manager awaited
 * one while priming a freshly connected device, and the tick awaited that
 * — so `ticking` stayed true forever and every later tick returned at the
 * overlap guard. The scheduler stopped: no reconnects, no telemetry, no
 * runs, and nothing to see except screens that had quietly gone stale.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-watchdog-'))
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

const post = (url: string, body: unknown) =>
  server.inject({ method: 'POST', url, payload: body as object })
const json = (response: { body: string }): any => JSON.parse(response.body)

describe('a device that accepts a command and never answers', () => {
  it('does not wedge the scheduler loop', async () => {
    // A tick that completes normally, so there is a baseline.
    let ticks = 0
    app.onTick(() => {
      ticks += 1
    })
    await app.tick()
    expect(ticks).toBe(1)

    const device = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Wedged deck',
        config: { kind: 'recorder', fault: 'never-answers' },
      }),
    )
    // Connecting primes the device's state, and the prime never answers.
    // The connect itself is bounded, so this resolves either way.
    await post(`/api/devices/${device.id}/connect`, {}).catch(() => {})

    const before = ticks
    // Whatever happened above, the loop still turns. Before the fix this
    // is where it stopped forever.
    await app.tick()
    expect(ticks).toBeGreaterThan(before)

    await app.tick()
    expect(ticks).toBeGreaterThan(before + 1)
  })

  it('abandons a tick that overruns rather than never ticking again', async () => {
    let ticks = 0
    app.onTick(() => {
      ticks += 1
    })

    // A tick that genuinely never settles, held open by hand.
    let release: (() => void) | undefined
    const wedged = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = app.engine.tick.bind(app.engine)
    app.engine.tick = async () => {
      await wedged
    }

    const hung = app.tick()
    // It is still in there, so a second tick now is refused as an overlap.
    const during = ticks
    await app.tick()
    expect(ticks).toBe(during)

    // Past the deadline, the next tick stops waiting for it.
    clock.advance(TICK_DEADLINE_MS + MINUTE)
    app.engine.tick = original
    await app.tick()
    expect(ticks).toBeGreaterThan(during)

    // And the abandoned one settling later does not clear the guard out
    // from under whatever is running by then.
    release?.()
    await hung
    const after = ticks
    await app.tick()
    expect(ticks).toBeGreaterThan(after)
  })
})
