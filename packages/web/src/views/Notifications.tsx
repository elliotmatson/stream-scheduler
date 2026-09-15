import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type ChannelKind,
  type NotificationChannel,
  type NotificationSettings,
} from '../api.ts'
import {
  Card,
  ConfigFields,
  ConfirmButton,
  Empty,
  ErrorBanner,
  Field,
  StatusPill,
} from '../components.tsx'
import { relative } from '../format.ts'

/**
 * Where the scheduler tells somebody.
 *
 * The screen leads with "send a test", because a notification nobody has
 * proved works is worse than none — it reads as coverage while being
 * silence.
 */
export function Notifications(): ReactNode {
  const { data, error, reload } = useResource(() => api.notificationChannels(), [])
  const { data: kinds } = useResource(() => api.notificationKinds(), [])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [tested, setTested] = useState<string>()

  const act = async (
    id: string,
    action: () => Promise<unknown>,
    thenTested = false,
  ): Promise<void> => {
    setBusy(id)
    setActionError(undefined)
    setTested(undefined)
    try {
      await action()
      if (thenTested) setTested(id)
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const channels = data?.channels ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Where to be told when a run fails — or, the evening before, when something would stop
            Sunday working.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding((open) => !open)}>
          {adding ? 'Cancel' : 'Add a notification'}
        </button>
      </div>

      <ErrorBanner error={error ?? actionError} />

      <div className="stack">
        {adding && kinds ? (
          <AddNotification
            kinds={kinds}
            onAdded={() => {
              setAdding(false)
              reload()
            }}
          />
        ) : null}

        {channels.length === 0 && !adding ? (
          <Card>
            <Empty>
              Nothing is set up, so a failed run passes in silence. Google Chat takes about a
              minute: add a webhook to your space and paste the URL here.
            </Empty>
          </Card>
        ) : null}

        {channels.map((channel) =>
          editing === channel.id && kinds ? (
            <EditNotification
              key={channel.id}
              channel={channel}
              kinds={kinds}
              onDone={() => {
                setEditing(undefined)
                reload()
              }}
            />
          ) : (
            <Card key={channel.id}>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <div>
                  <h2 style={{ marginBottom: 2 }}>{channel.label}</h2>
                  <span className="muted" title="What it is, and which events it is sent for.">
                    {kinds?.find((kind) => kind.kind === channel.kind)?.displayName ?? channel.kind}{' '}
                    · {channel.events.length === 0 ? 'every event' : channel.events.join(', ')}
                  </span>
                </div>
                <div className="row">
                  <StatusPill
                    status={channel.lastError ? 'failed' : channel.enabled ? 'ok' : 'off'}
                  />
                  <button onClick={() => setEditing(channel.id)}>Edit</button>
                  <button
                    disabled={busy === channel.id}
                    title={
                      channel.enabled
                        ? 'Keeps it set up but stops sending to it.'
                        : 'Starts sending to it again.'
                    }
                    onClick={() =>
                      void act(channel.id, () =>
                        api.updateChannel(channel.id, { enabled: !channel.enabled }),
                      )
                    }
                  >
                    {channel.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    disabled={busy === channel.id}
                    title="Sends a message now, so you can see it arrive."
                    onClick={() => void act(channel.id, () => api.testChannel(channel.id), true)}
                  >
                    {busy === channel.id ? 'Sending…' : 'Send a test'}
                  </button>
                  <ConfirmButton
                    label="Remove"
                    disabled={busy === channel.id}
                    onConfirm={() => void act(channel.id, () => api.deleteChannel(channel.id))}
                  />
                </div>
              </div>

              {tested === channel.id ? (
                <div className="banner info">
                  Sent. If it did not arrive, the webhook URL is probably wrong.
                </div>
              ) : null}
              {channel.lastError ? <div className="banner error">{channel.lastError}</div> : null}
              <p className="muted" style={{ margin: '8px 0 0' }}>
                Last delivered {channel.lastSentAt ? relative(channel.lastSentAt) : 'never'}.
              </p>
            </Card>
          ),
        )}

        <WhenToTell />

        {data && data.pending > 0 ? (
          <div className="banner info">
            {data.pending} {data.pending === 1 ? 'message is' : 'messages are'} waiting to be
            delivered.
          </div>
        ) : null}
      </div>
    </>
  )
}

/**
 * When the scheduler decides something is worth saying.
 *
 * On this page rather than under Settings because this is where somebody
 * comes when the messages are wrong — too many, or too late.
 */
function WhenToTell(): ReactNode {
  const { data, error, reload } = useResource(() => api.notificationSettings(), [])
  const [draft, setDraft] = useState<NotificationSettings>()
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [saved, setSaved] = useState(false)

  const current = draft ?? data
  if (!current) return null

  const set = <K extends keyof NotificationSettings>(key: K, value: number): void =>
    setDraft({ ...current, [key]: value })

  const save = async (): Promise<void> => {
    setSaving(true)
    setProblem(undefined)
    setSaved(false)
    try {
      await api.updateNotificationSettings(current)
      setDraft(undefined)
      setSaved(true)
      reload()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const changed = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(data)

  return (
    <Card title="When to tell you">
      <p className="muted" style={{ marginTop: 0 }}>
        The two warnings that depend on a number rather than on something having already gone wrong.
        Both are also what the status screen uses.
      </p>
      <ErrorBanner error={error ?? problem} />
      {saved && !changed ? <div className="banner info">Saved.</div> : null}

      <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
        <Field
          label="Cache full (%)"
          hint="A device buffering this much while on air is falling behind. Below 100, because at 100 the stream has already gone."
        >
          <input
            type="number"
            min={1}
            max={100}
            value={current.cacheWarningPercent}
            onChange={(event) => set('cacheWarningPercent', Number(event.target.value))}
          />
        </Field>
        <Field
          label="Media left (min)"
          hint="Recording time left on the card being written to, below which it is worth knowing."
        >
          <input
            type="number"
            min={1}
            max={1440}
            value={current.mediaWarningMinutes}
            onChange={(event) => set('mediaWarningMinutes', Number(event.target.value))}
          />
        </Field>
      </div>

      <div className="row">
        <button className="primary" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {changed ? <button onClick={() => setDraft(undefined)}>Cancel</button> : null}
      </div>
    </Card>
  )
}

/**
 * Which events are worth a message, in words rather than event names.
 *
 * The stored value is the event key; nobody outside this codebase should
 * have to know that a device falling behind is called `device.cache_high`.
 */
const EVENT_LABELS: Record<string, { label: string; detail: string }> = {
  'run.failed': {
    label: 'A run fails',
    detail: 'Something went wrong on the day: a device refused, a broadcast could not be made.',
  },
  'run.cancelled': {
    label: 'A run is stopped by hand',
    detail: 'Somebody pressed Stop now.',
  },
  'preflight.problem': {
    label: 'A problem found the evening before',
    detail: 'The checks that run ahead of an event found something that would stop it.',
  },
  'preflight.ready': {
    label: 'The evening checks pass',
    detail: 'Reassurance rather than news. Most people leave this one off.',
  },
  'account.reauth_required': {
    label: 'A service needs signing in again',
    detail: 'A YouTube account whose sign-in expired. Nothing can stream to it until it is fixed.',
  },
  'device.cache_high': {
    label: 'A device is falling behind',
    detail: 'Its cache is filling up mid-service, which ends in a dropped stream if it continues.',
  },
  test: { label: 'Test messages', detail: 'Sent when you press Send a test.' },
}

/** Which events a notification is sent for, as a set of switches. */
function EventChoices({
  events,
  all,
  onChange,
}: {
  events: string[]
  all: string[]
  onChange: (next: string[]) => void
}): ReactNode {
  // Empty means everything, and that needs saying: a list of empty tick
  // boxes otherwise reads as "you will never hear anything".
  const everything = events.length === 0

  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="field-label">Send it when</span>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={everything}
          onChange={(event) =>
            onChange(event.target.checked ? [] : all.filter((name) => name !== 'test'))
          }
        />
        <span>Anything happens worth telling you about</span>
      </label>

      {everything ? null : (
        <div className="stack" style={{ gap: 4, paddingLeft: 22 }}>
          {all
            .filter((event) => event !== 'test')
            .map((event) => (
              <label key={event} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  onChange={(changed) =>
                    onChange(
                      changed.target.checked
                        ? [...events, event]
                        : events.filter((kept) => kept !== event),
                    )
                  }
                />
                <span>
                  {EVENT_LABELS[event]?.label ?? event}
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                    {EVENT_LABELS[event]?.detail ?? ''}
                  </span>
                </span>
              </label>
            ))}
        </div>
      )}
    </div>
  )
}

/** Changes one that already exists. Its kind is fixed: that decides the fields. */
function EditNotification({
  channel,
  kinds,
  onDone,
}: {
  channel: NotificationChannel
  kinds: ChannelKind[]
  onDone: () => void
}): ReactNode {
  const { data: events } = useResource(() => api.notificationEvents(), [])
  const [label, setLabel] = useState(channel.label)
  const [config, setConfig] = useState<Record<string, unknown>>(channel.config)
  const [chosen, setChosen] = useState<string[]>(channel.events)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const definition = kinds.find((kind) => kind.kind === channel.kind)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await api.updateChannel(channel.id, { label, config, events: chosen })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={`Edit ${channel.label}`}>
      <ErrorBanner error={error} />
      <div className="stack" style={{ maxWidth: 560 }}>
        <Field label="Name" hint="What you will call it here.">
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>

        <ConfigFields
          fields={definition?.configSchema ?? []}
          values={config}
          onChange={setConfig}
        />
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          A webhook URL shows as dots. Leave it alone to keep the stored one.
        </p>

        <EventChoices events={chosen} all={events ?? []} onChange={setChosen} />

        <div className="row">
          <button className="primary" disabled={saving || !label} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onDone}>Cancel</button>
        </div>
      </div>
    </Card>
  )
}

function AddNotification({
  kinds,
  onAdded,
}: {
  kinds: ChannelKind[]
  onAdded: () => void
}): ReactNode {
  const [kind, setKind] = useState(kinds[0]?.kind ?? 'google-chat')
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const selected = kinds.find((k) => k.kind === kind)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await api.createChannel({ kind, label: label || (selected?.displayName ?? kind), config })
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Add a notification">
      <ErrorBanner error={error} />
      <div className="stack" style={{ maxWidth: 560 }}>
        <Field label="Type" hint="How it reaches you.">
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value)
              setConfig({})
            }}
          >
            {kinds.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.displayName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Name" hint="What you will call it here, e.g. “Tech team chat”.">
          <input
            value={label}
            placeholder={selected?.displayName ?? ''}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>

        {/* Rendered straight from its declared fields, the same way device
            settings are, so a new kind of notification needs no UI work. */}
        <ConfigFields fields={selected?.configSchema ?? []} values={config} onChange={setConfig} />

        <div className="row">
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </Card>
  )
}

export type { NotificationChannel }
