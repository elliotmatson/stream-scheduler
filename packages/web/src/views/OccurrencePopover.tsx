import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, type Device, type Occurrence } from '../api.ts'
import { ErrorBanner, IconButton, StatusPill } from '../components.tsx'
import { IconClose } from '../icons.tsx'
import { dateTimeIn, timeIn } from '../format.ts'

/**
 * One date, at a glance, where it was clicked.
 *
 * What it is, when, what it uses, and the things people do to one date —
 * open it, skip it, start it, get its link — without leaving the calendar.
 * Before, those lived only in the List view, and clicking a date anywhere
 * else went straight to a page.
 */
export function OccurrencePopover({
  occurrence,
  devices,
  at,
  navigate,
  onClose,
  onChanged,
}: {
  occurrence: Occurrence
  devices: Device[]
  at: { x: number; y: number }
  navigate: (path: string) => void
  onClose: () => void
  onChanged: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const box = useRef<HTMLDivElement>(null)

  // Closed by Escape or a click anywhere else, like any popover.
  useEffect(() => {
    box.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onClick = (event: MouseEvent): void => {
      if (box.current && !box.current.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // On the next turn, so the click that opened it does not close it.
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick))
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  const act = async (action: () => Promise<unknown>, after = onChanged): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
      after()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const uses = (occurrence.deviceIds ?? [])
    .map((id) => devices.find((device) => device.id === id)?.label)
    .filter(Boolean)
  const pending = occurrence.status === 'pending'

  // Kept on screen: placed beside the click, pulled back in at the edges.
  const width = 300
  const left = Math.max(8, Math.min(at.x + 8, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(at.y + 8, window.innerHeight - 280))

  return (
    <div
      ref={box}
      className="popover card"
      role="dialog"
      aria-label={occurrence.label}
      tabIndex={-1}
      style={{ position: 'fixed', left, top, width, zIndex: 20 }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{occurrence.label}</strong>
        <IconButton label="Close" icon={<IconClose />} onClick={onClose} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <StatusPill status={occurrence.runState ?? occurrence.status} />
        <span className="muted">
          {dateTimeIn(occurrence.scheduledStart, occurrence.timezone)} –{' '}
          {timeIn(occurrence.scheduledEnd, occurrence.timezone)}
        </span>
      </div>
      {uses.length > 0 ? <div className="muted small">Uses {uses.join(', ')}</div> : null}

      <ErrorBanner error={problem} />

      {/* Two things, always the same two: open it, or leave this date out.
          Everything else — going live, preparing, editing — is on the
          page Open goes to, where there is room to say what it does. */}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="primary" onClick={() => navigate(`/occurrences/${occurrence.id}`)}>
          Open
        </button>
        {pending ? (
          <button disabled={busy} onClick={() => void act(() => api.skip(occurrence.id))}>
            Skip
          </button>
        ) : null}
        {occurrence.status === 'skipped' ? (
          <button disabled={busy} onClick={() => void act(() => api.unskip(occurrence.id))}>
            Unskip
          </button>
        ) : null}
      </div>
    </div>
  )
}
