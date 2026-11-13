import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type Credential,
  type Destination,
  type Device,
  type EventOutput,
  type OutputInput,
  type OutputSettings,
  type OutputsResponse,
  type DeviceNode,
  type NodeState,
  type Series,
} from '../api.ts'
import { ConfirmButton, Empty, ErrorBanner, Field, Switch, TemplateTokens } from '../components.tsx'
import { clockAt, offsetFrom } from '../output-times.ts'
import { changedKeys, changesLabel, useUnsavedGuard } from '../unsaved.ts'
import {
  bitrateHint,
  CUSTOM_VALUE,
  DEFAULT_KEEP_LAST,
  freeformHint,
  LEAVE_AS_IS,
  PICK_ONE,
} from '../copy.ts'

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
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const act = async (run: () => Promise<OutputsResponse>): Promise<void> => {
    // One save at a time: a second click on Add while the first is still
    // on its way made a second output.
    if (saving) return
    setSaving(true)
    setSaved(false)
    setActionError(undefined)
    try {
      setResult(await run())
      setAdding(undefined)
      setSaved(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(timer)
  }, [saved])

  return (
    <section className="card">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Streams and recordings</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Each one starts and stops on its own clock inside the event.
          </p>
        </div>
        <div className="row">
          <button onClick={() => setAdding(adding === 'stream' ? undefined : 'stream')}>
            Add a stream
          </button>
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

      {saved ? (
        <div className="banner info" role="status">
          Saved.
        </div>
      ) : null}

      {adding ? (
        <OutputRow
          key={adding}
          kind={adding}
          series={series}
          destinations={destinations ?? []}
          credentials={credentials ?? []}
          devices={devices ?? []}
          onSave={(input) => act(() => api.createOutput(series.id, input))}
          saving={saving}
          onCancel={() => setAdding(undefined)}
        />
      ) : null}

      {(current?.outputs ?? []).length === 0 && !adding ? (
        <Empty>
          Nothing yet, so this event would do nothing when its time comes. Add a stream or a
          recording.
        </Empty>
      ) : null}

      <div className="stack">
        {(current?.outputs ?? []).map((output) => (
          <OutputRow
            // Keyed on the window's start as well as the output: a row shows a
            // clock time worked out from both, and it is worked out once when
            // the row mounts. Without the start in the key, moving the event
            // leaves every row showing the time it used to be at.
            key={`${output.id}:${series.dtstart}`}
            output={output}
            kind={output.kind}
            series={series}
            destinations={destinations ?? []}
            credentials={credentials ?? []}
            devices={devices ?? []}
            onSave={(input) => act(() => api.updateOutput(output.id, input))}
            saving={saving}
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
  /** A save is on its way; the button waits for it. */
  saving?: boolean
  onRemove?: () => void
  onCancel?: () => void
  onReload?: () => void
}

function OutputRow(props: RowProps): ReactNode {
  const { output, kind, series } = props
  // What is saved, to compare against and to go back to.
  const original = useMemo(() => toDraft(output, kind, series), [output, kind, series])
  const [draft, setDraft] = useState(original)
  // A save comes back as a new saved version; the boxes follow it. Keyed
  // on the values, not the object: the rows of an unsaved event get a fresh
  // object every render, and following that would undo every keystroke.
  const originalKey = JSON.stringify(original)
  useEffect(() => setDraft(original), [originalKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const changed = output ? changedKeys(original, draft) : []
  const isChanged = (...keys: (keyof RowDraft)[]): boolean =>
    keys.some((key) => changed.includes(key))
  // An output being added is unsaved by definition; a saved one, once edited.
  useUnsavedGuard(output ? changed.length > 0 : true)
  // A saved output starts as one line; a new one opens to be filled in.
  const [expanded, setExpanded] = useState(!output)
  const [customName, setCustomName] = useState(
    () => draft.title !== '' || draft.description !== '' || draft.filename !== '',
  )
  const [cleanup, setCleanup] = useState(() => draft.keepDays !== '' || draft.minFreeHours !== '')
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

  const save = (patch: Partial<RowDraft> = {}): void => {
    const draft_ = { ...draft, ...patch }
    if (!draft_.deviceId || !draft_.nodeId) return
    saveDraft(draft_)
  }
  const saveDraft = (draft: RowDraft): void => {
    if (!draft.deviceId || !draft.nodeId) return
    props.onSave({
      kind,
      label: draft.label.trim() || defaultLabel || (kind === 'stream' ? 'Stream' : 'Recording'),
      offsetMs: offsetFrom(series, draft.startsAt),
      durationMs: draft.minutes * 60_000,
      followsWindow: draft.followsWindow,
      stopAfterMs: draft.followsWindow ? draft.stopAfter * 60_000 : 0,
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
  const chosen = capable.find(
    (entry) => entry.device.id === draft.deviceId && entry.node.id === draft.nodeId,
  )
  const offset = offsetFrom(series, draft.startsAt)
  // A paired event has no clock time of its own: Planning Center says when
  // each service starts. So an output is placed relative to the service,
  // and a clock box here would only show a made-up time.
  const paired = Boolean(series.planSourceId && series.planGroupId)
  const chosenDestination = props.destinations.find((entry) => entry.id === draft.destinationId)
  // Left blank, an output is named after where it goes, or the device it
  // records on: "Grace Worship", "HyperDeck — archive".
  const defaultLabel =
    (kind === 'stream'
      ? (props.destinations.find((entry) => entry.id === draft.destinationId)?.label ??
        props.credentials.find((entry) => entry.id === draft.credentialId)?.label)
      : chosen?.device.label) ?? ''

  const where =
    kind === 'stream'
      ? chosenDestination
        ? `${chosenDestination.label} (${providerName(chosenDestination.providerId)})`
        : props.credentials.find((entry) => entry.id === draft.credentialId)?.label
      : chosen?.device.label
  const when = paired
    ? offset === 0
      ? 'with the service'
      : `${Math.abs(Math.round(offset / 60_000))} min ${offset < 0 ? 'before' : 'after'} the service`
    : `from ${draft.startsAt}`

  if (!expanded) {
    // One line: enough to tell outputs apart and see which are on, with the
    // whole form a click away.
    return (
      <div className="card inner output-summary">
        <button
          className="output-summary-open"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <span aria-hidden>▸</span>
          <strong>{draft.label || defaultLabel}</strong>
          <span className="muted">
            {kind === 'stream' ? 'Stream' : 'Recording'}
            {where ? ` to ${where}` : ''} · {when}
            {draft.followsWindow ? ', to the end' : `, ${draft.minutes} min`}
          </span>
        </button>
        <Switch
          checked={draft.enabled}
          label={`${draft.label || defaultLabel || 'This output'} on or off`}
          disabled={props.saving === true}
          onChange={(next) => {
            set('enabled', next)
            // Saved straight away from here: there is no form open to
            // press Save in.
            save({ enabled: next })
          }}
        />
      </div>
    )
  }

  return (
    <div className="card inner">
      {/* What it is called, and whether it runs at all, side by side: the
          two things somebody scanning a list of outputs is looking for. */}
      <div className="row output-head">
        <Field label="Name" changed={isChanged('label')}>
          <input
            value={draft.label}
            placeholder={defaultLabel || (kind === 'stream' ? 'Main channel' : 'Archive')}
            onChange={(event) => set('label', event.target.value)}
          />
        </Field>
        <span className="row" style={{ gap: 8 }}>
          <Switch
            checked={draft.enabled}
            label={`${draft.label || defaultLabel || 'This output'} on or off`}
            onChange={(next) => set('enabled', next)}
          />
          <span className="muted">{draft.enabled ? 'On' : 'Off'}</span>
        </span>
      </div>

      {kind === 'stream' ? (
        <Field
          label="Streams to"
          changed={isChanged('destinationId', 'credentialId')}
          // Once one is picked the hint has done its job, and a page with
          // four outputs on it would otherwise say this four times.
          hint={
            targetValue === ''
              ? 'A connected service issues its own key. A stream key is one you pasted in.'
              : undefined
          }
        >
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
            <option value="">{PICK_ONE}</option>
            {props.destinations.map((destination) => (
              <option key={destination.id} value={`destination:${destination.id}`}>
                {destination.label} ({providerName(destination.providerId)})
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
      {chosenDestination?.providerId === 'youtube' ? (
        <BroadcastOverrides
          destination={chosenDestination}
          privacy={draft.privacy}
          playlistId={draft.playlistId}
          onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
        />
      ) : null}

      {/* Only hardware that can actually do this. A recorder in a stream's
          picker is an invitation to a Sunday-morning failure, and the
          server refuses it anyway. */}
      <Field
        label="Runs on"
        changed={isChanged('deviceId', 'nodeId')}
        hint={
          capable.length === 0
            ? `No connected device offers ${kind === 'recording' ? 'recording' : 'streaming'}. Add or connect one first.`
            : chosen
              ? undefined
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
          <option value="">{PICK_ONE}</option>
          {capable.map(({ device, node }) => (
            <option key={`${device.id}/${node.id}`} value={`${device.id}/${node.id}`}>
              {device.label} — {node.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="row">
        {paired ? (
          <Field label="Starts" changed={isChanged('startsAt')}>
            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input
                type="number"
                min={0}
                style={{ width: 72 }}
                aria-label="Minutes"
                value={Math.abs(Math.round(offset / 60_000))}
                onChange={(event) =>
                  set(
                    'startsAt',
                    clockAt(
                      series,
                      (offset < 0 ? -1 : 1) * Math.abs(Number(event.target.value)) * 60_000,
                    ),
                  )
                }
              />
              <select
                aria-label="Before or after"
                value={offset < 0 ? 'before' : 'after'}
                onChange={(event) =>
                  set(
                    'startsAt',
                    clockAt(series, (event.target.value === 'before' ? -1 : 1) * Math.abs(offset)),
                  )
                }
              >
                <option value="before">min before the service</option>
                <option value="after">min after it starts</option>
              </select>
            </span>
          </Field>
        ) : (
          <Field
            label="Starts"
            changed={isChanged('startsAt')}
            hint={offset < 0 ? `${Math.round(-offset / 60_000)} min before the event.` : undefined}
          >
            <input
              type="time"
              value={draft.startsAt}
              onChange={(event) => set('startsAt', event.target.value)}
            />
          </Field>
        )}
        {/* Hidden rather than greyed out: with the box ticked the event's
            own length decides, and a number here would only mislead. */}
        {draft.followsWindow ? (
          <Field
            changed={isChanged('stopAfter')}
            label={
              paired ? 'Keeps going after the service (min)' : 'Keeps going after the event (min)'
            }
          >
            <input
              type="number"
              min={0}
              style={{ width: 90 }}
              value={draft.stopAfter}
              onChange={(event) => set('stopAfter', Math.max(0, Number(event.target.value)))}
            />
          </Field>
        ) : (
          <Field label="Runs for (min)" changed={isChanged('minutes')}>
            <input
              type="number"
              min={1}
              value={draft.minutes}
              onChange={(event) => set('minutes', Number(event.target.value))}
            />
          </Field>
        )}
      </div>

      <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input
          type="checkbox"
          checked={draft.followsWindow}
          onChange={(event) => set('followsWindow', event.target.checked)}
        />
        <span>{paired ? 'Run until the service ends' : 'Run until the event ends'}</span>
      </label>

      {/* An output that follows the window cannot run past it, so the
          warning below would be nonsense for one. */}
      {!draft.followsWindow && offset + draft.minutes * 60_000 > series.durationMs ? (
        <div className="banner warn">
          This runs past the end of the event. It will still run; the event just stays open for it.
        </div>
      ) : null}

      <DeviceSettings kind={kind} draft={draft} set={set} device={chosen} />

      {/* Its own name only when asked for: most outputs are named after the
          event, and a box of template tokens on every one was most of
          the form. */}
      <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input
          type="checkbox"
          checked={customName}
          onChange={(event) => {
            setCustomName(event.target.checked)
            if (!event.target.checked) {
              setDraft((current) => ({ ...current, title: '', description: '', filename: '' }))
            }
          }}
        />
        <span>{kind === 'stream' ? 'Custom name and description' : 'Custom filename'}</span>
      </label>
      {customName ? (
        <div className="stack">
          <TemplateTokens plan={Boolean(series.planSourceId && series.planGroupId)} />
          {kind === 'stream' ? (
            <>
              <Field label="Broadcast title" changed={isChanged('title')}>
                <input
                  value={draft.title}
                  placeholder={series.templates.title ?? '{{event.name}}'}
                  onChange={(event) => set('title', event.target.value)}
                />
              </Field>
              <Field label="Description" changed={isChanged('description')}>
                <textarea
                  rows={2}
                  value={draft.description}
                  onChange={(event) => set('description', event.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field
              label="Filename"
              hint="The device adds its own extension."
              changed={isChanged('filename')}
            >
              <input
                value={draft.filename}
                placeholder={series.templates.filename ?? '{{date "yyyy-MM-dd"}} {{event.name}}'}
                onChange={(event) => set('filename', event.target.value)}
              />
            </Field>
          )}
        </div>
      ) : null}

      {/* A policy this scheduler keeps, not a setting on the deck: the
          device has no notion of how long a file is worth. */}
      {kind === 'recording' ? (
        <>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input
              type="checkbox"
              checked={cleanup}
              onChange={(event) => {
                setCleanup(event.target.checked)
                setDraft((current) =>
                  event.target.checked
                    ? { ...current, keepDays: current.keepDays || '30' }
                    : { ...current, keepDays: '', minFreeHours: '', keepLast: '' },
                )
              }}
            />
            <span>Delete old recordings from the card</span>
          </label>
          {cleanup ? (
            <>
              <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
                <Field label="Delete after (days)" changed={isChanged('keepDays')}>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={draft.keepDays}
                    placeholder="forever"
                    onChange={(event) => set('keepDays', event.target.value)}
                  />
                </Field>
                <Field
                  label="Or when under (hours free)"
                  hint="Optional."
                  changed={isChanged('minFreeHours')}
                >
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={draft.minFreeHours}
                    placeholder="never"
                    onChange={(event) => set('minFreeHours', event.target.value)}
                  />
                </Field>
                <Field label="Always keep the newest" changed={isChanged('keepLast')}>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.keepLast}
                    placeholder={String(DEFAULT_KEEP_LAST)}
                    disabled={!draft.keepDays && !draft.minFreeHours}
                    onChange={(event) => set('keepLast', event.target.value)}
                  />
                </Field>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Checked every hour. Never while recording, and never files this scheduler did not
                make.
              </p>
            </>
          ) : null}
        </>
      ) : null}

      <div className="save-bar">
        <button
          className="primary"
          disabled={!draft.deviceId || props.saving === true || (output && changed.length === 0)}
          onClick={() => save()}
        >
          {props.saving
            ? 'Saving…'
            : !output
              ? 'Add'
              : changed.length > 0
                ? `Save ${changesLabel(changed.length)}`
                : 'Saved'}
        </button>
        {output && changed.length > 0 ? (
          <button onClick={() => setDraft(original)}>Revert</button>
        ) : null}
        {output && changed.length === 0 ? (
          <button onClick={() => setExpanded(false)}>Close</button>
        ) : null}
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
  // Set when the operator asks to type a figure the list does not offer.
  const [custom, setCustom] = useState(false)

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
  // Also on when what is already stored is a figure rather than a preset —
  // otherwise reopening an output would show "leave as it is" over a
  // setting it is going to apply.
  const showCustom =
    custom || (draft.quality !== '' && qualities.length > 0 && !qualities.includes(draft.quality))

  return (
    <details>
      <summary>Device settings</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {qualities.length > 0 ? (
          <Field
            label="Quality"
            hint={
              bitrate
                ? 'The presets this device offers. Anything else goes in as a bitrate.'
                : 'The profiles this encoder reports for the service it is on.'
            }
          >
            <select
              value={
                showCustom ? CUSTOM_VALUE : qualities.includes(draft.quality) ? draft.quality : ''
              }
              onChange={(event) => {
                setCustom(event.target.value === CUSTOM_VALUE)
                set('quality', event.target.value === CUSTOM_VALUE ? '' : event.target.value)
              }}
            >
              <option value="">
                {LEAVE_AS_IS}
                {current ? ` (${current})` : ''}
              </option>
              {qualities.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
              {/* Only where the device takes a figure as well as a name. */}
              {bitrate ? <option value={CUSTOM_VALUE}>Custom…</option> : null}
            </select>
          </Field>
        ) : null}

        {/* The figure, when the operator asked for one the list does not
            have, or the device only takes numbers. */}
        {bitrate && (qualities.length === 0 || showCustom) ? (
          <Field label="Bitrate (Mb/s)" hint={bitrateHint(bitrate, current)}>
            <input
              value={draft.quality}
              placeholder={current ?? `${bitrate.minMbps}-${bitrate.maxMbps}`}
              onChange={(event) => set('quality', event.target.value)}
            />
          </Field>
        ) : null}

        {freeform && qualities.length === 0 && !bitrate ? (
          <Field label="Quality" hint={freeformHint(freeform, current)}>
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
            <Field label="Record to" hint="The slot this recording is written to.">
              <select value={draft.slot} onChange={(event) => set('slot', event.target.value)}>
                <option value="">{LEAVE_AS_IS}</option>
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
                ? "When this slot fills, the deck rolls onto the other one by itself. That is the deck's own behaviour and cannot be turned off from here."
                : 'There is no second slot mounted, so recording stops when this one fills.'}
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
  /** Run to the end of the window rather than for `minutes`. */
  followsWindow: boolean
  /** Minutes it keeps going after the window, when it follows it. */
  stopAfter: number
  /** This stream's own privacy and playlist; blank follows the account. */
  privacy: '' | 'public' | 'unlisted' | 'private'
  playlistId: string
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
  /** Blank means recordings are kept forever, which is the default. */
  keepDays: string
  keepLast: string
  /** Blank means a full card is not by itself a reason to delete. */
  minFreeHours: string
  enabled: boolean
}

function toDraft(
  output: EventOutput | undefined,
  kind: 'stream' | 'recording',
  series: Series,
): RowDraft {
  return {
    label: output?.label ?? '',
    startsAt: clockAt(series, output?.offsetMs ?? 0),
    minutes: Math.round((output?.durationMs ?? series.durationMs) / 60_000),
    // A new output follows the event by default: it is what almost every
    // output wants, and it leaves one fewer number to get right. An
    // existing output keeps whatever it was set to.
    followsWindow: output?.followsWindow ?? true,
    stopAfter: Math.round((output?.stopAfterMs ?? 0) / 60_000),
    privacy: output?.settings.broadcast?.privacy ?? '',
    playlistId: output?.settings.broadcast?.playlistId ?? '',
    destinationId: output?.destinationId ?? null,
    credentialId: output?.credentialId ?? null,
    deviceId: output?.deviceId ?? null,
    nodeId: output?.nodeId ?? null,
    title: output?.templates.title ?? '',
    description: output?.templates.description ?? '',
    filename: output?.templates.filename ?? '',
    quality: output?.settings.quality ?? '',
    slot: output?.settings.slot === undefined ? '' : String(output.settings.slot),
    keepDays:
      output?.settings.retention?.keepDays === undefined
        ? ''
        : String(output.settings.retention.keepDays),
    keepLast:
      output?.settings.retention?.keepLast === undefined
        ? ''
        : String(output.settings.retention.keepLast),
    minFreeHours:
      output?.settings.retention?.minFreeHours === undefined
        ? ''
        : String(output.settings.retention.minFreeHours),
    enabled: output?.enabled ?? true,
    ...(kind === 'recording' ? { destinationId: null, credentialId: null } : {}),
  }
}

function settingsOf(draft: RowDraft): OutputSettings {
  const out: OutputSettings = {}
  if (draft.destinationId && (draft.privacy || draft.playlistId)) {
    out.broadcast = {
      ...(draft.privacy ? { privacy: draft.privacy } : {}),
      ...(draft.playlistId ? { playlistId: draft.playlistId } : {}),
    }
  }
  if (draft.quality) out.quality = draft.quality
  if (draft.slot) out.slot = Number(draft.slot)

  // Only sent when there is a limit to go on. Without one nothing is ever
  // eligible, so "keep the newest ten of forever" is not a policy — and
  // storing it would arm an hourly sweep that can never do anything.
  if (draft.keepDays || draft.minFreeHours) {
    out.retention = {
      ...(draft.keepDays === '' ? {} : { keepDays: Number(draft.keepDays) }),
      ...(draft.minFreeHours === '' ? {} : { minFreeHours: Number(draft.minFreeHours) }),
      ...(draft.keepLast === '' ? {} : { keepLast: Number(draft.keepLast) }),
    }
  }
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

/**
 * Streams and recordings for an event that has not been saved yet.
 *
 * The same editor as a saved event's outputs, holding them here until the
 * event is created, when they are sent with it. So an event is set up on one
 * page in one pass — times, then what goes out — rather than saved half-done
 * first.
 *
 * Takes the event as it stands in the form. Only its opening time, length
 * and pairing matter here: outputs are offsets into the window, so the
 * calendar date and the zone do not change them.
 */
export function DraftOutputs({
  event,
  value,
  onChange,
}: {
  event: { time: string; durationMs: number; paired: boolean; templates: Record<string, string> }
  value: OutputInput[]
  onChange: (next: OutputInput[]) => void
}): ReactNode {
  const { data: destinations } = useResource(() => api.destinations(), [])
  const { data: credentials } = useResource(() => api.credentials(), [])
  const { data: devices } = useResource(() => api.devices(), [])
  const [adding, setAdding] = useState<'stream' | 'recording'>()

  // A stand-in for the series the editor expects. Read in UTC with its
  // opening time on the clock, the offsets come out the same as they will
  // against the real one.
  const [hour = 0, minute = 0] = event.time.split(':').map(Number)
  const series = {
    id: 'draft',
    label: '',
    timezone: 'UTC',
    rrule: null,
    describes: '',
    dtstart: Date.UTC(2000, 0, 1, hour, minute),
    durationMs: event.durationMs,
    prepareLeadMs: 0,
    prerollMs: 0,
    postrollMs: 0,
    lateStartGraceMs: 0,
    templates: event.templates,
    version: 0,
    enabled: true,
    planSourceId: event.paired ? 'draft' : null,
    planGroupId: event.paired ? 'draft' : null,
  } as Series

  const asOutput = (input: OutputInput, index: number): EventOutput => ({
    id: `draft-${index}`,
    seriesId: 'draft',
    position: index,
    offsetMs: 0,
    followsWindow: false,
    destinationId: null,
    credentialId: null,
    templates: {},
    settings: {},
    enabled: true,
    ...input,
  })

  return (
    <section className="card">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Streams and recordings</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Saved with the event.
          </p>
        </div>
        <div className="row">
          <button onClick={() => setAdding(adding === 'stream' ? undefined : 'stream')}>
            Add a stream
          </button>
          <button onClick={() => setAdding(adding === 'recording' ? undefined : 'recording')}>
            Add a recording
          </button>
        </div>
      </div>

      {adding ? (
        <OutputRow
          key={`new-${adding}`}
          kind={adding}
          series={series}
          destinations={destinations ?? []}
          credentials={credentials ?? []}
          devices={devices ?? []}
          onSave={(input) => {
            onChange([...value, input])
            setAdding(undefined)
          }}
          onCancel={() => setAdding(undefined)}
        />
      ) : null}

      {value.length === 0 && !adding ? (
        <Empty>Nothing yet. Add a stream or a recording, or add them after saving.</Empty>
      ) : null}

      <div className="stack">
        {value.map((input, index) => (
          <OutputRow
            key={`draft-${index}-${event.time}`}
            output={asOutput(input, index)}
            kind={input.kind}
            series={series}
            destinations={destinations ?? []}
            credentials={credentials ?? []}
            devices={devices ?? []}
            onSave={(next) => onChange(value.map((entry, at) => (at === index ? next : entry)))}
            onRemove={() => onChange(value.filter((_, at) => at !== index))}
          />
        ))}
      </div>
    </section>
  )
}

/** "YouTube", "Twitch": a provider id the way people say it. */
function providerName(id: string): string {
  return id === 'youtube' ? 'YouTube' : id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * One stream's own privacy and playlist, over its account's defaults.
 *
 * Closed until wanted: most streams go out the way their account says, and
 * the one that does not — an unlisted rehearsal feed — is the exception.
 */
function BroadcastOverrides({
  destination,
  privacy,
  playlistId,
  onChange,
}: {
  destination: Destination
  privacy: RowDraft['privacy']
  playlistId: string
  onChange: (next: Partial<Pick<RowDraft, 'privacy' | 'playlistId'>>) => void
}): ReactNode {
  const [open, setOpen] = useState(privacy !== '' || playlistId !== '')
  const { data } = useResource(
    () =>
      open && destination.accountId
        ? api
            .playlists(destination.providerId, destination.accountId)
            .catch(() => ({ playlists: [] }))
        : Promise.resolve({ playlists: [] }),
    [open, destination.providerId, destination.accountId],
  )
  const accountPrivacy = String(destination.config.privacy ?? 'public')
  const accountPlaylist = data?.playlists.find(
    (entry) => entry.id === destination.config.playlistId,
  )

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Privacy and playlist</summary>
      <div className="row" style={{ marginTop: 8 }}>
        <Field label="Privacy">
          <select
            value={privacy}
            onChange={(event) => onChange({ privacy: event.target.value as RowDraft['privacy'] })}
          >
            <option value="">Account default ({accountPrivacy})</option>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </Field>
        <Field label="Playlist">
          <select
            value={playlistId}
            onChange={(event) => onChange({ playlistId: event.target.value })}
          >
            <option value="">
              Account default{accountPlaylist ? ` (${accountPlaylist.title})` : ''}
            </option>
            {(data?.playlists ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </details>
  )
}
