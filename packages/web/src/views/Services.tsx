import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type Account,
  type Credential,
  type Destination,
  type DestinationProvider,
  type OAuthClient,
} from '../api.ts'
import { Card, ConfigFields, ConfirmButton, Empty, ErrorBanner, Field, StatusPill } from '../components.tsx'

/**
 * Where streams go.
 *
 * Three layers, in the order you have to set them up: the Google Cloud OAuth
 * client this install uses, the channel it is signed in to, and the
 * destination — a channel plus the settings every broadcast inherits.
 * Underneath, stream keys typed in by hand, for a service without an
 * integration.
 */
export function Services(): ReactNode {
  const providers = useResource(() => api.destinationProviders(), [])
  const clients = useResource(() => api.oauthClients(), [])
  const accounts = useResource(() => api.accounts(), [])
  const destinations = useResource(() => api.destinations(), [])
  const credentials = useResource(() => api.credentials(), [])
  const [error, setError] = useState<string>()

  const reloadAll = (): void => {
    clients.reload()
    accounts.reload()
    destinations.reload()
  }

  const guard = async (action: () => Promise<unknown>, after: () => void): Promise<void> => {
    setError(undefined)
    try {
      await action()
      after()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const oauthProviders = (providers.data ?? []).filter((provider) => provider.supportsOAuth)

  return (
    <>
      <div className="page-head">
        <h1>Streaming services</h1>
      </div>
      <ErrorBanner
        error={error ?? providers.error ?? clients.error ?? accounts.error ?? destinations.error ?? credentials.error}
      />

      <div className="stack">
        {oauthProviders.map((provider) => (
          <ProviderSection
            key={provider.id}
            provider={provider}
            clients={(clients.data ?? []).filter((client) => client.provider === provider.id)}
            accounts={(accounts.data ?? []).filter((account) => account.provider === provider.id)}
            destinations={(destinations.data ?? []).filter((destination) => destination.providerId === provider.id)}
            onChanged={reloadAll}
            onError={setError}
          />
        ))}

        <StreamKeys
          credentials={credentials.data ?? []}
          onChanged={() => credentials.reload()}
          guard={guard}
          reload={() => credentials.reload()}
        />
      </div>
    </>
  )
}

function ProviderSection({
  provider,
  clients,
  accounts,
  destinations,
  onChanged,
  onError,
}: {
  provider: DestinationProvider
  clients: OAuthClient[]
  accounts: Account[]
  destinations: Destination[]
  onChanged: () => void
  onError: (message: string | undefined) => void
}): ReactNode {
  const [showSetup, setShowSetup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addingDestination, setAddingDestination] = useState(false)

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    onError(undefined)
    try {
      await action()
      onChanged()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (clientRef: string): Promise<void> => {
    const { url } = await api.startOAuth(provider.id, clientRef)
    // Google must be visited in a real browser, not an iframe, and the
    // callback lands back on this server.
    window.open(url, '_blank', 'noopener')
  }

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{provider.displayName}</h2>
        <button onClick={() => setShowSetup((open) => !open)}>
          {showSetup ? 'Hide setup steps' : 'Setup steps'}
        </button>
      </div>

      {showSetup ? <Instructions provider={provider.id} /> : null}

      <h3>1. This install's Google client</h3>
      {clients.length === 0 ? (
        <p className="muted">
          None yet. Each install brings its own OAuth client, so nothing is shared and your channel's API budget is
          your own. The setup steps above walk through making one.
        </p>
      ) : (
        <ul className="plain">
          {clients.map((client) => (
            <li key={client.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {client.label} <span className="muted">{client.clientId}</span>
              </span>
              <button disabled={busy} onClick={() => void act(() => connect(client.id))}>
                Connect an account
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddOAuthClient provider={provider.id} onAdded={onChanged} onError={onError} />

      <h3>2. Connected accounts</h3>
      {accounts.length === 0 ? (
        <p className="muted">No account is connected, so nothing can be scheduled to {provider.displayName} yet.</p>
      ) : (
        <ul className="plain">
          {accounts.map((account) => (
            <li key={account.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {account.displayName} <StatusPill status={account.status} />
                {account.status === 'reauth_required' ? (
                  <span className="muted"> — sign in again; the token expired.</span>
                ) : null}
              </span>
              <ConfirmButton
                label="Disconnect"
                disabled={busy}
                onConfirm={() => void act(() => api.deleteAccount(account.id))}
              />
            </li>
          ))}
        </ul>
      )}

      <h3>3. Destinations</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        A destination is an account plus the settings every broadcast gets — privacy, and the playlist to file it
        under. An event's outputs point at one of these.
      </p>
      {destinations.length === 0 ? null : (
        <ul className="plain">
          {destinations.map((destination) => (
            <li key={destination.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {destination.label}{' '}
                <span className="muted">
                  {Object.entries(destination.config)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(' · ')}
                </span>
              </span>
              <ConfirmButton
                label="Remove"
                disabled={busy}
                onConfirm={() => void act(() => api.deleteDestination(destination.id))}
              />
            </li>
          ))}
        </ul>
      )}

      {accounts.length === 0 ? null : addingDestination ? (
        <AddDestination
          provider={provider}
          accounts={accounts}
          onDone={() => {
            setAddingDestination(false)
            onChanged()
          }}
          onError={onError}
        />
      ) : (
        <button className="primary" onClick={() => setAddingDestination(true)}>
          Add a destination
        </button>
      )}
    </Card>
  )
}

function Instructions({ provider }: { provider: string }): ReactNode {
  const { data } = useResource(() => api.oauthInstructions(provider), [provider])
  if (!data) return null
  return (
    <div className="stack" style={{ marginBottom: 16 }}>
      <ol className="steps">
        {data.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {/* The one mistake that works for a week and then breaks every Sunday. */}
      {data.warning ? <div className="banner error">{data.warning}</div> : null}
    </div>
  )
}

function AddOAuthClient({
  provider,
  onAdded,
  onError,
}: {
  provider: string
  onAdded: () => void
  onError: (message: string | undefined) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) {
    return <button onClick={() => setOpen(true)}>Add a client</button>
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    onError(undefined)
    try {
      await api.createOAuthClient({ provider, label: label || 'OAuth client', clientId, clientSecret })
      setOpen(false)
      setLabel('')
      setClientId('')
      setClientSecret('')
      onAdded()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <Field label="Name">
        <input value={label} placeholder="OAuth client" onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field label="Client ID">
        <input value={clientId} onChange={(event) => setClientId(event.target.value)} />
      </Field>
      <Field label="Client secret" hint="Stored encrypted. There is no screen that shows it again.">
        <input
          type="password"
          autoComplete="new-password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
      </Field>
      <div className="row">
        <button className="primary" disabled={saving || !clientId || !clientSecret} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}

function AddDestination({
  provider,
  accounts,
  onDone,
  onError,
}: {
  provider: DestinationProvider
  accounts: Account[]
  onDone: () => void
  onError: (message: string | undefined) => void
}): ReactNode {
  const [label, setLabel] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  // `accountRef` is filled in from the picker above, not typed by hand.
  const fields = provider.configSchema.filter((field) => field.id !== 'accountRef')

  const save = async (): Promise<void> => {
    setSaving(true)
    onError(undefined)
    try {
      await api.createDestination({
        providerId: provider.id,
        label: label || provider.displayName,
        accountId,
        config,
      })
      onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <Field label="Name">
        <input value={label} placeholder={provider.displayName} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field label="Account">
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName}
            </option>
          ))}
        </select>
      </Field>
      <ConfigFields fields={fields} values={config} onChange={setConfig} />
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Add'}
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

function StreamKeys({
  credentials,
  guard,
  reload,
}: {
  credentials: Credential[]
  onChanged: () => void
  guard: (action: () => Promise<unknown>, after: () => void) => Promise<void>
  reload: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [ingestUrl, setIngestUrl] = useState('')
  const [key, setKey] = useState('')

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Stream keys</h2>
        <button onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : 'Add a key'}</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        For a service with no integration here: an ingest URL and key, typed in once. Anything that issues its own
        key per broadcast — YouTube, for one — belongs above instead.
      </p>

      {credentials.length === 0 ? (
        <Empty>Nothing saved.</Empty>
      ) : (
        <ul className="plain">
          {credentials.map((credential) => (
            <li key={credential.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {credential.label} <span className="muted">{credential.ingestUrl}</span>{' '}
                {/* Write-only: stored encrypted, with no endpoint that reads it back. */}
                <span className="muted">{credential.key}</span>
              </span>
              <ConfirmButton
                label="Remove"
                onConfirm={() => void guard(() => api.deleteCredential(credential.id), reload)}
              />
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <div className="stack" style={{ maxWidth: 560, marginTop: 12 }}>
          <Field label="Name">
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="Ingest URL" hint="e.g. rtmps://a.rtmp.youtube.com/live2">
            <input value={ingestUrl} onChange={(event) => setIngestUrl(event.target.value)} />
          </Field>
          <Field label="Stream key">
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <div className="row">
            <button
              className="primary"
              disabled={!label || !ingestUrl || !key}
              onClick={() =>
                void guard(() => api.createCredential({ label, ingestUrl, key }), () => {
                  setOpen(false)
                  setLabel('')
                  setIngestUrl('')
                  setKey('')
                  reload()
                })
              }
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
