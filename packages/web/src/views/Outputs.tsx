import { useEffect, useState } from 'react'
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
  type DeviceNode,
  type NodeState,
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
        // Keyed by kind as well as by pair: one pair can clash over more
        // than one thing, and two banners with one key is a rendering bug.
        <div
          key={`${conflict.kind ?? 'device'}-${conflict.first.id}-${conflict.second.id}`}
          className="banner warn"
          role="alert"
        >
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

  const save = (): void => {
    if (!draft.deviceId || !draft.nodeId) return
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
      settings: settingsOf(draft),
      enabled: draft.enabled,
    })
  }

  const needed = kind === 'recording' ? 'startRecording' : 'startStreaming'
  const capable = props.devices.flatMap((device) =>
    device.nodes.filter((node) => node.supports.includes(needed)).map((node) => ({ device, node })),
  )
  const chosen = capable.find((entry) => entry.device.id === draft.deviceId && entry.node.id === draft.nodeId)
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

      {/* Only hardware that can actually do this. A recorder in a stream's
          picker is an invitation to a Sunday-morning failure, and the
          server refuses it anyway. */}
      <Field
        label="Runs on"
        hint={
          capable.length === 0
            ? `No connected device offers ${kind === 'recording' ? 'recording' : 'streaming'}. Add or connect one first.`
            : kind === 'recording'
              ? 'The recorder this goes onto.'
              : 'The encoder this comes off.'
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
              // Its settings belong to the old device's vocabulary.
              quality: '',
              slot: '',
            }))
          }}
        >
          <option value="">— pick one —</option>
          {capable.map(({ device, node }) => (
            <option key={`${device.id}/${node.id}`} value={`${device.id}/${node.id}`}>
              {device.label} — {node.label}
            </option>
          ))}
        </select>
      </Field>

      <DeviceSettings kind={kind} draft={draft} set={set} device={chosen} />

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
        <button className="primary" disabled={!draft.label || !draft.deviceId} onClick={save}>
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


/**
 * What this output wants set on its device before it runs.
 *
 * The choices come from the device itself, asked for when one is picked —
 * an encoder's quality profiles are per platform and a deck's slots are
 * whatever cards are in it, so a free-text box here is a typo that surfaces
 * as a rejected command at 09:00.
 *
 * Every control has a "leave it" option and that is the default. An event
 * that does not care must not quietly reconfigure hardware somebody else
 * set up by hand.
 */
function DeviceSettings({
  kind,
  draft,
  set,
  device,
}: {
  kind: 'stream' | 'recording'
  draft: RowDraft
  set: <K extends keyof RowDraft>(key: K, value: RowDraft[K]) => void
  device: { device: Device; node: DeviceNode } | undefined
}): ReactNode {
  const [state, setState] = useState<NodeState | null>()

  useEffect(() => {
    if (!device) {
      setState(undefined)
      return
    }
    let cancelled = false
    api
      .nodeState(device.device.id, device.node.id)
      .then((result) => !cancelled && setState(result.state))
      // A device that will not answer is not an error here: the settings
      // simply cannot be offered, and the run will say so if it matters.
      .catch(() => !cancelled && setState(null))
    return () => {
      cancelled = true
    }
    // Keyed on the identity of the chosen node, not the object: the parent
    // rebuilds that on every render and depending on it would re-ask the
    // device on every keystroke in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.device.id, device?.node.id])

  if (!device) return null
  // Three ways a device spells its quality, and it says which one it takes:
  // named profiles (a Streaming Encoder), a bitrate (an ATEM, which stores
  // only numbers), or a name it cannot enumerate (a HyperDeck's codec).
  const quality = state?.options?.quality
  const qualities = quality?.choices ?? []
  const bitrate = quality?.bitrate
  const freeform = quality?.freeform
  const current = quality?.current
  const slots = state?.recording?.slots ?? []
  if (!quality && slots.length === 0) return null
  const listId = `quality-${device.device.id}-${device.node.id}`

  return (
    <details>
      <summary>Device settings</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {qualities.length > 0 ? (
          <Field label="Quality" hint="The profiles this encoder reports for the service it is on.">
            <select value={draft.quality} onChange={(event) => set('quality', event.target.value)}>
              <option value="">Leave as it is{current ? ` (${current})` : ''}</option>
              {qualities.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </Field>
        ) : bitrate ? (
          /* Offered for a recording as well as a stream: on a box that takes
             a bitrate, the two come out of the same encoder. */
          <Field
            label="Bitrate (Mb/s)"
            hint={`${bitrate.note ? `${bitrate.note} ` : ''}Between ${bitrate.minMbps} and ${bitrate.maxMbps}, or a low-high range. Blank leaves it${current ? ` at ${current}` : ''}.`}
          >
            <input
              value={draft.quality}
              placeholder={current ?? `${bitrate.minMbps}-${bitrate.maxMbps}`}
              onChange={(event) => set('quality', event.target.value)}
            />
          </Field>
        ) : freeform ? (
          <Field
            label="Quality"
            hint={`${freeform.note ? `${freeform.note} ` : ''}The list is a suggestion — the device has its own set and refuses one it does not have. Blank leaves it${current ? ` on ${current}` : ''}.`}
          >
            <input
              list={listId}
              value={draft.quality}
              placeholder={current ?? ''}
              onChange={(event) => set('quality', event.target.value)}
            />
            <datalist id={listId}>
              {(freeform.examples ?? []).map((example) => (
                <option key={example} value={example} />
              ))}
            </datalist>
          </Field>
        ) : null}

        {kind === 'recording' && slots.length > 0 ? (
          <>
            <Field label="Record to" hint="Which card this output writes to.">
              <select value={draft.slot} onChange={(event) => set('slot', event.target.value)}>
                <option value="">Leave as it is</option>
                {slots.map((slot) => (
                  <option key={slot.id} value={String(slot.id)}>
                    Slot {slot.id}
                    {slot.volumeName ? ` — ${slot.volumeName}` : ` — ${slot.status}`}
                  </option>
                ))}
              </select>
            </Field>
            {/* Said plainly rather than offered as a switch that would not
                do anything: the protocol has no rollover setting to write. */}
            <p className="muted" style={{ margin: 0 }}>
              {state?.recording?.rollover
                ? 'The deck rolls onto its other card by itself when this one fills. That is the deck\'s own behaviour and cannot be turned off from here.'
                : 'There is no second mounted card, so recording stops when this one fills.'}
            </p>
          </>
        ) : null}
      </div>
    </details>
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
  /** Blank means "leave the device as it is". */
  quality: string
  slot: string
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
    quality: output?.settings.quality ?? '',
    slot: output?.settings.slot === undefined ? '' : String(output.settings.slot),
    enabled: output?.enabled ?? true,
    ...(kind === 'recording' ? { destinationId: null, credentialId: null } : {}),
  }
}

function settingsOf(draft: RowDraft): { quality?: string; slot?: number } {
  const out: { quality?: string; slot?: number } = {}
  if (draft.quality) out.quality = draft.quality
  if (draft.slot) out.slot = Number(draft.slot)
  return out
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
