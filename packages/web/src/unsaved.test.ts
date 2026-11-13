import { describe, expect, it } from 'vitest'
import { changedKeys, changesLabel } from './unsaved.ts'

describe('what has changed since the last save', () => {
  it('names only the fields that differ', () => {
    expect(changedKeys({ label: 'A', minutes: 90 }, { label: 'B', minutes: 90 })).toEqual(['label'])
  })

  it('compares lists by what is in them, not by which list it is', () => {
    expect(changedKeys({ byday: ['SU'] }, { byday: ['SU'] })).toEqual([])
    expect(changedKeys({ byday: ['SU'] }, { byday: ['SU', 'WE'] })).toEqual(['byday'])
  })

  it('counts them the way the button says it', () => {
    expect(changesLabel(1)).toBe('1 change')
    expect(changesLabel(3)).toBe('3 changes')
  })
})
