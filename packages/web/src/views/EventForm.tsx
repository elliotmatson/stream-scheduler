import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type EventOutput, type SchedulePreview, type Series } from '../api.ts'
import { Outputs } from './Outputs.tsx'
import { GroupOptions } from './PlanSource.tsx'
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

type Repeat = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom' | 'plan'

interface Draft {
  label: string
  timezone: string
  date: string
  time: string
  durationMinutes: number
  prepareLeadMinutes: number
  repeat: Repeat
  byday: string[]
  /** True once the operator has clicked a day chip themselves. */
  bydayTouched: boolean
  customRrule: string
  /** Set when the schedule comes from a plan source rather than a rule. */
  planSourceId: string
  planGroupId: string
  /**
   * The rule this series had before it was paired.
   *
   * Kept so unpairing gives back the weekly it used to be rather than
   * dropping it to "does not repeat" — which is what happens if the rule is
   * simply not sent while the pairing is in place.
   */
  priorRrule: string | null
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
export function EventForm({ series, onDone }: { series?: Series; onDone: () => void }): ReactNode {
  const [draft, setDraft] = useState<Draft>(() => toDraft(series))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  /** Hold the outputs at their clock times rather than letting them follow. */
  const [keepOutputTimes, setKeepOutputTimes] = useState(false)
  // An event has to exist before its outputs can hang off it. Rather than
  // hiding that, a new event saves and then reveals the outputs editor in
  // place, so the flow is one screen either way.
  const [saved, setSaved] = useState<Series | undefined>(series)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  // Until the operator picks days themselves, "every week" means the weekday
  // of the first date. Deriving it here rather than freezing it at mount is
  // what stops "Sunday Service, first date the 20th" quietly recurring on
  // Tuesdays because that was the default date when the form opened.
  const byday = useMemo(
    () => (draft.bydayTouched ? draft.byday : [weekdayOf(draft.date)]),
    [draft.bydayTouched, draft.byday, draft.date],
  )
  const rrule = useMemo(() => toRrule(draft, byday), [draft, byday])
  const request = useMemo(
    () => ({
      label: draft.label || 'Untitled event',
      timezone: draft.timezone,
      rrule,
      dtstartLocal: { date: draft.date, time: draft.time },
      durationMs: draft.durationMinutes * 60_000,
      templates: templatesOf(draft),
      count: 5,
      ...pairingOf(draft),
    }),
    [draft, rrule],
  )

  // What moving the start time would do to the outputs sitting inside the
  // window. They are stored as offsets from it, so they move with it — which
  // is almost always what somebody wants and is worth saying out loud before
  // they press Save.
  const savedTime = saved ? timeInZone(saved.dtstart, saved.timezone) : undefined
  const shiftMs =
    savedTime !== undefined && saved?.timezone === draft.timezone
      ? (minutesOfDay(draft.time) - minutesOfDay(savedTime)) * 60_000
      : 0
  // Only asked for once the time has actually changed, and re-asked each time
  // it starts differing again: the panel below owns these rows and this is a
  // read for one sentence.
  const { data: outputsNow } = useResource(
    () => (saved && shiftMs !== 0 ? api.outputs(saved.id) : Promise.resolve(undefined)),
    [saved?.id, shiftMs !== 0],
  )
  const moving = outputsNow?.outputs ?? []
  // An output cannot start before the event opens, so holding them still is
  // only on offer when none of them would have to.
  const stuck = moving.find((output: EventOutput) => output.offsetMs - shiftMs < 0)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const input = {
        label: draft.label,
        timezone: draft.timezone,
        rrule,
        dtstartLocal: { date: draft.date, time: draft.time },
        durationMs: draft.durationMinutes * 60_000,
        prepareLeadMs: draft.prepareLeadMinutes * 60_000,
        templates: templatesOf(draft),
        // Always sent, and null when there is no pairing: "leave it alone"
        // and "unpair it" are different requests and the form has to be
        // able to say the second one.
        planSourceId: draft.repeat === 'plan' ? draft.planSourceId || null : null,
        planGroupId: draft.repeat === 'plan' ? draft.planGroupId || null : null,
      }
      if (saved) {
        // Captured before the series moves: re-basing needs the offsets as
        // they were, not as they will be.
        const holdStill = keepOutputTimes && shiftMs !== 0 ? [...moving] : []
        await api.updateSeries(saved.id, input)
        for (const output of holdStill) {
          await api.updateOutput(output.id, { offsetMs: output.offsetMs - shiftMs })
        }
        setKeepOutputTimes(false)
        setSaved({ ...saved, ...input, dtstart: saved.dtstart })
        const fresh = (await api.series()).find((row) => row.id === saved.id)
        if (fresh) setSaved(fresh)
      } else {
        const created = await api.createSeries(input)
        const fresh = (await api.series()).find((row) => row.id === created.id)
        setSaved(fresh)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={series ? `Edit ${series.label}` : 'Add an event'}>
      <ErrorBanner error={error} />
      <div className="split">
        <div className="stack">
          <Field label="Name" hint="What you will call it here, e.g. “Sunday Service”.">
            <input
              value={draft.label}
              placeholder="Sunday Service"
              onChange={(event) => set('label', event.target.value)}
            />
          </Field>

          <Field
            label="Timezone"
            hint="Times below are read in this zone, so a 9am service stays at 9am across a clock change."
          >
            <select
              value={draft.timezone}
              onChange={(event) => set('timezone', event.target.value)}
            >
              {zoneChoices(draft.timezone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>

          <div className="row">
            <Field label="First date">
              <input
                type="date"
                value={draft.date}
                onChange={(event) => set('date', event.target.value)}
              />
            </Field>
            <Field label="Start time">
              <input
                type="time"
                value={draft.time}
                onChange={(event) => set('time', event.target.value)}
              />
            </Field>
            <Field
              label="Length (min)"
              hint="Doors open to doors shut. Streams and recordings sit inside it."
            >
              <input
                type="number"
                min={1}
                value={draft.durationMinutes}
                onChange={(event) => set('durationMinutes', Number(event.target.value))}
              />
            </Field>
          </div>

          {/* Said before Save rather than discovered after it. The outputs
              follow the window because they are stored as offsets into it,
              which is what keeps a morning's shape when the morning moves. */}
          {shiftMs !== 0 && moving.length > 0 ? (
            <div className="banner info">
              <div>
                Saving moves this {describeShift(shiftMs)}.{' '}
                {keepOutputTimes
                  ? `Its ${countOf(moving.length)} stay where they are now.`
                  : `Its ${countOf(moving.length)} move with it: ${examplesOf(saved, moving, shiftMs)}`}
              </div>
              {stuck ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  Holding them at their current times is not possible here: “{stuck.label}” would
                  have to start before the event opens.
                </div>
              ) : (
                <label className="row" style={{ gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={keepOutputTimes}
                    onChange={(event) => setKeepOutputTimes(event.target.checked)}
                  />
                  <span>Keep them at their current times</span>
                </label>
              )}
            </div>
          ) : null}

          <Field label="Repeats">
            <select
              value={draft.repeat}
              onChange={(event) => set('repeat', event.target.value as Repeat)}
            >
              <option value="once">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month, on the same weekday</option>
              <option value="custom">Custom rule</option>
              <option value="plan">Whenever Planning Center says</option>
            </select>
          </Field>

          {draft.repeat === 'plan' ? (
            <PlanPairing
              sourceId={draft.planSourceId}
              groupId={draft.planGroupId}
              onChange={(next) =>
                setDraft((current) => ({
                  ...current,
                  planSourceId: next.sourceId,
                  planGroupId: next.groupId,
                }))
              }
            />
          ) : null}

          {draft.repeat === 'weekly' ? (
            <div className="row" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.code}
                  className={byday.includes(day.code) ? 'primary' : ''}
                  aria-pressed={byday.includes(day.code)}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      bydayTouched: true,
                      byday: byday.includes(day.code)
                        ? byday.filter((code) => code !== day.code)
                        : [...byday, day.code],
                    }))
                  }
                >
                  {day.label}
                </button>
              ))}
            </div>
          ) : null}

          {draft.repeat === 'custom' ? (
            <Field
              label="Custom rule"
              hint="An RFC 5545 RRULE, without the DTSTART line. e.g. FREQ=WEEKLY;BYDAY=SU,WE"
            >
              <input
                value={draft.customRrule}
                onChange={(event) => set('customRrule', event.target.value)}
              />
            </Field>
          ) : null}

          <Field
            label="Prepare early (min)"
            hint="How far ahead the broadcast is created and the encoders are pointed at it. Not when it goes on air."
          >
            <input
              type="number"
              min={0}
              value={draft.prepareLeadMinutes}
              onChange={(event) => set('prepareLeadMinutes', Number(event.target.value))}
            />
          </Field>

          <h3>Default names</h3>
          <p className="muted" style={{ margin: 0 }}>
            What every stream and recording is called unless it says otherwise. Tokens:{' '}
            <code>{'{{date "MMMM d, yyyy"}}'}</code>, <code>{'{{event.name}}'}</code>,{' '}
            <code>{'{{time}}'}</code>, <code>{'{{occurrence.index}}'}</code>. Dates resolve against
            the occurrence, in the zone above.
          </p>
          <Field label="Broadcast title">
            <input
              value={draft.title}
              placeholder={'{{event.name}} — {{date "MMMM d, yyyy"}}'}
              onChange={(event) => set('title', event.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              rows={3}
              value={draft.description}
              onChange={(event) => set('description', event.target.value)}
            />
          </Field>
          <Field label="Filename" hint="For recordings. The device adds its own extension.">
            <input
              value={draft.filename}
              placeholder={'{{date "yyyy-MM-dd"}} {{event.name}}'}
              onChange={(event) => set('filename', event.target.value)}
            />
          </Field>

          <div className="row">
            <button
              className="primary"
              disabled={saving || !draft.label}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : saved ? 'Save' : 'Create'}
            </button>
            <button onClick={onDone}>{saved ? 'Done' : 'Cancel'}</button>
          </div>
        </div>

        <PreviewPanel request={request} timezone={draft.timezone} />
      </div>

      {saved ? (
        <div style={{ marginTop: 16 }}>
          {/* Keyed on the version as well as the event, so saving a change to
              the window re-reads the outputs rather than rendering the last
              answer against the new start time. Editing an output from inside
              the panel does not change this key, so its own work is safe. */}
          <Outputs key={`${saved.id}:${saved.version}`} series={saved} />
        </div>
      ) : (
        <p className="muted" style={{ marginBottom: 0 }}>
          Create the event first. Its outputs — what it streams and records, and when — appear here.
        </p>
      )}
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
  // A paired event has no rule to produce anything, so the "this rule
  // produces nothing" line below would be nonsense for it.
  const isPaired = request.planSourceId !== undefined && request.planGroupId !== undefined

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
      {/* The rule and the names, as the server would actually resolve them. */}
      {problem ? <div className="banner error">{problem}</div> : null}
      {preview ? (
        <>
          <p className="muted">{preview.describes}</p>
          {/* A source that will not answer is its own message: falling back
              to "this rule produces nothing" would blame the rule for a
              network problem. */}
          {preview.error ? <div className="banner error">{preview.error}</div> : null}
          {preview.occurrences.length === 0 && !preview.error && !isPaired ? (
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
                {occurrence.error ? (
                  <div style={{ color: 'var(--bad)' }}>{occurrence.error}</div>
                ) : null}
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

/** `09:30` as minutes since midnight. */
function minutesOfDay(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return 0
  }
  return hour * 60 + minute
}

function describeShift(ms: number): string {
  const minutes = Math.abs(Math.round(ms / 60_000))
  const when = ms > 0 ? 'later' : 'earlier'
  if (minutes < 60) return `${minutes} minutes ${when}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const span = rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  return `${span} ${when}`
}

function countOf(n: number): string {
  return n === 1 ? 'one output' : `${n} outputs`
}

/** `9:30 → 10:30, 11:00 → 12:00`, for the first few. */
function examplesOf(
  series: Series | undefined,
  outputs: { offsetMs: number }[],
  shiftMs: number,
): string {
  if (!series) return ''
  const at = (offsetMs: number): string => timeInZone(series.dtstart + offsetMs, series.timezone)
  const shown = outputs
    .slice(0, 3)
    .map((output) => `${at(output.offsetMs)} → ${at(output.offsetMs + shiftMs)}`)
    .join(', ')
  return outputs.length > 3 ? `${shown}, …` : shown
}

function toDraft(series: Series | undefined): Draft {
  const zone = series?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const start = series?.dtstart ?? defaultStart()
  const parsed = parseRrule(series?.rrule ?? null)

  return {
    label: series?.label ?? '',
    timezone: zone,
    date: dateInZone(start, zone),
    time: timeInZone(start, zone),
    durationMinutes: Math.round((series?.durationMs ?? 90 * 60_000) / 60_000),
    prepareLeadMinutes: Math.round((series?.prepareLeadMs ?? 30 * 60_000) / 60_000),
    // A pairing wins over whatever rule is stored: the rule is kept so
    // unpairing has something to fall back to, but it is not what runs.
    repeat: series?.planSourceId && series.planGroupId ? 'plan' : parsed.repeat,
    byday: parsed.byday,
    // An existing series already says which days it runs; a new one follows
    // the first date until told otherwise.
    bydayTouched: parsed.byday.length > 0,
    customRrule: parsed.repeat === 'custom' ? (series?.rrule ?? '') : '',
    planSourceId: series?.planSourceId ?? '',
    planGroupId: series?.planGroupId ?? '',
    priorRrule: series?.rrule ?? null,
    title: series?.templates.title ?? '',
    description: series?.templates.description ?? '',
    filename: series?.templates.filename ?? '',
  }
}

/** The pairing, as the preview and save endpoints want it. */
function pairingOf(draft: Draft): { planSourceId?: string; planGroupId?: string } {
  if (draft.repeat !== 'plan' || !draft.planSourceId || !draft.planGroupId) return {}
  return { planSourceId: draft.planSourceId, planGroupId: draft.planGroupId }
}

/**
 * Choosing which service type this event follows.
 *
 * Deliberately says what changes rather than only offering a dropdown: an
 * event scheduled this way stops having a repeating rule, which is a bigger
 * change than a form field usually makes, and the weeks past the last
 * published plan go empty on purpose.
 */
function PlanPairing({
  sourceId,
  groupId,
  onChange,
}: {
  sourceId: string
  groupId: string
  onChange: (next: { sourceId: string; groupId: string }) => void
}): ReactNode {
  const sources = useResource(() => api.planSources(), [])
  const connected = (sources.data?.sources ?? []).filter(
    (source) => source.status.state !== 'not_configured',
  )
  // One source is the normal case, so it is chosen rather than asked about.
  const chosenSource = sourceId || connected[0]?.id || ''

  const groups = useResource(
    () => (chosenSource ? api.planGroups(chosenSource) : Promise.resolve({ groups: [] })),
    [chosenSource],
  )

  if (sources.data && connected.length === 0) {
    return (
      <div className="banner error">
        No schedule source is connected yet. Add a Planning Center token under Settings first.
      </div>
    )
  }

  return (
    <div className="stack">
      <ErrorBanner error={sources.error ?? groups.error} />
      {connected.length > 1 ? (
        <Field label="Source">
          <select
            value={chosenSource}
            onChange={(event) => onChange({ sourceId: event.target.value, groupId: '' })}
          >
            {connected.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field
        label="Service type"
        hint="Every service time in this service type becomes an occurrence — one week, two, or five."
      >
        <select
          value={groupId}
          onChange={(event) => onChange({ sourceId: chosenSource, groupId: event.target.value })}
        >
          <option value="">Choose a service type…</option>
          <GroupOptions groups={groups.data?.groups ?? []} />
        </select>
      </Field>

      <p className="muted" style={{ margin: 0 }}>
        The repeating rule stops being used. Weeks with no plan published yet show nothing, rather
        than a guess — and a plan edited after this event starts preparing is not acted on.
      </p>
    </div>
  )
}

function templatesOf(draft: Draft): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.title) out.title = draft.title
  if (draft.description) out.description = draft.description
  if (draft.filename) out.filename = draft.filename
  return out
}

function toRrule(draft: Draft, byday: string[]): string | null {
  switch (draft.repeat) {
    case 'once':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekly':
      // No day selected at all is a rule that would never fire, so fall back
      // to plain weekly rather than emitting BYDAY= with nothing after it.
      return byday.length > 0 ? `FREQ=WEEKLY;BYDAY=${byday.join(',')}` : 'FREQ=WEEKLY'
    case 'monthly':
      return 'FREQ=MONTHLY;BYDAY=' + nthWeekdayOf(draft)
    case 'custom':
      return draft.customRrule.trim() || null
    case 'plan':
      // Stored but not consulted while the pairing is in place. Kept as it
      // was so unpairing gives back the weekly this used to be, rather than
      // silently dropping it to "does not repeat".
      return draft.priorRrule
  }
}

/** `2SU` — the second Sunday — from the chosen first date. */
function nthWeekdayOf(draft: Draft): string {
  const [, , day] = draft.date.split('-').map(Number) as [number, number, number]
  const nth = Math.floor((day - 1) / 7) + 1
  return `${nth}${weekdayOf(draft.date)}`
}

/** The `SU`..`SA` code for a `YYYY-MM-DD` date. Read at noon UTC so the
 *  browser's own offset cannot roll it onto the day before. */
function weekdayOf(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return WEEKDAYS[Number.isNaN(day) ? 0 : day]!.code
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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

function timeInZone(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant)
}

/** Every zone the browser knows, with the current one guaranteed present. */
function zoneChoices(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [Intl.DateTimeFormat().resolvedOptions().timeZone]
  return supported.includes(current) ? supported : [current, ...supported]
}
