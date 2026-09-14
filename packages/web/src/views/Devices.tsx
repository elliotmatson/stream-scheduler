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
import { Card, ConfigFields, ConfirmButton, CopyButton, Empty, ErrorBanner, Field, StatusPill } from '../components.tsx'
import { duration, relative } from '../format.ts'

export function Devices(): ReactNode {
  const { data, error, reload } = useResource(() => api.devices(), [])
  // Health and what is in use change without anybody pressing anything.
  useLiveRefresh(reload)
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

      {/* Where to go for the things this app does not do: a deck's media
          over FTP, say. The plugin builds the address because only it knows
          the protocol and port; this just shows it and makes it copyable,
          since browsers no longer open ftp:// themselves. */}
      {(device.capabilities?.links ?? []).length > 0 ? (
        <div className="stack" style={{ marginTop: 10, gap: 6 }}>
          {device.capabilities!.links!.map((link) => (
            <div key={link.url} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span style={{ minWidth: 130 }}>{link.label}</span>
              <code className="address">{link.url}</code>
              <CopyButton value={link.url} />
              {link.note ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {link.note}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {device.nodes.length > 0 ? (
        <div className="stack" style={{ marginTop: 12, gap: 6 }}>
          {device.nodes.map((node) => (
            <NodeControls key={node.id} device={device} node={node} />
          ))}
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
  // Only fetched for a node that can be pointed somewhere, and only once
  // the panel is open.
  const { data: credentials } = useResource(
    () => (open && node.supports.includes('applyStreamTarget') ? api.credentials() : Promise.resolve([])),
    [open, node.id],
  )

  const connected = device.health === 'connected' || device.health === 'degraded'

  const run = async (label: string, action: () => Promise<{ state: NodeState | null }>): Promise<void> => {
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
      <summary>
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
                {device.inUseBy.length === 1 ? 'is' : 'are'} mid-run on this device. Anything you do here the
                scheduler may undo at the next start or stop in its window — to end it properly, stop the run
                on its own page.
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
                    This encoder has not been pointed anywhere yet. Put it on an event, which applies the key
                    when the event starts — a stream key never travels through this screen.
                  </>
                ) : null}
              </div>
            ) : null}

            {/* Only what this node actually does. A recorder with a
                "Streaming —" line reads as broken rather than as a
                recorder. */}
            {readOnly ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing to drive here. This node {node.roles.includes('router') ? 'routes signal' : 'does neither streaming nor recording'}, which is
                the operator's job at the desk rather than the scheduler's — so this panel only reports what it
                is set to.
              </p>
            ) : null}

            {state?.input ? (
              <div className={state.input.present ? 'banner info' : 'banner warn'} style={{ marginBottom: 0 }}>
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

            {state?.routing && Object.keys(state.routing).length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(state.routing).map(([output, source]) => (
                      <tr key={output}>
                        <td>{output}</td>
                        <td className="muted">{source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="row" style={{ gap: 18 }}>
              {canStream ? (
                <Fact
                  label="Streaming"
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
                  value={
                    recording === undefined ? '—' : recording.active ? (recording.filename ?? 'on') : 'off'
                  }
                />
              ) : null}
              {streaming?.targetUrl ? <Fact label="Pointed at" value={streaming.targetUrl} /> : null}
            </div>

            {state?.recording?.slots && state.recording.slots.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>Media</th>
                      <th>Free</th>
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
                      ? 'Rolls onto the other slot when this one fills.'
                      : 'Nowhere to roll onto: recording stops when this slot fills.'}
                  </p>
                ) : null}
              </div>
            ) : null}

            {node.supports.includes('applyStreamTarget') ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                  <Field
                    label="Stream target"
                    hint="A saved key, chosen by name. The key itself stays on the server."
                  >
                    <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
                      <option value="">Leave as it is</option>
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
                    <Field label="Quality" hint={current ? `Now on ${current}.` : undefined}>
                      <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                        <option value="">Leave as it is</option>
                        {qualityChoices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : bitrate ? (
                    <Field
                      label="Bitrate (Mb/s)"
                      hint={`${bitrate.minMbps}–${bitrate.maxMbps}, or a low-high range.${current ? ` Now on ${current}.` : ''}`}
                    >
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
                    {busy === 'point' ? 'Pointing…' : 'Point at it'}
                  </button>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {device.inUseBy.length > 0
                    ? 'Re-pointing is off while an event is mid-run on this device.'
                    : 'For a one-off. An event points its own encoder when it starts, which overwrites this.'}
                </p>
              </div>
            ) : null}

            {canRecord ? (
              <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                <Field label="Recording name" hint="Needed before a recording can start. Named by you, not by us.">
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
                  <Field
                    label="Bitrate (Mb/s)"
                    hint={`${bitrate.note ? `${bitrate.note} ` : ''}Now on ${current ?? 'whatever it was set to'}.`}
                  >
                    <input
                      value={quality}
                      placeholder={current ?? `${bitrate.minMbps}-${bitrate.maxMbps}`}
                      onChange={(event) => setQuality(event.target.value)}
                    />
                  </Field>
                ) : !canStream && freeform ? (
                  <Field
                    label="Quality"
                    hint={`${freeform.note ? `${freeform.note} ` : ''}Now on ${current ?? 'whatever it was set to'}. The list is a suggestion; the deck refuses a codec it does not have.`}
                  >
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
              <button disabled={busy !== undefined} onClick={read}>
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
                {canStream ? 'Starting a stream sends it wherever this device is already pointed. ' : ''}
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

/** Less than an hour of headroom before a service is worth shouting about. */
function lowOn(slot: { remainingMs?: number }): boolean {
  return slot.remainingMs !== undefined && slot.remainingMs < 3_600_000
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
