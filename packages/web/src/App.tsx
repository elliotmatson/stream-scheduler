import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLive, useResource, whenSignedOut } from './api.ts'
import { useTheme, type ThemePreference } from './theme.ts'
import {
  IconBrand,
  IconDevices,
  IconEvents,
  IconMoon,
  IconRuns,
  IconNotifications,
  IconNow,
  IconSchedule,
  IconServices,
  IconSettings,
  IconSun,
  IconSystem,
} from './icons.tsx'
import { Dashboard } from './views/Dashboard.tsx'
import { Schedule } from './views/Schedule.tsx'
import { Devices } from './views/Devices.tsx'
import { SeriesList } from './views/SeriesList.tsx'
import { RunDetail, Runs } from './views/RunDetail.tsx'
import { Notifications } from './views/Notifications.tsx'
import { Services } from './views/Services.tsx'
import { Settings } from './views/Settings.tsx'
import { Login } from './views/Login.tsx'

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
  { to: '/notifications', label: 'Notifications', icon: <IconNotifications /> },
  { to: '/settings', label: 'Settings', icon: <IconSettings /> },
]

export function App(): ReactNode {
  const [path, navigate] = useHashRoute()
  const theme = useTheme()
  const session = useResource(() => api.session(), [])

  // Any request coming back 401 — an expired session, or a password set
  // from another browser — re-reads the session, which puts the login form
  // up rather than leaving a screen of numbers that stopped being true.
  useEffect(() => whenSignedOut(session.reload), [session.reload])

  // Nothing is rendered until the answer is in: guessing wrong flashes the
  // whole app up and then snatches it away, or the reverse.
  if (!session.data) return null
  if (session.data.required && !session.data.signedIn) {
    return <Login onSignedIn={session.reload} />
  }

  return (
    <SignedIn
      path={path}
      navigate={navigate}
      theme={theme}
      locked={session.data.required}
      onSessionChanged={session.reload}
    />
  )
}

function SignedIn({
  path,
  navigate,
  theme,
  locked,
  onSessionChanged,
}: {
  path: string
  navigate: (path: string) => void
  theme: ReturnType<typeof useTheme>
  /** Whether there is a password to sign out of. */
  locked: boolean
  onSessionChanged: () => void
}): ReactNode {
  // Below the gate, so the socket is only opened by a browser that is
  // allowed to have one.
  const live = useLive()
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

          {/* Grouped so the links can scroll sideways on a phone without
              taking the status pill and the theme toggle with them. */}
          <div className="nav-links">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                path={path}
                to={item.to}
                label={item.label}
                icon={item.icon}
                navigate={navigate}
              />
            ))}
          </div>

          <div className="sidebar-foot">
            {liveRuns > 0 ? (
              <span
                className="pill live"
                title={`${liveRuns === 1 ? 'One event is' : `${liveRuns} events are`} on air.`}
              >
                {liveRuns} live
              </span>
            ) : (
              // Says plainly whether what you are looking at is current.
              <span
                // The happy one is hidden on a phone, where it would cost a
                // third of the bar to say that nothing is wrong.
                className={`pill ${live.connected ? 'ok when-wide' : 'bad'}`}
                title={
                  live.connected
                    ? 'These screens are following the server. They update themselves.'
                    : 'Not following the server, so what you see may be out of date. Trying again.'
                }
              >
                {live.connected ? 'connected' : 'reconnecting'}
              </span>
            )}
            <ThemeToggle preference={theme.preference} onChange={theme.setPreference} />
            {locked ? (
              <button
                className="link"
                title="Ends this session on this browser."
                onClick={() => {
                  void api.logout().then(onSessionChanged, onSessionChanged)
                }}
              >
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      </nav>

      <main className="content">
        <Route path={path} navigate={navigate} onSessionChanged={onSessionChanged} />
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

function Route({
  path,
  navigate,
  onSessionChanged,
}: {
  path: string
  navigate: (path: string) => void
  onSessionChanged: () => void
}): ReactNode {
  const run = /^\/runs\/(.+)$/.exec(path)
  if (run) return <RunDetail runId={run[1]!} navigate={navigate} />
  // A device linked to from the status board or a run's own page.
  const device = /^\/devices\/(.+)$/.exec(path)
  if (device) return <Devices focusId={device[1]!} />
  if (path === '/settings') return <Settings onSessionChanged={onSessionChanged} />
  if (path === '/schedule') return <Schedule navigate={navigate} />
  if (path === '/devices') return <Devices />
  if (path === '/services') return <Services />
  if (path === '/events') return <SeriesList />
  if (path === '/runs') return <Runs navigate={navigate} />
  if (path === '/notifications') return <Notifications />
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
