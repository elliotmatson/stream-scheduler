import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type SessionState } from '../api.ts'
import { Card, ConfirmButton, ErrorBanner, Field, PageHead } from '../components.tsx'

/**
 * The things that belong to the install rather than to an event.
 *
 * One card so far. It is here because a password with nowhere to set it is
 * the same as no password.
 */
export function Settings({ onSessionChanged }: { onSessionChanged: () => void }): ReactNode {
  const { data, error, reload } = useResource(() => api.session(), [])

  return (
    <>
      <PageHead title="Settings" subtitle="How this install is reached, and who can reach it." />
      <ErrorBanner error={error} />

      <div className="stack">
        {data ? (
          <Security
            session={data}
            onChanged={() => {
              reload()
              onSessionChanged()
            }}
          />
        ) : null}
      </div>
    </>
  )
}

function Security({
  session,
  onChanged,
}: {
  session: SessionState
  onChanged: () => void
}): ReactNode {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string>()

  const act = async (next: string | null): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    try {
      await api.setPassword(next)
      setPassword('')
      setConfirm('')
      setDone(next === null ? 'The password is off.' : 'Saved. Everyone else is signed out.')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const mismatch = confirm !== '' && confirm !== password
  const tooShort = password !== '' && password.length < session.minPasswordLength

  if (session.managedByEnvironment) {
    return (
      <Card title="Password">
        <p className="muted" style={{ marginTop: 0 }}>
          Set by <code>SCHEDULER_UI_PASSWORD</code> on the machine this runs on, so it cannot be
          changed from here. Change it there and restart.
        </p>
      </Card>
    )
  }

  return (
    <Card title="Password">
      <p className="muted" style={{ marginTop: 0 }}>
        {session.required
          ? 'One password, shared by everyone who runs this. Changing it signs everybody out, including you on your other devices.'
          : 'No password is set, so anyone who can reach this address can start a broadcast and drive your devices. On a booth machine nobody else can reach, that is a reasonable way to run it.'}
      </p>

      <ErrorBanner error={error} />
      {done ? <div className="banner info">{done}</div> : null}

      <div className="stack" style={{ maxWidth: 420 }}>
        <Field
          label={session.required ? 'New password' : 'Password'}
          hint={`At least ${session.minPasswordLength} characters.`}
        >
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Again" hint={mismatch ? 'These two do not match.' : undefined}>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        <div className="row">
          <button
            className="primary"
            disabled={busy || password === '' || mismatch || tooShort || confirm === ''}
            onClick={() => void act(password)}
          >
            {busy ? 'Saving…' : session.required ? 'Change it' : 'Set a password'}
          </button>
          {session.required ? (
            <ConfirmButton
              label="Remove the password"
              confirmLabel="Leave it open to anyone?"
              disabled={busy}
              onConfirm={() => void act(null)}
            />
          ) : null}
        </div>
      </div>
    </Card>
  )
}
