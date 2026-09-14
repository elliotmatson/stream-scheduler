import type { Db } from '../db/index.js'
import { deviceFor, outputsForSeries, type EventOutput } from './outputs.js'

export interface OutputConflict {
  deviceLabel: string
  first: { id: string; label: string }
  second: { id: string; label: string }
  /** Milliseconds from the event's window start, so it reads the same way
   *  the editor does. */
  from: number
  to: number
}

/**
 * Finds outputs that would need the same hardware at the same time.
 *
 * A Blackmagic encoder holds one stream target and pushes one stream. Point
 * it at a second service while it is live and the first one drops — the
 * device accepts the command and says nothing, which is exactly the class
 * of failure that only shows up on a Sunday. Two YouTube channels at once
 * needs a relay in front of the encoder, which this does not have yet, so
 * the honest thing is to say so at the point the event is saved rather than
 * to pretend and fail live.
 *
 * Recordings on separate hardware do not conflict with anything, which is
 * why the check is per device and not per event.
 */
export function findOverlaps(
  outputs: EventOutput[],
  source: { deviceId: string | null; nodeId: string | null },
  labelFor: (deviceId: string) => string,
): OutputConflict[] {
  const enabled = outputs.filter((output) => output.enabled)
  const conflicts: OutputConflict[] = []

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i]!
      const b = enabled[j]!
      const deviceA = deviceFor(a, source)
      const deviceB = deviceFor(b, source)
      if (!deviceA || !deviceB) continue
      if (deviceA.deviceId !== deviceB.deviceId || deviceA.nodeId !== deviceB.nodeId) continue

      // A recording and a stream can share one device: a Web Presenter
      // records to USB while it streams. Two of the same cannot.
      if (a.kind !== b.kind) continue

      const from = Math.max(a.offsetMs, b.offsetMs)
      const to = Math.min(a.offsetMs + a.durationMs, b.offsetMs + b.durationMs)
      if (to <= from) continue

      conflicts.push({
        deviceLabel: labelFor(deviceA.deviceId),
        first: { id: a.id, label: a.label },
        second: { id: b.id, label: b.label },
        from,
        to,
      })
    }
  }
  return conflicts
}

/** The same check against what is stored, for the API and pre-flight. */
export function overlapsForSeries(db: Db, seriesId: string): OutputConflict[] {
  const series = db
    .prepare('SELECT source_device_id, source_node_id FROM event_series WHERE id = ?')
    .get(seriesId) as { source_device_id: string | null; source_node_id: string | null } | undefined
  if (!series) return []

  return findOverlaps(
    outputsForSeries(db, seriesId),
    { deviceId: series.source_device_id, nodeId: series.source_node_id },
    (deviceId) => {
      const row = db.prepare('SELECT label FROM device WHERE id = ?').get(deviceId) as
        | { label: string }
        | undefined
      return row?.label ?? `device ${deviceId}`
    },
  )
}

/** One line a human can act on. */
export function describeConflict(conflict: OutputConflict): string {
  return (
    `"${conflict.first.label}" and "${conflict.second.label}" both need ${conflict.deviceLabel} for ` +
    `${describeSpan(conflict.from, conflict.to)}. It can only do one at a time, so one of them will drop ` +
    'the other. Move one, or give it its own encoder.'
  )
}

function describeSpan(from: number, to: number): string {
  return `${describeOffset(from)} to ${describeOffset(to)} into the event`
}

function describeOffset(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`
}
