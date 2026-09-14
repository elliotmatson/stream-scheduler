import { describe, expect, it } from 'vitest'
import { renderTemplate, renderTemplateOrThrow, TemplateError } from './render.js'
import type { TemplateContext } from './render.js'
import { sanitizeFilename, uniqueFilename } from './filename.js'

/** 09:00 on Sunday 8 March 2026 in Chicago - the morning US DST begins, so
 *  this instant is already CDT (UTC-5). */
const SUNDAY_9AM_CHICAGO = Date.parse('2026-03-08T14:00:00Z')

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  occurrenceStart: SUNDAY_9AM_CHICAGO,
  timezone: 'America/Chicago',
  event: { name: 'Sunday Service' },
  series: { name: 'Sunday Morning' },
  occurrence: { index: 42 },
  ...over,
})

describe('renderTemplate', () => {
  it('substitutes names and formats dates in the series timezone', () => {
    const result = renderTemplate('{{event.name}} - {{date "EEEE, MMMM d, yyyy"}}', ctx())
    expect(result.issues).toEqual([])
    expect(result.text).toBe('Sunday Service - Sunday, March 8, 2026')
  })

  it('renders the same local date regardless of the server timezone', () => {
    // The bug this prevents: the app in a UTC container putting yesterday's
    // date on every evening event in the Americas.
    const evening = Date.parse('2026-03-09T01:30:00Z') // 8:30pm Sunday in Chicago
    const result = renderTemplate(
      '{{date "yyyy-MM-dd"}} {{time "h:mm a"}}',
      ctx({ occurrenceStart: evening }),
    )
    expect(result.text).toBe('2026-03-08 8:30 PM')
  })

  it('formats against the occurrence start, not the moment of rendering', () => {
    // Prepared at T-30m, which is before midnight for a 00:15 event. The title
    // must still name the event's own day.
    const justAfterMidnight = Date.parse('2026-03-08T06:15:00Z') // 00:15 Sunday in Chicago
    const result = renderTemplate('{{date "EEEE"}}', ctx({ occurrenceStart: justAfterMidnight }))
    expect(result.text).toBe('Sunday')
  })

  it('applies calendar-aware offsets across a DST boundary', () => {
    // 8 March 2026 is a spring-forward day in the US. "-1d" must still be the 7th.
    expect(renderTemplate('{{date "yyyy-MM-dd" offset="-1d"}}', ctx()).text).toBe('2026-03-07')
    expect(renderTemplate('{{date "yyyy-MM-dd" offset="+1w"}}', ctx()).text).toBe('2026-03-15')
    expect(renderTemplate('{{time "h:mm a" offset="-30m"}}', ctx()).text).toBe('8:30 AM')
  })

  it('handles a southern-hemisphere zone stepping the other way out of DST', () => {
    // Sydney leaves AEDT (UTC+11) for AEST (UTC+10) at 03:00 on 5 April 2026.
    const sydney = (iso: string) =>
      renderTemplate('{{date "yyyy-MM-dd"}} {{time "HH:mm"}}', {
        ...ctx(),
        timezone: 'Australia/Sydney',
        occurrenceStart: Date.parse(iso),
      }).text

    expect(sydney('2026-04-04T12:00:00Z')).toBe('2026-04-04 23:00') // still AEDT
    expect(sydney('2026-04-04T23:00:00Z')).toBe('2026-04-05 09:00') // now AEST
  })

  it('reports unknown tokens instead of quietly publishing them', () => {
    const result = renderTemplate('{{event.name}} {{speaker.name}}', ctx())
    expect(result.issues).toEqual([
      { token: '{{speaker.name}}', message: 'unknown token "speaker.name"' },
    ])
    expect(result.text).toContain('{{speaker.name}}')
  })

  it('renders counters with padding', () => {
    const result = renderTemplate(
      'Week {{counter "sermons" pad=3}}',
      ctx({ counters: { sermons: 7 } }),
    )
    expect(result.text).toBe('Week 007')
  })

  it('reports a counter that does not exist', () => {
    expect(renderTemplate('{{counter "nope"}}', ctx()).issues[0]?.message).toMatch(
      /no counter named/,
    )
  })

  it('reports a malformed offset', () => {
    expect(renderTemplate('{{date offset="tomorrow"}}', ctx()).issues[0]?.message).toMatch(
      /must look like/,
    )
  })

  it('reports a missing encoder rather than rendering "undefined"', () => {
    expect(renderTemplate('{{encoder.label}}', ctx()).issues[0]?.message).toMatch(/no encoder/)
    expect(
      renderTemplate('{{encoder.label}}', ctx({ encoder: { label: 'ATEM Mini Pro' } })).text,
    ).toBe('ATEM Mini Pro')
  })

  it('leaves text without tokens untouched', () => {
    expect(renderTemplate('Plain title', ctx()).text).toBe('Plain title')
  })

  it('throws in the prepare phase so a bad template fails before air', () => {
    expect(() => renderTemplateOrThrow('{{nope}}', ctx())).toThrow(TemplateError)
    expect(renderTemplateOrThrow('{{series.name}}', ctx())).toBe('Sunday Morning')
  })
})

describe('sanitizeFilename', () => {
  it('replaces characters that are illegal on recording media', () => {
    expect(sanitizeFilename('Sunday: 9am / Main "Service"')).toBe('Sunday- 9am - Main -Service-')
  })

  it('strips trailing dots and spaces that Windows would silently drop', () => {
    expect(sanitizeFilename('Service.  ')).toBe('Service')
  })

  it('escapes reserved Windows device names', () => {
    expect(sanitizeFilename('CON.mp4')).toBe('_CON.mp4')
  })

  it('truncates while keeping the extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(200)}.mp4`, { maxLength: 20 })
    expect(out).toHaveLength(20)
    expect(out.endsWith('.mp4')).toBe(true)
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('   ')).toBe('untitled')
  })
})

describe('uniqueFilename', () => {
  it('returns the name when it is free', () => {
    expect(uniqueFilename('service.mp4', [])).toBe('service.mp4')
  })

  it('suffixes rather than overwriting an existing recording', () => {
    expect(uniqueFilename('service.mp4', ['service.mp4'])).toBe('service-2.mp4')
    expect(uniqueFilename('service.mp4', ['service.mp4', 'service-2.mp4'])).toBe('service-3.mp4')
  })
})
