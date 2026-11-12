import { describe, expect, it } from 'vitest'
import type { OccurrenceDetail } from './api.ts'
import { draftOf, editOf, type Draft } from './occurrence-edit.ts'

/**
 * Changing one date of a repeating event.
 *
 * What matters is what is *not* sent. A field sent unchanged is pinned to
 * today's value on that date, and every later change to the event then
 * silently skips it — which is how a renamed series kept last month's
 * title on one Sunday.
 */

const detail = (over: Partial<OccurrenceDetail> = {}): OccurrenceDetail => ({
  id: 'occ-1',
  seriesId: 'series-1',
  seriesLabel: 'Sunday Service',
  label: 'Sunday Service',
  timezone: 'America/Chicago',
  // 9:00 in Chicago, 90 minutes.
  scheduledStart: Date.parse('2026-09-20T14:00:00Z'),
  scheduledEnd: Date.parse('2026-09-20T15:30:00Z'),
  localDate: '2026-09-20',
  status: 'pending',
  detached: false,
  overrides: {},
  runId: null,
  runState: null,
  seriesTemplates: { title: '{{event.name}}', filename: '{{date "yyyy-MM-dd"}}' },
  outputs: [],
  ...over,
})

const edited = (base: OccurrenceDetail, change: Partial<Draft>) => {
  const original = draftOf(base)
  return editOf(base, original, { ...original, ...change })
}

describe('what the form opens with', () => {
  it('shows the date and time in the event’s zone', () => {
    expect(draftOf(detail())).toMatchObject({ date: '2026-09-20', time: '09:00', minutes: 90 })
  })

  it('shows this date’s own values where it has them, and the event’s otherwise', () => {
    const draft = draftOf(
      detail({ overrides: { label: 'Easter Sunday', templates: { title: 'He is risen' } } }),
    )
    expect(draft).toMatchObject({
      label: 'Easter Sunday',
      title: 'He is risen',
      filename: '{{date "yyyy-MM-dd"}}',
      description: '',
    })
  })
})

describe('what gets sent', () => {
  it('sends nothing when nothing changed', () => {
    expect(edited(detail(), {})).toEqual({})
  })

  it('sends a new name', () => {
    expect(edited(detail(), { label: 'Easter Sunday' })).toEqual({ label: 'Easter Sunday' })
  })

  it('clears the name when it is put back to the event’s', () => {
    const renamed = detail({ label: 'Easter Sunday', overrides: { label: 'Easter Sunday' } })
    expect(edited(renamed, { label: 'Sunday Service' })).toEqual({ label: null })
  })

  it('sends the date and time together when only the time moves', () => {
    expect(edited(detail(), { time: '10:30' })).toEqual({
      startsAt: { date: '2026-09-20', time: '10:30' },
    })
  })

  it('sends a new length in milliseconds', () => {
    expect(edited(detail(), { minutes: 120 })).toEqual({ durationMs: 120 * 60_000 })
  })

  it('sends only the template that changed, leaving the others on the event', () => {
    expect(edited(detail(), { title: 'Special service' })).toEqual({
      templates: { title: 'Special service' },
    })
  })

  it('clears a template put back to what the event says', () => {
    const changed = detail({ overrides: { templates: { title: 'Special service' } } })
    expect(edited(changed, { title: '{{event.name}}' })).toEqual({ templates: { title: null } })
  })

  it('clears a template emptied on an event that has none', () => {
    const changed = detail({ overrides: { templates: { description: 'Just this once' } } })
    expect(edited(changed, { description: '' })).toEqual({ templates: { description: null } })
  })
})
