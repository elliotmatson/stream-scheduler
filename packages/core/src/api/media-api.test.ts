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
 * Managing the files on a recorder by hand.
 *
 * Bulk selection is why the two-step matters here: ticking twelve boxes
 * and pressing a button is far easier to do by accident than deleting
 * twelve files one at a time, so the confirm removes exactly the list the
 * first call described and nothing else.
 */

const MINUTE = 60_000
const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-media-'))
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
const get = (url: string) => server.inject({ method: 'GET', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

/** A recorder with `names` already written to it. */
async function deckWith(names: string[]): Promise<string> {
  const device = json(
    await post('/api/devices', {
      pluginId: 'mock',
      label: 'Stage deck',
      config: { kind: 'recorder' },
    }),
  )
  await post(`/api/devices/${device.id}/connect`, {})
  for (const name of names) {
    await post(`/api/devices/${device.id}/nodes/record/startRecording`, { filename: name, slot: 1 })
    await post(`/api/devices/${device.id}/nodes/record/stopRecording`, {})
  }
  return device.id
}

describe('browsing what is on a recorder', () => {
  it('lists the files the device reports', async () => {
    const deviceId = await deckWith(['sunday', 'midweek'])

    const body = json(await get(`/api/devices/${deviceId}/nodes/record/media`))
    expect(body.files.map((file: { name: string }) => file.name)).toEqual([
      'sunday.mov',
      'midweek.mov',
    ])
  })

  it('refuses on a device that cannot list its media', async () => {
    const encoder = json(
      await post('/api/devices', {
        pluginId: 'mock',
        label: 'Encoder',
        config: { kind: 'encoder' },
      }),
    )
    await post(`/api/devices/${encoder.id}/connect`, {})

    const refused = await get(`/api/devices/${encoder.id}/nodes/stream/media`)
    expect(refused.statusCode).toBe(409)
  })
})

describe('deleting a selection', () => {
  it('describes the selection first, then removes exactly it', async () => {
    const deviceId = await deckWith(['one', 'two', 'three'])

    const plan = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov', 'three.mov'],
        slot: 1,
      }),
    )
    expect(plan.deleted).toBe(false)
    expect(plan.files).toEqual(['one.mov', 'three.mov'])

    const done = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov', 'three.mov'],
        slot: 1,
        confirm: plan.confirm,
      }),
    )
    expect(done.deleted).toBe(true)
    expect(done.removed).toEqual(['one.mov', 'three.mov'])
    expect(done.failed).toEqual([])

    // The one nobody ticked is still there.
    const left = json(await get(`/api/devices/${deviceId}/nodes/record/media`))
    expect(left.files.map((file: { name: string }) => file.name)).toEqual(['two.mov'])
  })

  it('removes what the confirmation described, not what the second call asks for', async () => {
    const deviceId = await deckWith(['one', 'two', 'three'])

    const plan = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov'],
        slot: 1,
      }),
    )
    // A second call naming more files does not get to widen the agreement:
    // the token is a record of what somebody was shown.
    const done = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov', 'two.mov', 'three.mov'],
        slot: 1,
        confirm: plan.confirm,
      }),
    )
    expect(done.removed).toEqual(['one.mov'])

    const left = json(await get(`/api/devices/${deviceId}/nodes/record/media`))
    expect(left.files.map((file: { name: string }) => file.name)).toEqual(['two.mov', 'three.mov'])
  })

  it('refuses a token that has already been used', async () => {
    const deviceId = await deckWith(['one', 'two'])
    const plan = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov'],
        slot: 1,
      }),
    )
    await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
      names: ['one.mov'],
      slot: 1,
      confirm: plan.confirm,
    })

    const again = await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
      names: ['one.mov'],
      slot: 1,
      confirm: plan.confirm,
    })
    expect(again.statusCode).toBe(409)
  })

  it('refuses a token that has gone stale', async () => {
    const deviceId = await deckWith(['one'])
    const plan = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov'],
        slot: 1,
      }),
    )

    clock.advance(6 * MINUTE)
    const stale = await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
      names: ['one.mov'],
      slot: 1,
      confirm: plan.confirm,
    })
    expect(stale.statusCode).toBe(409)
    expect(json(stale).error).toMatch(/five minutes/i)
  })

  it('will not delete from a device that is recording', async () => {
    const deviceId = await deckWith(['one'])
    await post(`/api/devices/${deviceId}/nodes/record/startRecording`, { filename: 'live' })

    const refused = await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
      names: ['one.mov'],
      slot: 1,
    })
    expect(refused.statusCode).toBe(409)
    expect(json(refused).error).toMatch(/recording/i)
  })

  it('carries on past a file it cannot remove, and says which', async () => {
    const deviceId = await deckWith(['one', 'two'])
    const plan = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        names: ['one.mov', 'gone-already.mov', 'two.mov'],
        slot: 1,
      }),
    )
    const done = json(
      await post(`/api/devices/${deviceId}/nodes/record/media/delete`, {
        // Ignored — the token decides — but the route still wants a valid body.
        names: ['one.mov'],
        slot: 1,
        confirm: plan.confirm,
      }),
    )

    expect(done.removed).toEqual(['one.mov', 'two.mov'])
    expect(done.failed.map((entry: { name: string }) => entry.name)).toEqual(['gone-already.mov'])
  })
})
