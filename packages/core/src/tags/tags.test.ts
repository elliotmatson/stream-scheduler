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
import { MAX_TAG_LENGTH, normalize } from './index.js'

/**
 * Labels on things, so a full rack can be narrowed.
 *
 * Most of what matters here is spelling. Two people tagging the same
 * building "Sanctuary" and "sanctuary" have not made two groups, and a
 * filter that misses half a rack over a capital letter is worse than no
 * filter at all.
 */

const START = Date.parse('2026-03-08T14:00:00Z')

let dir: string
let clock: ManualClock
let app: Application
let server: FastifyInstance

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-tags-'))
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
const put = (url: string, body: unknown) =>
  server.inject({ method: 'PUT', url, payload: body as object })
const get = (url: string) => server.inject({ method: 'GET', url })
const del = (url: string) => server.inject({ method: 'DELETE', url })
const json = (response: { body: string }): any => JSON.parse(response.body)

const device = async (label: string): Promise<string> =>
  json(await post('/api/devices', { pluginId: 'mock', label, config: { kind: 'recorder' } })).id

describe('tidying what somebody typed', () => {
  it('trims, drops blanks, and de-duplicates ignoring case', () => {
    expect(normalize(['  Sanctuary  ', 'sanctuary', '', '   ', 'Chapel'])).toEqual([
      'Chapel',
      'sanctuary',
    ])
  })

  it('keeps the last spelling, so a capital can be corrected by retyping it', () => {
    expect(normalize(['sanctuary', 'Sanctuary'])).toEqual(['Sanctuary'])
  })

  it('caps a tag that is really a sentence', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH + 20)
    expect(normalize([long])[0]).toHaveLength(MAX_TAG_LENGTH)
  })
})

describe('tagging a device', () => {
  it('stores them, and hands back what was stored', async () => {
    const id = await device('Stage deck')

    const saved = json(await put(`/api/tags/device/${id}`, { tags: ['  Sanctuary ', 'deck'] }))
    expect(saved.tags).toEqual(['deck', 'Sanctuary'])

    const devices = json(await get('/api/devices'))
    expect(devices.find((entry: { id: string }) => entry.id === id).tags).toEqual([
      'deck',
      'Sanctuary',
    ])
  })

  it('replaces the whole list rather than adding to it', async () => {
    const id = await device('Stage deck')
    await put(`/api/tags/device/${id}`, { tags: ['one', 'two'] })

    const saved = json(await put(`/api/tags/device/${id}`, { tags: ['three'] }))
    expect(saved.tags).toEqual(['three'])
  })

  it('counts a tag once however it was spelled', async () => {
    const a = await device('Deck A')
    const b = await device('Deck B')
    await put(`/api/tags/device/${a}`, { tags: ['Sanctuary'] })
    await put(`/api/tags/device/${b}`, { tags: ['sanctuary'] })

    const known = json(await get('/api/tags/device')).tags
    expect(known).toHaveLength(1)
    expect(known[0].count).toBe(2)
  })

  it('refuses a tag on something that is not there', async () => {
    const refused = await put('/api/tags/device/nope', { tags: ['x'] })
    expect(refused.statusCode).toBe(404)
  })

  it('forgets them when the device goes', async () => {
    const id = await device('Stage deck')
    await put(`/api/tags/device/${id}`, { tags: ['Sanctuary'] })
    expect(json(await get('/api/tags/device')).tags).toHaveLength(1)

    await del(`/api/devices/${id}`)

    // A tag exists only by being used, so the last thing carrying it going
    // should take it with it rather than leaving a filter option that
    // matches nothing.
    expect(json(await get('/api/tags/device')).tags).toEqual([])
  })
})

describe('tagging an event', () => {
  it('keeps device and event tags apart', async () => {
    const deviceId = await device('Stage deck')
    const series = json(
      await post('/api/series', {
        label: 'Sunday Service',
        timezone: 'America/Chicago',
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        dtstart: START,
        durationMs: 90 * 60_000,
      }),
    )

    await put(`/api/tags/device/${deviceId}`, { tags: ['hardware'] })
    await put(`/api/tags/series/${series.id}`, { tags: ['weekly'] })

    expect(json(await get('/api/tags/device')).tags.map((t: { tag: string }) => t.tag)).toEqual([
      'hardware',
    ])
    expect(json(await get('/api/tags/series')).tags.map((t: { tag: string }) => t.tag)).toEqual([
      'weekly',
    ])

    const listed = json(await get('/api/series'))
    expect(listed[0].tags).toEqual(['weekly'])
  })
})
