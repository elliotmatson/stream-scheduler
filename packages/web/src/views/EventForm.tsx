import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type EventOutput,
  type OutputInput,
  type SchedulePreview,
  type Series,
} from '../api.ts'
import { DraftOutputs, Outputs } from './Outputs.tsx'
import { GroupOptions } from './PlanSource.tsx'
import { Card, ErrorBanner, Field, TemplateTokens } from '../components.tsx'
import { shortZone, timeIn } from '../format.ts'
import {
  clockPlus,
  minutesOfDay,
  parseRrule,
  toRrule,
  weekdayOf,
  WEEKDAYS,
  type Repeat,
} from '../event-rules.ts'
import { commonZones, zoneChoices, zoneName } from '../zones.ts'
import { changedKeys, changesLabel, useUnsavedGuard } from '../unsaved.ts'

interface Draft {
  label: string
  timezone: string
  date: string
  time: string
  durationMinutes: number
  prepareLeadMinutes: number
  repeat: Repeat
  /** The builder's parts: every how many, which kind of monthly, and when
   *  it stops. See `toRrule`. */
  interval: number
  monthlyBy: 'weekday' | 'day'
  ends: 'never' | 'on' | 'after'
  until: string
  count: number
  /** For a Planning Center event: one per service time, or one per plan. */
  planMode: 'time' | 'plan'
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
  // What it will stream and record, held here until the event is created.
  const [draftOutputs, setDraftOutputs] = useState<OutputInput[]>([])
  /** Hold the outputs at their clock times rather than letting them follow. */
  const [keepOutputTimes, setKeepOutputTimes] = useState(false)
  // An event has to exist before its outputs can hang off it. Rather than
  // hiding that, a new event saves and then reveals the outputs editor in
  // place, so the flow is one screen either way.
  const [saved, setSaved] = useState<Series | undefined>(series)

  // What is saved, to show what has changed and to go back to. A new event
  // has nothing saved, so it counts as changed once anything is typed.
  const original = useMemo(() => (saved ? toDraft(saved) : undefined), [saved])
  const changed: (keyof Draft)[] = original
    ? changedKeys(original, draft).filter((key) => key !== 'bydayTouched')
    : []
  const isChanged = (...keys: (keyof Draft)[]): boolean => keys.some((key) => changed.includes(key))
  useUnsavedGuard(saved ? changed.length > 0 : draft.label !== '' || draftOutputs.length > 0)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  // A new event is in the install's timezone, set once under Settings,
  // rather than asking every time.
  const { data: general } = useResource(() => api.generalSettings(), [])
  const [zoneTouched, setZoneTouched] = useState(false)
  useEffect(() => {
    if (series || zoneTouched || !general?.timezone) return
    setDraft((current) => ({ ...current, timezone: general.timezone! }))
  }, [series, zoneTouched, general?.timezone])

  // Until the operator picks days themselves, "every week" means the weekday
  // of the first date. Deriving it here rather than freezing it at mount is
  // what stops "Sunday Service, first date the 20th" quietly recurring on
  // Tuesdays because that was the default date when the form opened.
  const byday = useMemo(
    () => (draft.bydayTouched ? draft.byday : [weekdayOf(draft.date)]),
    [draft.bydayTouched, draft.byday, draft.date],
  )
  const rrule = useMemo(() => toRrule(draft, byday), [draft, byday])
  /** True when the schedule comes from a plan, so the fields the plan
   *  supplies can say so rather than sitting there looking editable. */
  const fromPlan = draft.repeat === 'plan'
  // What each date sends out, for the preview: the saved event's outputs,
  // or the ones being added to a new one.
  const { data: savedOutputs } = useResource(
    () => (saved ? api.outputs(saved.id) : Promise.resolve(undefined)),
    [saved?.id, saved?.version],
  )
  const previewOutputs = useMemo(
    () =>
      (saved ? (savedOutputs?.outputs ?? []) : draftOutputs).map((output) => ({
        label: output.label,
        kind: output.kind,
        offsetMs: output.offsetMs ?? 0,
        durationMs: output.durationMs,
        followsWindow: output.followsWindow ?? false,
        stopAfterMs: output.stopAfterMs ?? 0,
        templates: output.templates ?? {},
      })),
    [saved, savedOutputs, draftOutputs],
  )
  const request = useMemo(
    () => ({
      label: draft.label || 'Untitled event',
      timezone: draft.timezone,
      rrule,
      dtstartLocal: { date: draft.date, time: draft.time },
      durationMs: draft.durationMinutes * 60_000,
      templates: templatesOf(draft),
      count: 5,
      outputs: previewOutputs,
      planMode: draft.planMode,
      ...pairingOf(draft),
    }),
    [draft, rrule, previewOutputs],
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
        planMode: draft.planMode,
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
        if (fresh) {
          setSaved(fresh)
          // The boxes follow what was stored, so nothing reads as unsaved.
          setDraft(toDraft(fresh))
        }
      } else {
        const created = await api.createSeries({ ...input, outputs: draftOutputs })
        setDraftOutputs([])
        const fresh = (await api.series()).find((row) => row.id === created.id)
        setSaved(fresh)
        if (fresh) setDraft(toDraft(fresh))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={series ? `Edit ${series.label}` : undefined}>
      <ErrorBanner error={error} />
      <div className="split">
        <div className="stack">
          <Field label="Name" changed={isChanged('label')}>
            <input
              value={draft.label}
              placeholder="Sunday Service"
              onChange={(event) => set('label', event.target.value)}
            />
          </Field>

          <Field label="Repeats" changed={isChanged('repeat', 'customRrule')}>
            <select
              value={draft.repeat}
              onChange={(event) => set('repeat', event.target.value as Repeat)}
            >
              <option value="once">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="plan">From Planning Center</option>
              <option value="custom">Custom rule</option>
            </select>
          </Field>

          {draft.repeat === 'plan' ? (
            <>
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
              <Field label="Make an event for" changed={isChanged('planMode')}>
                <select
                  value={draft.planMode}
                  onChange={(event) => set('planMode', event.target.value as 'time' | 'plan')}
                >
                  <option value="time">Each service time</option>
                  <option value="plan">Each plan, from its first time to its last</option>
                </select>
              </Field>
            </>
          ) : null}

          <div className="row">
            {/* A paired event does not run at a time this form decides:
                Planning Center supplies the date and the start. So the two
                boxes go away rather than sitting there greyed out. */}
            {fromPlan ? null : (
              <>
                <Field label="First date" changed={isChanged('date')}>
                  <input
                    type="date"
                    value={draft.date}
                    onChange={(event) => set('date', event.target.value)}
                  />
                </Field>
                <Field label="Start time" changed={isChanged('time')}>
                  <input
                    type="time"
                    value={draft.time}
                    onChange={(event) => set('time', event.target.value)}
                  />
                </Field>
              </>
            )}
            <Field
              label="Length (min)"
              changed={isChanged('durationMinutes')}
              hint={
                fromPlan
                  ? 'For a service time with no end in the plan.'
                  : `Ends at ${clockPlus(draft.time, draft.durationMinutes)}.`
              }
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

          {['daily', 'weekly', 'monthly'].includes(draft.repeat) ? (
            <div className="row">
              <Field label="Every" changed={isChanged('interval')}>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    style={{ width: 72 }}
                    value={draft.interval}
                    onChange={(event) => set('interval', Math.max(1, Number(event.target.value)))}
                  />
                  <span>{unitOf(draft.repeat, draft.interval)}</span>
                </span>
              </Field>
              {draft.repeat === 'monthly' ? (
                <Field label="On" changed={isChanged('monthlyBy')}>
                  <select
                    value={draft.monthlyBy}
                    onChange={(event) => set('monthlyBy', event.target.value as 'weekday' | 'day')}
                  >
                    <option value="weekday">The {ordinalWeekday(draft.date)}</option>
                    <option value="day">Day {Number(draft.date.split('-')[2])}</option>
                  </select>
                </Field>
              ) : null}
              <Field label="Ends" changed={isChanged('ends')}>
                <select
                  value={draft.ends}
                  onChange={(event) => set('ends', event.target.value as 'never' | 'on' | 'after')}
                >
                  <option value="never">Never</option>
                  <option value="on">On a date</option>
                  <option value="after">After a number of times</option>
                </select>
              </Field>
              {draft.ends === 'on' ? (
                <Field label="Last date" changed={isChanged('until')}>
                  <input
                    type="date"
                    value={draft.until}
                    onChange={(event) => set('until', event.target.value)}
                  />
                </Field>
              ) : null}
              {draft.ends === 'after' ? (
                <Field label="Times" changed={isChanged('count')}>
                  <input
                    type="number"
                    min={1}
                    style={{ width: 80 }}
                    value={draft.count}
                    onChange={(event) => set('count', Math.max(1, Number(event.target.value)))}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {draft.repeat === 'custom' ? (
            <Field
              label="Custom rule"
              changed={isChanged('customRrule')}
              hint="An iCalendar RRULE, e.g. FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24"
            >
              <input
                value={draft.customRrule}
                onChange={(event) => set('customRrule', event.target.value)}
              />
            </Field>
          ) : null}

          {/* Everything a volunteer can leave alone. */}
          <details className="more-options">
            <summary>More options</summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <Field
                label="Time zone"
                changed={isChanged('timezone')}
                hint="Set once for everything under Settings. Change it here only for an event somewhere else."
              >
                <select
                  value={draft.timezone}
                  onChange={(event) => {
                    setZoneTouched(true)
                    set('timezone', event.target.value)
                  }}
                >
                  <optgroup label="Common">
                    {commonZones(draft.timezone).map((zone) => (
                      <option key={zone} value={zone}>
                        {zoneName(zone)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Everywhere else">
                    {zoneChoices(draft.timezone)
                      .filter((zone) => !commonZones(draft.timezone).includes(zone))
                      .map((zone) => (
                        <option key={zone} value={zone}>
                          {zone.replace(/_/g, ' ')}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </Field>

              <Field
                label="Prepare early (min)"
                changed={isChanged('prepareLeadMinutes')}
                hint={
                  fromPlan
                    ? 'Creates the broadcast on YouTube or Twitch this long before each service, so its link can go out. Nothing goes on air. "Prepare now" on the event does it by hand.'
                    : `Creates the broadcast on YouTube or Twitch at ${clockPlus(draft.time, -draft.prepareLeadMinutes)}, so its link can go out. Nothing goes on air. "Prepare now" on the event does it by hand.`
                }
              >
                <input
                  type="number"
                  min={0}
                  value={draft.prepareLeadMinutes}
                  onChange={(event) => set('prepareLeadMinutes', Number(event.target.value))}
                />
              </Field>

              <strong>Names</strong>
              <TemplateTokens plan={draft.repeat === 'plan'} />
              <Field label="Broadcast title" changed={isChanged('title')}>
                <input
                  value={draft.title}
                  placeholder="{{event.name}}"
                  onChange={(event) => set('title', event.target.value)}
                />
              </Field>
              <Field label="Description" changed={isChanged('description')}>
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) => set('description', event.target.value)}
                />
              </Field>
              <Field
                label="Filename"
                hint="For recordings. The device adds its own extension."
                changed={isChanged('filename')}
              >
                <input
                  value={draft.filename}
                  placeholder={'{{date "yyyy-MM-dd"}} {{event.name}}'}
                  onChange={(event) => set('filename', event.target.value)}
                />
              </Field>
            </div>
          </details>

          {saved ? (
            <div className="save-bar">
              <button
                className="primary"
                disabled={saving || !draft.label || changed.length === 0}
                onClick={() => void save()}
              >
                {saving
                  ? 'Saving…'
                  : changed.length > 0
                    ? `Save ${changesLabel(changed.length)}`
                    : 'Saved'}
              </button>
              {changed.length > 0 && original ? (
                <button onClick={() => setDraft(original)}>Revert</button>
              ) : null}
              <button onClick={onDone}>Done</button>
            </div>
          ) : null}
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
        <div style={{ marginTop: 16 }}>
          <DraftOutputs
            event={{
              time: draft.time,
              durationMs: draft.durationMinutes * 60_000,
              paired: draft.repeat === 'plan',
              templates: templatesOf(draft),
            }}
            value={draftOutputs}
            onChange={setDraftOutputs}
          />
          {/* Last on the page: the event and everything it sends out are
              made together, so the button that does it comes after both. */}
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="primary"
              disabled={saving || !draft.label}
              onClick={() => void save()}
            >
              {saving
                ? 'Creating…'
                : draftOutputs.length > 0
                  ? `Create with ${draftOutputs.length} output${draftOutputs.length === 1 ? '' : 's'}`
                  : 'Create'}
            </button>
            <button onClick={onDone}>Cancel</button>
          </div>
        </div>
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
      <h3 style={{ marginTop: 0 }}>Preview</h3>
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
                  <strong>{occurrence.localDate}</strong> {timeIn(occurrence.start, timezone)}–
                  {timeIn(occurrence.end, timezone)}{' '}
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
                {occurrence.outputs && occurrence.outputs.length > 0 ? (
                  // What actually goes out that day, each under its own
                  // name, which is what gets checked before a Sunday.
                  <ul className="preview-outputs">
                    {occurrence.outputs.map((output, index) => (
                      <li key={`${output.label}-${index}`}>
                        <span className="muted">
                          {timeIn(output.startsAt, timezone)}–{timeIn(output.endsAt, timezone)}
                        </span>{' '}
                        {output.kind === 'stream' ? 'Stream' : 'Recording'}:{' '}
                        {output.kind === 'stream'
                          ? (output.title ?? output.label)
                          : (output.filename ?? output.label)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    {occurrence.title ? <div>{occurrence.title}</div> : null}
                    {occurrence.filename ? (
                      <div className="muted">{occurrence.filename}</div>
                    ) : null}
                  </>
                )}
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
    interval: parsed.interval,
    monthlyBy: parsed.monthlyBy,
    ends: parsed.ends,
    until: parsed.until,
    count: parsed.count,
    planMode: series?.planMode ?? 'time',
    // An existing series already says which days it runs; a new one follows
    // the first date until told otherwise.
    bydayTouched: parsed.byday.length > 0,
    customRrule: parsed.repeat === 'custom' ? (series?.rrule ?? '') : '',
    planSourceId: series?.planSourceId ?? '',
    planGroupId: series?.planGroupId ?? '',
    priorRrule: series?.rrule ?? null,
    // A new event is named after itself until somebody says otherwise.
    // The filename carries the date too, so one week's recording does not
    // land on top of the last on the same card.
    title: series ? (series.templates.title ?? '') : '{{event.name}}',
    description: series?.templates.description ?? '',
    filename: series ? (series.templates.filename ?? '') : '{{date "yyyy-MM-dd"}} {{event.name}}',
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
        Dates come from Planning Center. A plan changed after preparing starts is not picked up.
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

/** "day", "weeks" — the unit beside the "Every" box. */
function unitOf(repeat: Repeat, interval: number): string {
  const unit = repeat === 'daily' ? 'day' : repeat === 'weekly' ? 'week' : 'month'
  return interval === 1 ? unit : `${unit}s`
}

/** "third Sunday" for a date, for the monthly choice. */
function ordinalWeekday(date: string): string {
  const day = Number(date.split('-')[2])
  const nth = ['first', 'second', 'third', 'fourth', 'fifth'][Math.floor((day - 1) / 7)] ?? 'last'
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  })
  return `${nth} ${weekday}`
}
