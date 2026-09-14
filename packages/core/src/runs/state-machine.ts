/**
 * The run lifecycle from docs/plan/03-scheduling-engine.md.
 *
 *   scheduled -> preparing -> ready -> running -> completing -> completed
 *   (any non-terminal) -> failed | cancelled
 *
 * `running` is one state covering the whole event window, not a moment. An
 * event has several outputs inside that window — two services streaming to
 * two channels each, a recorder running the length of the morning — and
 * they go on and come off on their own clocks. There is no single instant
 * at which the run is "live", so the states that used to claim there was
 * (`starting`, `live`, `stopping`) are gone. What each output is doing is
 * read from its own steps instead.
 */
export const RUN_STATES = [
  'scheduled',
  'preparing',
  'ready',
  'running',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const

export type RunState = (typeof RUN_STATES)[number]

export const TERMINAL_STATES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly RunState[]

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state)
}

/**
 * True once outputs may have been told to go.
 *
 * Only says the run has entered its window: whether anything is *actually*
 * on air is per-output, and the engine reads that from the step records.
 * Abandoning a run in one of these states has to run stop steps rather than
 * just marking the row.
 */
export function isOnAir(state: RunState): boolean {
  return state === 'running' || state === 'completing'
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  scheduled: ['preparing', 'failed', 'cancelled'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['running', 'completing', 'failed', 'cancelled'],
  // Self-transition is allowed: the run sits here for the length of the
  // window while outputs start and stop beneath it.
  running: ['running', 'completing', 'failed', 'cancelled'],
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

/**
 * Work is grouped into phases. `prepare` and `complete` happen once for the
 * whole event; `start` and `stop` happen once per output, each on its own
 * clock, which is why a phase no longer maps to a single run state.
 */
export const RUN_PHASES = ['prepare', 'start', 'stop', 'complete'] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/** The state a run occupies while a phase's steps run, and where it lands. */
export const PHASE_STATES: Record<RunPhase, { during: RunState; after: RunState }> = {
  prepare: { during: 'preparing', after: 'ready' },
  start: { during: 'running', after: 'running' },
  stop: { during: 'running', after: 'running' },
  complete: { during: 'completing', after: 'completed' },
}
