/**
 * Wording that more than one screen uses.
 *
 * The same setting is offered on an event's output and on the device panel,
 * and when the two screens explained it in their own words they drifted:
 * one said "Between 3 and 70", the other "3–70". Saying it once is the only
 * way that stays fixed.
 */

/** The dropdown entry that changes nothing on the device. */
export const LEAVE_AS_IS = 'Leave as it is'

/** The dropdown entry that opens a box for a figure the list does not offer. */
export const CUSTOM_VALUE = '__custom__'

/** Nothing chosen yet, in a picker that needs an answer. */
export const PICK_ONE = '— pick one —'

/** What a device is set to now, for a hint that has room for it. */
export function nowOn(current: string | undefined): string {
  return current ? ` Now on ${current}.` : ''
}

export function bitrateHint(
  bitrate: { minMbps: number; maxMbps: number; note?: string },
  current?: string,
): string {
  return `${bitrate.note ? `${bitrate.note} ` : ''}${bitrate.minMbps}–${bitrate.maxMbps} Mb/s, or a low-high range such as 6-9.${nowOn(current)}`
}

export function freeformHint(freeform: { note?: string }, current?: string): string {
  return `${freeform.note ? `${freeform.note} ` : ''}The list is a suggestion — the device has its own set and refuses one it does not have.${nowOn(current)}`
}

/** What each status means, for the tooltip on its pill. */
const STATUS_MEANINGS: Record<string, string> = {
  scheduled: 'Waiting for its time.',
  pending: 'Waiting for its time.',
  preparing: 'Creating the broadcast and pointing the encoders at it.',
  ready: 'Prepared. Waiting to go on air.',
  running: 'On air. Its streams and recordings come and go inside the window.',
  live: 'On air now.',
  completing: 'Stopping its streams and recordings.',
  completed: 'Finished, with nothing left to do.',
  done: 'Finished.',
  waiting: 'Has not started yet.',
  failed: 'Something went wrong. The timeline says what.',
  cancelled: 'Stopped by hand before it finished.',
  skipped: 'Told not to run this time.',
  off: 'Set up, but switched off.',
  connected: 'Reachable, and answering.',
  streaming: 'Sending a stream right now.',
  recording: 'Writing to its card right now.',
  'streaming and recording': 'Doing both at once.',
  idle: 'Reachable, and doing nothing.',
  unreachable: 'Not answering. Nothing can be started on it.',
  degraded: 'Answering, but not everything works.',
  disconnected: 'Not reachable.',
  unknown: 'Not asked yet.',
  ok: 'Working.',
  reauth_required: 'Signed out. Connect it again before it can stream.',
}

export function describeStatus(status: string): string | undefined {
  return STATUS_MEANINGS[status]
}
