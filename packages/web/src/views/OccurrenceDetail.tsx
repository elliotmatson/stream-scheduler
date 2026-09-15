import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type OccurrenceDetail as Detail, type OccurrenceEdit } from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner, Fact, Field, PageHead } from '../components.tsx'
import { dateTimeIn, duration, inputTimeIn, localDateKey, shortZone, timeIn } from '../format.ts'

/**
 * One morning of a repeating event, and changing just that one.
 *
 * The screen that was missing: the calendar has always linked here and
 * there was nothing to land on. It exists for the question every calendar
 * has to answer — "this one, or every one of them?" — and both answers go
 * somewhere real. This one writes an override on the occurrence; every one
 * of them is the series form, which is where that edit belongs and where
 * somebody can see the rule they are about to change.
 *
 * An edited occurrence stops following its series for good. That is the
 * behaviour people expect and it is also a trap, so it is stated on the
 * screen and there is always a way back.
 */
export function OccurrenceDetail({
  occurrenceId,
  navigate,
}: {
  occurrenceId: string
  navigate: (path: string) => void
}): ReactNode {
  const { data, error, reload } = useResource(() => api.occurrence(occurrenceId), [occurrenceId])
  const [problem, setProblem] = useState<string>()

  if (error) {
    return (
      <>
        <PageHead
          title="Event"
          back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
        />
        <ErrorBanner error={error} />
      </>
    )
  }
  if (!data) return null

  const zone = data.timezone
  const past = data.status !== 'pending'

  return (
    <>
      <PageHead
        title={data.label}
        subtitle={`${dateTimeIn(data.scheduledStart, zone)} ${shortZone(data.scheduledStart, zone)} · ${duration(data.scheduledEnd - data.scheduledStart)}`}
        back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
        actions={
          data.runId ? (
            <button onClick={() => navigate(`/runs/${data.runId}`)}>Open the run</button>
          ) : null
        }
      />
      <ErrorBanner error={problem} />

      <div className="stack">
        <Card>
          <div className="row" style={{ gap: 18 }}>
            <Fact
              label="Event"
              value={data.seriesLabel}
              tip="The repeating event this is one of."
            />
            <Fact label="Date" value={localDateKey(data.scheduledStart, zone)} />
            <Fact
              label="Starts"
              value={`${timeIn(data.scheduledStart, zone)} ${shortZone(data.scheduledStart, zone)}`}
            />
            <Fact label="Runs for" value={duration(data.scheduledEnd - data.scheduledStart)} />
            <Fact label="State" value={data.status} />
          </div>

          {data.detached ? (
            <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
              Changed on its own, so it no longer follows «{data.seriesLabel}». Editing the event
              will leave this one where it is.
              {data.overrides.movedFrom === undefined
                ? ''
                : ` Moved from ${dateTimeIn(data.overrides.movedFrom, zone)}.`}
            </p>
          ) : null}

          <div className="row" style={{ marginTop: 10 }}>
            <button
              title="Opens the event itself, where a change applies to every date it has."
              onClick={() => navigate('/events')}
            >
              Edit every one of them
            </button>
            {data.detached ? (
              <ConfirmButton
                label="Put this one back on the event"
                confirmLabel="Really undo the changes?"
                disabled={past}
                onConfirm={() => {
                  setProblem(undefined)
                  api
                    .revertOccurrence(data.id)
                    .then(reload, (err: Error) => setProblem(err.message))
                }}
              />
            ) : null}
          </div>
        </Card>

        {past ? (
          <Card title="Just this one">
            <Empty>This is {data.status}, so it can no longer be changed. What ran, ran.</Empty>
          </Card>
        ) : (
          <EditOne detail={data} onSaved={reload} onProblem={setProblem} />
        )}

        <Card title="What goes out">
          {data.outputs.length === 0 ? (
            <Empty>This event has no outputs set up.</Empty>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {data.outputs.map((output) => (
                <div key={output.outputId} className="onair-output">
                  <span className="state-dot" aria-hidden />
                  <div className="onair-name">{output.label}</div>
                  <div className="onair-actions" />
                  <div className="onair-meta muted">
                    <span>{output.kind === 'recording' ? 'Records' : 'Streams'}</span>
                    <span>
                      {timeIn(output.startsAt, zone)}–{timeIn(output.endsAt, zone)}
                    </span>
                    {output.title ? <span title={output.title}>{output.title}</span> : null}
                    {output.filename ? (
                      <span title={output.filename}>{output.filename}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

interface Draft {
  label: string
  date: string
  time: string
  minutes: number
  title: string
  description: string
  filename: string
}

/** What the form should show when nothing has been typed into it yet. */
function draftOf(detail: Detail): Draft {
  const zone = detail.timezone
  return {
    // The occurrence's own values where it has them, and the series' where
    // it does not — so the boxes read as what will happen, which is what
    // somebody is checking when they open this.
    label: detail.overrides.label ?? detail.seriesLabel,
    date: localDateKey(detail.scheduledStart, zone),
    time: inputTimeIn(detail.scheduledStart, zone),
    minutes: Math.round((detail.scheduledEnd - detail.scheduledStart) / 60_000),
    title: detail.overrides.templates?.title ?? detail.seriesTemplates.title ?? '',
    description:
      detail.overrides.templates?.description ?? detail.seriesTemplates.description ?? '',
    filename: detail.overrides.templates?.filename ?? detail.seriesTemplates.filename ?? '',
  }
}

/**
 * The edit itself.
 *
 * Only what belongs to one morning: its name, when it runs, how long for,
 * and the templates the outputs render. Devices, services and the outputs
 * themselves are the event's, because "just this week we use a different
 * encoder" is a different feature and pretending otherwise here would
 * silently change every week.
 */
function EditOne({
  detail,
  onSaved,
  onProblem,
}: {
  detail: Detail
  onSaved: () => void
  onProblem: (message: string | undefined) => void
}): ReactNode {
  const original = draftOf(detail)
  const [draft, setDraft] = useState<Draft>(original)
  const [saving, setSaving] = useState(false)

  // A save reloads the occurrence, and the boxes follow what came back
  // rather than holding on to what was typed.
  useEffect(() => setDraft(draftOf(detail)), [detail])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  const changed = (Object.keys(original) as (keyof Draft)[]).some(
    (key) => draft[key] !== original[key],
  )

  const save = (): void => {
    onProblem(undefined)
    setSaving(true)

    // Only what actually differs is sent, and a box cleared back to what
    // the series says clears the override rather than pinning the same
    // value onto this one for ever.
    const edit: OccurrenceEdit = {}
    if (draft.label !== original.label) {
      edit.label = draft.label === detail.seriesLabel ? null : draft.label
    }
    if (draft.date !== original.date || draft.time !== original.time) {
      edit.startsAt = { date: draft.date, time: draft.time }
    }
    if (draft.minutes !== original.minutes) edit.durationMs = draft.minutes * 60_000
    if (
      draft.title !== original.title ||
      draft.description !== original.description ||
      draft.filename !== original.filename
    ) {
      const templates: Record<string, string> = {}
      if (draft.title) templates.title = draft.title
      if (draft.description) templates.description = draft.description
      if (draft.filename) templates.filename = draft.filename
      edit.templates = Object.keys(templates).length > 0 ? templates : null
    }

    api.editOccurrence(detail.id, edit).then(
      () => {
        setSaving(false)
        onSaved()
      },
      (err: Error) => {
        setSaving(false)
        onProblem(err.message)
      },
    )
  }

  return (
    <Card title="Just this one">
      <p className="muted" style={{ marginTop: -4, fontSize: 12 }}>
        Changes only this date. Every other one keeps following the event.
      </p>
      <div className="stack">
        <Field label="Called" hint="What this one morning is called, if it is not the usual.">
          <input value={draft.label} onChange={(event) => set('label', event.target.value)} />
        </Field>

        <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
          <Field label="Date">
            <input
              type="date"
              value={draft.date}
              onChange={(event) => set('date', event.target.value)}
            />
          </Field>
          <Field label="Starts" hint={`In ${detail.timezone}.`}>
            <input
              type="time"
              value={draft.time}
              onChange={(event) => set('time', event.target.value)}
            />
          </Field>
          <Field label="Runs for (minutes)">
            <input
              type="number"
              min={1}
              max={24 * 60}
              value={draft.minutes}
              onChange={(event) => set('minutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <Field label="Stream title" hint="Left blank, the outputs use the event's own template.">
          <input value={draft.title} onChange={(event) => set('title', event.target.value)} />
        </Field>
        <Field label="Description">
          <textarea
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
        <Field label="Recording filename" hint="The device adds its own extension.">
          <input value={draft.filename} onChange={(event) => set('filename', event.target.value)} />
        </Field>

        <div className="row">
          <button className="primary" disabled={!changed || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save just this one'}
          </button>
          {changed ? <button onClick={() => setDraft(original)}>Cancel</button> : null}
          {changed && !detail.detached ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Saving detaches this date: later changes to the event will leave it alone.
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
