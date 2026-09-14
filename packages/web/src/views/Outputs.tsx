import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type Credential,
  type Destination,
  type Device,
  type EventOutput,
  type OutputInput,
  type OutputsResponse,
  type Series,
} from '../api.ts'
import { ConfirmButton, Empty, ErrorBanner, Field } from '../components.tsx'

/**
 * What an event streams and records, and when inside its window.
 *
 * The times are shown as clock times rather than offsets, because that is
 * how anybody thinks about a Sunday: the 9:00 service, the 11:00 service,
 * the recording that runs all morning. They are *stored* as offsets from
 * the window, which is what keeps them together when the event moves and
 * across a clock change.
 */
export function Outputs({ series }: { series: Series }): ReactNode {
  const { data, error, reload } = useResource(() => api.outputs(series.id), [series.id])
  const { data: destinations } = useResource(() => api.destinations(), [])
  const { data: credentials } = useResource(() => api.credentials(), [])
  const { data: devices } = useResource(() => api.devices(), [])

  const [actionError, setActionError] = useState<string>()
  const [result, setResult] = useState<OutputsResponse>()
  const [adding, setAdding] = useState<'stream' | 'recording'>()

  const current = result ?? data
  const act = async (run: () => Promise<OutputsResponse>): Promise<void> => {
    setActionError(undefined)
    try {
      setResult(await run())
      setAdding(undefined)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Outputs</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Each one starts and stops on its own clock inside the event.
          </p>
        </div>
        <div className="row">
          <button onClick={() => setAdding(adding === 'stream' ? undefined : 'stream')}>Add a stream</button>
          <button onClick={() => setAdding(adding === 'recording' ? undefined : 'recording')}>
            Add a recording
          </button>
        </div>
      </div>

      <ErrorBanner error={error ?? actionError} />

      {(current?.conflicts ?? []).map((conflict) => (
        <div key={`${conflict.first.id}-${conflict.second.id}`} className="banner warn" role="alert">
          {conflict.detail}
        </div>
      ))}

      {adding ? (
        <OutputRow
          key={adding}
          kind={adding}
          series={series}
          destinations={destinations ?? []}
          credentials={credentials ?? []}
          devices={devices ?? []}
          onSave={(input) => act(() => api.createOutput(series.id, input))}
          onCancel={() => setAdding(undefined)}
        />
      ) : null}

      {(current?.outputs ?? []).length === 0 && !adding ? (
        <Empty>Nothing yet. This event would do nothing at all when its time comes.</Empty>
      ) : null}

      <div className="stack">
        {(current?.outputs ?? []).map((output) => (
          <OutputRow
            key={output.id}
            output={output}
            kind={output.kind}
            series={series}
            destinations={destinations ?? []}
            credentials={credentials ?? []}
            devices={devices ?? []}
            onSave={(input) => act(() => api.updateOutput(output.id, input))}
            onRemove={() => act(() => api.deleteOutput(output.id))}
            onReload={reload}
          />
        ))}
      </div>
    </section>
  )
}

interface RowProps {
  output?: EventOutput
  kind: 'stream' | 'recording'
  series: Series
  destinations: Destination[]
  credentials: Credential[]
  devices: Device[]
  onSave: (input: OutputInput) => void
  onRemove?: () => void
  onCancel?: () => void
  onReload?: () => void
}

function OutputRow(props: RowProps): ReactNode {
  const { output, kind, series } = props
  const [draft, setDraft] = useState(() => toDraft(output, kind, series))
  const set = <K extends keyof RowDraft>(key: K, value: RowDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  // "Where does it go" is one choice with two kinds of answer, not two
  // independent fields: an output with both is refused by the server, and
  // offering two dropdowns invites exactly that.
  const targetValue = draft.destinationId
    ? `destination:${draft.destinationId}`
    : draft.credentialId
      ? `credential:${draft.credentialId}`
      : ''

  const save = (): void =>
    props.onSave({
      kind,
      label: draft.label,
      offsetMs: offsetFrom(series, draft.startsAt),
      durationMs: draft.minutes * 60_000,
      destinationId: draft.destinationId,
      credentialId: draft.credentialId,
      deviceId: draft.deviceId,
      nodeId: draft.nodeId,
      templates: templatesOf(draft, kind),
      enabled: draft.enabled,
    })

  const offset = offsetFrom(series, draft.startsAt)

  return (
    <div className="card inner">
      <div className="row">
        <Field label="Name">
          <input
            value={draft.label}
            placeholder={kind === 'stream' ? 'Main channel // 9:00' : 'Archive'}
            onChange={(event) => set('label', event.target.value)}
          />
        </Field>
        <Field label="Starts">
          <input type="time" value={draft.startsAt} onChange={(event) => set('startsAt', event.target.value)} />
        </Field>
        <Field label="Runs for (min)">
          <input
            type="number"
            min={1}
            value={draft.minutes}
            onChange={(event) => set('minutes', Number(event.target.value))}
          />
        </Field>
      </div>

      {offset < 0 ? (
        <div className="banner warn">
          That is before the event opens at {timeOf(series)}. Move the event's start, or this one.
        </div>
      ) : null}
      {offset + draft.minutes * 60_000 > series.durationMs ? (
        <div className="banner warn">
          This runs past the end of the event's window. It will still run; the event just stays open for it.
        </div>
      ) : null}

      {kind === 'stream' ? (
        <Field label="Streams to" hint="A connected service issues its own key. A stream key is one you pasted in.">
          <select
            value={targetValue}
            onChange={(event) => {
              const [type, id] = event.target.value.split(':')
              setDraft((current) => ({
                ...current,
                destinationId: type === 'destination' ? (id ?? null) : null,
                credentialId: type === 'credential' ? (id ?? null) : null,
              }))
            }}
          >
            <option value="">— pick one —</option>
            {props.destinations.map((destination) => (
              <option key={destination.id} value={`destination:${destination.id}`}>
                {destination.label}
              </option>
            ))}
            {props.credentials.map((credential) => (
              <option key={credential.id} value={`credential:${credential.id}`}>
                {credential.label} (stream key)
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field
        label="Runs on"
        hint={
          kind === 'recording'
            ? 'A recorder of its own, usually. Leave on the source to record on the encoder itself.'
            : "Leave on the source unless this stream comes off different hardware."
        }
      >
        <select
          value={draft.deviceId ? `${draft.deviceId}/${draft.nodeId}` : ''}
          onChange={(event) => {
            const [deviceId, nodeId] = event.target.value.split('/')
            setDraft((current) => ({
              ...current,
              deviceId: event.target.value ? (deviceId ?? null) : null,
              nodeId: event.target.value ? (nodeId ?? null) : null,
            }))
          }}
        >
          <option value="">The event's source encoder</option>
          {props.devices.flatMap((device) =>
            device.nodes.map((node) => (
              <option key={`${device.id}/${node.id}`} value={`${device.id}/${node.id}`}>
                {device.label} — {node.label}
              </option>
            )),
          )}
        </select>
      </Field>

      <details>
        <summary>Its own name{kind === 'stream' ? ' and description' : ''}</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="muted" style={{ margin: 0 }}>
            Left blank, this uses the event's. Two services from one morning usually want different titles.
          </p>
          {kind === 'stream' ? (
            <>
              <Field label="Broadcast title">
                <input
                  value={draft.title}
                  placeholder={series.templates.title ?? '{{event.name}}'}
                  onChange={(event) => set('title', event.target.value)}
                />
              </Field>
              <Field label="Description">
                <textarea
                  rows={2}
                  value={draft.description}
                  onChange={(event) => set('description', event.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field label="Filename">
              <input
                value={draft.filename}
                placeholder={series.templates.filename ?? '{{date "yyyy-MM-dd"}} {{event.name}}'}
                onChange={(event) => set('filename', event.target.value)}
              />
            </Field>
          )}
        </div>
      </details>

      <div className="row">
        <button className="primary" disabled={!draft.label} onClick={save}>
          {output ? 'Save' : 'Add'}
        </button>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />
          <span>On</span>
        </label>
        {props.onCancel ? <button onClick={props.onCancel}>Cancel</button> : null}
        {props.onRemove ? <ConfirmButton label="Remove" onConfirm={props.onRemove} /> : null}
      </div>
    </div>
  )
}

interface RowDraft {
  label: string
  /** A wall clock time, in the event's zone. Stored as an offset. */
  startsAt: string
  minutes: number
  destinationId: string | null
  credentialId: string | null
  deviceId: string | null
  nodeId: string | null
  title: string
  description: string
  filename: string
  enabled: boolean
}

function toDraft(output: EventOutput | undefined, kind: 'stream' | 'recording', series: Series): RowDraft {
  return {
    label: output?.label ?? '',
    startsAt: clockAt(series, output?.offsetMs ?? 0),
    minutes: Math.round((output?.durationMs ?? series.durationMs) / 60_000),
    destinationId: output?.destinationId ?? null,
    credentialId: output?.credentialId ?? null,
    deviceId: output?.deviceId ?? null,
    nodeId: output?.nodeId ?? null,
    title: output?.templates.title ?? '',
    description: output?.templates.description ?? '',
    filename: output?.templates.filename ?? '',
    enabled: output?.enabled ?? true,
    ...(kind === 'recording' ? { destinationId: null, credentialId: null } : {}),
  }
}

function templatesOf(draft: RowDraft, kind: 'stream' | 'recording'): Record<string, string> {
  const out: Record<string, string> = {}
  if (kind === 'stream') {
    if (draft.title) out.title = draft.title
    if (draft.description) out.description = draft.description
  } else if (draft.filename) {
    out.filename = draft.filename
  }
  return out
}

/** The event's own start, as HH:mm in its zone. */
function timeOf(series: Series): string {
  return clockAt(series, 0)
}

function clockAt(series: Series, offsetMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: series.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(series.dtstart + offsetMs)
}

/**
 * Turns a typed clock time back into an offset from the window's start.
 *
 * Done in minutes-since-midnight rather than by building a date, so a clock
 * change on the event's first date cannot make an output an hour out from
 * every other one.
 */
function offsetFrom(series: Series, startsAt: string): number {
  const [hour, minute] = startsAt.split(':').map(Number)
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return 0
  const [openHour, openMinute] = timeOf(series).split(':').map(Number) as [number, number]
  return (hour * 60 + minute - openHour * 60 - openMinute) * 60_000
}
