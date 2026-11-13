import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api, useLiveRefresh, useResource, type Occurrence } from '../api.ts'
import {
  Card,
  ConfirmButton,
  CopyButton,
  Empty,
  ErrorBanner,
  PageHead,
  StatusPill,
  toneFor,
} from '../components.tsx'
import { OccurrencePopover } from './OccurrencePopover.tsx'
import {
  dateTimeIn,
  dayLabel,
  inputTimeIn,
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

type View = 'day' | 'week' | 'month' | 'list'

export function Schedule({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const [view, setView] = useState<View>('month')
  // One anchor for both calendars: the month it falls in, or the week it
  // falls in. Switching views then keeps you looking at the same dates
  // rather than jumping back to today.
  const [anchor, setAnchor] = useState(() => new Date())

  const weekStart = startOfWeek(anchor)
  const dayStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  // A month's worth either side in the month view, a few days in the week
  // view: a calendar cell for an event in another timezone must never be
  // missing just because the UTC instant fell outside the range.
  const range =
    view === 'day'
      ? { from: addDays(dayStart, -2).getTime(), to: addDays(dayStart, 3).getTime() }
      : view === 'week'
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
      view === 'day'
        ? addDays(current, by)
        : view === 'week'
          ? addDays(current, by * 7)
          : new Date(current.getFullYear(), current.getMonth() + by, 1),
    )

  // Narrowed to one device's mornings: which events need the main encoder
  // this month is a question people ask about the gear, not the events.
  const devices = useResource(() => api.devices(), []).data ?? []
  const [deviceFilter, setDeviceFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<'' | 'stream' | 'recording'>('')
  const knownTags = [
    ...new Set([
      ...(data ?? []).flatMap((occurrence) => occurrence.tags ?? []),
      ...(tagFilter ? [tagFilter] : []),
    ]),
  ].sort()
  const shown = (data ?? []).filter(
    (occurrence) =>
      (!tagFilter || (occurrence.tags ?? []).includes(tagFilter)) &&
      (!kindFilter || (occurrence.kinds ?? []).includes(kindFilter)) &&
      (!deviceFilter || (occurrence.deviceIds ?? []).includes(deviceFilter)),
  )

  // A click opens a summary with the things people do to one date, rather
  // than going straight to a page: most of the time a glance is the point.
  const [picked, setPicked] = useState<{ occurrence: Occurrence; x: number; y: number }>()
  const select = (occurrence: Occurrence, at?: { x: number; y: number }): void =>
    setPicked({ occurrence, x: at?.x ?? 0, y: at?.y ?? 0 })

  const move = useMove(reload)

  return (
    <>
      <PageHead
        title="Schedule"
        actions={
          <>
            {/* Smallest span to largest, then the list. */}
            <div className="toggle">
              <button aria-pressed={view === 'day'} onClick={() => setView('day')}>
                Day
              </button>
              <button aria-pressed={view === 'week'} onClick={() => setView('week')}>
                Week
              </button>
              <button aria-pressed={view === 'month'} onClick={() => setView('month')}>
                Month
              </button>
              <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
                List
              </button>
            </div>
            <button className="primary" onClick={() => navigate('/events')}>
              Add an event
            </button>
          </>
        }
      />

      {/* Where you are on the left, what you are looking at on the right. */}
      <div className="schedule-bar">
        {view === 'list' ? (
          <span />
        ) : (
          <div className="row">
            <button onClick={() => setAnchor(new Date())}>Today</button>
            <button
              onClick={() => shift(-1)}
              aria-label={
                view === 'day'
                  ? 'Previous day'
                  : view === 'week'
                    ? 'Previous week'
                    : 'Previous month'
              }
            >
              ←
            </button>
            <button
              onClick={() => shift(1)}
              aria-label={
                view === 'day' ? 'Next day' : view === 'week' ? 'Next week' : 'Next month'
              }
            >
              →
            </button>
            <strong>
              {view === 'day'
                ? dayStart.toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })
                : view === 'week'
                  ? weekLabel(weekStart)
                  : monthLabel(anchor.getFullYear(), anchor.getMonth())}
            </strong>
          </div>
        )}
        <div className="row">
          {devices.length > 1 ? (
            <select
              aria-label="Device"
              value={deviceFilter}
              onChange={(event) => setDeviceFilter(event.target.value)}
            >
              <option value="">All devices</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          ) : null}
          {knownTags.length > 0 ? (
            <select
              aria-label="Tag"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">All tags</option>
              {knownTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          ) : null}
          <select
            aria-label="Streams or recordings"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as '' | 'stream' | 'recording')}
          >
            <option value="">Streams and recordings</option>
            <option value="stream">Streams</option>
            <option value="recording">Recordings</option>
          </select>
        </div>
      </div>

      <ErrorBanner error={error ?? move.problem} />

      {data !== undefined && data.length === 0 ? (
        // An empty calendar is a blank grid; it says nothing about what to
        // do next. This does.
        <div className="banner info">
          Nothing is scheduled yet.{' '}
          <button className="link" onClick={() => navigate('/events')}>
            Add an event
          </button>
        </div>
      ) : null}

      {view === 'month' ? (
        <CalendarGrid
          year={anchor.getFullYear()}
          month={anchor.getMonth()}
          occurrences={shown}
          onSelect={select}
          move={move}
        />
      ) : view === 'week' || view === 'day' ? (
        <WeekGrid
          start={view === 'day' ? dayStart : weekStart}
          dayCount={view === 'day' ? 1 : 7}
          occurrences={shown}
          onSelect={select}
          move={move}
        />
      ) : (
        <ScheduleList occurrences={shown} navigate={navigate} reload={reload} />
      )}

      {picked ? (
        <OccurrencePopover
          devices={devices}
          occurrence={picked.occurrence}
          at={picked}
          navigate={navigate}
          onClose={() => setPicked(undefined)}
          onChanged={() => {
            setPicked(undefined)
            reload()
          }}
        />
      ) : null}
    </>
  )
}

/**
 * Dragging one date of a repeating event to another.
 *
 * The obvious gesture, and it writes the same override the occurrence
 * screen does — the same endpoint, the same rails. What it is not allowed
 * to be is a shortcut around them: the server still resolves the dropped
 * wall-clock time in the event's own zone, still refuses a time the clocks
 * skip over, still refuses the past, and still refuses anything that has
 * run or is running. A drop that lands on one of those puts the message on
 * the page rather than silently snapping back.
 *
 * Only a pending date moves. A drag that could quietly reschedule a
 * service already on air is a gesture nobody wants near a Sunday.
 *
 * Dragging is the shortcut, not the only way. It is the browser's own
 * drag and drop, which does not happen on a touch screen at all — so the
 * occurrence's own page takes a date and a time in boxes, and that is the
 * path a phone uses.
 */
interface Move {
  /** The occurrence being dragged, if any. */
  dragging: Occurrence | undefined
  problem: string | undefined
  /** Whether this one may be picked up at all. */
  movable: (occurrence: Occurrence) => boolean
  start: (occurrence: Occurrence) => void
  end: () => void
  /** Drops it on a date, keeping the time of day it already had. */
  toDay: (date: string) => void
  /** Drops it on a date and a time, both in the event's own zone. */
  toDayAndTime: (date: string, minutesOfDay: number) => void
}

/** Dropping between the lines is fussy; a quarter of an hour is the grid
 *  everybody already thinks in. */
const SNAP_MINUTES = 15

function useMove(reload: () => void): Move {
  const [dragging, setDragging] = useState<Occurrence>()
  const [problem, setProblem] = useState<string>()

  const send = (occurrence: Occurrence, date: string, time: string): void => {
    setDragging(undefined)
    setProblem(undefined)
    if (
      date === localDateKey(occurrence.scheduledStart, occurrence.timezone) &&
      time === inputTimeIn(occurrence.scheduledStart, occurrence.timezone)
    ) {
      // Picked up and put back down. Not an edit, so it must not detach it.
      return
    }
    api
      .editOccurrence(occurrence.id, { startsAt: { date, time } })
      .then(reload, (err: Error) => setProblem(err.message))
  }

  return {
    dragging,
    problem,
    movable: (occurrence) => occurrence.status === 'pending' && occurrence.runId === null,
    start: (occurrence) => {
      setProblem(undefined)
      setDragging(occurrence)
    },
    end: () => setDragging(undefined),
    toDay: (date) => {
      if (dragging) send(dragging, date, inputTimeIn(dragging.scheduledStart, dragging.timezone))
    },
    toDayAndTime: (date, minutesOfDay) => {
      if (!dragging) return
      const snapped = Math.max(
        0,
        Math.min(23 * 60 + 45, Math.round(minutesOfDay / SNAP_MINUTES) * SNAP_MINUTES),
      )
      const hh = String(Math.floor(snapped / 60)).padStart(2, '0')
      const mm = String(snapped % 60).padStart(2, '0')
      send(dragging, date, `${hh}:${mm}`)
    },
  }
}

/** The props a chip needs to be picked up, or nothing when it cannot be. */
function dragProps(
  occurrence: Occurrence,
  move: Move,
): { draggable: true; onDragStart: () => void; onDragEnd: () => void } | Record<string, never> {
  if (!move.movable(occurrence)) return {}
  return {
    draggable: true,
    onDragStart: () => move.start(occurrence),
    onDragEnd: () => move.end(),
  }
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
  move,
}: {
  year: number
  month: number
  occurrences: Occurrence[]
  onSelect: (occurrence: Occurrence, at?: { x: number; y: number }) => void
  move: Move
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
    <div className="calendar" role="region" aria-label="Scheduled events">
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
            className={`day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}${
              move.dragging ? ' droppable' : ''
            }`}
            // Only a day being dragged over accepts the drop; preventing the
            // default is what makes a drop possible at all.
            onDragOver={move.dragging ? (event) => event.preventDefault() : undefined}
            onDrop={
              move.dragging
                ? (event) => {
                    event.preventDefault()
                    move.toDay(key)
                  }
                : undefined
            }
          >
            <span className="daynum">{date.getDate()}</span>
            {events.map((occurrence) => (
              <button
                key={occurrence.id}
                className={`event ${occurrence.runState === 'running' ? 'live' : ''} ${occurrence.status}${
                  move.dragging?.id === occurrence.id ? ' dragging' : ''
                }`}
                onClick={(event) => onSelect(occurrence, { x: event.clientX, y: event.clientY })}
                title={describeChip(occurrence, move.movable(occurrence))}
                {...dragProps(occurrence, move)}
              >
                {/* Two lines: at a glance you want the time, and the name
                    would otherwise be cut off in a narrow cell. */}
                <span className="event-time">
                  {timeIn(occurrence.scheduledStart, occurrence.timezone)}
                  {occurrence.detached ? <ChangedMark /> : null}
                </span>
                <span className="event-name">{occurrence.label}</span>
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
/**
 * A dot on a date somebody has changed by hand.
 *
 * The trap this exists for: an occurrence edited away from its series
 * looks identical to one following it, and later changes to the event
 * leave it behind. A mark is the difference between "the service moved"
 * and "the service moved except that one and nobody noticed".
 */
function ChangedMark(): ReactNode {
  return (
    <span className="event-changed" aria-label="changed on its own">
      •
    </span>
  )
}

/** The chip's tooltip: what it is, when, and whether it is its own. */
function describeChip(occurrence: Occurrence, movable = false): string {
  const when = `${dateTimeIn(occurrence.scheduledStart, occurrence.timezone)} ${shortZone(occurrence.scheduledStart, occurrence.timezone)}`
  const drag = movable ? ' Drag it to move this date on its own.' : ''
  if (!occurrence.detached) return `${occurrence.label} — ${when}.${drag}`
  const moved =
    occurrence.overrides.movedFrom === undefined
      ? ''
      : `, moved from ${dateTimeIn(occurrence.overrides.movedFrom, occurrence.timezone)}`
  return `${occurrence.label} — ${when}. Changed on its own${moved}, so edits to «${occurrence.seriesLabel}» leave it alone.${drag}`
}

function WeekGrid({
  start,
  dayCount = 7,
  occurrences,
  onSelect,
  move,
}: {
  start: Date
  /** 7 for a week, 1 for the day view. */
  dayCount?: number
  occurrences: Occurrence[]
  onSelect: (occurrence: Occurrence, at?: { x: number; y: number }) => void
  move: Move
}): ReactNode {
  // Keyed on the week itself, not on the array: a fresh array every render
  // would make every memo below recompute and defeat the point of them.
  const weekKey = keyOf(start)
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, index) => addDays(start, index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekKey, dayCount],
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
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
  const offset = (minutes: number): number => (minutes / 60 - window.from) * HOUR_PX

  return (
    <div
      className="week"
      role="region"
      aria-label="Scheduled events by time of day"
      style={{ '--days': dayCount } as CSSProperties}
    >
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
              className={`week-day${key === todayKey ? ' today' : ''}${
                move.dragging ? ' droppable' : ''
              }`}
              style={{ height: hours.length * HOUR_PX, backgroundSize: `100% ${HOUR_PX}px` }}
              onDragOver={move.dragging ? (event) => event.preventDefault() : undefined}
              onDrop={
                move.dragging
                  ? (event) => {
                      event.preventDefault()
                      // Where in the column it landed, read as a time of
                      // day in the event's own zone — the same axis the
                      // chips were laid out on.
                      const box = event.currentTarget.getBoundingClientRect()
                      const minutes = (window.from + (event.clientY - box.top) / HOUR_PX) * 60
                      move.toDayAndTime(key, minutes)
                    }
                  : undefined
              }
            >
              {key === todayKey &&
              nowMinutes >= window.from * 60 &&
              nowMinutes <= window.to * 60 ? (
                // Where the day has got to, as in any calendar: the line
                // between what has happened and what is still coming.
                <div className="now-line" style={{ top: offset(nowMinutes) }} aria-hidden="true" />
              ) : null}
              {(laid.get(key) ?? []).map((placed) => (
                <button
                  key={placed.occurrence.id}
                  className={`event ${placed.occurrence.runState === 'running' ? 'live' : ''} ${placed.occurrence.status}${
                    move.dragging?.id === placed.occurrence.id ? ' dragging' : ''
                  }`}
                  {...dragProps(placed.occurrence, move)}
                  style={{
                    position: 'absolute',
                    top: offset(placed.from),
                    height: Math.max(offset(placed.to) - offset(placed.from), 18),
                    // Side by side when they overlap, so neither hides the
                    // other and the clash is visible.
                    left: `${(placed.lane / placed.lanes) * 100}%`,
                    width: `${(1 / placed.lanes) * 100}%`,
                  }}
                  onClick={(event) =>
                    onSelect(placed.occurrence, { x: event.clientX, y: event.clientY })
                  }
                  title={describeChip(placed.occurrence, move.movable(placed.occurrence))}
                >
                  <span className="event-time">
                    {timeIn(placed.occurrence.scheduledStart, placed.occurrence.timezone)}
                    {placed.occurrence.detached ? <ChangedMark /> : null}
                  </span>
                  <span className="event-name">{placed.occurrence.label}</span>
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

  const [links, setLinks] = useState<{
    occurrenceId: string
    links: { label: string; url: string }[]
  }>()

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
                  {occurrence.label}
                  {occurrence.detached ? (
                    <div
                      className="muted"
                      title={`This date was edited on its own, so later changes to «${occurrence.seriesLabel}» leave it alone.`}
                    >
                      edited on its own
                      {occurrence.label === occurrence.seriesLabel
                        ? ''
                        : ` · ${occurrence.seriesLabel}`}
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
                        <button
                          title="This one date on its own: what it is called, when it runs, and what goes out."
                          onClick={() => navigate(`/occurrences/${occurrence.id}`)}
                        >
                          Open
                        </button>
                        {/* Makes the broadcast now, so an unlisted link can
                            go out ahead of the day. The outputs still start
                            at their own times. */}
                        <button
                          disabled={busy === occurrence.id}
                          title="Creates the broadcast now, so the link can go out ahead of the day. Nothing goes on air."
                          onClick={() =>
                            void act(occurrence.id, async () => {
                              const prepared = await api.prepareNow(occurrence.id)
                              setLinks({ occurrenceId: occurrence.id, links: prepared.links })
                            })
                          }
                        >
                          Prepare now
                        </button>
                        {/* Puts it on air this minute: asked twice. */}
                        <ConfirmButton
                          className=""
                          label="Start now"
                          confirmLabel="Go on air now?"
                          disabled={busy === occurrence.id}
                          title="Runs it now, without waiting for its time."
                          onConfirm={() =>
                            void act(occurrence.id, () => api.startNow(occurrence.id))
                          }
                        />
                        <button
                          disabled={busy === occurrence.id}
                          title="Leaves this date alone. The rest of the event carries on."
                          onClick={() => void act(occurrence.id, () => api.skip(occurrence.id))}
                        >
                          Skip
                        </button>
                      </>
                    ) : null}
                    {['failed', 'cancelled'].includes(occurrence.status) &&
                    occurrence.scheduledEnd > Date.now() ? (
                      <button
                        disabled={busy === occurrence.id}
                        title="Puts this date back on the schedule, to run at its time."
                        onClick={() => void act(occurrence.id, () => api.rearm(occurrence.id))}
                      >
                        Schedule again
                      </button>
                    ) : null}
                    {links?.occurrenceId === occurrence.id && links.links.length > 0 ? (
                      <span className="links">
                        {links.links.map((link) => (
                          <CopyButton
                            key={link.url}
                            value={link.url}
                            label={`Copy ${link.label}`}
                          />
                        ))}
                      </span>
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
