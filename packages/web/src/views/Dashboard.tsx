import type { ReactNode } from 'react'
import { api, useLive, useLiveRefresh, useResource, type DashboardOutput } from '../api.ts'
import { Card, CopyButton, Empty, ErrorBanner, StatusPill } from '../components.tsx'
import { dateTimeIn, duration, isForeignZone, relative, shortZone, timeIn } from '../format.ts'

/**
 * The screen a booth leaves open.
 *
 * Answers three questions in the order they get asked: is anything on air
 * and is it healthy, what is next, and is there anything I should be doing
 * about it. Everything else in the app is for setting up; this is for the
 * hour it matters.
 *
 * Reloads on the live tick rather than on a timer of its own, so it follows
 * the server's pulse and goes quiet when the socket drops — the banner says
 * so rather than the numbers quietly going stale.
 */
export function Dashboard({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const { data, error, reload } = useResource(() => api.dashboard(), [])
  const live = useLive()

  // Follows the server's pulse: every tick is a reason to re-read the one
  // endpoint this page has.
  useLiveRefresh(reload)

  if (!data) return <ErrorBanner error={error} />

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Now</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {data.onAir.length === 0
              ? 'Nothing on air.'
              : `${data.onAir.length} event${data.onAir.length === 1 ? '' : 's'} running.`}
          </p>
        </div>
        <div className="row">
          {!live.connected ? (
            <span
              className="pill warn"
              title="Not following the server, so these figures may be out of date."
            >
              reconnecting
            </span>
          ) : null}
          <button onClick={reload} title="This screen updates itself; this asks again now.">
            Refresh
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="stack">
        {data.attention.length > 0 ? (
          <Card title="Needs attention">
            <div className="stack" style={{ gap: 6 }}>
              {data.attention.map((item) => (
                <button
                  key={`${item.kind}-${item.message}`}
                  className={`banner ${item.kind === 'media' || item.kind === 'security' ? 'warn' : 'error'} banner-action`}
                  onClick={() => navigate(item.href)}
                >
                  {item.message}
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        {data.onAir.map((run) => (
          <Card key={run.runId} title={run.seriesLabel}>
            <div className="row" style={{ gap: 18, marginBottom: 10 }}>
              <StatusPill status={run.state} />
              <span className="muted">
                {timeIn(run.windowStart, run.timezone)}–{timeIn(run.windowEnd, run.timezone)}
                {isForeignZone(run.timezone) ? ` ${shortZone(run.windowStart, run.timezone)}` : ''}
              </span>
              <button
                onClick={() => navigate(`/runs/${run.runId}`)}
                title="Every step this run has taken, and what the device said back."
              >
                Timeline
              </button>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              {run.outputs.map((output) => (
                <Output key={output.id} output={output} now={data.now} />
              ))}
            </div>
          </Card>
        ))}

        <Card title="Up next">
          {data.next.length === 0 ? (
            <Empty>Nothing scheduled in the next week.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Starts</th>
                    <th title="Streams and recordings attached to this event.">Outputs</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.next.map((entry) => (
                    <tr key={entry.occurrenceId}>
                      <td>{entry.seriesLabel}</td>
                      <td className="muted">
                        {dateTimeIn(entry.scheduledStart, entry.timezone)}
                        {isForeignZone(entry.timezone)
                          ? ` ${shortZone(entry.scheduledStart, entry.timezone)}`
                          : ''}
                        {/* Counted from the server's clock, not the browser's.
                            Under the time rather than beside it, which is how
                            the schedule reads too. */}
                        <div>{relative(entry.scheduledStart, data.now)}</div>
                      </td>
                      <td className="muted">{entry.outputs}</td>
                      <td>
                        {entry.runId ? (
                          <button
                            onClick={() => navigate(`/runs/${entry.runId}`)}
                            title="Every step this run has taken."
                          >
                            Timeline
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Devices">
          {data.devices.length === 0 ? (
            <Empty>No devices are set up yet.</Empty>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {data.devices.map((device) => (
                <div key={device.id} className="row" style={{ gap: 12, alignItems: 'baseline' }}>
                  <StatusPill status={device.health} />
                  <strong>{device.label}</strong>
                  <span className="muted">{device.detail ?? device.lastError ?? 'idle'}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

/**
 * One output's line.
 *
 * The telemetry is the last thing the device said, not a fresh read — so
 * when it is old, the age is shown rather than the number being presented
 * as current.
 */
function Output({ output, now }: { output: DashboardOutput; now: number }): ReactNode {
  const stale = output.telemetry !== undefined && now - output.telemetry.at > 60_000

  return (
    <div className="row" style={{ gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <StatusPill status={output.state === 'live' ? 'running' : output.state} />
      <strong style={{ minWidth: 140 }}>{output.label}</strong>
      <span className="muted">
        {output.kind === 'stream' ? 'stream' : 'recording'}
        {output.deviceLabel ? ` · ${output.deviceLabel}` : ''}
      </span>

      {output.state === 'waiting' ? (
        <span className="muted">starts {relative(output.startsAt, now)}</span>
      ) : output.state === 'live' ? (
        <span className="muted">{duration(Math.max(output.endsAt - now, 0))} left</span>
      ) : null}

      {output.telemetry?.bitrateBps ? (
        <span className="muted" title="What the encoder says it is sending.">
          {Math.round(output.telemetry.bitrateBps / 1000)} kbps
        </span>
      ) : null}
      {output.telemetry?.remainingMs !== undefined ? (
        <span
          className={output.telemetry.remainingMs < 3_600_000 ? 'bad' : 'muted'}
          title="Recording time left on the slot being written to."
        >
          {duration(output.telemetry.remainingMs)} of media
        </span>
      ) : null}
      {output.telemetry?.inputPresent === false ? (
        <span className="bad" title="Nothing is arriving at the device's input.">
          no signal
        </span>
      ) : null}
      {stale ? (
        <span
          className="muted"
          title="The device has not reported since then, so these figures are not fresh."
        >
          · last heard {relative(output.telemetry!.at, now)}
        </span>
      ) : null}

      {output.watchUrl ? (
        <span className="row" style={{ gap: 6 }}>
          <a href={output.watchUrl} target="_blank" rel="noreferrer" title={output.watchUrl}>
            Watch
          </a>
          <CopyButton value={output.watchUrl} label="Copy link" />
        </span>
      ) : null}
    </div>
  )
}
