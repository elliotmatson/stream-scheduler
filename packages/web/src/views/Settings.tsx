import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type BackupInspection, type SessionState } from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner, Field, PageHead } from '../components.tsx'
import { dateTimeIn, relative } from '../format.ts'

/**
 * The things that belong to the install rather than to an event.
 *
 * A password with nowhere to set it is the same as no password, and a
 * backup nobody can make is the same as no backup. Both live here.
 */
export function Settings({ onSessionChanged }: { onSessionChanged: () => void }): ReactNode {
  const { data, error, reload } = useResource(() => api.session(), [])

  return (
    <>
      <PageHead title="Settings" subtitle="Who can reach this install, and how to get it back." />
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

        <Backup />
      </div>
    </>
  )
}

/** The browser's own zone: a backup is a file on a disk, not an event. */
const here = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Taking a copy, and putting one back.
 *
 * Most of this card is words rather than controls, on purpose. The two
 * ways a backup quietly turns out to be worthless are both invisible —
 * a copy taken while the database was mid-write, and an archive whose
 * secrets no key can open — and the first is handled for you while the
 * second can only be handled by somebody who knows it is a question.
 */
function Backup(): ReactNode {
  const { data, error, reload } = useResource(() => api.backupStatus(), [])
  const [file, setFile] = useState<File>()
  const [looked, setLooked] = useState<BackupInspection>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [staged, setStaged] = useState<string>()
  const chooser = useRef<HTMLInputElement>(null)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const forget = (): void => {
    setFile(undefined)
    setLooked(undefined)
    if (chooser.current) chooser.current.value = ''
  }

  return (
    <Card title="Backup">
      <ErrorBanner error={error ?? problem} />

      <p className="muted" style={{ marginTop: 0 }}>
        One file: a complete, consistent copy of everything this install knows, taken without
        stopping it. Any tool that reads SQLite can open it.
      </p>

      {data ? (
        <>
          <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
            {data.includes.map((line) => (
              <div key={line}>
                <span className="ok-text">✓</span> {line}
              </div>
            ))}
            {data.excludes.map((line) => (
              <div key={line} className="muted">
                <span>✗</span> {line}
              </div>
            ))}
          </div>

          {/* The part nobody thinks about until a restore, and the part
              that decides whether the restore is any use. */}
          <div className="banner">
            <strong>The master key is not in the backup.</strong>
            <div style={{ marginTop: 4 }}>{data.keySourceLabel}</div>
            {data.secretsReadable.state === 'unreadable' ? (
              <div className="warn-text" style={{ marginTop: 6 }}>
                {data.secretsReadable.message}
              </div>
            ) : null}
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            {/* A plain link, so the browser saves the file the way it
                saves every other download. */}
            <a className="button-link" href="/api/backup" download>
              Download a backup
            </a>
          </div>
        </>
      ) : null}

      {data?.lastRestore ? (
        <div className="banner" style={{ marginTop: 12 }}>
          This install started by restoring a backup taken {relative(data.lastRestore.takenAt)}. The
          database it replaced was kept, at <code>{data.lastRestore.previousDatabase}</code>.
        </div>
      ) : null}

      <h3 style={{ marginBottom: 4 }}>Restore</h3>

      {data?.stagedRestore ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="banner warn">
            A backup taken {dateTimeIn(data.stagedRestore.takenAt, here)} is waiting. Restart the
            app to finish restoring it. The database in place now will be kept alongside it rather
            than deleted.
          </div>
          <div className="row">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.cancelRestore()
                  setStaged(undefined)
                  forget()
                  reload()
                })
              }
            >
              Cancel it
            </button>
          </div>
        </div>
      ) : staged ? (
        <div className="banner">{staged}</div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <p className="muted" style={{ margin: 0 }}>
            Choosing a file says what is in it and what its secrets would need. Nothing changes
            until you confirm.
          </p>
          <input
            ref={chooser}
            type="file"
            accept=".db,application/octet-stream"
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              setLooked(undefined)
              setProblem(undefined)
              setFile(chosen)
              if (chosen) {
                void run(async () => setLooked(await api.inspectBackup(chosen)))
              }
            }}
          />

          {looked ? (
            <>
              <div className="row" style={{ gap: 18 }}>
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Taken
                  </div>
                  <div>{dateTimeIn(looked.takenAt, here)}</div>
                </div>
                {Object.entries(looked.counts).map(([label, count]) => (
                  <div key={label}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {label}
                    </div>
                    <div>{count}</div>
                  </div>
                ))}
              </div>

              <div className={looked.key.state === 'mismatch' ? 'banner warn' : 'banner'}>
                {looked.key.message}
              </div>

              <div className="row">
                <ConfirmButton
                  label="Restore this"
                  confirmLabel="Really replace everything?"
                  disabled={busy || !file}
                  onConfirm={() =>
                    void run(async () => {
                      const result = await api.restoreBackup(file!, looked.confirm)
                      setStaged(result.message)
                      forget()
                      reload()
                    })
                  }
                />
                <button disabled={busy} onClick={forget}>
                  Choose another
                </button>
              </div>
            </>
          ) : file ? null : (
            <Empty>No file chosen.</Empty>
          )}
        </div>
      )}
    </Card>
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

  return (
    <Card title="Password">
      <p className="muted" style={{ marginTop: 0 }}>
        {session.required
          ? 'One password, shared by everyone who runs this. Changing it signs everybody out, including you on your other devices.'
          : 'No password is set, so anyone who can reach this address can start a broadcast and drive your devices. On a booth machine nobody else can reach, that is a reasonable way to run it.'}
      </p>

      {/* Said once, where somebody about to change it will read it. The
          variable is almost always still sitting in a compose file, and
          "why did my change stick?" is a fair question to have answered
          before you make it rather than after. */}
      {session.seededFromEnvironment ? (
        <p className="muted" style={{ marginTop: 0 }}>
          This password started out as <code>SCHEDULER_UI_PASSWORD</code>. It was copied here the
          first time the app started and that variable is no longer read, so changing it here is
          what counts from now on.
        </p>
      ) : null}

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
