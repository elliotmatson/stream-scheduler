import { useEffect } from 'react'

/**
 * Forms with changes nobody has saved yet, so leaving can ask first.
 *
 * Each form says whether it is dirty; this keeps the set. Closing the tab
 * asks through the browser's own prompt, and moving to another screen in
 * the app asks through `confirmLeave`, which the router calls before it
 * moves.
 */
const dirty = new Set<symbol>()

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.size === 0) return
  event.preventDefault()
  // Older browsers want a value here before they will show the prompt.
  event.returnValue = ''
}

/** Marks a form as having unsaved changes while `isDirty` is true. */
export function useUnsavedGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return
    const token = Symbol('unsaved')
    dirty.add(token)
    if (dirty.size === 1) window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      dirty.delete(token)
      if (dirty.size === 0) window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [isDirty])
}

/** True when it is fine to move on: nothing is unsaved, or the user said so. */
export function confirmLeave(): boolean {
  if (dirty.size === 0) return true
  return window.confirm('You have changes that are not saved. Leave without saving them?')
}

/** The keys of two flat objects whose values differ. */
export function changedKeys<T extends object>(before: T, after: T): (keyof T)[] {
  return (Object.keys(after) as (keyof T)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
}

/** "1 change", "3 changes". */
export function changesLabel(count: number): string {
  return `${count} change${count === 1 ? '' : 's'}`
}
