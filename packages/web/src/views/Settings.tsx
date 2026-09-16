import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type BackupInspection,
  type BackupSchedule,
  type BackupStatus,
  type SessionState,
} from '../api.ts'
import { Card, ConfirmButton, ErrorBanner, Field, PageHead } from '../components.tsx'
import { PlanSourceCard } from './PlanSource.tsx'
import { dateTimeIn, relative } from '../format.ts'

/**
 * The things that belong to the install rather than to an event.
 *
 * A password with nowhere to set it is the same as no password, and a
 * backup nobody can make is the same as no backup. Both live here, and so
 * does the Planning Center token — it belongs to the install rather than to
 * any one event, even though what it changes is what the events are.
 */

/** Times are shown in the reader's own zone here: this page has no series
 *  to borrow one from. */
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
export function Settings({ onSessionChanged }: { onSessionChanged: () => void }): ReactNode {
  const { data, error, reload } = useResource(() => api.session(), [])
  // Asked for once here and handed to both cards below: backing up and
  // putting one back read the same status, and two fetches of it would be
  // two chances for the two cards to disagree.
  const backup = useResource(() => api.backupStatus(), [])

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

        <PlanSourceCard timezone={browserZone} />

        <Backup data={backup.data} error={backup.error} onChanged={backup.reload} />
        <Restore
          lastRestore={backup.data?.lastRestore}
          stagedRestore={backup.data?.stagedRestore}
          onChanged={backup.reload}
        />
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
function Backup({
  data,
  error,
  onChanged,
}: {
  data: BackupStatus | undefined
  error: string | undefined
  onChanged: () => void
}): ReactNode {
  return (
    <Card title="Backup">
      <ErrorBanner error={error} />

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

          <Schedule schedule={data.schedule} onChanged={onChanged} />
        </>
      ) : null}
    </Card>
  )
}

/**
 * Putting one back.
 *
 * Its own card rather than the bottom of the backup one. They are opposite
 * operations that happen years apart, and the one that replaces everything
 * should not be something you arrive at by scrolling past the one that
 * does not.
 */
function Restore({
  lastRestore,
  stagedRestore,
  onChanged,
}: {
  lastRestore: BackupStatus['lastRestore']
  stagedRestore: BackupStatus['stagedRestore']
  onChanged: () => void
}): ReactNode {
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

  const reload = onChanged

  return (
    <Card title="Restore">
      <ErrorBanner error={problem} />

      {lastRestore ? (
        <div className="banner">
          This install started by restoring a backup taken {relative(lastRestore.takenAt)}. The
          database it replaced was kept, at <code>{lastRestore.previousDatabase}</code>.
        </div>
      ) : null}

      {stagedRestore ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="banner warn">
            A backup taken {dateTimeIn(stagedRestore.takenAt, here)} is waiting. Restart the app to
            finish restoring it. The database in place now will be kept alongside it rather than
            deleted.
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
          ) : null}
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

/**
 * When the app takes its own backups, and how many it keeps.
 *
 * The directory is shown rather than edited. Where the files go is a
 * deployment decision — a volume in Docker, an environment variable
 * otherwise — and a path typed into a browser is a path somebody can point
 * at the database's own directory by accident, which would leave them with
 * a backup on the disk it is meant to survive.
 */
function Schedule({
  schedule,
  onChanged,
}: {
  schedule: BackupSchedule
  onChanged: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const save = (next: { enabled?: boolean; everyHours?: number; keep?: number }): void => {
    setBusy(true)
    setError(undefined)
    void api
      .setBackupSchedule(next)
      .then(() => onChanged())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ margin: '0 0 4px' }}>On a schedule</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Written to <code>{schedule.directory}</code>. What these are worth depends on where that
        actually is: on the same disk as the database they will bring you back from a bad restore,
        and go down with the drive.
      </p>

      <ErrorBanner error={error} />

      {/* The failure that actually happens: a volume that stopped being
          writable and a directory that has been empty ever since. */}
      {schedule.lastError ? (
        <div className="banner error">
          <strong>The last backup did not happen.</strong>
          <div style={{ marginTop: 4 }}>{schedule.lastError}</div>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            disabled={busy}
            onChange={(event) => save({ enabled: event.target.checked })}
          />
          <span>Take one automatically</span>
        </label>
      </div>

      {schedule.enabled ? (
        <div className="row">
          <Field label="Every">
            <select
              value={String(schedule.everyHours)}
              disabled={busy}
              onChange={(event) => save({ everyHours: Number(event.target.value) })}
            >
              <option value="6">6 hours</option>
              <option value="12">12 hours</option>
              <option value="24">day</option>
              <option value="168">week</option>
            </select>
          </Field>
          <Field label="Keep" hint="Oldest removed first.">
            <select
              value={String(schedule.keep)}
              disabled={busy}
              onChange={(event) => save({ keep: Number(event.target.value) })}
            >
              <option value="7">7</option>
              <option value="14">14</option>
              <option value="30">30</option>
              <option value="90">90</option>
            </select>
          </Field>
        </div>
      ) : null}

      <p className="muted" style={{ marginBottom: 0 }}>
        {schedule.count === 0
          ? 'None taken yet.'
          : `${schedule.count} in the folder${
              schedule.lastAt === undefined
                ? ''
                : `, most recent ${dateTimeIn(schedule.lastAt, here)}`
            }.`}
      </p>
    </div>
  )
}
