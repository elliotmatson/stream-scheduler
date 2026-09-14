import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useLive } from './api.ts'
import { useTheme, type ThemePreference } from './theme.ts'
import {
  IconAlerts,
  IconBrand,
  IconDevices,
  IconEvents,
  IconMoon,
  IconRuns,
  IconNow,
  IconSchedule,
  IconServices,
  IconSun,
  IconSystem,
} from './icons.tsx'
import { Dashboard } from './views/Dashboard.tsx'
import { Schedule } from './views/Schedule.tsx'
import { Devices } from './views/Devices.tsx'
import { SeriesList } from './views/SeriesList.tsx'
import { RunDetail, Runs } from './views/RunDetail.tsx'
import { Alerts } from './views/Alerts.tsx'
import { Services } from './views/Services.tsx'

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

const NAV = [
  // What is on air now comes before what is planned: this is the screen a
  // booth leaves open, and everything else is for setting up.
  { to: '/', label: 'Now', icon: <IconNow /> },
  { to: '/schedule', label: 'Schedule', icon: <IconSchedule /> },
  { to: '/events', label: 'Events', icon: <IconEvents /> },
  { to: '/devices', label: 'Devices', icon: <IconDevices /> },
  { to: '/services', label: 'Services', icon: <IconServices /> },
  { to: '/runs', label: 'Runs', icon: <IconRuns /> },
  { to: '/alerts', label: 'Alerts', icon: <IconAlerts /> },
]

export function App(): ReactNode {
  const [path, navigate] = useHashRoute()
  const live = useLive()
  const theme = useTheme()
  const liveRuns = live.runs.filter((run) => run.state === 'running').length

  return (
    <div className="app">
      <nav className="sidebar">
        {/* The nav sticks to the top; the <nav> itself stretches, so the
            panel is painted all the way down a long page. */}
        <div className="sidebar-inner">
          <div className="brand">
            <span className="brand-mark">
              <IconBrand />
            </span>
            Stream Scheduler
          </div>

          {NAV.map((item) => (
            <NavLink key={item.to} path={path} to={item.to} label={item.label} icon={item.icon} navigate={navigate} />
          ))}

          <div className="sidebar-foot">
            {liveRuns > 0 ? (
              <span className="pill live">{liveRuns} live</span>
            ) : (
              // Says plainly whether what you are looking at is current.
              <span className={`pill ${live.connected ? 'ok' : 'bad'}`}>
                {live.connected ? 'connected' : 'reconnecting'}
              </span>
            )}
            <ThemeToggle preference={theme.preference} onChange={theme.setPreference} />
          </div>
        </div>
      </nav>

      <main className="content">
        <Route path={path} navigate={navigate} />
      </main>
    </div>
  )
}

const THEMES: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'Match the system setting', icon: <IconSystem /> },
  { value: 'light', label: 'Light', icon: <IconSun /> },
  { value: 'dark', label: 'Dark', icon: <IconMoon /> },
]

function ThemeToggle({
  preference,
  onChange,
}: {
  preference: ThemePreference
  onChange: (next: ThemePreference) => void
}): ReactNode {
  return (
    <div className="toggle theme-toggle" role="group" aria-label="Theme">
      {THEMES.map((option) => (
        <button
          key={option.value}
          aria-pressed={preference === option.value}
          // Icon-only, so the accessible name has to come from the label.
          aria-label={option.label}
          title={option.label}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  )
}

function Route({ path, navigate }: { path: string; navigate: (path: string) => void }): ReactNode {
  const run = /^\/runs\/(.+)$/.exec(path)
  if (run) return <RunDetail runId={run[1]!} navigate={navigate} />
  if (path === '/schedule') return <Schedule navigate={navigate} />
  if (path === '/devices') return <Devices />
  if (path === '/services') return <Services />
  if (path === '/events') return <SeriesList />
  if (path === '/runs') return <Runs navigate={navigate} />
  if (path === '/alerts') return <Alerts />
  return <Dashboard navigate={navigate} />
}

function NavLink({
  path,
  to,
  label,
  icon,
  navigate,
}: {
  path: string
  to: string
  label: string
  icon: ReactNode
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
      {icon}
      <span>{label}</span>
    </a>
  )
}
