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
  const slots = (live.nodeStates[`${deviceId}/${nodeId}`]?.recording?.slots ?? []).map(
    (entry) => entry.id,
  )
  const [chosen, setChosen] = useState<number>()
  const slot = chosen ?? slots[0]
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<'name' | 'size' | 'recorded'>('recorded')
  const [pending, setPending] = useState<{ confirm: string; files: string[] }>()
  const [result, setResult] = useState<{ removed: string[]; failed: { name: string }[] }>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const { data, error, reload } = useResource(
    () => (open ? api.media(deviceId, nodeId, slot) : Promise.resolve({ files: [] })),
    [deviceId, nodeId, slot, open],
  )

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
        subtitle="Everything on the media, including what this scheduler did not record."
        actions={
          <>
            {slots.length > 1 ? (
              <select
                value={String(slot ?? '')}
                onChange={(event) => {
                  setChosen(Number(event.target.value))
                  setPicked(new Set())
                  setResult(undefined)
                }}
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

      {!open ? (
        <p className="muted" style={{ margin: 0 }}>
          Reading a card takes a moment, so this asks only when you want it to.
        </p>
      ) : files.length === 0 ? (
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
                  setPending(await api.prepareDelete(deviceId, nodeId, names, slot))
                })
              }
            >
              Delete {picked.size > 0 ? `${picked.size} selected` : 'selected'}
            </button>
            {picked.size > 0 ? (
              <button onClick={() => setPicked(new Set())}>Clear selection</button>
            ) : null}
          </div>

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
                    <td>{file.name}</td>
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
