import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Series } from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner } from '../components.tsx'
import { duration } from '../format.ts'
import { EventForm } from './EventForm.tsx'

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
      <div className="page-head">
        <div>
          <h1>Events</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            What runs, when, and under what name.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding((open) => !open)}>
          {adding ? 'Cancel' : 'New event'}
        </button>
      </div>
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
            <Empty>No recurring events yet.</Empty>
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

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{series.label}</h2>
          <span className="muted">
            {series.rrule ?? 'Once'} · {series.timezone} · {duration(series.durationMs)}
          </span>
        </div>
        <div className="row">
          <span className="muted">prepares {duration(series.prepareLeadMs)} early</span>
          <button onClick={onEdit}>Edit</button>
          <ConfirmButton label="Remove" onConfirm={onRemove} />
        </div>
      </div>

      {Object.keys(series.templates).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Pattern</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(series.templates).map(([key, pattern]) => (
                <tr key={key}>
                  <td>{key}</td>
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
          <h2>Next {preview.length} rendered</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.map((item) => (
              <li key={item.occurrenceId} style={item.error ? { color: 'var(--bad)' } : undefined}>
                {item.error ?? item.title ?? item.filename ?? <span className="muted">no name templates set</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}
