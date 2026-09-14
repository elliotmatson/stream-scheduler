import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLiveRefresh, useResource, type RunStep } from '../api.ts'
import { Card, CopyButton, ErrorBanner, StatusPill } from '../components.tsx'
import { relative } from '../format.ts'

/**
 * The run timeline.
 *
 * Built early on purpose: it is the difference between "the stream didn't
 * start" and "the stream key was rejected at 08:30, here is the exact
 * request". Requests and responses were scrubbed before they were written,
 * so this page is safe to screenshot into a bug report.
 */
export function RunDetail({ runId, navigate }: { runId: string; navigate: (path: string) => void }): ReactNode {
  const { data: run, error, reload } = useResource(() => api.run(runId), [runId])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  // Steps land one at a time while a run is going, and this is the screen
  // somebody watches when they are worried. A finished run never changes
  // again, so it stops asking.
  const finished = run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.state)
  useLiveRefresh(reload, !finished)

  const cancel = async (): Promise<void> => {
    setBusy(true)
    setActionError(undefined)
    try {
      await api.cancelRun(runId, 'Stopped by an operator')
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorBanner error={error} />
  if (!run) return <p className="muted">Loading…</p>

  const stoppable = !['completed', 'failed', 'cancelled'].includes(run.state)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{run.seriesLabel}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Attempt {run.attempt} · started {run.startedAt ? relative(run.startedAt) : 'not yet'}
          </p>
        </div>
        <div className="row">
          <StatusPill status={run.state} />
          <button onClick={reload}>Refresh</button>
          {/* The scheduler must never be the only way to stop a stream. */}
          {stoppable ? (
            <button className="danger solid" disabled={busy} onClick={() => void cancel()}>
              Stop now
            </button>
          ) : null}
          <button onClick={() => navigate('/')}>Back</button>
        </div>
      </div>

      <ErrorBanner error={actionError} />

      <div className="stack">
        {run.failure ? (
          <div className="banner error">
            <strong>{run.failure.code}</strong>
            <div>{run.failure.message}</div>
            {run.failure.remediation ? <div style={{ marginTop: 6 }}>{run.failure.remediation}</div> : null}
          </div>
        ) : null}

        {/* The reason somebody opens this page before the day: an unlisted
            broadcast's link, ready to send round, as soon as it exists. */}
        {(run.links ?? []).length > 0 ? (
          <Card title="Where to watch">
            <div className="stack" style={{ gap: 8 }}>
              {(run.links ?? []).map((link) => (
                <div key={link.url} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <span style={{ minWidth: 130 }}>{link.label}</span>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.url}
                  </a>
                  <CopyButton value={link.url} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        <Card title="Steps">
          {(run.steps ?? []).length === 0 ? (
            <p className="muted">No steps recorded.</p>
          ) : (
            (run.steps ?? []).map((step) => <Step key={step.seq} step={step} />)
          )}
        </Card>
      </div>
    </>
  )
}

function Step({ step }: { step: RunStep }): ReactNode {
  const [open, setOpen] = useState(false)
  const hasDetail = step.request !== null || step.response !== null || step.error !== null

  return (
    <div className={`step ${step.state}`}>
      <div className="marker" aria-hidden />
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="step-kind">{step.label ?? step.kind}</span>
          {step.attempts > 1 ? <span className="muted">{step.attempts} attempts</span> : null}
          {step.externalId ? <span className="muted">→ {step.externalId}</span> : null}
        </div>
        {step.error ? <div style={{ color: 'var(--bad)', marginTop: 4 }}>{step.error}</div> : null}
        {hasDetail ? (
          <button style={{ marginTop: 6 }} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} detail
          </button>
        ) : null}
        {open ? (
          <>
            {step.request !== null ? <pre>{JSON.stringify(step.request, null, 2)}</pre> : null}
            {step.response !== null ? <pre>{JSON.stringify(step.response, null, 2)}</pre> : null}
          </>
        ) : null}
      </div>
      <div className="muted" style={{ whiteSpace: 'nowrap' }}>
        {step.durationMs === null ? '—' : `${step.durationMs} ms`}
      </div>
    </div>
  )
}

export function Runs({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const { data, error, reload } = useResource(() => api.runs(), [])
  useLiveRefresh(reload)

  return (
    <>
      <div className="page-head">
        <h1>Runs</h1>
      </div>
      <ErrorBanner error={error} />
      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Started</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((run) => (
                <tr key={run.id}>
                  <td>{run.seriesLabel}</td>
                  <td className="muted">{run.startedAt ? relative(run.startedAt) : '—'}</td>
                  <td>
                    <StatusPill status={run.state} />
                  </td>
                  <td>
                    <button onClick={() => navigate(`/runs/${run.id}`)}>Timeline</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(data ?? []).length === 0 ? <p className="muted">Nothing has run yet.</p> : null}
      </Card>
    </>
  )
}
