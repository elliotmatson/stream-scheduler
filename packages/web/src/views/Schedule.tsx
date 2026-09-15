import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLiveRefresh, useResource, type Occurrence } from '../api.ts'
import { Card, Empty, ErrorBanner, PageHead, StatusPill, toneFor } from '../components.tsx'
import {
  dateTimeIn,
  dayLabel,
  duration,
  isForeignZone,
  localDateKey,
  minutesOfDayIn,
  monthLabel,
  relative,
  shortZone,
  timeIn,
  weekLabel,
} from '../format.ts'

type View = 'month' | 'week' | 'list'

export function Schedule({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const [view, setView] = useState<View>('month')
  // One anchor for both calendars: the month it falls in, or the week it
  // falls in. Switching views then keeps you looking at the same dates
  // rather than jumping back to today.
  const [anchor, setAnchor] = useState(() => new Date())

  const weekStart = startOfWeek(anchor)
  // A month's worth either side in the month view, a few days in the week
  // view: a calendar cell for an event in another timezone must never be
  // missing just because the UTC instant fell outside the range.
  const range =
    view === 'week'
      ? { from: addDays(weekStart, -2).getTime(), to: addDays(weekStart, 9).getTime() }
      : {
          from: Date.UTC(anchor.getFullYear(), anchor.getMonth() - 1, 1),
          to: Date.UTC(anchor.getFullYear(), anchor.getMonth() + 2, 1),
        }
  const { data, error, reload } = useResource(
    () => api.occurrences(range.from, range.to),
    [range.from, range.to],
  )
  // A run starting or finishing changes what the chips say, and somebody
  // watching this screen on a Sunday should not have to press anything.
  useLiveRefresh(reload)

  const shift = (by: number): void =>
    setAnchor((current) =>
      view === 'week'
        ? addDays(current, by * 7)
        : new Date(current.getFullYear(), current.getMonth() + by, 1),
    )

  const select = (occurrence: Occurrence): void =>
    navigate(occurrence.runId ? `/runs/${occurrence.runId}` : `/occurrences/${occurrence.id}`)

  return (
    <>
      <PageHead
        title="Schedule"
        subtitle="Every date each event falls on, and what became of it."
        actions={
          <>
            <div className="toggle">
              <button aria-pressed={view === 'month'} onClick={() => setView('month')}>
                Month
              </button>
              <button aria-pressed={view === 'week'} onClick={() => setView('week')}>
                Week
              </button>
              <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
                List
              </button>
            </div>
            {view === 'list' ? null : (
              <div className="row">
                <button
                  onClick={() => shift(-1)}
                  aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
                >
                  ←
                </button>
                <strong style={{ minWidth: 150, textAlign: 'center' }}>
                  {view === 'week'
                    ? weekLabel(weekStart)
                    : monthLabel(anchor.getFullYear(), anchor.getMonth())}
                </strong>
                <button
                  onClick={() => shift(1)}
                  aria-label={view === 'week' ? 'Next week' : 'Next month'}
                >
                  →
                </button>
                <button onClick={() => setAnchor(new Date())}>Today</button>
              </div>
            )}
          </>
        }
      />

      <ErrorBanner error={error} />

      {view === 'month' ? (
        <CalendarGrid
          year={anchor.getFullYear()}
          month={anchor.getMonth()}
          occurrences={data ?? []}
          onSelect={select}
        />
      ) : view === 'week' ? (
        <WeekGrid start={weekStart} occurrences={data ?? []} onSelect={select} />
      ) : (
        <ScheduleList occurrences={data ?? []} navigate={navigate} reload={reload} />
      )}
    </>
  )
}

function startOfWeek(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay())
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function CalendarGrid({
  year,
  month,
  occurrences,
  onSelect,
}: {
  year: number
  month: number
  occurrences: Occurrence[]
  onSelect: (occurrence: Occurrence) => void
}): ReactNode {
  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>()
    for (const occurrence of occurrences) {
      // Bucket by the date in the *event's* zone. Using the browser's zone
      // would put an evening service on the wrong day for anyone abroad.
      const key = localDateKey(occurrence.scheduledStart, occurrence.timezone)
      const list = map.get(key) ?? []
      list.push(occurrence)
      map.set(key, list)
    }
    return map
  }, [occurrences])

  const first = new Date(year, month, 1)
  const startOffset = first.getDay()
  const cells: { date: Date; outside: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month, 1 - startOffset + i)
    cells.push({ date, outside: date.getMonth() !== month })
  }

  const todayKey = keyOf(new Date())

  return (
    <div className="calendar" role="grid" aria-label="Scheduled events">
      {WEEKDAYS.map((day) => (
        <div key={day} className="dow">
          {day}
        </div>
      ))}
      {cells.map(({ date, outside }) => {
        const key = keyOf(date)
        const events = byDay.get(key) ?? []
        return (
          <div
            key={key}
            className={`day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}`}
          >
            <span className="daynum">{date.getDate()}</span>
            {events.map((occurrence) => (
              <button
                key={occurrence.id}
                className={`event ${occurrence.runState === 'running' ? 'live' : ''} ${occurrence.status}`}
                onClick={() => onSelect(occurrence)}
                title={`${occurrence.seriesLabel} — ${dateTimeIn(occurrence.scheduledStart, occurrence.timezone)} ${shortZone(occurrence.scheduledStart, occurrence.timezone)}`}
              >
                {/* Two lines: at a glance you want the time, and the name
                    would otherwise be cut off in a narrow cell. */}
                <span className="event-time">
                  {timeIn(occurrence.scheduledStart, occurrence.timezone)}
                </span>
                <span className="event-name">{occurrence.seriesLabel}</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** Pixels per hour. Enough that a 75-minute service is a readable block. */
const HOUR_PX = 44
/** What a week shows when nothing forces it wider: a normal church day. */
const DEFAULT_WINDOW = { from: 6, to: 22 }

/**
 * A week laid out by time of day.
 *
 * The month grid answers "what is on this month"; this answers "what is on
 * at the same time as what". Two services an hour apart are an hour apart
 * here, and two things running at once are side by side rather than stacked
 * in a box — which is the whole reason to have it.
 *
 * Every position is computed in the *event's* timezone, like every other
 * date in this app: an evening service abroad belongs at its own evening.
 */
function WeekGrid({
  start,
  occurrences,
  onSelect,
}: {
  start: Date
  occurrences: Occurrence[]
  onSelect: (occurrence: Occurrence) => void
}): ReactNode {
  // Keyed on the week itself, not on the array: a fresh array every render
  // would make every memo below recompute and defeat the point of them.
  const weekKey = keyOf(start)
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(start, index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekKey],
  )
  const shown = useMemo(() => new Set(days.map(keyOf)), [days])

  const laid = useMemo(() => {
    const byDay = new Map<string, Span[]>()
    for (const occurrence of occurrences) {
      const key = localDateKey(occurrence.scheduledStart, occurrence.timezone)
      // The fetch reaches a couple of days either side so nothing is lost to
      // a timezone edge. Those extra days must not be laid out here, or an
      // early service next week stretches this week's hours to fit it.
      if (!shown.has(key)) continue
      const from = minutesOfDayIn(occurrence.scheduledStart, occurrence.timezone)
      // An event running past midnight is clipped at the end of its own day
      // rather than drawn into the next one, which would claim it starts
      // there.
      const to = Math.min(
        from + Math.round((occurrence.scheduledEnd - occurrence.scheduledStart) / 60_000),
        24 * 60,
      )
      const list = byDay.get(key) ?? []
      list.push({ occurrence, from, to: Math.max(to, from + 15) })
      byDay.set(key, list)
    }
    const packed = new Map<string, Placed[]>()
    for (const [key, list] of byDay) packed.set(key, packIntoLanes(list))
    return packed
  }, [occurrences, shown])

  // Widen the window rather than always drawing all 24 hours: most of a day
  // is empty, and a 6am start is nobody's idea of scrolling.
  const window = useMemo(() => {
    let { from, to } = DEFAULT_WINDOW
    for (const list of laid.values()) {
      for (const placed of list) {
        from = Math.min(from, Math.floor(placed.from / 60))
        to = Math.max(to, Math.ceil(placed.to / 60))
      }
    }
    return { from: Math.max(0, from), to: Math.min(24, Math.max(to, from + 1)) }
  }, [laid])

  const hours = Array.from({ length: window.to - window.from }, (_, index) => window.from + index)
  const todayKey = keyOf(new Date())
  const offset = (minutes: number): number => (minutes / 60 - window.from) * HOUR_PX

  return (
    <div className="week" role="grid" aria-label="Scheduled events by time of day">
      <div className="week-head">
        <div className="week-gutter" />
        {days.map((day) => (
          <div
            key={keyOf(day)}
            className={`week-day-head${keyOf(day) === todayKey ? ' today' : ''}`}
          >
            {dayLabel(day)}
          </div>
        ))}
      </div>
      <div className="week-body">
        <div className="week-gutter">
          {hours.map((hour) => (
            <div key={hour} className="week-hour-label" style={{ height: HOUR_PX }}>
              {formatHour(hour)}
            </div>
          ))}
        </div>
        {days.map((day) => {
          const key = keyOf(day)
          return (
            <div
              key={key}
              className={`week-day${key === todayKey ? ' today' : ''}`}
              style={{ height: hours.length * HOUR_PX, backgroundSize: `100% ${HOUR_PX}px` }}
            >
              {(laid.get(key) ?? []).map((placed) => (
                <button
                  key={placed.occurrence.id}
                  className={`event ${placed.occurrence.runState === 'running' ? 'live' : ''} ${placed.occurrence.status}`}
                  style={{
                    position: 'absolute',
                    top: offset(placed.from),
                    height: Math.max(offset(placed.to) - offset(placed.from), 18),
                    // Side by side when they overlap, so neither hides the
                    // other and the clash is visible.
                    left: `${(placed.lane / placed.lanes) * 100}%`,
                    width: `${(1 / placed.lanes) * 100}%`,
                  }}
                  onClick={() => onSelect(placed.occurrence)}
                  title={`${placed.occurrence.seriesLabel} — ${dateTimeIn(placed.occurrence.scheduledStart, placed.occurrence.timezone)} ${shortZone(placed.occurrence.scheduledStart, placed.occurrence.timezone)}`}
                >
                  <span className="event-time">
                    {timeIn(placed.occurrence.scheduledStart, placed.occurrence.timezone)}
                  </span>
                  <span className="event-name">{placed.occurrence.seriesLabel}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface Span {
  occurrence: Occurrence
  /** Minutes from midnight, in the event's own zone. */
  from: number
  to: number
}

interface Placed extends Span {
  /** Which of the day's side-by-side lanes this one sits in. */
  lane: number
  /** How many lanes the day ended up needing. */
  lanes: number
}

/**
 * Puts overlapping events in adjacent lanes.
 *
 * Earliest first, each one taking the first lane whose previous occupant has
 * finished. Everything that overlaps at all then shares the width of the day
 * evenly — cruder than a true calendar's packing, and enough to make "these
 * two are on at once" obvious at a glance.
 */
function packIntoLanes(items: Span[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.from - b.from || a.to - b.to)
  const lanes: number[] = []
  const placed = sorted.map((item) => {
    let lane = lanes.findIndex((endsAt) => endsAt <= item.from)
    if (lane === -1) {
      lane = lanes.length
      lanes.push(item.to)
    } else {
      lanes[lane] = item.to
    }
    return { ...item, lane }
  })
  // One width for the whole day: simple, and stable as the week scrolls.
  return placed.map((item) => ({ ...item, lanes: Math.max(lanes.length, 1) }))
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2026, 0, 1, hour))
}

function keyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function ScheduleList({
  occurrences,
  navigate,
  reload,
}: {
  occurrences: Occurrence[]
  navigate: (path: string) => void
  reload: () => void
}): ReactNode {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const act = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setError(undefined)
    try {
      await action()
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  if (occurrences.length === 0) {
    return (
      <Card>
        <Empty>Nothing scheduled in this window.</Empty>
      </Card>
    )
  }

  return (
    <Card>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th title="How long the event's window is. Its streams and recordings sit inside it.">
                Length
              </th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {occurrences.map((occurrence) => (
              <tr key={occurrence.id}>
                <td>
                  {dateTimeIn(occurrence.scheduledStart, occurrence.timezone)}{' '}
                  {isForeignZone(occurrence.timezone) ? (
                    // The event's own zone, shown because the engine schedules
                    // in it and an operator elsewhere would otherwise misread.
                    <span className="muted">
                      {shortZone(occurrence.scheduledStart, occurrence.timezone)}
                    </span>
                  ) : null}
                  <div className="muted">{relative(occurrence.scheduledStart)}</div>
                </td>
                <td>
                  {occurrence.seriesLabel}
                  {occurrence.detached ? (
                    <div
                      className="muted"
                      title="This date was edited on its own, so later changes to the event leave it alone."
                    >
                      edited on its own
                    </div>
                  ) : null}
                </td>
                <td>{duration(occurrence.scheduledEnd - occurrence.scheduledStart)}</td>
                <td>
                  <StatusPill status={occurrence.runState ?? occurrence.status} />
                </td>
                <td>
                  <div className="row">
                    {occurrence.runId ? (
                      <button
                        onClick={() => navigate(`/runs/${occurrence.runId}`)}
                        title="Every step this run has taken, and what the device said back."
                      >
                        Timeline
                      </button>
                    ) : null}
                    {occurrence.status === 'pending' ? (
                      <>
                        {/* Makes the broadcast now, so an unlisted link can
                            go out ahead of the day. The outputs still start
                            at their own times. */}
                        <button
                          disabled={busy === occurrence.id}
                          title="Creates the broadcast now, so the link can go out ahead of the day. Nothing goes on air."
                          onClick={() =>
                            void act(occurrence.id, () => api.prepareNow(occurrence.id))
                          }
                        >
                          Prepare now
                        </button>
                        <button
                          disabled={busy === occurrence.id}
                          title="Runs it now, without waiting for its time."
                          onClick={() => void act(occurrence.id, () => api.startNow(occurrence.id))}
                        >
                          Start now
                        </button>
                        <button
                          disabled={busy === occurrence.id}
                          title="Leaves this date alone. The rest of the event carries on."
                          onClick={() => void act(occurrence.id, () => api.skip(occurrence.id))}
                        >
                          Skip
                        </button>
                      </>
                    ) : null}
                    {occurrence.status === 'skipped' ? (
                      <button
                        disabled={busy === occurrence.id}
                        title="Puts this date back on."
                        onClick={() => void act(occurrence.id, () => api.unskip(occurrence.id))}
                      >
                        Unskip
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export { toneFor }
