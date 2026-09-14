/**
 * Every time source goes through this interface. Nothing in the scheduler calls
 * `Date.now()` directly, so tests can fast-forward through DST transitions,
 * leap days and machine-sleep gaps. See docs/plan/03-scheduling-engine.md.
 */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** A clock tests drive by hand. */
export class ManualClock implements Clock {
  private current: number

  constructor(start: number | string | Date = 0) {
    this.current = typeof start === 'number' ? start : new Date(start).getTime()
  }

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }

  set(to: number | string | Date): void {
    this.current = typeof to === 'number' ? to : new Date(to).getTime()
  }
}
