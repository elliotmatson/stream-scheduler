import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api.ts'
import { IconBrand } from '../icons.tsx'

/**
 * The whole app, when it is locked.
 *
 * Deliberately the only thing on screen: a login form in a corner of a
 * dashboard invites the dashboard to be half-rendered from failed requests.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }): ReactNode {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await api.login(password)
      setPassword('')
      onSignedIn()
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form
        className="card signin-card"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="brand" style={{ marginBottom: 4 }}>
          <span className="brand-mark">
            <IconBrand />
          </span>
          Stream Scheduler
        </div>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            // The only thing on the page worth typing into.
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? (
          <div className="banner error" role="alert">
            {error}
          </div>
        ) : null}

        <button className="primary" type="submit" disabled={busy || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          One password for everyone who runs this. Lost it? Whoever set it up can change it, or
          clear it from the machine this runs on.
        </p>
      </form>
    </div>
  )
}
