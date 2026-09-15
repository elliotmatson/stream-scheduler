import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useLiveRefresh,
  useResource,
  type DashboardOutput,
  type RunStep,
  type TelemetrySample,
} from '../api.ts'
import { Card, CopyButton, Empty, ErrorBanner, Fact, StatusPill } from '../components.tsx'
import { Chart, type Point } from '../chart.tsx'
import { duration, relative } from '../format.ts'

/**
 * The run timeline.
 *
 * Built early on purpose: it is the difference between "the stream didn't
 * start" and "the stream key was rejected at 08:30, here is the exact
 * request". Requests and responses were scrubbed before they were written,
 * so this page is safe to screenshot into a bug report.
 */
export function RunDetail({
  runId,
  navigate,
}: {
  runId: string
  navigate: (path: string) => void
}): ReactNode {
  const { data: run, error, reload } = useResource(() => api.run(runId), [runId])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  // Steps land one at a time while a run is going, and this is the screen
  // somebody watches when they are worried. A finished run never changes
  // again, so it stops asking.
  const finished = run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.state)
  useLiveRefresh(reload, !finished)

  // On its own clock, and slower: the readings themselves are only taken
  // every fifteen seconds, so re-fetching the whole history on every pulse
  // would be the same picture at four times the bandwidth.
  const { data: telemetry, reload: reloadTelemetry } = useResource(
    () => api.runTelemetry(runId),
    [runId],
  )
  useEffect(() => {
    if (finished) return
    const timer = setInterval(reloadTelemetry, 15_000)
    return () => clearInterval(timer)
  }, [finished, reloadTelemetry])

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
          <p
            className="muted"
            style={{ margin: '4px 0 0' }}
            title="A run is retried from the start if it fails early enough to be worth retrying."
          >
            Attempt {run.attempt} · started {run.startedAt ? relative(run.startedAt) : 'not yet'}
          </p>
        </div>
        <div className="row">
          <StatusPill status={run.state} />
          {/* The scheduler must never be the only way to stop a stream. */}
          {stoppable ? (
            <button
              className="danger solid"
              disabled={busy}
              title="Ends every stream and recording in this run, now."
              onClick={() => void cancel()}
            >
              Stop now
            </button>
          ) : null}
          <button onClick={() => navigate('/')}>Back to Now</button>
        </div>
      </div>

      <ErrorBanner error={actionError} />

      <div className="stack">
        {run.failure ? (
          <div className="banner error">
            <strong>{run.failure.code}</strong>
            <div>{run.failure.message}</div>
            {run.failure.remediation ? (
              <div style={{ marginTop: 6 }}>{run.failure.remediation}</div>
            ) : null}
          </div>
        ) : null}

        {/* What this page is for once the event is on: every number the
            devices report, and the shape each of them made over the run. */}
        {(run.outputs ?? []).map((output) => (
          <OutputDetail
            key={output.id}
            output={output}
            samples={
              telemetry?.outputs.find((entry) => entry.outputId === output.id)?.samples ?? []
            }
            navigate={navigate}
          />
        ))}

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
            <p className="muted">Nothing has been attempted yet.</p>
          ) : (
            (run.steps ?? []).map((step) => <Step key={step.seq} step={step} />)
          )}
        </Card>
      </div>
    </>
  )
}

/**
 * One output, in full: what it is doing now and what it has been doing.
 *
 * The status screen answers "is it working"; this answers "what happened".
 * A bitrate that sagged for two minutes at 09:40 is a shape, and no single
 * reading has a shape.
 */
function OutputDetail({
  output,
  samples,
  navigate,
}: {
  output: DashboardOutput
  samples: TelemetrySample[]
  navigate: (path: string) => void
}): ReactNode {
  // The newest reading wins, and the sampler's is newer than the last one
  // the device pushed of its own accord. Without this the figure above a
  // chart disagrees with the end of the chart, which is the sort of thing
  // that makes somebody stop trusting the screen.
  const last = samples[samples.length - 1]
  const now: DashboardOutput['telemetry'] =
    output.telemetry === undefined && last === undefined
      ? undefined
      : {
          at: last?.at ?? output.telemetry!.at,
          ...output.telemetry,
          ...(last?.bitrateBps === null || last?.bitrateBps === undefined
            ? {}
            : { bitrateBps: last.bitrateBps }),
          ...(last?.remainingMs === null || last?.remainingMs === undefined
            ? {}
            : { remainingMs: last.remainingMs }),
          ...(last?.elapsedMs === null || last?.elapsedMs === undefined
            ? {}
            : { elapsedMs: last.elapsedMs }),
          ...(last?.cachePercent === null || last?.cachePercent === undefined
            ? {}
            : { cachePercent: last.cachePercent }),
          ...(last?.cacheBufferedMs === null || last?.cacheBufferedMs === undefined
            ? {}
            : { cacheBufferedMs: last.cacheBufferedMs }),
          ...(last?.inputPresent === null || last?.inputPresent === undefined
            ? {}
            : { inputPresent: last.inputPresent }),
        }

  const series = (pick: (sample: TelemetrySample) => number | null): Point[] =>
    samples.map((sample) => ({ at: sample.at, value: pick(sample) }))

  const has = (pick: (sample: TelemetrySample) => number | null): boolean =>
    samples.some((sample) => pick(sample) !== null)

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{output.label}</h2>
          <span className="muted">
            {output.kind === 'stream' ? 'stream' : 'recording'}
            {output.deviceLabel ? ' · ' : ''}
            {output.deviceId ? (
              <button className="link" onClick={() => navigate(`/devices/${output.deviceId}`)}>
                {output.deviceLabel}
              </button>
            ) : (
              output.deviceLabel
            )}
          </span>
        </div>
        <div className="row">
          <StatusPill status={output.state === 'live' ? 'running' : output.state} />
          {output.watchUrl ? (
            <a href={output.watchUrl} target="_blank" rel="noreferrer" title={output.watchUrl}>
              Watch
            </a>
          ) : null}
        </div>
      </div>

      {now === undefined ? (
        <p className="muted" style={{ margin: 0 }}>
          The device has not reported anything for this one.
        </p>
      ) : (
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          {now.bitrateBps !== undefined ? (
            <Fact
              label="Bitrate"
              value={`${Math.round(now.bitrateBps / 1000)} kbps`}
              tip="What the encoder says it is sending."
            />
          ) : null}
          {now.elapsedMs !== undefined ? (
            <Fact
              label={output.kind === 'stream' ? 'On air for' : 'Recorded'}
              value={duration(now.elapsedMs)}
              tip="As the device counts it, not as the schedule does."
            />
          ) : null}
          {now.remainingMs !== undefined ? (
            <Fact
              label="Media left"
              value={duration(now.remainingMs)}
              tip="Recording time left on the slot being written to."
            />
          ) : null}
          {now.cachePercent !== undefined ? (
            <Fact
              label="Cache"
              value={`${Math.round(now.cachePercent)}%`}
              tip="How full the device's own buffer is. Climbing and staying up means it is not keeping up."
            />
          ) : null}
          {now.cacheBufferedMs !== undefined ? (
            <Fact
              label="Cached"
              value={duration(now.cacheBufferedMs)}
              tip="Recording held in the deck's cache, not yet written to the card."
            />
          ) : null}
          {now.cacheStatus !== undefined ? (
            <Fact label="Cache state" value={now.cacheStatus} tip="As the deck names it." />
          ) : null}
          {now.inputPresent === false ? (
            <Fact
              label="Input"
              value="no signal"
              tip="Nothing is arriving at the device's input."
            />
          ) : null}
        </div>
      )}

      {samples.length > 1 ? (
        <div className="charts">
          {has((sample) => sample.bitrateBps) ? (
            <Chart
              label="Bitrate"
              points={series((sample) => sample.bitrateBps)}
              format={(value) => `${Math.round(value / 1000)} kbps`}
            />
          ) : null}
          {has((sample) => sample.remainingMs) ? (
            <Chart
              label="Media left"
              points={series((sample) => sample.remainingMs)}
              format={(value) => duration(value)}
              floor={3_600_000}
              tone="warn"
            />
          ) : null}
          {has((sample) => sample.cachePercent) ? (
            <Chart
              label="Cache"
              points={series((sample) => sample.cachePercent)}
              format={(value) => `${Math.round(value)}%`}
              max={100}
              floor={80}
              tone="warn"
            />
          ) : null}
          {has((sample) => sample.cacheBufferedMs) ? (
            <Chart
              label="Held in cache"
              points={series((sample) => sample.cacheBufferedMs)}
              format={(value) => duration(value)}
              tone="warn"
            />
          ) : null}
        </div>
      ) : samples.length === 0 && output.state !== 'waiting' ? (
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
          No readings were recorded. Devices are asked every fifteen seconds while an event is on
          air, so a short output may finish before the first one.
        </p>
      ) : null}
    </Card>
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
          {step.attempts > 1 ? (
            <span className="muted" title="It was retried this many times before it settled.">
              {step.attempts} attempts
            </span>
          ) : null}
          {step.externalId ? (
            <span className="muted" title="What the service calls the thing this step made.">
              → {step.externalId}
            </span>
          ) : null}
        </div>
        {step.error ? <div style={{ color: 'var(--bad)', marginTop: 4 }}>{step.error}</div> : null}
        {hasDetail ? (
          <button
            style={{ marginTop: 6 }}
            title="What was sent and what came back. Keys and tokens were scrubbed before this was written."
            onClick={() => setOpen((o) => !o)}
          >
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
      <div
        className="muted"
        style={{ whiteSpace: 'nowrap' }}
        title="How long the device or service took to answer."
      >
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
        <div>
          <h1>Runs</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Every event the scheduler has taken on, newest first.
          </p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <Card>
        {(data ?? []).length === 0 ? (
          <Empty>Nothing has run yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Started</th>
                  <th>Status</th>
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
                      <button
                        onClick={() => navigate(`/runs/${run.id}`)}
                        title="Every step this run has taken, and what the device said back."
                      >
                        Timeline
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
