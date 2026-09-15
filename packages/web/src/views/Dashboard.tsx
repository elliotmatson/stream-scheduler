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
            <div className="stack" style={{ gap: 2 }}>
              {data.devices.map((device) => (
                // What it is doing, not whether a socket is open: five rows
                // of "connected" say nothing about whether the morning is
                // being recorded. The whole row opens the device.
                <button
                  key={device.id}
                  className="device-row"
                  title={`Open ${device.label}`}
                  onClick={() => navigate(`/devices/${device.id}`)}
                >
                  <StatusPill status={device.activity} />
                  <strong>{device.label}</strong>
                  {device.activity === 'unreachable' && device.lastError ? (
                    <span className="bad">{device.lastError}</span>
                  ) : (
                    device.facts.map((fact) => (
                      <span key={fact.label} className="muted" title={fact.label}>
                        {fact.value}
                      </span>
                    ))
                  )}
                  {device.health === 'degraded' ? (
                    <span className="muted" title={device.lastError ?? undefined}>
                      · answering, but not everything works
                    </span>
                  ) : null}
                </button>
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
 * Deliberately not the numbers. Bitrate, cache and headroom live on the
 * run's own page, which is the detailed view; what belongs on a screen
 * somebody glances at between services is whether it is on, and anything
 * that is wrong with it.
 */
function Output({ output, now }: { output: DashboardOutput; now: number }): ReactNode {
  const stale = output.telemetry !== undefined && now - output.telemetry.at > 60_000
  const lowMedia =
    output.telemetry?.remainingMs !== undefined && output.telemetry.remainingMs < 3_600_000

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

      {/* Only what is wrong. Everything else is a number, and numbers are
          on the timeline. */}
      {lowMedia ? (
        <span className="bad" title="Recording time left on the slot being written to.">
          {duration(output.telemetry!.remainingMs!)} of media left
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
