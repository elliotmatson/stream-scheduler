import type { Db } from '../db/index.js'
import { deviceFor, outputsForSeries, type EventOutput } from './outputs.js'

export interface OutputConflict {
  /** `device` is two outputs wanting the transport; `setting` is two
   *  wanting it configured differently; `destination` is two wanting one
   *  service's single ingest at once. */
  kind?: 'device' | 'setting' | 'destination'
  /** The thing being fought over: a device, or a destination. */
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
  labelFor: (deviceId: string) => string,
): OutputConflict[] {
  const enabled = outputs.filter((output) => output.enabled)
  const conflicts: OutputConflict[] = []

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i]!
      const b = enabled[j]!
      const deviceA = deviceFor(a)
      const deviceB = deviceFor(b)
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
        kind: 'device',
      })
    }
  }
  return conflicts
}

/**
 * Outputs that would need one device set two ways at once.
 *
 * A different clash from an overlap: these are not fighting over the
 * transport, they are fighting over a setting. An ATEM encodes streaming
 * and recording through one encoder at one quality, so a 9:00 service
 * asking for one profile while a recording asks for another cannot both be
 * honoured — whichever is applied last wins, and silently.
 *
 * Checked per device rather than per node for exactly that reason: the
 * contention is in the box, not in the node.
 */
export function findSettingConflicts(
  outputs: EventOutput[],
  labelFor: (deviceId: string) => string,
): OutputConflict[] {
  const enabled = outputs.filter((output) => output.enabled && output.settings.quality)
  const conflicts: OutputConflict[] = []

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i]!
      const b = enabled[j]!
      if (!a.deviceId || a.deviceId !== b.deviceId) continue
      if (a.settings.quality === b.settings.quality) continue

      const from = Math.max(a.offsetMs, b.offsetMs)
      const to = Math.min(a.offsetMs + a.durationMs, b.offsetMs + b.durationMs)
      if (to <= from) continue

      conflicts.push({
        kind: 'setting',
        deviceLabel: labelFor(a.deviceId),
        first: { id: a.id, label: a.label },
        second: { id: b.id, label: b.label },
        from,
        to,
      })
    }
  }
  return conflicts
}

/**
 * Outputs that would push to one service at the same moment.
 *
 * A destination that reuses one ingestion stream has exactly one key, and
 * every broadcast on that channel is bound to it. Two events live at once
 * are then two encoders pushing the same key, which is not a thing that
 * works: one of them loses. It is invisible until it happens, because both
 * broadcasts are created quite happily.
 *
 * Only reported where the destination really does share one stream. Turn
 * that off and each event gets a key of its own, and this stops being a
 * clash this app can see — YouTube's own limit on concurrent streams still
 * applies, and that is between the operator and the service.
 *
 * Skipped when the two already clash over a device: it is the same pair of
 * outputs and the more fundamental problem, and saying it twice is noise.
 */
export function findDestinationConflicts(
  outputs: EventOutput[],
  destinationFor: (id: string) => { label: string; sharesOneStream: boolean } | undefined,
): OutputConflict[] {
  const enabled = outputs.filter((output) => output.enabled && output.destinationId)
  const conflicts: OutputConflict[] = []

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i]!
      const b = enabled[j]!
      if (a.destinationId !== b.destinationId) continue

      const destination = destinationFor(a.destinationId!)
      if (!destination?.sharesOneStream) continue

      const deviceA = deviceFor(a)
      const deviceB = deviceFor(b)
      if (
        deviceA &&
        deviceB &&
        deviceA.deviceId === deviceB.deviceId &&
        deviceA.nodeId === deviceB.nodeId
      ) {
        continue
      }

      const from = Math.max(a.offsetMs, b.offsetMs)
      const to = Math.min(a.offsetMs + a.durationMs, b.offsetMs + b.durationMs)
      if (to <= from) continue

      conflicts.push({
        kind: 'destination',
        deviceLabel: destination.label,
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
  const outputs = outputsForSeries(db, seriesId)
  const labelFor = (deviceId: string): string => {
    const row = db.prepare('SELECT label FROM device WHERE id = ?').get(deviceId) as
      { label: string } | undefined
    return row?.label ?? `device ${deviceId}`
  }
  const destinationFor = (
    destinationId: string,
  ): { label: string; sharesOneStream: boolean } | undefined => {
    const row = db
      .prepare('SELECT label, config FROM destination WHERE id = ?')
      .get(destinationId) as { label: string; config: string } | undefined
    if (!row) return undefined
    const config = JSON.parse(row.config) as { reusableStream?: unknown }
    // Absent means on: it is the default, and the one that shares a key.
    return { label: row.label, sharesOneStream: config.reusableStream !== false }
  }

  return [
    ...findOverlaps(outputs, labelFor),
    ...findSettingConflicts(outputs, labelFor),
    ...findDestinationConflicts(outputs, destinationFor),
  ]
}

/** One line a human can act on. */
export function describeConflict(conflict: OutputConflict): string {
  const when = describeSpan(conflict.from, conflict.to)
  if (conflict.kind === 'destination') {
    return (
      `"${conflict.first.label}" and "${conflict.second.label}" both stream to ${conflict.deviceLabel} ` +
      `while both are running, ${when}. That destination reuses one ingestion stream, so both are pushing ` +
      'the same key and one of them will lose. Turn off "Reuse one ingestion stream" on the destination to ' +
      'give each event its own key, or send one of them to a different channel.'
    )
  }
  if (conflict.kind === 'setting') {
    return (
      `"${conflict.first.label}" and "${conflict.second.label}" ask ${conflict.deviceLabel} for different ` +
      `quality settings while both are running, ${when}. One box encodes both, so whichever is applied ` +
      'last wins and the other gets it silently. Match them, or move one onto its own hardware.'
    )
  }
  return (
    `"${conflict.first.label}" and "${conflict.second.label}" both need ${conflict.deviceLabel} for ` +
    `${when}. It can only do one at a time, so one of them will drop the other. Move one, or give it ` +
    'its own encoder.'
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
