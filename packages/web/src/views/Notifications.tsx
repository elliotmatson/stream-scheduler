import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type ChannelKind,
  type NotificationChannel,
  type NotificationEventKind,
  type NotificationSettings,
} from '../api.ts'
import {
  Card,
  ConfigFields,
  ConfirmButton,
  Empty,
  ErrorBanner,
  Field,
  PageHead,
  StatusPill,
  Switch,
} from '../components.tsx'
import { relative } from '../format.ts'

/**
 * Where the scheduler tells somebody.
 *
 * Testing lives on the edit form rather than in the list: a notification
 * nobody has proved works is worse than none, and the moment somebody is
 * most likely to prove it is straight after changing the webhook.
 */
export function Notifications(): ReactNode {
  const { data, error, reload } = useResource(() => api.notificationChannels(), [])
  const { data: kinds } = useResource(() => api.notificationKinds(), [])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()

  const act = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setActionError(undefined)
    try {
      await action()
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
      <PageHead
        title="Notifications"
        subtitle="Where this tells you what happened. Problems by default; the rest if you ask."
        actions={
          <button className="primary" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : 'Add a notification'}
          </button>
        }
      />

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
              Nothing is set up, so a failed run passes in silence. Add a Google Chat webhook to get
              started.
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
                  <span className="muted" title={describeEvents(channel.events)}>
                    {kinds?.find((kind) => kind.kind === channel.kind)?.displayName ?? channel.kind}{' '}
                    · {summariseEvents(channel.events)}
                  </span>
                </div>
                <div className="row">
                  {/* The switch already says on or off; a pill repeating it
                      is noise. Failed is the one state it cannot show. */}
                  {channel.lastError ? <StatusPill status="failed" /> : null}
                  <Switch
                    checked={channel.enabled}
                    label={`Send to ${channel.label}`}
                    disabled={busy === channel.id}
                    onChange={(enabled) =>
                      void act(channel.id, () => api.updateChannel(channel.id, { enabled }))
                    }
                  />
                  <button onClick={() => setEditing(channel.id)}>Edit</button>
                  <ConfirmButton
                    label="Remove"
                    disabled={busy === channel.id}
                    onConfirm={() => void act(channel.id, () => api.deleteChannel(channel.id))}
                  />
                </div>
              </div>

              {channel.lastError ? <div className="banner error">{channel.lastError}</div> : null}
              <p className="muted" style={{ margin: '8px 0 0' }}>
                {channel.lastSentAt
                  ? `Last delivered ${relative(channel.lastSentAt)}.`
                  : 'Nothing delivered yet.'}
              </p>
            </Card>
          ),
        )}

        <Thresholds />

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
 * The numbers the warnings are measured against.
 *
 * On this page rather than under Settings because this is where somebody
 * comes when the messages are wrong — too many, or too late.
 */
function Thresholds(): ReactNode {
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
    <Card title="Thresholds">
      <ErrorBanner error={error ?? problem} />
      {saved && !changed ? <div className="banner info">Saved.</div> : null}

      <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
        <Field
          label="Cache full (%)"
          hint="A device buffering this much while on air is falling behind."
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
          hint="Warn when the card being recorded to has less than this left."
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
 * Which alerts are worth a message, in words rather than event names.
 *
 * The stored value is the event key; nobody outside this codebase should
 * have to know that a device falling behind is called `device.cache_high`.
 */
const EVENT_LABELS: Record<string, { label: string; detail: string }> = {
  'run.failed': {
    label: 'A run fails',
    detail: 'A device refused, or a broadcast could not be made.',
  },
  'run.cancelled': {
    label: 'A run is stopped by hand',
    detail: 'Somebody pressed Stop now.',
  },
  'preflight.problem': {
    label: 'The evening checks find a problem',
    detail: 'Something would stop the next event working.',
  },
  'preflight.ready': {
    label: 'The evening checks pass',
    detail: 'Reassurance rather than news.',
  },
  'account.reauth_required': {
    label: 'A service needs signing in again',
    detail: 'Nothing can stream to it until it is fixed.',
  },
  'device.cache_high': {
    label: 'A device is falling behind',
    detail: 'Its cache is filling up mid-service.',
  },
  'retention.swept': {
    label: 'Old recordings are deleted',
    detail: 'The hourly sweep removed files past an output’s keep-for policy.',
  },
  'retention.failed': {
    label: 'A recording would not delete',
    detail: 'The sweep left files behind — a card may be write-protected, or still in use.',
  },
  'backup.failed': {
    label: 'A scheduled backup fails',
    detail: 'The backup volume is missing, read-only or full.',
  },
  'run.started': {
    label: 'An event goes on air',
    detail: 'Its first output started.',
  },
  'run.finished': {
    label: 'An event finishes',
    detail: 'Everything came off air and the run closed out.',
  },
  'output.started': {
    label: 'One output goes live',
    detail: 'Every output of every event, separately. The noisiest of these.',
  },
  'output.finished': {
    label: 'One output stops',
    detail: 'Carries the recording’s name, where the device reports one.',
  },
}

/** The three headings the switches are grouped under. */
const SEVERITY_GROUPS: { severity: 'error' | 'warning' | 'info'; title: string; note: string }[] = [
  { severity: 'error', title: 'Something broke', note: 'On unless you turn them off.' },
  { severity: 'warning', title: 'Something needs attention', note: 'On unless you turn them off.' },
  {
    severity: 'info',
    title: 'It worked',
    note: 'Off unless you ask for them. These arrive every service.',
  },
]

/** `3 alerts`, or `problems only` — the count is what fits on the row. */
function summariseEvents(events: string[]): string {
  const alerts = events.filter((event) => event !== 'test')
  if (events.length === 0) return 'problems only'
  if (alerts.length === 0) return 'tests only'
  if (alerts.length === Object.keys(EVENT_LABELS).length) return 'everything'
  return `${alerts.length} of ${Object.keys(EVENT_LABELS).length} alerts`
}

/** The full list, for the tooltip, where there is room to spell it out. */
function describeEvents(events: string[]): string {
  const alerts = events.filter((event) => event !== 'test')
  if (events.length === 0) return 'Sent for anything that went wrong, and nothing else.'
  if (alerts.length === 0) return 'Sent for nothing but tests.'
  return alerts.map((event) => EVENT_LABELS[event]?.label ?? event).join(', ')
}

/**
 * Which alerts a notification is sent for, one switch each.
 *
 * Stored as an explicit list rather than as "everything", because a list
 * is the thing somebody can read back. The empty list the API uses to mean
 * every event is still honoured on the way in — it is just never written
 * back out, so what is stored and what is ticked always agree.
 *
 * `test` is not offered: it is sent by the button below, and a channel
 * that had it switched off would swallow its own test silently, which is
 * the one failure this screen exists to prevent.
 */
function EventChoices({
  events,
  all,
  onChange,
}: {
  events: string[]
  all: NotificationEventKind[]
  onChange: (next: string[]) => void
}): ReactNode {
  const alerts = all.filter((entry) => entry.event !== 'test')
  // An empty stored list means warnings and errors, so that is what is
  // shown ticked. It used to mean everything, which stopped being a sane
  // default the moment the app could announce every service starting.
  const chosen =
    events.length === 0
      ? alerts.filter((entry) => entry.severity !== 'info').map((entry) => entry.event)
      : alerts.map((entry) => entry.event).filter((event) => events.includes(event))

  const toggle = (event: string, on: boolean): void => {
    const next = on ? [...chosen, event] : chosen.filter((kept) => kept !== event)
    // Ordered by the API's list, not by what was clicked last.
    const ordered = alerts.map((entry) => entry.event).filter((name) => next.includes(name))
    onChange([...ordered, 'test'])
  }

  const setAll = (on: boolean): void =>
    onChange(on ? [...alerts.map((entry) => entry.event), 'test'] : ['test'])

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="field-label">Send it when</span>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="link" onClick={() => setAll(true)}>
            All
          </button>
          <button type="button" className="link" onClick={() => setAll(false)}>
            None
          </button>
        </div>
      </div>

      {/* Grouped by how bad it is, because that is the question somebody is
          actually answering. An alphabetical list makes you read every row
          to find out whether you have turned off something that matters. */}
      {SEVERITY_GROUPS.map((group) => {
        const inGroup = alerts.filter((entry) => entry.severity === group.severity)
        if (inGroup.length === 0) return null

        return (
          <div key={group.severity} className="stack" style={{ gap: 4 }}>
            <div className="field-label" style={{ marginTop: 6 }}>
              {group.title}
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}
                · {group.note}
              </span>
            </div>
            {inGroup.map((entry) => (
              <label key={entry.event} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={chosen.includes(entry.event)}
                  onChange={(changed) => toggle(entry.event, changed.target.checked)}
                />
                <span>
                  {EVENT_LABELS[entry.event]?.label ?? entry.event}
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                    {EVENT_LABELS[entry.event]?.detail ?? ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )
      })}

      {chosen.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Nothing is ticked, so this only receives tests.
        </p>
      ) : null}
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
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)

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

  /**
   * Saves first, then sends.
   *
   * A test that went to the stored webhook while a corrected one sat
   * unsaved in the box above would prove the wrong thing.
   */
  const test = async (): Promise<void> => {
    setTesting(true)
    setError(undefined)
    setTested(false)
    try {
      await api.updateChannel(channel.id, { label, config, events: chosen })
      await api.testChannel(channel.id)
      setTested(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
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

        {tested ? (
          <div className="banner info">
            Sent. If it did not arrive, the webhook URL is probably wrong.
          </div>
        ) : null}

        <div className="row">
          <button className="primary" disabled={saving || !label} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            disabled={saving || testing || !label}
            title="Saves what is here, then sends a message so you can see it arrive."
            onClick={() => void test()}
          >
            {testing ? 'Sending…' : 'Send a test'}
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
