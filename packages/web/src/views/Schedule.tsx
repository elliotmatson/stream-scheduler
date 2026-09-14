import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Occurrence } from '../api.ts'
import { Card, Empty, ErrorBanner, StatusPill, toneFor } from '../components.tsx'
import { dateTimeIn, duration, isForeignZone, localDateKey, monthLabel, relative, shortZone, timeIn } from '../format.ts'

type View = 'calendar' | 'list'

export function Schedule({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const [view, setView] = useState<View>('calendar')
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })

  // A month's worth either side, so a calendar cell for an event in another
  // timezone is never missing just because the UTC instant fell outside.
  const from = Date.UTC(cursor.year, cursor.month - 1, 1)
  const to = Date.UTC(cursor.year, cursor.month + 2, 1)
  const { data, error, reload } = useResource(() => api.occurrences(from, to), [from, to])

  const shift = (by: number): void =>
    setCursor((c) => {
      const next = new Date(c.year, c.month + by, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })

  return (
    <>
      <div className="page-head">
        <h1>Schedule</h1>
        <div className="row">
          <div className="toggle">
            <button aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>
              Calendar
            </button>
            <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
              List
            </button>
          </div>
          {view === 'calendar' ? (
            <div className="row">
              <button onClick={() => shift(-1)} aria-label="Previous month">
                ←
              </button>
              <strong style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(cursor.year, cursor.month)}</strong>
              <button onClick={() => shift(1)} aria-label="Next month">
                →
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <ErrorBanner error={error} />

      {view === 'calendar' ? (
        <CalendarGrid
          year={cursor.year}
          month={cursor.month}
          occurrences={data ?? []}
          onSelect={(o) => navigate(o.runId ? `/runs/${o.runId}` : `/occurrences/${o.id}`)}
        />
      ) : (
        <ScheduleList occurrences={data ?? []} navigate={navigate} reload={reload} />
      )}
    </>
  )
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
          <div key={key} className={`day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}`}>
            <span className="daynum">{date.getDate()}</span>
            {events.map((occurrence) => (
              <button
                key={occurrence.id}
                className={`event ${occurrence.runState === 'live' ? 'live' : ''} ${occurrence.status}`}
                onClick={() => onSelect(occurrence)}
                title={`${occurrence.seriesLabel} — ${dateTimeIn(occurrence.scheduledStart, occurrence.timezone)} ${shortZone(occurrence.scheduledStart, occurrence.timezone)}`}
              >
                {timeIn(occurrence.scheduledStart, occurrence.timezone)} {occurrence.seriesLabel}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
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
              <th>Length</th>
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
                    <span className="muted">{shortZone(occurrence.scheduledStart, occurrence.timezone)}</span>
                  ) : null}
                  <div className="muted">{relative(occurrence.scheduledStart)}</div>
                </td>
                <td>
                  {occurrence.seriesLabel}
                  {occurrence.detached ? <div className="muted">edited — series changes skip this one</div> : null}
                </td>
                <td>{duration(occurrence.scheduledEnd - occurrence.scheduledStart)}</td>
                <td>
                  <StatusPill status={occurrence.runState ?? occurrence.status} />
                </td>
                <td>
                  <div className="row">
                    {occurrence.runId ? (
                      <button onClick={() => navigate(`/runs/${occurrence.runId}`)}>Timeline</button>
                    ) : null}
                    {occurrence.status === 'pending' ? (
                      <>
                        <button disabled={busy === occurrence.id} onClick={() => void act(occurrence.id, () => api.startNow(occurrence.id))}>
                          Start now
                        </button>
                        <button disabled={busy === occurrence.id} onClick={() => void act(occurrence.id, () => api.skip(occurrence.id))}>
                          Skip
                        </button>
                      </>
                    ) : null}
                    {occurrence.status === 'skipped' ? (
                      <button disabled={busy === occurrence.id} onClick={() => void act(occurrence.id, () => api.unskip(occurrence.id))}>
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
