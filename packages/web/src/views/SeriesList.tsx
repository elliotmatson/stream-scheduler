import type { ReactNode } from 'react'
import { api, useResource, type Series } from '../api.ts'
import { Card, Empty, ErrorBanner } from '../components.tsx'
import { duration } from '../format.ts'

export function SeriesList(): ReactNode {
  const { data, error } = useResource(() => api.series(), [])

  return (
    <>
      <div className="page-head">
        <h1>Events</h1>
      </div>
      <ErrorBanner error={error} />
      {(data ?? []).length === 0 ? (
        <Card>
          <Empty>No recurring events yet.</Empty>
        </Card>
      ) : (
        <div className="stack">
          {(data ?? []).map((series) => (
            <SeriesCard key={series.id} series={series} />
          ))}
        </div>
      )}
    </>
  )
}

function SeriesCard({ series }: { series: Series }): ReactNode {
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
        <span className="muted">prepares {duration(series.prepareLeadMs)} early</span>
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
