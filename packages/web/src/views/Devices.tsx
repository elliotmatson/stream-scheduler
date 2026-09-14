import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Device, type DiscoveredDevice, type Plugin } from '../api.ts'
import { Card, ConfigFields, ConfirmButton, Empty, ErrorBanner, Field, StatusPill } from '../components.tsx'
import { relative } from '../format.ts'

export function Devices(): ReactNode {
  const { data, error, reload } = useResource(() => api.devices(), [])
  const { data: plugins } = useResource(() => api.plugins(), [])
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()

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

  const devices = data ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Devices</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            The encoders, switchers and recorders this scheduler drives.
          </p>
        </div>
        <div className="row">
          <button onClick={reload}>Refresh</button>
          <button className="primary" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : 'Add a device'}
          </button>
        </div>
      </div>
      <ErrorBanner error={error ?? actionError} />

      <div className="stack">
        {adding && plugins ? (
          <DeviceForm
            plugins={plugins}
            onDone={() => {
              setAdding(false)
              reload()
            }}
          />
        ) : null}

        {devices.length === 0 && !adding ? (
          <Card>
            <Empty>
              No devices yet. Add the bundled mock encoder to try a whole scheduled run without touching hardware,
              or point this at a real one.
            </Empty>
          </Card>
        ) : null}

        {devices.map((device) =>
          editing === device.id && plugins ? (
            <DeviceForm
              key={device.id}
              plugins={plugins}
              device={device}
              onDone={() => {
                setEditing(undefined)
                reload()
              }}
            />
          ) : (
            <DeviceCard
              key={device.id}
              device={device}
              busy={busy === device.id}
              onConnect={() => void act(device.id, () => api.connectDevice(device.id))}
              onEdit={() => setEditing(device.id)}
              onRemove={() => void act(device.id, () => api.deleteDevice(device.id))}
            />
          ),
        )}
      </div>
    </>
  )
}

function DeviceCard({
  device,
  busy,
  onConnect,
  onEdit,
  onRemove,
}: {
  device: Device
  busy: boolean
  onConnect: () => void
  onEdit: () => void
  onRemove: () => void
}): ReactNode {
  return (
    <Card>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{device.label}</h2>
          <span className="muted">
            {device.pluginId}
            {/* The probed model, not what someone picked in a dropdown. */}
            {device.probedModel ? ` · ${device.probedModel}` : ''}
          </span>
        </div>
        <div className="row">
          <StatusPill status={device.health} />
          <button disabled={busy} onClick={onConnect}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          <button onClick={onEdit}>Edit</button>
          <ConfirmButton label="Remove" disabled={busy} onConfirm={onRemove} />
        </div>
      </div>

      {device.lastError ? <div className="banner error">{device.lastError}</div> : null}

      <div className="row" style={{ gap: 18, marginTop: 8 }}>
        <Fact label="Last seen" value={device.lastSeenAt ? relative(device.lastSeenAt) : 'never'} />
        <Fact label="Firmware" value={device.capabilities?.firmware ?? '—'} />
        <Fact label="Capabilities" value={device.capabilities?.features.join(', ') || '—'} />
      </div>

      {device.nodes.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Roles</th>
                <th>Supports</th>
              </tr>
            </thead>
            <tbody>
              {device.nodes.map((node) => (
                <tr key={node.id}>
                  <td>{node.label}</td>
                  <td className="muted">{node.roles.join(', ')}</td>
                  <td className="muted">{node.supports.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ marginBottom: 0 }}>
          Connect to probe what this device can actually do.
        </p>
      )}
    </Card>
  )
}

/**
 * Add or edit a device.
 *
 * Saving connects straight away rather than waiting for the operator to press
 * Connect: a typo in an address should be visible now, at a desk, not on
 * Sunday morning.
 */
function DeviceForm({
  plugins,
  device,
  onDone,
}: {
  plugins: Plugin[]
  device?: Device
  onDone: () => void
}): ReactNode {
  const [pluginId, setPluginId] = useState(device?.pluginId ?? plugins[0]?.id ?? '')
  const [label, setLabel] = useState(device?.label ?? '')
  const [config, setConfig] = useState<Record<string, unknown>>(device?.config ?? {})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [found, setFound] = useState<DiscoveredDevice[]>()
  const [scanning, setScanning] = useState(false)

  const plugin = plugins.find((candidate) => candidate.id === pluginId)

  const scan = async (): Promise<void> => {
    setScanning(true)
    setError(undefined)
    try {
      setFound(await api.discover(pluginId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      if (device) {
        await api.updateDevice(device.id, { label, config })
        // The connection was dropped by the edit; prove the new settings work.
        await api.connectDevice(device.id).catch(() => undefined)
      } else {
        const created = await api.createDevice({ pluginId, label: label || (plugin?.displayName ?? pluginId), config })
        await api.connectDevice(created.id).catch(() => undefined)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={device ? `Edit ${device.label}` : 'Add a device'}>
      <ErrorBanner error={error} />
      <div className="stack" style={{ maxWidth: 560 }}>
        {device ? null : (
          <Field label="Type">
            <select
              value={pluginId}
              onChange={(event) => {
                setPluginId(event.target.value)
                setConfig({})
                setFound(undefined)
              }}
            >
              {plugins.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}

        {!device && plugin?.canDiscover ? (
          <div>
            <button disabled={scanning} onClick={() => void scan()}>
              {scanning ? 'Scanning…' : 'Scan the network'}
            </button>
            {found ? (
              found.length === 0 ? (
                <p className="muted">Nothing answered. Enter the address by hand below.</p>
              ) : (
                <ul className="discovered">
                  {found.map((candidate) => (
                    <li key={candidate.label}>
                      <button
                        onClick={() => {
                          setLabel(candidate.label)
                          setConfig(candidate.config)
                        }}
                      >
                        Use
                      </button>{' '}
                      {candidate.label}{' '}
                      <span className="muted">{String(candidate.config.host ?? '')}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}

        <Field label="Name" hint="What you will call it on the schedule, e.g. “Sanctuary encoder”.">
          <input value={label} placeholder={plugin?.displayName ?? ''} onChange={(event) => setLabel(event.target.value)} />
        </Field>

        <ConfigFields fields={plugin?.configSchema ?? []} values={config} onChange={setConfig} />

        {device ? (
          <p className="muted" style={{ margin: 0 }}>
            Passwords show as dots. Leave them alone to keep the stored one.
          </p>
        ) : null}

        <div className="row">
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : device ? 'Save and reconnect' : 'Add and connect'}
          </button>
          <button onClick={onDone}>Cancel</button>
        </div>
      </div>
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div>{value}</div>
    </div>
  )
}
