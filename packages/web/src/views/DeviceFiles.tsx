import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, useLive, useResource, type RemoteFile } from '../api.ts'
import { Card, ErrorBanner, Empty, PageHead } from '../components.tsx'
import { dateTimeIn, duration } from '../format.ts'

/**
 * What is on a recorder's media, and taking some of it off.
 *
 * Reads the device rather than the ledger: this screen is about the card
 * as it actually is, including everything somebody else put there with a
 * camera. Retention's view of the same card — what this scheduler
 * recorded and what a policy says about it — is a different question and
 * lives on the status screen.
 *
 * The device's own file page has no way to select several files, so
 * clearing a card after a busy month means pressing a delete icon and
 * confirming, over and over. Tick boxes and one button is the entire
 * point of this existing.
 */
export function DeviceFiles({
  deviceId,
  nodeId,
  timezone,
}: {
  deviceId: string
  nodeId: string
  timezone: string
}): ReactNode {
  // The slots come from what the device last reported, not from a prop:
  // a deck with a second card mounted mid-session should offer it without
  // the page being rebuilt around it.
  const live = useLive()
  // But the live channel only carries states the device has pushed since
  // this page opened, and a deck sitting still has no reason to push one.
  // So on a fresh load there were no slots, the card picker was hidden,
  // and it appeared only once something else made the deck emit — which
  // from the outside looks like "the selector shows up after I change
  // slots somewhere else". Asking once, on mount, is what makes it there
  // from the start; the live state still wins the moment it arrives.
  const { data: known } = useResource(
    () => api.nodeState(deviceId, nodeId).catch(() => ({ state: null })),
    [deviceId, nodeId],
  )
  const slots = (
    live.nodeStates[`${deviceId}/${nodeId}`]?.recording?.slots ??
    known?.state?.recording?.slots ??
    []
  ).map((entry) => entry.id)
  const [chosen, setChosen] = useState<number>()
  const slot = chosen ?? slots[0]
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<'name' | 'size' | 'recorded'>('recorded')
  // Undefined is "wherever the recordings are", which is where this opens
  // and what every other caller of the endpoint means. A path only ever
  // comes from a folder the device itself listed, never from us building
  // one out of names.
  const [path, setPath] = useState<string>()
  const [pending, setPending] = useState<{ confirm: string; files: string[] }>()
  const [result, setResult] = useState<{ removed: string[]; failed: { name: string }[] }>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const { data, error, reload } = useResource(
    () => (open ? api.media(deviceId, nodeId, slot, path) : Promise.resolve({ files: [] })),
    [deviceId, nodeId, slot, open, path],
  )

  const here = data?.directory
  const parent = data?.parent

  // Walking into a folder is a different list, so nothing picked on the
  // way in should still be ticked on the way out — least of all with a
  // delete button next to it.
  const goTo = (next: string | undefined): void => {
    setPicked(new Set())
    setResult(undefined)
    setPending(undefined)
    setPath(next)
  }

  const files = useMemo(() => sorted(data?.files ?? [], sort), [data, sort])
  const allPicked = files.length > 0 && files.every((file) => picked.has(file.name))

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // A path belongs to the card it came from, so choosing another card has
  // to start at the top of that one rather than asking it for a directory
  // off the previous card.
  const chooseSlot = (next: number): void => {
    goTo(undefined)
    setChosen(next)
  }

  const toggle = (name: string): void =>
    setPicked((was) => {
      const next = new Set(was)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <Card>
      <PageHead
        level={2}
        title="Files"
        subtitle={
          open
            ? 'Everything on the media, including what this scheduler did not record.'
            : 'Everything on the media, including what this scheduler did not record. Reading a card takes a moment, so this asks only when you want it to.'
        }
        actions={
          <>
            {slots.length > 1 ? (
              <select
                value={String(slot ?? '')}
                onChange={(event) => chooseSlot(Number(event.target.value))}
              >
                {slots.map((id) => (
                  <option key={id} value={String(id)}>
                    Slot {id}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              onClick={() => {
                setOpen((was) => !was)
                setPicked(new Set())
                setResult(undefined)
              }}
            >
              {open ? 'Hide' : 'Read the media'}
            </button>
          </>
        }
      />

      <ErrorBanner error={error ?? problem} />

      {!open ? null : files.length === 0 ? (
        <Empty>Nothing on this media.</Empty>
      ) : (
        <>
          {/* What is about to go, spelled out, before it goes. Ticking
              twelve boxes and pressing a button is far easier to do by
              accident than deleting twelve files one at a time. */}
          {pending ? (
            <div className="banner error">
              <strong>
                Delete {pending.files.length} file{pending.files.length === 1 ? '' : 's'}?
              </strong>
              <div style={{ margin: '4px 0 8px' }}>{pending.files.join(', ')}</div>
              <div className="row">
                <button
                  className="danger solid"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const done = await api.confirmDelete(
                        deviceId,
                        nodeId,
                        pending.files,
                        pending.confirm,
                        slot,
                        path,
                      )
                      setResult(done)
                      setPending(undefined)
                      setPicked(new Set())
                      reload()
                    })
                  }
                >
                  {busy ? 'Removing…' : 'Yes, delete'}
                </button>
                <button disabled={busy} onClick={() => setPending(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {result ? (
            <div className="banner info">
              Removed {result.removed.length}
              {result.failed.length > 0 ? `, ${result.failed.length} refused` : ''}.
            </div>
          ) : null}

          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="danger"
              disabled={picked.size === 0 || busy || pending !== undefined}
              onClick={() =>
                void run(async () => {
                  const names = files.map((f) => f.name).filter((name) => picked.has(name))
                  setPending(await api.prepareDelete(deviceId, nodeId, names, slot, path))
                })
              }
            >
              Delete {picked.size > 0 ? `${picked.size} selected` : 'selected'}
            </button>
            {picked.size > 0 ? (
              <button onClick={() => setPicked(new Set())}>Clear selection</button>
            ) : null}
          </div>

          {/* Where this listing came from, and the way back out of it.
              Only shown once the device has said — nothing here invents a
              path, because the shape of them belongs to the device's own
              file server and not to this screen. */}
          {here === undefined ? null : (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button
                disabled={busy || parent === undefined}
                title={
                  parent === undefined
                    ? 'This is the top of what the device serves.'
                    : `Up to ${parent}`
                }
                onClick={() => goTo(parent)}
              >
                ↑ Up
              </button>
              <code className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {here}
              </code>
              {path === undefined ? null : (
                <button disabled={busy} onClick={() => goTo(undefined)}>
                  Back to the recordings
                </button>
              )}
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={allPicked}
                      aria-label={allPicked ? 'Select none' : 'Select all'}
                      title={allPicked ? 'Select none' : 'Select all'}
                      onChange={() =>
                        setPicked(allPicked ? new Set() : new Set(files.map((f) => f.name)))
                      }
                    />
                  </th>
                  <SortHeader label="Name" by="name" sort={sort} onSort={setSort} />
                  <SortHeader label="Size" by="size" sort={sort} onSort={setSort} />
                  <SortHeader label="Recorded" by="recorded" sort={sort} onSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.name} className={picked.has(file.name) ? 'is-picked' : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(file.name)}
                        aria-label={`Select ${file.name}`}
                        onChange={() => toggle(file.name)}
                      />
                    </td>
                    <td>
                      {/* A folder is still selectable — an ATEM's ISO
                          recording is one and deleting it is the point —
                          but it is also a place, so the name opens it. */}
                      {file.isFolder && here !== undefined ? (
                        <button
                          className="linkish"
                          disabled={busy}
                          title={`Open ${file.name}`}
                          onClick={() =>
                            goTo(here === '/' ? `/${file.name}` : `${here}/${file.name}`)
                          }
                        >
                          {file.name}
                          <span aria-hidden="true"> ›</span>
                        </button>
                      ) : (
                        file.name
                      )}
                    </td>
                    <td className="muted">{file.bytes === undefined ? '—' : bytes(file.bytes)}</td>
                    <td className="muted">
                      {file.recordedAt === undefined ? '—' : dateTimeIn(file.recordedAt, timezone)}
                      {file.durationMs === undefined ? '' : ` · ${duration(file.durationMs)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

function SortHeader({
  label,
  by,
  sort,
  onSort,
}: {
  label: string
  by: 'name' | 'size' | 'recorded'
  sort: string
  onSort: (next: 'name' | 'size' | 'recorded') => void
}): ReactNode {
  return (
    <th>
      <button className="link" aria-pressed={sort === by} onClick={() => onSort(by)}>
        {label}
        {sort === by ? ' ↓' : ''}
      </button>
    </th>
  )
}

/** Newest, largest or alphabetical — the three ways anybody looks for a file. */
function sorted(files: RemoteFile[], by: 'name' | 'size' | 'recorded'): RemoteFile[] {
  const out = [...files]
  if (by === 'name') return out.sort((a, b) => a.name.localeCompare(b.name))
  if (by === 'size') return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  return out.sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0))
}

/** The device's own units: a card is talked about in GB, not bytes. */
function bytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${Math.round(value / 1e3)} kB`
  return `${value} B`
}
