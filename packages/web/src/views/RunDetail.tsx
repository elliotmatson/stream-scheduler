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
import {
  Card,
  CopyButton,
  Empty,
  ErrorBanner,
  Fact,
  IconButton,
  PageHead,
  StatusPill,
} from '../components.tsx'
import { Chart, type Point } from '../chart.tsx'
import { clockTimeIn, dateTimeIn, duration, relative } from '../format.ts'
import { IconExternal } from '../icons.tsx'

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
  const [range, setRange] = useState<RangeKey>('all')
  const [chartsOpen, setChartsOpen] = useState(true)
  const { data: telemetry, reload: reloadTelemetry } = useResource(
    () => api.runTelemetry(runId, RANGES[range].windowMs),
    [runId, range],
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
      <PageHead
        title={run.seriesLabel}
        back={{ to: '/', label: 'Back to Now', onNavigate: navigate }}
        subtitle={
          <span title="A run is retried from the start if it fails early enough to be worth retrying.">
            Attempt {run.attempt} · started {run.startedAt ? relative(run.startedAt) : 'not yet'}
          </span>
        }
        actions={
          <>
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
          </>
        }
      />

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
        <ChartControls range={range} onRange={setRange} open={chartsOpen} onOpen={setChartsOpen} />

        {(run.outputs ?? []).map((output) => (
          <OutputDetail
            key={output.id}
            output={output}
            samples={
              telemetry?.outputs.find((entry) => entry.outputId === output.id)?.samples ?? []
            }
            navigate={navigate}
            timezone={run.timezone}
            showCharts={chartsOpen}
          />
        ))}

        <Card title="Steps">
          {(run.steps ?? []).length === 0 ? (
            <p className="muted">Nothing has been attempted yet.</p>
          ) : (
            (run.steps ?? []).map((step) => (
              <Step key={step.seq} step={step} timezone={run.timezone} />
            ))
          )}
        </Card>
      </div>
    </>
  )
}

/**
 * How much of the run the charts show.
 *
 * A four-hour service drawn into six hundred pixels is a smear: the ninety
 * seconds somebody came here to look at are four pixels wide. Narrowing
 * the window is the difference between a chart and a decoration. The
 * window is applied on the server, so a long run does not ship four hours
 * of readings to draw fifteen minutes of them.
 */
type RangeKey = 'all' | '15m' | '1h' | '3h'

const RANGES: Record<RangeKey, { label: string; windowMs?: number }> = {
  all: { label: 'Whole run' },
  '15m': { label: 'Last 15 min', windowMs: 15 * 60_000 },
  '1h': { label: 'Last hour', windowMs: 60 * 60_000 },
  '3h': { label: 'Last 3 hours', windowMs: 3 * 60 * 60_000 },
}

const RANGE_KEYS = Object.keys(RANGES) as RangeKey[]

function ChartControls({
  range,
  onRange,
  open,
  onOpen,
}: {
  range: RangeKey
  onRange: (next: RangeKey) => void
  open: boolean
  onOpen: (next: boolean) => void
}): ReactNode {
  return (
    <div className="chart-controls">
      <h2 title="What the devices reported while this run was on air.">Readings</h2>
      <div className="toggle" role="group" aria-label="How much of the run to chart">
        {RANGE_KEYS.map((key) => (
          <button
            key={key}
            aria-pressed={range === key}
            disabled={!open}
            onClick={() => onRange(key)}
          >
            {RANGES[key].label}
          </button>
        ))}
      </div>
      <button
        onClick={() => onOpen(!open)}
        title={open ? 'Charts off, facts only.' : 'Draw the charts again.'}
      >
        {open ? 'Hide charts' : 'Show charts'}
      </button>
    </div>
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
  timezone,
  showCharts,
}: {
  output: DashboardOutput
  samples: TelemetrySample[]
  navigate: (path: string) => void
  timezone: string
  showCharts: boolean
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
          {/* The reason somebody opens this page before the day: an unlisted
              broadcast's link, ready to send round, as soon as it exists.
              Beside the output that produced it rather than in a card of its
              own further down, which listed the same links a second time. */}
          {output.watchUrl ? (
            <>
              <IconButton label="Watch" href={output.watchUrl} icon={<IconExternal />} />
              <CopyButton value={output.watchUrl} label="Copy the watch link" icon />
            </>
          ) : null}
        </div>
      </div>

      {output.watchUrl ? (
        <a
          className="muted watch-url"
          href={output.watchUrl}
          target="_blank"
          rel="noreferrer"
          title="Where this broadcast can be watched."
        >
          {output.watchUrl}
        </a>
      ) : null}

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

      {samples.length > 1 && showCharts ? (
        <div className="charts">
          {has((sample) => sample.bitrateBps) ? (
            <Chart
              label="Bitrate"
              timezone={timezone}
              points={series((sample) => sample.bitrateBps)}
              format={(value) => `${Math.round(value / 1000)} kbps`}
            />
          ) : null}
          {has((sample) => sample.remainingMs) ? (
            <Chart
              label="Media left"
              timezone={timezone}
              points={series((sample) => sample.remainingMs)}
              format={(value) => duration(value)}
              floor={3_600_000}
              tone="warn"
            />
          ) : null}
          {has((sample) => sample.cachePercent) ? (
            <Chart
              label="Cache"
              timezone={timezone}
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
              timezone={timezone}
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

function Step({ step, timezone }: { step: RunStep; timezone: string }): ReactNode {
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
      {/* When it happened, then how long it took. A step list is read when
          something went wrong, and "it took 40 ms" is no use without the
          clock time to line it up against what somebody saw in the room. */}
      <div className="step-when muted">
        <div
          title={
            step.startedAt === null
              ? 'This step has not started.'
              : `Started ${dateTimeIn(step.startedAt, timezone)}.`
          }
        >
          {step.startedAt === null ? '—' : clockTimeIn(step.startedAt, timezone)}
        </div>
        <div title="How long the device or service took to answer.">
          {step.durationMs === null ? '' : `${step.durationMs} ms`}
        </div>
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
