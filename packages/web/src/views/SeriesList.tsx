import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Series } from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner, PageHead } from '../components.tsx'
import { duration, timeIn } from '../format.ts'
import { EventForm } from './EventForm.tsx'

/** The stored template keys, in the words the form uses for them. */
const TEMPLATE_LABELS: Record<string, string> = {
  title: 'Broadcast title',
  description: 'Description',
  filename: 'Filename',
}

export function SeriesList(): ReactNode {
  const { data, error, reload } = useResource(() => api.series(), [])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [actionError, setActionError] = useState<string>()

  const remove = async (id: string): Promise<void> => {
    setActionError(undefined)
    try {
      await api.deleteSeries(id)
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <PageHead
        title="Events"
        subtitle="What runs, when it runs, and what it is called."
        actions={
          <button className="primary" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : 'Add an event'}
          </button>
        }
      />
      <ErrorBanner error={error ?? actionError} />

      <div className="stack">
        {adding ? (
          <EventForm
            onDone={() => {
              setAdding(false)
              reload()
            }}
          />
        ) : null}

        {(data ?? []).length === 0 && !adding ? (
          <Card>
            <Empty>
              No events yet. An event is one service or programme, with the dates it falls on.
            </Empty>
          </Card>
        ) : null}

        {(data ?? []).map((series) =>
          editing === series.id ? (
            <EventForm
              key={series.id}
              series={series}
              onDone={() => {
                setEditing(undefined)
                reload()
              }}
            />
          ) : (
            <SeriesCard
              key={series.id}
              series={series}
              onEdit={() => setEditing(series.id)}
              onRemove={() => void remove(series.id)}
            />
          ),
        )}
      </div>
    </>
  )
}

function SeriesCard({
  series,
  onEdit,
  onRemove,
}: {
  series: Series
  onEdit: () => void
  onRemove: () => void
}): ReactNode {
  const { data: preview } = useResource(() => api.preview(series.id), [series.id])

  // `nextAt` is null when nothing is left: a one-off whose date has gone,
  // or a repeat whose rule has run out. Undefined means an older server
  // that does not answer the question, and an unanswered question is not
  // an event to mark as over.
  const finished = series.nextAt === null

  return (
    <Card className={finished ? 'is-finished' : undefined}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>
            {series.label}
            {finished ? (
              <span
                className="pill warn"
                style={{ marginLeft: 8, verticalAlign: 'middle' }}
                title="Every date this event was going to run has passed. It will not run again unless its schedule is changed."
              >
                finished
              </span>
            ) : null}
          </h2>
          <span
            className="muted"
            title="How often it repeats, the zone its times are read in, and how long its window is."
          >
            {series.describes} · {series.timezone} · {duration(series.durationMs)}
          </span>
        </div>
        <div className="row">
          <span
            className="muted"
            title="How far ahead the broadcast is created and the encoders are pointed at it."
          >
            prepares {duration(series.prepareLeadMs)} early
          </span>
          <button onClick={onEdit}>Edit</button>
          <ConfirmButton label="Remove" onConfirm={onRemove} />
        </div>
      </div>

      {Object.keys(series.templates).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th title="Tokens are filled in against each date when the event runs.">Pattern</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(series.templates).map(([key, pattern]) => (
                <tr key={key}>
                  <td>{TEMPLATE_LABELS[key] ?? key}</td>
                  <td className="step-kind">{pattern}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/*
        Rendering the next few occurrences catches essentially every template
        mistake before it ships — including the timezone ones, because seeing
        "Saturday" where you expected "Sunday" is immediately obvious.
      */}
      {preview && preview.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h2>The next {preview.length}, as they will be named</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.map((item) => (
              <li key={item.occurrenceId} style={item.error ? { color: 'var(--bad)' } : undefined}>
                {item.error ?? (
                  <>
                    {(item.outputs ?? []).length === 0 ? (
                      <span className="muted">nothing streams or records on this one</span>
                    ) : null}
                    {(item.outputs ?? []).map((output) => (
                      <div key={output.outputId}>
                        <span className="muted">{timeIn(output.startsAt, series.timezone)}</span>{' '}
                        {output.title ?? output.filename ?? output.label}
                      </div>
                    ))}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}
