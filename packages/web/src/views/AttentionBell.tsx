import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLiveRefresh, useResource } from '../api.ts'
import { IconAttention } from '../icons.tsx'

/**
 * What needs somebody, as a button on every screen.
 *
 * It used to be a card at the top of Home, which meant it was only seen
 * by whoever happened to be on Home, and pushed what is on air down the
 * page whenever anything at all was wrong. A count on the button says there
 * is something; opening it says what, and each line goes to the place
 * that fixes it.
 */
export function AttentionBell({ navigate }: { navigate: (path: string) => void }): ReactNode {
  const { data, reload } = useResource(() => api.attention(), [])
  useLiveRefresh(reload)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Closes on Escape or a click anywhere else, the way a menu does.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const items = data?.items ?? []
  const urgent = items.some((item) => item.kind !== 'media' && item.kind !== 'security')
  const label =
    items.length === 0
      ? 'Nothing needs attention'
      : `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention`

  return (
    <div className="bell" ref={box}>
      <button
        className="bell-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <IconAttention />
        {items.length > 0 ? (
          <span className={`bell-count ${urgent ? 'bad' : 'warn'}`} aria-hidden>
            {items.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="bell-panel card" role="dialog" aria-label="Needs attention">
          <strong>Needs attention</strong>
          {items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing right now.
            </p>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {items.map((item) => (
                <button
                  key={`${item.kind}-${item.message}`}
                  className={`banner ${item.kind === 'media' || item.kind === 'security' ? 'warn' : 'error'} banner-action`}
                  onClick={() => {
                    setOpen(false)
                    navigate(item.href)
                  }}
                >
                  {item.message}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
