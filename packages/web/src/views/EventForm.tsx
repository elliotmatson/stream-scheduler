import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Pipeline, type SchedulePreview, type Series } from '../api.ts'
import { Card, ErrorBanner, Field } from '../components.tsx'
import { shortZone, timeIn } from '../format.ts'

const WEEKDAYS = [
  { code: 'SU', label: 'Sun' },
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
]

type Repeat = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom'

interface Draft {
  label: string
  pipelineId: string
  timezone: string
  date: string
  time: string
  durationMinutes: number
  prepareLeadMinutes: number
  repeat: Repeat
  byday: string[]
  customRrule: string
  title: string
  description: string
  filename: string
}

/**
 * Create or edit a recurring event.
 *
 * The preview panel is the point of this screen. A recurrence rule and a
 * name template are both write-only-looking things whose mistakes surface
 * weeks later, on air; seeing the next five occurrences written out in the
 * event's own timezone catches almost all of them while still typing.
 */
export function EventForm({
  series,
  onDone,
}: {
  series?: Series
  onDone: () => void
}): ReactNode {
  const { data: pipelines } = useResource(() => api.pipelines(), [])
  const [draft, setDraft] = useState<Draft>(() => toDraft(series))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  // Adopt the first pipeline once the list arrives, so a new event is
  // valid without touching the picker when there is only one.
  useEffect(() => {
    if (!draft.pipelineId && pipelines?.[0]) set('pipelineId', pipelines[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines])

  const rrule = useMemo(() => toRrule(draft), [draft])
  const request = useMemo(
    () => ({
      label: draft.label || 'Untitled event',
      timezone: draft.timezone,
      rrule,
      dtstartLocal: { date: draft.date, time: draft.time },
      durationMs: draft.durationMinutes * 60_000,
      templates: templatesOf(draft),
      count: 5,
    }),
    [draft, rrule],
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const input = {
        label: draft.label,
        pipelineId: draft.pipelineId,
        timezone: draft.timezone,
        rrule,
        dtstartLocal: { date: draft.date, time: draft.time },
        durationMs: draft.durationMinutes * 60_000,
        prepareLeadMs: draft.prepareLeadMinutes * 60_000,
        templates: templatesOf(draft),
      }
      if (series) await api.updateSeries(series.id, input)
      else await api.createSeries(input)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={series ? `Edit ${series.label}` : 'New event'}>
      <ErrorBanner error={error} />
      <div className="split">
        <div className="stack">
          <Field label="Name">
            <input
              value={draft.label}
              placeholder="Sunday Service"
              onChange={(event) => set('label', event.target.value)}
            />
          </Field>

          <Field label="Pipeline" hint="Which devices this event drives, and where they send.">
            <select value={draft.pipelineId} onChange={(event) => set('pipelineId', event.target.value)}>
              {(pipelines ?? []).length === 0 ? <option value="">— none set up —</option> : null}
              {(pipelines ?? []).map((pipeline: Pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Timezone"
            hint="Times below are read in this zone, so a 9am service stays at 9am across a clock change."
          >
            <select value={draft.timezone} onChange={(event) => set('timezone', event.target.value)}>
              {zoneChoices(draft.timezone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>

          <div className="row">
            <Field label="First date">
              <input type="date" value={draft.date} onChange={(event) => set('date', event.target.value)} />
            </Field>
            <Field label="Start time">
              <input type="time" value={draft.time} onChange={(event) => set('time', event.target.value)} />
            </Field>
            <Field label="Runs for (min)">
              <input
                type="number"
                min={1}
                value={draft.durationMinutes}
                onChange={(event) => set('durationMinutes', Number(event.target.value))}
              />
            </Field>
          </div>

          <Field label="Repeats">
            <select value={draft.repeat} onChange={(event) => set('repeat', event.target.value as Repeat)}>
              <option value="once">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month, on the same weekday</option>
              <option value="custom">Custom rule</option>
            </select>
          </Field>

          {draft.repeat === 'weekly' ? (
            <div className="row" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.code}
                  className={draft.byday.includes(day.code) ? 'primary' : ''}
                  onClick={() =>
                    set(
                      'byday',
                      draft.byday.includes(day.code)
                        ? draft.byday.filter((code) => code !== day.code)
                        : [...draft.byday, day.code],
                    )
                  }
                >
                  {day.label}
                </button>
              ))}
            </div>
          ) : null}

          {draft.repeat === 'custom' ? (
            <Field label="RRULE" hint="RFC 5545, without the DTSTART line. e.g. FREQ=WEEKLY;BYDAY=SU,WE">
              <input value={draft.customRrule} onChange={(event) => set('customRrule', event.target.value)} />
            </Field>
          ) : null}

          <Field
            label="Prepare this many minutes early"
            hint="When the broadcast is created and the encoders are pointed at it. Not when it goes live."
          >
            <input
              type="number"
              min={0}
              value={draft.prepareLeadMinutes}
              onChange={(event) => set('prepareLeadMinutes', Number(event.target.value))}
            />
          </Field>

          <h3>Names</h3>
          <p className="muted" style={{ margin: 0 }}>
            Tokens: <code>{'{{date "MMMM d, yyyy"}}'}</code>, <code>{'{{event.name}}'}</code>,{' '}
            <code>{'{{time}}'}</code>, <code>{'{{occurrence.index}}'}</code>. Dates resolve against the
            occurrence, in the zone above.
          </p>
          <Field label="Broadcast title">
            <input
              value={draft.title}
              placeholder={'{{event.name}} — {{date "MMMM d, yyyy"}}'}
              onChange={(event) => set('title', event.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={draft.description} onChange={(event) => set('description', event.target.value)} />
          </Field>
          <Field label="Recording filename">
            <input
              value={draft.filename}
              placeholder={'{{date "yyyy-MM-dd"}} {{event.name}}'}
              onChange={(event) => set('filename', event.target.value)}
            />
          </Field>

          <div className="row">
            <button
              className="primary"
              disabled={saving || !draft.label || !draft.pipelineId}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : series ? 'Save' : 'Create'}
            </button>
            <button onClick={onDone}>Cancel</button>
          </div>
        </div>

        <PreviewPanel request={request} timezone={draft.timezone} />
      </div>
    </Card>
  )
}

/** Asks the server what the rule and templates would actually produce. */
function PreviewPanel({
  request,
  timezone,
}: {
  request: Parameters<typeof api.schedulePreview>[0]
  timezone: string
}): ReactNode {
  const [preview, setPreview] = useState<SchedulePreview>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    let cancelled = false
    // Debounced: this fires on every keystroke in a template box.
    const timer = setTimeout(() => {
      api
        .schedulePreview(request)
        .then((result) => {
          if (cancelled) return
          setPreview(result)
          setProblem(undefined)
        })
        .catch((err: unknown) => {
          if (!cancelled) setProblem(err instanceof Error ? err.message : String(err))
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [request])

  return (
    <aside className="preview">
      <h3 style={{ marginTop: 0 }}>What this does</h3>
      {problem ? <div className="banner error">{problem}</div> : null}
      {preview ? (
        <>
          <p className="muted">{preview.describes}</p>
          {preview.occurrences.length === 0 ? (
            <p className="muted">This rule produces nothing in the next two years.</p>
          ) : null}
          <ol className="preview-list">
            {preview.occurrences.map((occurrence) => (
              <li key={occurrence.start}>
                <div>
                  <strong>{occurrence.localDate}</strong> {timeIn(occurrence.start, timezone)}{' '}
                  <span className="muted">{shortZone(occurrence.start, timezone)}</span>
                </div>
                {/* A clock change landing on this occurrence is worth saying
                    out loud rather than resolving quietly. */}
                {occurrence.resolution !== 'exact' ? (
                  <div className="muted">
                    {occurrence.resolution === 'ambiguous'
                      ? 'The clocks go back over this time; the earlier one is used.'
                      : 'The clocks go forward over this time; it has been shifted.'}
                  </div>
                ) : null}
                {occurrence.error ? <div style={{ color: 'var(--bad)' }}>{occurrence.error}</div> : null}
                {occurrence.title ? <div>{occurrence.title}</div> : null}
                {occurrence.filename ? <div className="muted">{occurrence.filename}</div> : null}
              </li>
            ))}
          </ol>
        </>
      ) : problem ? null : (
        <p className="muted">…</p>
      )}
    </aside>
  )
}

function toDraft(series: Series | undefined): Draft {
  const zone = series?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const start = series?.dtstart ?? defaultStart()
  const parsed = parseRrule(series?.rrule ?? null)

  return {
    label: series?.label ?? '',
    pipelineId: series?.pipelineId ?? '',
    timezone: zone,
    date: dateInZone(start, zone),
    time: timeInZone(start, zone),
    durationMinutes: Math.round((series?.durationMs ?? 90 * 60_000) / 60_000),
    prepareLeadMinutes: Math.round((series?.prepareLeadMs ?? 30 * 60_000) / 60_000),
    repeat: parsed.repeat,
    byday: parsed.byday.length > 0 ? parsed.byday : [WEEKDAYS[new Date(start).getDay()]!.code],
    customRrule: parsed.repeat === 'custom' ? (series?.rrule ?? '') : '',
    title: series?.templates.title ?? '',
    description: series?.templates.description ?? '',
    filename: series?.templates.filename ?? '',
  }
}

function templatesOf(draft: Draft): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.title) out.title = draft.title
  if (draft.description) out.description = draft.description
  if (draft.filename) out.filename = draft.filename
  return out
}

function toRrule(draft: Draft): string | null {
  switch (draft.repeat) {
    case 'once':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekly':
      return draft.byday.length > 0 ? `FREQ=WEEKLY;BYDAY=${draft.byday.join(',')}` : 'FREQ=WEEKLY'
    case 'monthly':
      return 'FREQ=MONTHLY;BYDAY=' + nthWeekdayOf(draft)
    case 'custom':
      return draft.customRrule.trim() || null
  }
}

/** `2SU` — the second Sunday — from the chosen first date. */
function nthWeekdayOf(draft: Draft): string {
  const [, , day] = draft.date.split('-').map(Number) as [number, number, number]
  const nth = Math.floor((day - 1) / 7) + 1
  const weekday = WEEKDAYS[new Date(`${draft.date}T12:00:00Z`).getUTCDay()]!.code
  return `${nth}${weekday}`
}

function parseRrule(rrule: string | null): { repeat: Repeat; byday: string[] } {
  if (rrule === null) return { repeat: 'once', byday: [] }
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1]?.split(',') ?? []
  if (rrule === 'FREQ=DAILY') return { repeat: 'daily', byday: [] }
  // Only the shapes this form can round-trip get a friendly control; anything
  // else stays as the rule the operator wrote, rather than being rewritten.
  if (/^FREQ=WEEKLY(;BYDAY=[A-Z,]+)?$/.test(rrule)) return { repeat: 'weekly', byday }
  if (/^FREQ=MONTHLY;BYDAY=\d[A-Z]{2}$/.test(rrule)) return { repeat: 'monthly', byday: [] }
  return { repeat: 'custom', byday: [] }
}

function defaultStart(): number {
  const next = new Date()
  next.setHours(9, 0, 0, 0)
  next.setDate(next.getDate() + 1)
  return next.getTime()
}

function dateInZone(instant: number, timeZone: string): string {
  // en-CA is the locale that formats as YYYY-MM-DD, which is what
  // <input type="date"> wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  )
}

function timeInZone(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    instant,
  )
}

/** Every zone the browser knows, with the current one guaranteed present. */
function zoneChoices(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [Intl.DateTimeFormat().resolvedOptions().timeZone]
  return supported.includes(current) ? supported : [current, ...supported]
}
