import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, useResource, type Device } from '../api.ts'
import { Card, Empty, ErrorBanner, StatusPill } from '../components.tsx'
import { relative } from '../format.ts'

export function Devices(): ReactNode {
  const { data, error, reload } = useResource(() => api.devices(), [])
  const [busy, setBusy] = useState<string>()
  const [actionError, setActionError] = useState<string>()

  const connect = async (id: string): Promise<void> => {
    setBusy(id)
    setActionError(undefined)
    try {
      await api.connectDevice(id)
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Devices</h1>
        <button onClick={reload}>Refresh</button>
      </div>
      <ErrorBanner error={error ?? actionError} />

      {(data ?? []).length === 0 ? (
        <Card>
          <Empty>
            No devices yet. Add one through the API, or start with the bundled mock encoder to try the scheduler
            without hardware.
          </Empty>
        </Card>
      ) : (
        <div className="stack">
          {(data ?? []).map((device) => (
            <DeviceCard key={device.id} device={device} busy={busy === device.id} onConnect={() => void connect(device.id)} />
          ))}
        </div>
      )}
    </>
  )
}

function DeviceCard({
  device,
  busy,
  onConnect,
}: {
  device: Device
  busy: boolean
  onConnect: () => void
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
