import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type Credential,
  type Destination,
  type Device,
  type Pipeline,
  type PipelineNode,
} from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner, Field } from '../components.tsx'

/**
 * A pipeline is the wiring: which device outputs feed which service, and
 * where each one gets its stream key.
 *
 * Events reference a pipeline rather than a device, so the same Sunday
 * morning schedule survives swapping the encoder out.
 */
export function Pipelines(): ReactNode {
  const pipelines = useResource(() => api.pipelines(), [])
  const devices = useResource(() => api.devices(), [])
  const destinations = useResource(() => api.destinations(), [])
  const credentials = useResource(() => api.credentials(), [])
  const [editing, setEditing] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()

  const remove = async (id: string): Promise<void> => {
    setError(undefined)
    try {
      await api.deletePipeline(id)
      pipelines.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const ready = devices.data && destinations.data && credentials.data
  const editor = (pipeline?: Pipeline): ReactNode =>
    ready ? (
      <PipelineForm
        key={pipeline?.id ?? 'new'}
        pipeline={pipeline}
        devices={devices.data!}
        destinations={destinations.data!}
        credentials={credentials.data!}
        onDone={() => {
          setAdding(false)
          setEditing(undefined)
          pipelines.reload()
        }}
      />
    ) : null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipelines</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Which devices stream where, and where each one gets its key.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding((open) => !open)}>
          {adding ? 'Cancel' : 'New pipeline'}
        </button>
      </div>
      <ErrorBanner error={error ?? pipelines.error ?? devices.error} />

      <div className="stack">
        {adding ? editor() : null}

        {(devices.data ?? []).length === 0 ? (
          <Card>
            <Empty>
              Add a device first — a pipeline is built from the outputs a connected device actually reports, not
              from a list of what it might have.
            </Empty>
          </Card>
        ) : null}

        {(pipelines.data ?? []).length === 0 && !adding ? (
          <Card>
            <Empty>No pipelines yet.</Empty>
          </Card>
        ) : null}

        {(pipelines.data ?? []).map((pipeline) =>
          editing === pipeline.id ? (
            editor(pipeline)
          ) : (
            <Card key={pipeline.id}>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>{pipeline.label}</h2>
                <div className="row">
                  <button onClick={() => setEditing(pipeline.id)}>Edit</button>
                  <ConfirmButton label="Remove" onConfirm={() => void remove(pipeline.id)} />
                </div>
              </div>
              <Summary
                pipeline={pipeline}
                devices={devices.data ?? []}
                destinations={destinations.data ?? []}
                credentials={credentials.data ?? []}
              />
            </Card>
          ),
        )}
      </div>
    </>
  )
}

function Summary({
  pipeline,
  devices,
  destinations,
  credentials,
}: {
  pipeline: Pipeline
  devices: Device[]
  destinations: Destination[]
  credentials: Credential[]
}): ReactNode {
  const nodes = pipeline.graph.nodes ?? []
  if (nodes.length === 0) return <Empty>Nothing attached, so a run would do nothing.</Empty>

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Output</th>
            <th>Sends to</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const device = devices.find((candidate) => candidate.id === node.deviceId)
            const via = node.ingestFrom
              ? (pipeline.graph.destinations ?? []).find((entry) => entry.id === node.ingestFrom)
              : undefined
            const destination = via
              ? destinations.find((candidate) => candidate.id === via.destinationId)
              : undefined
            const credential = credentials.find((candidate) => candidate.id === node.credentialId)
            return (
              <tr key={node.id}>
                {/* A device that has since been removed still shows its id,
                    rather than an empty cell that looks like nothing. */}
                <td>{device?.label ?? <span className="muted">{node.deviceId} (missing)</span>}</td>
                <td className="muted">{node.nodeId}</td>
                <td>
                  {destination?.label ??
                    credential?.label ?? <span className="muted">{node.filenameTemplate ?? 'nothing'}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface Row {
  key: string
  deviceId: string
  nodeId: string
  /** '' = nothing, 'dest:<id>' = a destination, 'cred:<id>' = a saved key. */
  target: string
  filenameTemplate: string
}

function PipelineForm({
  pipeline,
  devices,
  destinations,
  credentials,
  onDone,
}: {
  pipeline?: Pipeline
  devices: Device[]
  destinations: Destination[]
  credentials: Credential[]
  onDone: () => void
}): ReactNode {
  const [label, setLabel] = useState(pipeline?.label ?? '')
  const [rows, setRows] = useState<Row[]>(() => toRows(pipeline))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const connected = devices.filter((device) => device.nodes.length > 0)

  const update = (key: string, patch: Partial<Row>): void =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const graph = toGraph(rows)
      if (pipeline) await api.updatePipeline(pipeline.id, { label, graph })
      else await api.createPipeline({ label: label || 'Pipeline', graph })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={pipeline ? `Edit ${pipeline.label}` : 'New pipeline'}>
      <ErrorBanner error={error} />
      <div className="stack">
        <Field label="Name">
          <input
            style={{ maxWidth: 400 }}
            value={label}
            placeholder="Sunday main"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>

        {rows.map((row) => {
          const device = devices.find((candidate) => candidate.id === row.deviceId)
          const node = device?.nodes.find((candidate) => candidate.id === row.nodeId)
          const records = node?.supports.includes('startRecording') ?? false
          const streams = node?.supports.includes('applyStreamTarget') ?? false

          return (
            <div key={row.key} className="pipeline-row">
              <Field label="Device">
                <select
                  value={row.deviceId}
                  onChange={(event) => {
                    const next = devices.find((candidate) => candidate.id === event.target.value)
                    update(row.key, { deviceId: event.target.value, nodeId: next?.nodes[0]?.id ?? '', target: '' })
                  }}
                >
                  {connected.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Output">
                <select value={row.nodeId} onChange={(event) => update(row.key, { nodeId: event.target.value })}>
                  {(device?.nodes ?? []).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </Field>

              {streams ? (
                <Field
                  label="Stream key from"
                  hint="A service issues a fresh key per broadcast; a saved key is the same every week."
                >
                  <select value={row.target} onChange={(event) => update(row.key, { target: event.target.value })}>
                    <option value="">— nothing —</option>
                    {destinations.map((destination) => (
                      <option key={destination.id} value={`dest:${destination.id}`}>
                        {destination.label}
                      </option>
                    ))}
                    {credentials.map((credential) => (
                      <option key={credential.id} value={`cred:${credential.id}`}>
                        {credential.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {records ? (
                <Field label="Filename" hint="Supports the same tokens as an event title.">
                  <input
                    value={row.filenameTemplate}
                    placeholder="{{date}} {{event.name}}"
                    onChange={(event) => update(row.key, { filenameTemplate: event.target.value })}
                  />
                </Field>
              ) : null}

              <button onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}>
                Remove
              </button>
            </div>
          )
        })}

        <div className="row">
          <button
            disabled={connected.length === 0}
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  key: `row-${current.length}-${Date.now()}`,
                  deviceId: connected[0]?.id ?? '',
                  nodeId: connected[0]?.nodes[0]?.id ?? '',
                  target: '',
                  filenameTemplate: '',
                },
              ])
            }
          >
            Add an output
          </button>
          {connected.length === 0 ? (
            <span className="muted">
              No device is connected. A pipeline is built from probed outputs, so connect one first.
            </span>
          ) : null}
        </div>

        <div className="row">
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onDone}>Cancel</button>
        </div>
      </div>
    </Card>
  )
}

function toRows(pipeline: Pipeline | undefined): Row[] {
  const destinations = pipeline?.graph.destinations ?? []
  return (pipeline?.graph.nodes ?? []).map((node, index) => ({
    key: `row-${index}`,
    deviceId: node.deviceId,
    nodeId: node.nodeId,
    target: node.ingestFrom
      ? `dest:${destinations.find((entry) => entry.id === node.ingestFrom)?.destinationId ?? ''}`
      : node.credentialId
        ? `cred:${node.credentialId}`
        : '',
    filenameTemplate: node.filenameTemplate ?? '',
  }))
}

/**
 * Flattens the form back into the stored graph.
 *
 * Two rows pointing at the same destination share one entry in
 * `destinations`, so the service is asked to create one broadcast and both
 * encoders are pointed at it — rather than two broadcasts racing.
 */
function toGraph(rows: Row[]): Pipeline['graph'] {
  const destinations: { id: string; destinationId: string }[] = []
  const refFor = (destinationId: string): string => {
    const existing = destinations.find((entry) => entry.destinationId === destinationId)
    if (existing) return existing.id
    const id = `dest${destinations.length + 1}`
    destinations.push({ id, destinationId })
    return id
  }

  const nodes: PipelineNode[] = rows.map((row, index) => {
    const node: PipelineNode = { id: `n${index + 1}`, deviceId: row.deviceId, nodeId: row.nodeId }
    if (row.target.startsWith('dest:')) node.ingestFrom = refFor(row.target.slice(5))
    else if (row.target.startsWith('cred:')) node.credentialId = row.target.slice(5)
    if (row.filenameTemplate) node.filenameTemplate = row.filenameTemplate
    return node
  })

  return { nodes, destinations }
}
