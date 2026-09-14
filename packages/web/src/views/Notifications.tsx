import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type ChannelKind, type NotificationChannel } from '../api.ts'
import { Card, ConfigFields, ConfirmButton, Empty, ErrorBanner, Field, StatusPill } from '../components.tsx'
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
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [tested, setTested] = useState<string>()

  const act = async (id: string, action: () => Promise<unknown>, thenTested = false): Promise<void> => {
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
            Where to be told when a run fails — or, the evening before, when something would stop Sunday
            working.
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
              Nothing is set up, so a failed run passes in silence. Google Chat takes about a minute: add a webhook
              to your space and paste the URL here.
            </Empty>
          </Card>
        ) : null}

        {channels.map((channel) => (
          <Card key={channel.id}>
            <div className="page-head" style={{ marginBottom: 8 }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>{channel.label}</h2>
                <span className="muted" title="What it is, and which events it is sent for.">
                  {kinds?.find((kind) => kind.kind === channel.kind)?.displayName ?? channel.kind} ·{' '}
                  {channel.events.length === 0 ? 'every event' : channel.events.join(', ')}
                </span>
              </div>
              <div className="row">
                <StatusPill status={channel.lastError ? 'failed' : channel.enabled ? 'ok' : 'off'} />
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
              <div className="banner info">Sent. If it did not arrive, the webhook URL is probably wrong.</div>
            ) : null}
            {channel.lastError ? <div className="banner error">{channel.lastError}</div> : null}
            <p className="muted" style={{ margin: '8px 0 0' }}>
              Last delivered {channel.lastSentAt ? relative(channel.lastSentAt) : 'never'}.
            </p>
          </Card>
        ))}

        {data && data.pending > 0 ? (
          <div className="banner info">
            {data.pending} {data.pending === 1 ? 'message is' : 'messages are'} waiting to be delivered.
          </div>
        ) : null}
      </div>
    </>
  )
}

function AddNotification({ kinds, onAdded }: { kinds: ChannelKind[]; onAdded: () => void }): ReactNode {
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
