import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useLive,
  useLiveRefresh,
  useResource,
  type Device,
  type DeviceNode,
  type DiscoveredDevice,
  type ManualAction,
  type NodeState,
  type Plugin,
} from '../api.ts'
import {
  Card,
  ConfigFields,
  ConfirmButton,
  CopyButton,
  Empty,
  ErrorBanner,
  Fact,
  Field,
  IconButton,
  PageHead,
  StatusPill,
} from '../components.tsx'
import { bitrateHint, CUSTOM_VALUE, freeformHint, LEAVE_AS_IS, nowOn } from '../copy.ts'
import { duration, relative } from '../format.ts'
import { DeviceFiles } from './DeviceFiles.tsx'
import { FilterBar, matches, TagEditor, TagList } from '../tags.tsx'
import { IconClose } from '../icons.tsx'

/** The three ways anybody looks for a device in a full rack. */
const DEVICE_SORTS = [
  { id: 'label', label: 'Name' },
  { id: 'health', label: 'Health' },
  { id: 'seen', label: 'Last seen' },
]

/** Unreachable first when sorting by health: the ones needing attention
 *  are the reason somebody opened this screen. */
function sortDevices(by: string): (a: Device, b: Device) => number {
  if (by === 'health') {
    const rank = (device: Device): number =>
      device.health === 'connected' ? 2 : device.health === 'degraded' ? 1 : 0
    return (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)
  }
  if (by === 'seen') return (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
  return (a, b) => a.label.localeCompare(b.label)
}

/**
 * Files are stamped by the device's own clock, so they are shown in the
 * browser's zone rather than an event's: a card is a thing in the room,
 * not a thing on a schedule.
 */
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

export function Devices({
  focusId,
  navigate,
}: { focusId?: string; navigate?: (path: string) => void } = {}): ReactNode {
  const { data, error, reload } = useResource(() => api.devices(), [])
  // Health and what is in use change without anybody pressing anything.
  useLiveRefresh(reload)
  const { data: known, reload: reloadTags } = useResource(() => api.tags('device'), [])
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [sort, setSort] = useState('label')
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

  const all = data ?? []
  const devices = all.filter((device) => matches(device, query, chosen)).sort(sortDevices(sort))

  // The open device is the route, not a piece of local state. That makes
  // a link from the status board or a run land on the same thing a click
  // here does, and makes the browser's own back button close the panel.
  const open = focusId === undefined ? undefined : all.find((device) => device.id === focusId)
  const show = (id: string | undefined): void =>
    navigate?.(id === undefined ? '/devices' : `/devices/${id}`)

  // Closing the panel with Escape, because a drawer that can only be
  // dismissed by finding its close button is a drawer people leave open.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') show(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id])

  return (
    <>
      <PageHead
        title="Devices"
        subtitle="The encoders, switchers and recorders this scheduler drives."
        actions={
          <button className="primary" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Cancel' : 'Add a device'}
          </button>
        }
      />
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

        {all.length > 1 ? (
          <FilterBar
            query={query}
            onQuery={setQuery}
            tags={known?.tags ?? []}
            chosen={chosen}
            onChosen={setChosen}
            sort={sort}
            sorts={DEVICE_SORTS}
            onSort={setSort}
            count={devices.length}
            total={all.length}
          />
        ) : null}

        {devices.length === 0 && !adding ? (
          <Card>
            <Empty>
              {all.length === 0
                ? 'No devices yet. Add a real encoder, switcher or deck — or the bundled mock, which runs a whole scheduled event without touching hardware.'
                : 'No devices match that.'}
            </Empty>
          </Card>
        ) : null}

        {/* A list rather than a stack of cards. A rack of twenty was
            twenty expanded panels, and finding one meant scrolling past
            nineteen sets of controls belonging to something else. */}
        {devices.length > 0 ? (
          <Card>
            <div className="device-list">
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  kind={plugins?.find((plugin) => plugin.id === device.pluginId)?.displayName}
                  selected={device.id === focusId}
                  onOpen={() => show(device.id)}
                />
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      {open ? (
        <DevicePanel
          device={open}
          kind={plugins?.find((plugin) => plugin.id === open.pluginId)?.displayName}
          plugins={plugins}
          editing={editing === open.id}
          busy={busy === open.id}
          onClose={() => show(undefined)}
          onConnect={() => void act(open.id, () => api.connectDevice(open.id))}
          onEdit={() => setEditing(open.id)}
          onEdited={() => {
            setEditing(undefined)
            reload()
          }}
          onRemove={() => {
            void act(open.id, () => api.deleteDevice(open.id)).then(() => show(undefined))
          }}
          onTagged={() => {
            reload()
            // The filter offers the tags that exist, so a new one has to
            // reach it as soon as it is typed.
            reloadTags()
          }}
        />
      ) : null}
    </>
  )
}

/**
 * One device in the list: what it is, and whether it is all right.
 *
 * Everything else is behind opening it. A rack of twenty used to be
 * twenty expanded panels, and finding the deck that stopped answering
 * meant scrolling past nineteen sets of controls belonging to something
 * else.
 */
function DeviceRow({
  device,
  kind,
  selected,
  onOpen,
}: {
  device: Device
  kind: string | undefined
  selected: boolean
  onOpen: () => void
}): ReactNode {
  return (
    <button
      className={`device-row-item${selected ? ' is-selected' : ''}`}
      title={`Open ${device.label}`}
      onClick={onOpen}
    >
      <StatusPill status={device.health} />
      <span className="device-row-name">
        <strong>{device.label}</strong>
        <span className="muted">
          {kind ?? device.pluginId}
          {device.probedModel ? ` · ${device.probedModel}` : ''}
        </span>
      </span>

      <TagList tags={device.tags ?? []} />

      {/* Only the things somebody would scan a list for: what is wrong,
          and what is in use. Everything else is inside. */}
      {device.inUseBy.length > 0 ? (
        <span className="pill live" title={device.inUseBy.map((run) => run.label).join(', ')}>
          in use
        </span>
      ) : null}
      {!device.enabled ? (
        <span className="pill warn" title="Skipped when an event runs.">
          off
        </span>
      ) : null}
      {device.lastError ? (
        <span className="bad device-row-error" title={device.lastError}>
          {device.lastError}
        </span>
      ) : null}
    </button>
  )
}

/**
 * One device in full, in a drawer over the list.
 *
 * A drawer rather than an expanding row because the contents are a whole
 * screen's worth — config, every node's controls, the files on its media
 * — and pushing the rest of the rack down the page to show them loses the
 * thing somebody was comparing against.
 */
function DevicePanel({
  device,
  kind,
  plugins,
  editing,
  busy,
  onClose,
  onConnect,
  onEdit,
  onEdited,
  onRemove,
  onTagged,
}: {
  device: Device
  /** The plugin's own name for this kind of box, e.g. "Blackmagic HyperDeck". */
  kind: string | undefined
  plugins: Plugin[] | undefined
  editing: boolean
  busy: boolean
  onClose: () => void
  onTagged: () => void
  onConnect: () => void
  onEdit: () => void
  onEdited: () => void
  onRemove: () => void
}): ReactNode {
  return (
    <>
      {/* Catches the click that means "I am done with this", which on a
          drawer is anywhere else on the page. */}
      <button className="drawer-scrim" aria-label="Close" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={device.label}>
        <div className="page-head drawer-head">
          <div>
            <h2 style={{ marginBottom: 2 }}>{device.label}</h2>
            <span
              className="muted"
              title="What it is, and — once connected — the model it says it is."
            >
              {kind ?? device.pluginId}
              {/* The probed model, not what someone picked in a dropdown. */}
              {device.probedModel ? ` · ${device.probedModel}` : ''}
            </span>
          </div>
          <div className="row">
            <StatusPill status={device.health} />
            <button
              disabled={busy}
              title="Opens the connection again and re-reads what this device can do."
              onClick={onConnect}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button onClick={onEdit}>Edit</button>
            <ConfirmButton label="Remove" disabled={busy} onConfirm={onRemove} />
            <IconButton label="Close" icon={<IconClose />} onClick={onClose} />
          </div>
        </div>

        {/* Editing happens in the drawer rather than replacing the row it
          came from, so the thing being edited stays on screen. */}
        {editing && plugins ? (
          <DeviceForm plugins={plugins} device={device} onDone={onEdited} />
        ) : null}

        <TagEditor kind="device" id={device.id} tags={device.tags ?? []} onChanged={onTagged} />

        {device.lastError ? <div className="banner error">{device.lastError}</div> : null}

        <div className="row" style={{ gap: 18, marginTop: 8 }}>
          <Fact
            label="Last seen"
            value={device.lastSeenAt ? relative(device.lastSeenAt) : 'never'}
            tip="When this device last answered."
          />
          <Fact
            label="Firmware"
            value={device.capabilities?.firmware ?? '—'}
            tip="The version the device reported when it connected."
          />
          <Fact
            label="Can do"
            value={device.capabilities?.features.join(', ') || '—'}
            tip="What this model told us it supports. An event can only ask for these."
          />
        </div>

        {/* Where to go for the things this app does not do: the media on a
          deck or a switcher's drive. The plugin builds the address because
          only it knows the protocol and port. */}
        {(device.capabilities?.links ?? []).length > 0 ? (
          <div className="stack" style={{ marginTop: 10, gap: 6 }}>
            {device.capabilities!.links!.map((link) => (
              <div key={link.url} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <span style={{ minWidth: 130 }}>{link.label}</span>
                {/* A real link, so it opens wherever the browser or the OS
                  still handles the scheme. Most browsers dropped ftp://,
                  which the hint says rather than leaving a dead click, and
                  the address stays selectable for pasting elsewhere. */}
                <a className="address" href={link.url} target="_blank" rel="noreferrer">
                  {link.url}
                </a>
                <CopyButton value={link.url} />
                {link.note ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {link.note}
                  </span>
                ) : null}
              </div>
            ))}
            {/* Said once under the list rather than beside every line. */}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Most browsers no longer open ftp:// — if nothing happens, copy the address and paste
              it into Finder (Go &gt; Connect to Server) or Windows Explorer.
            </p>
          </div>
        ) : null}

        {device.nodes.length > 0 ? (
          <div className="stack" style={{ marginTop: 12, gap: 6 }}>
            {device.nodes.map((node) => (
              <NodeControls key={node.id} device={device} node={node} />
            ))}
            {/* Only where the device can actually be read. A recorder that
              cannot list its media has nothing to show, and an empty file
              browser reads as a broken one. */}
            {device.nodes
              .filter((node) => node.supports.includes('listMedia'))
              .map((node) => (
                <DeviceFiles
                  key={`${node.id}-files`}
                  deviceId={device.id}
                  nodeId={node.id}
                  timezone={browserZone}
                />
              ))}
          </div>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            Connect, and this fills in with what the device can actually do.
          </p>
        )}
      </aside>
    </>
  )
}

/**
 * Drive one node by hand.
 *
 * Collapsed until opened, and it reads the device only when it is: an
 * operator glancing at the Devices page should not set off a round trip to
 * every HyperDeck in the building.
 *
 * Every button here goes through the same verify-after-write the scheduler
 * uses, so "Stop" going green means the device really stopped rather than
 * that it accepted the command.
 */
function NodeControls({ device, node }: { device: Device; node: DeviceNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<NodeState | null>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [filename, setFilename] = useState('')
  const live = useLive()

  // Devices push their state as it changes — a deck notifies on transport
  // and slot, an ATEM on every change — so an open panel follows the box
  // without anybody pressing Read state, and without this screen polling
  // hardware that is busy recording.
  const pushed = live.nodeStates[`${device.id}/${node.id}`]
  useEffect(() => {
    if (open && pushed) setState(pushed)
  }, [open, pushed])
  const [credentialId, setCredentialId] = useState('')
  const [quality, setQuality] = useState('')
  /** Typing a figure the preset list does not offer. A mode, not a value. */
  const [typingQuality, setTypingQuality] = useState(false)
  // Only fetched for a node that can be pointed somewhere, and only once
  // the panel is open.
  const { data: credentials } = useResource(
    () =>
      open && node.supports.includes('applyStreamTarget') ? api.credentials() : Promise.resolve([]),
    [open, node.id],
  )

  const connected = device.health === 'connected' || device.health === 'degraded'

  const run = async (
    label: string,
    action: () => Promise<{ state: NodeState | null }>,
  ): Promise<void> => {
    setBusy(label)
    setError(undefined)
    try {
      setState((await action()).state)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const read = (): void => void run('read', () => api.nodeState(device.id, node.id))

  /**
   * Erase a card, asking the deck twice as its protocol requires.
   *
   * The button is armed once by the operator and the two calls go back to
   * back, so the deck's token never sits around waiting. The state is
   * re-read afterwards because the volume name and the headroom both
   * change.
   */
  /** Put the deck on a card. Read back, like every other button here. */
  const select = (slot: number): void =>
    void run(`select-${slot}`, () => api.driveNode(device.id, node.id, 'selectSlot', { slot }))

  const format = (slot: number): void => {
    setBusy(`format-${slot}`)
    setError(undefined)
    void (async () => {
      try {
        const prepared = await api.formatStorage(device.id, node.id, slot)
        if (prepared.confirm) await api.formatStorage(device.id, node.id, slot, prepared.confirm)
        setState((await api.nodeState(device.id, node.id)).state)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(undefined)
      }
    })()
  }
  const drive = (action: ManualAction): void =>
    void run(action, () =>
      api.driveNode(
        device.id,
        node.id,
        action,
        action === 'startRecording' && filename
          ? {
              filename,
              // Only where the quality box belongs to the recorder: on a
              // node that streams, the same box is part of pointing it.
              ...(quality && !canStream ? { quality } : {}),
            }
          : {},
      ),
    )

  /** Point the encoder at a saved target, with the profile if one is picked. */
  const point = (): void =>
    void run('point', () =>
      api.pointAtTarget(device.id, node.id, {
        credentialId,
        ...(quality ? { quality } : {}),
      }),
    )

  const streaming = state?.streaming
  const recording = state?.recording
  const canStream = node.supports.includes('startStreaming')
  const canRecord = node.supports.includes('startRecording')
  // Nothing here can drive this node. An ATEM's aux bus is the case: the
  // adapter can route it, but routing is a live-production control rather
  // than something the scheduler has any business touching, so there is
  // nothing to press. Showing what it is set to is still worth doing.
  const readOnly = !canStream && !canRecord
  const qualityChoices = state?.options?.quality?.choices ?? []
  // A device with no named profiles may still take a bitrate — an ATEM
  // keeps only a number, the names being a file on the computer running
  // ATEM Software Control.
  const bitrate = state?.options?.quality?.bitrate
  // A name the device takes but will not list — a deck's recording codec.
  const freeform = state?.options?.quality?.freeform
  const current = state?.options?.quality?.current
  const qualityListId = `quality-${device.id}-${node.id}`

  return (
    <details
      open={open}
      onToggle={(event) => {
        const nowOpen = (event.currentTarget as HTMLDetailsElement).open
        setOpen(nowOpen)
        if (nowOpen && state === undefined && connected) read()
      }}
    >
      <summary title="Open to see what this part of the device is doing, and to drive it by hand.">
        {node.label} <span className="muted">· {node.roles.join(', ')}</span>
      </summary>

      <div className="stack" style={{ marginTop: 10 }}>
        {!connected ? (
          <p className="muted" style={{ margin: 0 }}>
            Not connected. Press Connect above first.
          </p>
        ) : (
          <>
            {device.inUseBy.length > 0 ? (
              <div className="banner warn">
                {device.inUseBy.map((entry) => entry.label).join(', ')}{' '}
                {device.inUseBy.length === 1 ? 'is' : 'are'} mid-run on this device. Anything you do
                here the scheduler may undo at the next start or stop in its window — to end it
                properly, stop the run on its own page.
              </div>
            ) : null}

            {error ? (
              <div className="banner error">
                {error}
                {/* The most likely failure on this screen, and the message
                    alone does not say what to do about it. */}
                {/no stream target/i.test(error) ? (
                  <>
                    {' '}
                    This encoder has not been pointed anywhere yet. Put it on an event, which
                    applies the key when the event starts — a stream key never travels through this
                    screen.
                  </>
                ) : null}
              </div>
            ) : null}

            {/* Only what this node actually does. A recorder with a
                "Streaming —" line reads as broken rather than as a
                recorder. */}
            {readOnly ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing to drive here. This node{' '}
                {node.roles.includes('router')
                  ? 'routes signal'
                  : 'does neither streaming nor recording'}
                , which is the operator's job at the desk rather than the scheduler's — so this
                panel only reports what it is set to.
              </p>
            ) : null}

            {state?.input ? (
              <div
                className={state.input.present ? 'banner info' : 'banner warn'}
                style={{ marginBottom: 0 }}
              >
                {state.input.present
                  ? `Input: ${state.input.format ?? 'signal present'}${state.input.source ? ` · taking ${state.input.source}` : ''}`
                  : // A recorder with no signal refuses to record, and a deck
                    // set to the wrong socket is the usual reason. Saying both
                    // here means nobody learns it from a failed run.
                    `No signal${state.input.source ? ` on ${state.input.source}` : ' on the input'}.${
                      canRecord ? ' A recording will be refused until there is one.' : ''
                    }`}
              </div>
            ) : null}

            <div className="row" style={{ gap: 18 }}>
              {canStream ? (
                <Fact
                  label="Streaming"
                  tip="What the device says it is sending right now."
                  value={
                    streaming === undefined
                      ? '—'
                      : streaming.active
                        ? `on${streaming.bitrateBps ? ` · ${Math.round(streaming.bitrateBps / 1000)} kbps` : ''}`
                        : 'off'
                  }
                />
              ) : null}
              {canRecord ? (
                <Fact
                  label="Recording"
                  tip="What it is writing right now, and under what name."
                  value={
                    recording === undefined
                      ? '—'
                      : recording.active
                        ? (recording.filename ?? 'on')
                        : 'off'
                  }
                />
              ) : null}
              {streaming?.targetUrl ? (
                <Fact
                  label="Pointed at"
                  value={streaming.targetUrl}
                  tip="The ingest address this encoder is set to. The key itself is never shown."
                />
              ) : null}
            </div>

            {state?.recording?.slots && state.recording.slots.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th title="The card or drive in this slot.">Media</th>
                      <th title="Recording time left, at what the device is set to now.">Free</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {state.recording.slots.map((slot) => (
                      <tr key={slot.id}>
                        <td>
                          {slot.id}
                          {slot.active ? <span className="muted"> · in use</span> : null}
                        </td>
                        <td className="muted">{slot.volumeName ?? slot.status}</td>
                        <td className={lowOn(slot) ? 'bad' : 'muted'}>
                          {slot.remainingMs === undefined ? '—' : duration(slot.remainingMs)}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            {/* Which card the deck writes to, chosen on the
                                row it belongs to rather than in a dropdown
                                that repeats the same list. */}
                            {node.supports.includes('selectSlot') ? (
                              <button
                                disabled={busy !== undefined || slot.active === true}
                                title="Records to this slot from now on."
                                onClick={() => select(slot.id)}
                              >
                                {busy === `select-${slot.id}`
                                  ? 'Selecting…'
                                  : slot.active
                                    ? 'Selected'
                                    : 'Select'}
                              </button>
                            ) : null}
                            {node.supports.includes('formatStorage') ? (
                              <ConfirmButton
                                label="Format"
                                confirmLabel={`Erase slot ${slot.id}?`}
                                disabled={busy !== undefined || device.inUseBy.length > 0}
                                onConfirm={() => format(slot.id)}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {device.inUseBy.length > 0 && node.supports.includes('formatStorage') ? (
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    Formatting is off while an event is mid-run on this device.
                  </p>
                ) : null}
                {state.recording.rollover !== undefined ? (
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    {state.recording.rollover
                      ? 'When the slot in use fills, the deck rolls onto the other one by itself.'
                      : 'Nowhere to roll onto: recording stops when the slot in use fills.'}
                  </p>
                ) : null}
              </div>
            ) : null}

            {node.supports.includes('applyStreamTarget') ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                  <Field
                    label="Stream key"
                    hint="One of the saved keys, chosen by name. The key itself never reaches this screen."
                  >
                    <select
                      value={credentialId}
                      onChange={(event) => setCredentialId(event.target.value)}
                    >
                      <option value="">{LEAVE_AS_IS}</option>
                      {(credentials ?? [])
                        .filter((credential) => credential.ingestUrl)
                        .map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {/* Quality is set in the same command as the target on
                      every device that has it, so it is offered here and
                      nowhere else. */}
                  {qualityChoices.length > 0 ? (
                    <Field
                      label="Quality"
                      hint={`The presets this device offers.${nowOn(current)}`}
                    >
                      <select
                        value={typingQuality ? CUSTOM_VALUE : quality}
                        onChange={(event) => {
                          setTypingQuality(event.target.value === CUSTOM_VALUE)
                          setQuality(event.target.value === CUSTOM_VALUE ? '' : event.target.value)
                        }}
                      >
                        <option value="">{LEAVE_AS_IS}</option>
                        {qualityChoices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                        {bitrate ? <option value={CUSTOM_VALUE}>Custom…</option> : null}
                      </select>
                    </Field>
                  ) : null}
                  {bitrate && (qualityChoices.length === 0 || typingQuality) ? (
                    <Field label="Bitrate (Mb/s)" hint={bitrateHint(bitrate, current)}>
                      <input
                        value={quality}
                        placeholder={current ?? `${bitrate.minMbps}-${bitrate.maxMbps}`}
                        onChange={(event) => setQuality(event.target.value)}
                      />
                    </Field>
                  ) : null}
                  <button
                    disabled={busy !== undefined || !credentialId || device.inUseBy.length > 0}
                    onClick={point}
                  >
                    {busy === 'point' ? 'Applying…' : 'Apply to the device'}
                  </button>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {device.inUseBy.length > 0
                    ? 'Off while an event is mid-run on this device: re-pointing it would move the stream.'
                    : !credentialId
                      ? 'Pick a saved target to apply. The quality goes with it — the device takes both in ' +
                        'one command, so there is no way to send one alone.'
                      : 'Pushes the key and the quality to the device now. For a one-off: an event points ' +
                        'its own encoder when it starts, which overwrites this.'}
                </p>
              </div>
            ) : null}

            {canRecord ? (
              <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                <Field
                  label="Filename"
                  hint="Needed before a recording can start. A scheduled event names its own."
                >
                  <input
                    value={filename}
                    placeholder="2026-09-06 rehearsal"
                    onChange={(event) => setFilename(event.target.value)}
                  />
                </Field>
                {/* On a box whose encoder serves both, the recording's
                    quality is set here because there is no stream target to
                    hang it on. */}
                {!canStream && bitrate ? (
                  <Field label="Bitrate (Mb/s)" hint={bitrateHint(bitrate, current)}>
                    <input
                      value={quality}
                      placeholder={current ?? `${bitrate.minMbps}-${bitrate.maxMbps}`}
                      onChange={(event) => setQuality(event.target.value)}
                    />
                  </Field>
                ) : !canStream && freeform ? (
                  <Field label="Quality" hint={freeformHint(freeform, current)}>
                    <input
                      list={qualityListId}
                      value={quality}
                      placeholder={current ?? ''}
                      onChange={(event) => setQuality(event.target.value)}
                    />
                    <datalist id={qualityListId}>
                      {(freeform.examples ?? []).map((example) => (
                        <option key={example} value={example} />
                      ))}
                    </datalist>
                  </Field>
                ) : null}
              </div>
            ) : null}

            <div className="row">
              <button
                disabled={busy !== undefined}
                title="Asks the device what it is doing now. It also reports changes by itself while this panel is open."
                onClick={read}
              >
                {busy === 'read' ? 'Reading…' : 'Read state'}
              </button>
              {(
                [
                  ['startStreaming', 'Start streaming'],
                  ['stopStreaming', 'Stop streaming'],
                  ['startRecording', 'Start recording'],
                  ['stopRecording', 'Stop recording'],
                ] as [ManualAction, string][]
              )
                .filter(([action]) => node.supports.includes(action))
                .map(([action, label]) => (
                  <button
                    key={action}
                    className={action.startsWith('stop') ? 'danger' : ''}
                    // A recording has to be called something, and greying
                    // the button out says so better than an error does.
                    disabled={busy !== undefined || (action === 'startRecording' && !filename)}
                    onClick={() => drive(action)}
                  >
                    {busy === action ? 'Working…' : label}
                  </button>
                ))}
            </div>

            {readOnly ? null : (
              <p className="muted" style={{ margin: 0 }}>
                {canStream
                  ? 'Starting a stream sends it wherever this device is already pointed. '
                  : ''}
                Every button here is read back off the device before it reports success.
              </p>
            )}
          </>
        )}
      </div>
    </details>
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
        const created = await api.createDevice({
          pluginId,
          label: label || (plugin?.displayName ?? pluginId),
          config,
        })
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
          <Field label="Type" hint="What kind of box it is. This decides the settings below.">
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
            <button
              disabled={scanning}
              title="Looks for this kind of device on the local network and fills in what it finds."
              onClick={() => void scan()}
            >
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
          <input
            value={label}
            placeholder={plugin?.displayName ?? ''}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>

        <ConfigFields fields={plugin?.configSchema ?? []} values={config} onChange={setConfig} />

        {device ? (
          <p className="muted" style={{ margin: 0 }}>
            Passwords show as dots. Leave one alone to keep the stored password.
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

/** Less than an hour of headroom before a service is worth shouting about. */
function lowOn(slot: { remainingMs?: number }): boolean {
  return slot.remainingMs !== undefined && slot.remainingMs < 3_600_000
}
