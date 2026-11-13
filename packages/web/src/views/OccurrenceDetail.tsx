import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type OccurrenceDetail as Detail } from '../api.ts'
import { draftOf, editOf, type Draft } from '../occurrence-edit.ts'
import { changedKeys, changesLabel, useUnsavedGuard } from '../unsaved.ts'
import {
  Card,
  ConfirmButton,
  CopyButton,
  Empty,
  ErrorBanner,
  Field,
  PageHead,
  StatusPill,
  TemplateTokens,
} from '../components.tsx'
import { TagEditor } from '../tags.tsx'
import { EventForm } from './EventForm.tsx'
import { dateTimeIn, shortZone, timeIn } from '../format.ts'

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
  const { data: allSeries, reload: reloadSeries } = useResource(() => api.series(), [])
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [links, setLinks] = useState<{ label: string; url: string }[]>()
  const [scope, setScope] = useState<'one' | 'all'>('one')

  if (error) {
    return (
      <>
        <PageHead
          title="Event"
          back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
        />
        <ErrorBanner error={error} />
        <p className="muted">If you just moved it, it is on the schedule at its new time.</p>
      </>
    )
  }
  if (!data) return null

  const zone = data.timezone
  const series = allSeries?.find((entry) => entry.id === data.seriesId)
  // Whether "this one or all of them" is a real question.
  const repeats = Boolean(series && (series.rrule || series.planSourceId))
  const running = data.runState === 'running' || data.status === 'running'
  const pending = data.status === 'pending' && !running
  const rearmable = ['failed', 'cancelled'].includes(data.status) && data.scheduledEnd > Date.now()
  const past = data.status !== 'pending'

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
      reload()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title={data.label}
        subtitle={`${dateTimeIn(data.scheduledStart, zone)}–${timeIn(data.scheduledEnd, zone)} ${shortZone(data.scheduledStart, zone)}${series && repeats ? ` · ${series.describes}` : ''}`}
        back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
        actions={<StatusPill status={data.runState ?? data.status} />}
      />
      <ErrorBanner error={problem} />

      <div className="stack">
        {/* What can be done to it right now, and nothing that cannot. */}
        <div className="row">
          {pending ? (
            <>
              <button
                disabled={busy}
                title="Creates the broadcast now, so its link can go out. Nothing goes on air."
                onClick={() =>
                  void act(async () => setLinks((await api.prepareNow(data.id)).links))
                }
              >
                Prepare now
              </button>
              <ConfirmButton
                className=""
                label="Start now"
                confirmLabel="Go on air now?"
                disabled={busy}
                onConfirm={() => void act(() => api.startNow(data.id))}
              />
              <button disabled={busy} onClick={() => void act(() => api.skip(data.id))}>
                Skip
              </button>
            </>
          ) : null}
          {running && data.runId ? (
            <ConfirmButton
              label="Stop now"
              confirmLabel="Stop every stream and recording?"
              disabled={busy}
              onConfirm={() =>
                void act(() => api.cancelRun(data.runId!, 'Stopped from the event page.'))
              }
            />
          ) : null}
          {data.status === 'skipped' ? (
            <button disabled={busy} onClick={() => void act(() => api.unskip(data.id))}>
              Unskip
            </button>
          ) : null}
          {rearmable ? (
            <button disabled={busy} onClick={() => void act(() => api.rearm(data.id))}>
              Schedule again
            </button>
          ) : null}
          {data.runId ? (
            <button onClick={() => navigate(`/runs/${data.runId}`)}>Event log</button>
          ) : null}
        </div>

        {links && links.length > 0 ? (
          <div className="banner info">
            Ready to share:{' '}
            {links.map((link) => (
              <CopyButton key={link.url} value={link.url} label={`Copy ${link.label}`} />
            ))}
          </div>
        ) : null}

        <Card title="What goes out">
          {data.outputs.length === 0 ? (
            <Empty>Nothing streams or records yet. Add a stream under All events.</Empty>
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

        {/* Editing. A repeating event asks which: this date on its own, or
            every date — the question every calendar asks. A one-off has
            only itself, so it goes straight to the form. */}
        {repeats ? (
          <div className="toggle" role="group" aria-label="What to change">
            <button aria-pressed={scope === 'one'} onClick={() => setScope('one')}>
              This event only
            </button>
            <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              All events in the series
            </button>
          </div>
        ) : null}

        {repeats && scope === 'one' ? (
          past ? (
            <Card>
              <Empty>This has already {data.status}, so it can no longer be changed.</Empty>
            </Card>
          ) : (
            <>
              <EditOne detail={data} onSaved={reload} onProblem={setProblem} />
              {data.detached ? (
                <p className="muted" style={{ margin: 0 }}>
                  Changed on its own, so changes to the series leave it alone.{' '}
                  <ConfirmButton
                    className="link"
                    label="Undo the changes"
                    confirmLabel="Really undo them?"
                    onConfirm={() => void act(() => api.revertOccurrence(data.id))}
                  />
                </p>
              ) : null}
            </>
          )
        ) : series ? (
          <>
            <EventForm
              key={`${series.id}-${series.version}`}
              series={series}
              onDone={() => {
                reloadSeries()
                reload()
              }}
            />
            <Card>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <TagEditor
                  kind="series"
                  id={series.id}
                  tags={series.tags ?? []}
                  onChanged={reloadSeries}
                />
                <ConfirmButton
                  label={repeats ? 'Delete the whole series' : 'Delete this event'}
                  confirmLabel={repeats ? 'Delete it and every date?' : 'Delete it?'}
                  onConfirm={() =>
                    void act(async () => {
                      await api.deleteSeries(series.id)
                      navigate('/schedule')
                    })
                  }
                />
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </>
  )
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

  const changedList = changedKeys(original, draft)
  const changed = changedList.length > 0
  const isChanged = (key: keyof Draft): boolean => changedList.includes(key)
  useUnsavedGuard(changed)

  const save = (): void => {
    onProblem(undefined)
    setSaving(true)

    // Only what actually differs is sent, and a box cleared back to what
    // the series says clears the override rather than pinning the same
    // value onto this one for ever.
    const edit = editOf(detail, original, draft)

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
        <Field
          label="Called"
          hint="What this one morning is called, if it is not the usual."
          changed={isChanged('label')}
        >
          <input value={draft.label} onChange={(event) => set('label', event.target.value)} />
        </Field>

        <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
          <Field label="Date" changed={isChanged('date')}>
            <input
              type="date"
              value={draft.date}
              onChange={(event) => set('date', event.target.value)}
            />
          </Field>
          <Field label="Starts" hint={`In ${detail.timezone}.`} changed={isChanged('time')}>
            <input
              type="time"
              value={draft.time}
              onChange={(event) => set('time', event.target.value)}
            />
          </Field>
          <Field label="Runs for (minutes)" changed={isChanged('minutes')}>
            <input
              type="number"
              min={1}
              max={24 * 60}
              value={draft.minutes}
              onChange={(event) => set('minutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <TemplateTokens plan={detail.fromPlan === true} />

        <Field
          label="Stream title"
          hint="Left blank, the outputs use the event's own template."
          changed={isChanged('title')}
        >
          <input value={draft.title} onChange={(event) => set('title', event.target.value)} />
        </Field>
        <Field label="Description" changed={isChanged('description')}>
          <textarea
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
        <Field
          label="Recording filename"
          hint="The device adds its own extension."
          changed={isChanged('filename')}
        >
          <input value={draft.filename} onChange={(event) => set('filename', event.target.value)} />
        </Field>

        <div className="save-bar">
          <button className="primary" disabled={!changed || saving} onClick={save}>
            {saving
              ? 'Saving…'
              : changed
                ? `Save ${changesLabel(changedList.length)} to this date`
                : 'Saved'}
          </button>
          {changed ? <button onClick={() => setDraft(original)}>Revert</button> : null}
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
