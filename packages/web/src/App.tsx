import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from './api.ts'
import { Schedule } from './views/Schedule.tsx'
import { Devices } from './views/Devices.tsx'
import { SeriesList } from './views/SeriesList.tsx'
import { RunDetail, Runs } from './views/RunDetail.tsx'
import { Alerts } from './views/Alerts.tsx'

/**
 * A hash router in twenty lines. This app has a handful of screens; a routing
 * library would be more code than the routes.
 */
function useHashRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const onChange = (): void => setPath(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((next: string) => {
    window.location.hash = next
  }, [])

  return [path, navigate]
}

export function App(): ReactNode {
  const [path, navigate] = useHashRoute()
  const live = useLive()
  const liveRuns = live.runs.filter((run) => run.state === 'live').length

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">Stream Scheduler</div>
        <NavLink path={path} to="/" label="Schedule" navigate={navigate} />
        <NavLink path={path} to="/events" label="Events" navigate={navigate} />
        <NavLink path={path} to="/devices" label="Devices" navigate={navigate} />
        <NavLink path={path} to="/runs" label="Runs" navigate={navigate} />
        <NavLink path={path} to="/alerts" label="Alerts" navigate={navigate} />
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          {liveRuns > 0 ? (
            <span className="pill live">
              {liveRuns} live
            </span>
          ) : (
            // Says plainly whether what you are looking at is current.
            <span className={`pill ${live.connected ? 'ok' : 'bad'}`}>
              {live.connected ? 'connected' : 'reconnecting'}
            </span>
          )}
        </div>
      </nav>

      <main className="content">
        <Route path={path} navigate={navigate} />
      </main>
    </div>
  )
}

function Route({ path, navigate }: { path: string; navigate: (path: string) => void }): ReactNode {
  const run = /^\/runs\/(.+)$/.exec(path)
  if (run) return <RunDetail runId={run[1]!} navigate={navigate} />
  if (path === '/devices') return <Devices />
  if (path === '/events') return <SeriesList />
  if (path === '/runs') return <Runs navigate={navigate} />
  if (path === '/alerts') return <Alerts />
  return <Schedule navigate={navigate} />
}

function NavLink({
  path,
  to,
  label,
  navigate,
}: {
  path: string
  to: string
  label: string
  navigate: (path: string) => void
}): ReactNode {
  const active = to === '/' ? path === '/' || path.startsWith('/occurrences') : path.startsWith(to)
  return (
    <a
      className="nav-link"
      href={`#${to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault()
        navigate(to)
      }}
    >
      {label}
    </a>
  )
}
