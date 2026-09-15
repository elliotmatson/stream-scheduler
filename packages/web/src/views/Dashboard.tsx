import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLive, useLiveRefresh, useResource, type DashboardOutput } from '../api.ts'
import {
  Card,
  CopyButton,
  Empty,
  ErrorBanner,
  IconButton,
  PageHead,
  StatusPill,
  toneFor,
} from '../components.tsx'
import { describeStatus } from '../copy.ts'
import { dateTimeIn, duration, isForeignZone, relative, shortZone, timeIn } from '../format.ts'
import { IconExternal } from '../icons.tsx'

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
      <PageHead
        title="Now"
        subtitle={
          data.onAir.length === 0
            ? 'Nothing on air.'
            : `${data.onAir.length} event${data.onAir.length === 1 ? '' : 's'} running.`
        }
        actions={
          !live.connected ? (
            <span
              className="pill warn"
              title="Not following the server, so these figures may be out of date."
            >
              reconnecting
            </span>
          ) : null
        }
      />

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
          <Card key={run.runId}>
            {/* The event states itself once, at the top: its name, when its
                window runs, and the one way in. Everything below is an
                output, and reads as one. */}
            <PageHead
              level={2}
              title={run.seriesLabel}
              subtitle={
                <>
                  {timeIn(run.windowStart, run.timezone)}–{timeIn(run.windowEnd, run.timezone)}
                  {isForeignZone(run.timezone)
                    ? ` ${shortZone(run.windowStart, run.timezone)}`
                    : ''}
                </>
              }
              actions={
                <>
                  <StatusPill status={run.state} />
                  <button
                    onClick={() => navigate(`/runs/${run.runId}`)}
                    title="Every step this run has taken, and what the device said back."
                  >
                    Timeline
                  </button>
                </>
              }
            />

            <div>
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
                      <span
                        key={fact.label}
                        className={fact.tone === 'bad' ? 'bad' : 'muted'}
                        title={fact.label}
                      >
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

        <Recordings />
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
/**
 * What each recording output's policy says could go.
 *
 * Deliberately a statement, not a button. Automated deletion of somebody's
 * Sunday has to earn its place: this screen is how the decision gets
 * looked at before anything is allowed to act on it. Asking the decks is
 * the slow part, so it loads on its own rather than with the rest of the
 * page, and only when somebody opens it.
 */
function Recordings(): ReactNode {
  const [open, setOpen] = useState(false)
  const { data, error } = useResource(
    () => (open ? api.retention() : Promise.resolve({ outputs: [] })),
    [open],
  )

  const outputs = data?.outputs ?? []
  const configured = outputs.filter((entry) => entry.policy.keepDays !== undefined)
  const eligible = configured.reduce((sum, entry) => sum + entry.wouldDelete.length, 0)

  return (
    <Card>
      <PageHead
        level={2}
        title="Recordings"
        subtitle="What is on the cards, and what a keep-for policy says could go."
        actions={
          <button onClick={() => setOpen((was) => !was)}>
            {open ? 'Hide' : 'Ask the devices'}
          </button>
        }
      />

      <ErrorBanner error={error} />

      {!open ? (
        <p className="muted" style={{ margin: 0 }}>
          Reading a card takes a moment, so this asks only when you want it to.
        </p>
      ) : outputs.length === 0 ? (
        <Empty>No recording outputs are set up.</Empty>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {outputs.map((entry) => (
            <div key={entry.outputId} className="onair-output">
              <span className="state-dot" aria-hidden />
              <div className="onair-name">
                {entry.seriesLabel} · {entry.outputLabel}
              </div>
              <div className="onair-actions" />
              <div className="onair-meta muted">
                <span>
                  {entry.kept.length} recording{entry.kept.length === 1 ? '' : 's'} of ours
                </span>
                {entry.policy.keepDays === undefined ? (
                  <span>kept forever</span>
                ) : (
                  <span>
                    keep {entry.policy.keepDays} days, newest {entry.policy.keepLast ?? 3} always
                  </span>
                )}
                {entry.wouldDelete.length > 0 ? (
                  <span
                    className="warn-text"
                    title={entry.wouldDelete.map((c) => c.artifact.filename).join(', ')}
                  >
                    {entry.wouldDelete.length} past the keep-by date
                  </span>
                ) : null}
                {entry.unknownToUs.length > 0 ? (
                  <span title={entry.unknownToUs.join(', ')}>
                    {entry.unknownToUs.length} file{entry.unknownToUs.length === 1 ? '' : 's'} this
                    scheduler did not record
                  </span>
                ) : null}
              </div>
            </div>
          ))}

          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {eligible === 0
              ? 'Nothing is past its keep-by date.'
              : `${eligible} recording${eligible === 1 ? '' : 's'} would go if deleting were switched on. Nothing is deleted: this scheduler cannot delete anything yet.`}
          </p>
        </div>
      )}
    </Card>
  )
}

/**
 * One output inside a running event.
 *
 * Two lines rather than one wrapping row: the name with its actions pinned
 * to the right, and everything the devices are saying underneath. The old
 * single row wrapped whenever there was a watch link, which put the link
 * and the copy button on a line of their own, under a different output's
 * name, attached to nothing.
 */
function Output({ output, now }: { output: DashboardOutput; now: number }): ReactNode {
  const stale = output.telemetry !== undefined && now - output.telemetry.at > 60_000
  const lowMedia =
    output.telemetry?.remainingMs !== undefined && output.telemetry.remainingMs < 3_600_000
  const state = output.state === 'live' ? 'running' : output.state

  return (
    <div className="onair-output">
      <span
        className={`state-dot ${toneFor(state)}`}
        title={describeStatus(state)}
        aria-label={state}
      />

      <div className="onair-name">{output.label}</div>

      <div className="onair-actions">
        {/* The address, not the word: "Watch" spelled out sat level with
            the name and read as a second heading. */}
        {output.watchUrl ? (
          <>
            <IconButton label="Watch" href={output.watchUrl} icon={<IconExternal />} />
            <CopyButton value={output.watchUrl} label="Copy the watch link" icon />
          </>
        ) : null}
      </div>

      <div className="onair-meta muted">
        <span>
          {output.kind === 'stream' ? 'stream' : 'recording'}
          {output.deviceLabel ? ` · ${output.deviceLabel}` : ''}
        </span>

        {output.state === 'waiting' ? (
          <span>starts {relative(output.startsAt, now)}</span>
        ) : output.state === 'live' ? (
          <span>{duration(Math.max(output.endsAt - now, 0))} left</span>
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
          <span title="The device has not reported since then, so these figures are not fresh.">
            last heard {relative(output.telemetry!.at, now)}
          </span>
        ) : null}
      </div>
    </div>
  )
}
