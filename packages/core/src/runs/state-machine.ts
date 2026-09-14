/**
 * The run lifecycle from docs/plan/03-scheduling-engine.md.
 *
 *   scheduled -> preparing -> ready -> starting -> live -> stopping
 *                                                          -> completing -> completed
 *   (any non-terminal) -> failed | cancelled
 */
export const RUN_STATES = [
  'scheduled',
  'preparing',
  'ready',
  'starting',
  'live',
  'stopping',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const

export type RunState = (typeof RUN_STATES)[number]

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly RunState[]

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state)
}

/** True once the encoder has been told to go: stopping needs real work. */
export function isOnAir(state: RunState): boolean {
  return state === 'starting' || state === 'live' || state === 'stopping'
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  scheduled: ['preparing', 'failed', 'cancelled'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['starting', 'failed', 'cancelled'],
  starting: ['live', 'failed', 'cancelled'],
  live: ['stopping', 'failed', 'cancelled'],
  stopping: ['completing', 'failed', 'cancelled'],
  completing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to)
}

export class InvalidTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`A run cannot move from "${from}" to "${to}".`)
    this.name = 'InvalidTransitionError'
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

/** Work is grouped into phases, each gated on the clock. */
export const RUN_PHASES = ['prepare', 'start', 'stop', 'complete'] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/** The state a run occupies while a phase's steps are executing, and the one
 *  it lands in when they all succeed. */
export const PHASE_STATES: Record<RunPhase, { during: RunState; after: RunState }> = {
  prepare: { during: 'preparing', after: 'ready' },
  start: { during: 'starting', after: 'live' },
  stop: { during: 'stopping', after: 'completing' },
  complete: { during: 'completing', after: 'completed' },
}
