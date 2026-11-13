import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type Account,
  type Credential,
  type DestinationProvider,
  type OAuthClient,
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
} from '../components.tsx'

/**
 * Where streams go.
 *
 * Three layers, in the order you have to set them up: the OAuth client this
 * install registers with the service, the channel it is signed in to, and
 * the destination — a channel plus the settings every broadcast inherits.
 * Underneath, stream keys typed in by hand, for a service without an
 * integration.
 */
export function Services(): ReactNode {
  const providers = useResource(() => api.destinationProviders(), [])
  const clients = useResource(() => api.oauthClients(), [])
  const accounts = useResource(() => api.accounts(), [])
  const credentials = useResource(() => api.credentials(), [])
  const [error, setError] = useState<string>()

  const reloadAll = (): void => {
    clients.reload()
    accounts.reload()
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
      <PageHead
        title="Services"
        subtitle="Accounts that make their own broadcasts, and stream keys for everything else."
      />
      <ErrorBanner
        error={error ?? providers.error ?? clients.error ?? accounts.error ?? credentials.error}
      />

      <div className="stack">
        {oauthProviders.map((provider) => (
          <ProviderSection
            key={provider.id}
            provider={provider}
            clients={(clients.data ?? []).filter((client) => client.provider === provider.id)}
            accounts={(accounts.data ?? []).filter((account) => account.provider === provider.id)}
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
  onChanged,
  onError,
}: {
  provider: DestinationProvider
  clients: OAuthClient[]
  accounts: Account[]
  onChanged: () => void
  onError: (message: string | undefined) => void
}): ReactNode {
  const [showSetup, setShowSetup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string>()

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
    // Opened now, while this is still the click. Safari and Firefox block a
    // window opened after an `await`, and the button then does nothing.
    const popup = window.open('', '_blank')
    try {
      const { url } = await api.startOAuth(provider.id, clientRef)
      // Sign-in has to happen in a real browser, not an iframe — Google and
      // Twitch both refuse to be framed — and the callback lands back on
      // this server.
      if (popup) {
        popup.opener = null
        popup.location.href = url
      } else {
        window.location.href = url
      }
    } catch (error) {
      popup?.close()
      throw error
    }
  }

  // Coming back to this tab after signing in elsewhere shows the account,
  // rather than leaving the list as it was until a reload.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') onChanged()
    }
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [onChanged])

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{provider.displayName}</h2>
        <button
          title="What to do in the provider's own console before any of this will connect."
          onClick={() => setShowSetup((open) => !open)}
        >
          {showSetup ? 'Hide setup steps' : 'Setup steps'}
        </button>
      </div>

      {showSetup ? <Instructions provider={provider.id} /> : null}

      <h3>Sign-in app</h3>
      {clients.length === 0 ? (
        <p className="muted">None yet. Setup steps shows how to make one.</p>
      ) : (
        <ul className="plain">
          {clients.map((client) => (
            <li key={client.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{client.label}</span>
              <button
                disabled={busy}
                title={`Opens ${provider.displayName} in a new tab to sign in. Nothing is scheduled until an account is connected.`}
                onClick={() => void act(() => connect(client.id))}
              >
                Connect an account
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddOAuthClient provider={provider.id} onAdded={onChanged} onError={onError} />

      <h3>Accounts</h3>
      {accounts.length === 0 ? (
        <p className="muted">
          No account is connected, so nothing can stream to {provider.displayName} yet.
        </p>
      ) : (
        <ul className="plain">
          {accounts.map((account) => (
            <li key={account.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  {account.displayName} <StatusPill status={account.status} />
                  {account.status === 'reauth_required' ? (
                    <span className="muted"> — its sign-in expired; connect it again.</span>
                  ) : (
                    <span className="muted"> {summarise(provider, account.settings)}</span>
                  )}
                </span>
                <span className="row">
                  <button
                    onClick={() => setEditing(editing === account.id ? undefined : account.id)}
                  >
                    {editing === account.id ? 'Close' : 'Settings'}
                  </button>
                  <ConfirmButton
                    label="Disconnect"
                    disabled={busy}
                    onConfirm={() => void act(() => api.deleteAccount(account.id))}
                  />
                </span>
              </div>
              {editing === account.id && account.destinationId ? (
                <AccountSettings
                  provider={provider}
                  account={account}
                  onDone={() => {
                    setEditing(undefined)
                    onChanged()
                  }}
                  onError={onError}
                />
              ) : null}
            </li>
          ))}
        </ul>
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
      {(data.warnings ?? (data.warning ? [data.warning] : [])).map((warning) => (
        <div key={warning} className="banner error">
          {warning}
        </div>
      ))}
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
      await api.createOAuthClient({
        provider,
        label: label || 'OAuth client',
        clientId,
        clientSecret,
      })
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
        <input
          value={label}
          placeholder="OAuth client"
          onChange={(event) => setLabel(event.target.value)}
        />
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
        <button
          className="primary"
          disabled={saving || !clientId || !clientSecret}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * An account's broadcast defaults: who can watch, which playlist finished
 * videos go in, the description when an event has none.
 *
 * What a destination used to be, without the second list to keep in step:
 * one account, one set of defaults, and a stream that wants something else
 * says so on the stream.
 */
function AccountSettings({
  provider,
  account,
  onDone,
  onError,
}: {
  provider: DestinationProvider
  account: Account
  onDone: () => void
  onError: (message: string | undefined) => void
}): ReactNode {
  const [config, setConfig] = useState<Record<string, unknown>>(account.settings)
  const [saving, setSaving] = useState(false)
  const [playlists, setPlaylists] = useState<{ id: string; label: string }[]>()

  // `accountRef` is the account itself, not something to type.
  const fields = provider.configSchema.filter((field) => field.id !== 'accountRef')
  const wantsPlaylists = fields.some(
    (field) => field.type === 'dropdown' && field.choicesFrom === 'playlists',
  )

  // Asked of the channel itself, and re-asked on Refresh — a playlist made
  // a minute ago in YouTube should not need a page reload.
  const loadPlaylists = useCallback((): void => {
    if (!wantsPlaylists) return
    setPlaylists(undefined)
    api
      .playlists(provider.id, account.id)
      .then((result) => setPlaylists(result.playlists.map((p) => ({ id: p.id, label: p.title }))))
      .catch(() => setPlaylists([]))
  }, [provider.id, account.id, wantsPlaylists])

  useEffect(loadPlaylists, [loadPlaylists])

  const save = async (): Promise<void> => {
    setSaving(true)
    onError(undefined)
    try {
      await api.updateDestination(account.destinationId!, { config })
      onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 560, margin: '10px 0 16px' }}>
      <ConfigFields
        fields={fields}
        values={config}
        onChange={setConfig}
        runtimeChoices={{ playlists }}
        onRefreshChoices={(source) => source === 'playlists' && loadPlaylists()}
      />
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

/** "Public · Worship Reviews" — the defaults on one line beside the name. */
function summarise(provider: DestinationProvider, settings: Record<string, unknown>): string {
  return Object.entries(settings)
    .filter(([key]) => key === 'privacy')
    .map(([key, value]) => describeSetting(provider, key, value))
    .filter(Boolean)
    .join(' · ')
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
  const [platformId, setPlatformId] = useState('')
  // Whether the name is still the one this form filled in. Once somebody
  // has typed their own, changing the service must not overwrite it.
  const [namedItself, setNamedItself] = useState(true)
  const { data: platforms } = useResource(() => api.platforms(), [])
  const platform = platforms?.find((entry) => entry.id === platformId)

  /**
   * Picking a service fills in what is known about it and gets out of the
   * way. The URL stays editable afterwards: every one of these hostnames
   * has changed at some point, and a box somebody cannot correct is how a
   * stale list becomes an outage.
   */
  const choosePlatform = (id: string): void => {
    setPlatformId(id)
    const chosen = platforms?.find((entry) => entry.id === id)
    setIngestUrl(chosen?.ingestUrl ?? '')
    if (namedItself) setLabel(chosen && chosen.id !== 'custom' ? chosen.name : '')
  }

  // Three answers, not two: "no pattern published for this service" is not
  // the same as "that looks wrong", and treating them alike would put a
  // warning under every key for every service without a known format.
  const keyLooks =
    !key || !platform?.keyPattern
      ? 'unknown'
      : safeTest(platform.keyPattern, key.trim())
        ? 'ok'
        : 'unexpected'

  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Stream keys</h2>
        <button onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : 'Add a key'}</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        For services not listed above: an ingest URL and key.
      </p>

      {credentials.length === 0 ? (
        <Empty>No keys saved.</Empty>
      ) : (
        <ul className="plain">
          {credentials.map((credential) => (
            <li key={credential.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {credential.label}{' '}
                {credential.platformName ? (
                  <span className="pill">{credential.platformName}</span>
                ) : null}{' '}
                <span className="muted">{credential.ingestUrl}</span>{' '}
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
          <Field label="Service" hint="Fills in what is known about it. Everything stays editable.">
            <select value={platformId} onChange={(event) => choosePlatform(event.target.value)}>
              <option value="">Pick a service…</option>
              {(platforms ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>

          {platform ? (
            <div className="banner">
              <div>{platform.whereToFind}</div>
              {platform.note ? (
                <div className="muted" style={{ marginTop: 4 }}>
                  {platform.note}
                </div>
              ) : null}
              {platform.findKeyUrl ? (
                <a
                  href={platform.findKeyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ display: 'inline-block', marginTop: 6 }}
                >
                  Open {platform.name}
                </a>
              ) : null}
            </div>
          ) : null}

          <Field label="Name" hint="What you will call it here, e.g. “Facebook, main page”.">
            <input
              value={label}
              onChange={(event) => {
                setNamedItself(false)
                setLabel(event.target.value)
              }}
            />
          </Field>

          {/* Only where the service publishes more than one. Otherwise the
              URL box below is the whole story and a picker with one entry
              is a question nobody needed asking. */}
          {platform?.servers && platform.servers.length > 1 ? (
            <Field
              label="Ingest server"
              hint="The nearest one, unless you have measured otherwise."
            >
              <select value={ingestUrl} onChange={(event) => setIngestUrl(event.target.value)}>
                {platform.servers.map((server) => (
                  <option key={server.url} value={server.url}>
                    {server.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field
            label="Ingest URL"
            hint={
              platform && !platform.ingestUrl && platform.id !== 'custom'
                ? `${platform.name} issues this per account or per broadcast, so paste the one it gave you.`
                : 'Where the encoder sends to, e.g. rtmps://a.rtmp.youtube.com/live2'
            }
          >
            <input value={ingestUrl} onChange={(event) => setIngestUrl(event.target.value)} />
          </Field>
          <Field
            label="Stream key"
            hint="Stored encrypted. There is no screen that shows it again."
          >
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          {keyLooks === 'unexpected' ? (
            <p className="warn-text" style={{ margin: 0, fontSize: 12 }}>
              That does not look like a {platform?.name} key — check you have copied the key and not
              the URL. Saving it anyway is fine; these formats do change.
            </p>
          ) : null}
          <div className="row">
            <button
              className="primary"
              disabled={!label || !ingestUrl || !key}
              onClick={() =>
                void guard(
                  () =>
                    api.createCredential({
                      label,
                      ingestUrl,
                      key,
                      ...(platformId ? { platform: platformId } : {}),
                    }),
                  () => {
                    setOpen(false)
                    setLabel('')
                    setIngestUrl('')
                    setKey('')
                    setPlatformId('')
                    setNamedItself(true)
                    reload()
                  },
                )
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

/**
 * Whether a key matches a service's published format.
 *
 * Wrapped because the pattern comes over the wire from the catalogue: a
 * bad one there must warn nobody rather than take the form down.
 */
function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return true
  }
}

/**
 * One setting as a person would say it: the field's own label, a choice's
 * name rather than its id, yes or no rather than true or false. The account
 * is said separately, so its stored reference is left out.
 */
function describeSetting(
  provider: DestinationProvider,
  key: string,
  value: unknown,
): string | undefined {
  if (key === 'accountRef' || value === undefined || value === '') return undefined
  const field = provider.configSchema.find((candidate) => candidate.id === key)
  const label = field && 'label' in field ? field.label : key
  if (typeof value === 'boolean') return value ? label : `${label}: off`
  const choice =
    field && 'choices' in field && Array.isArray(field.choices)
      ? field.choices.find((option: { id: string }) => option.id === value)
      : undefined
  return `${label}: ${choice && 'label' in choice ? String(choice.label) : String(value)}`
}
