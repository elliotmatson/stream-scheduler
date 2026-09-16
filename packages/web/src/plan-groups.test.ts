import { describe, expect, it } from 'vitest'
import { byFolder } from './plan-groups.ts'

/**
 * Grouping service types by their folder.
 *
 * Small, but the thing it prevents is not: a church with thirty service
 * types has them in folders precisely because several are called "9:00",
 * and a flat list of those cannot be picked from correctly. Getting the
 * grouping wrong puts the wrong service on air.
 */

const group = (id: string, name: string, path?: string[]) => ({
  id,
  name,
  ...(path === undefined ? {} : { path }),
})

describe('grouping by folder', () => {
  it('puts service types under the folder they came from', () => {
    expect(
      byFolder([
        group('1', 'Sunday Morning', ['Sunday']),
        group('2', 'Sunday Evening', ['Sunday']),
      ]),
    ).toEqual([
      {
        label: 'Sunday',
        groups: [
          group('1', 'Sunday Morning', ['Sunday']),
          group('2', 'Sunday Evening', ['Sunday']),
        ],
      },
    ])
  })

  it('reads a nested folder as one heading, however deep it goes', () => {
    // optgroup only nests one level, so the whole path becomes the label
    // rather than the deepest folder alone — "Youth" on its own would lose
    // which Youth it is.
    const buckets = byFolder([group('1', 'Students', ['Midweek', 'Youth'])])
    expect(buckets[0]?.label).toBe('Midweek / Youth')
  })

  it('leaves a top-level service type ungrouped', () => {
    const buckets = byFolder([group('1', 'Midweek')])
    expect(buckets).toEqual([{ label: '', groups: [group('1', 'Midweek')] }])
  })

  it('keeps the order the source gave, rather than sorting', () => {
    // Planning Center returns them in the order the church arranged them.
    // Sorting alphabetically would throw that away.
    const buckets = byFolder([
      group('1', 'Zulu', ['Sunday']),
      group('2', 'Alpha', ['Sunday']),
      group('3', 'Loose'),
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Sunday', ''])
    expect(buckets[0]?.groups.map((entry) => entry.name)).toEqual(['Zulu', 'Alpha'])
  })

  it('gathers a folder split across the list into one heading', () => {
    // Two service types in the same folder, with another folder's between
    // them, must not produce that folder's heading twice.
    const buckets = byFolder([
      group('1', 'Morning', ['Sunday']),
      group('2', 'Students', ['Midweek']),
      group('3', 'Evening', ['Sunday']),
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Sunday', 'Midweek'])
    expect(buckets[0]?.groups.map((entry) => entry.name)).toEqual(['Morning', 'Evening'])
  })

  it('keeps two identically named service types apart by their folder', () => {
    // The case the whole feature exists for.
    const buckets = byFolder([
      group('1', '9:00', ['Main Auditorium']),
      group('2', '9:00', ['Chapel']),
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Main Auditorium', 'Chapel'])
  })

  it('has nothing to show for nothing', () => {
    expect(byFolder([])).toEqual([])
  })
})
