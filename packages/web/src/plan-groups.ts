import type { PlanGroup } from './api.ts'

/**
 * Service types grouped by the folder they live in.
 *
 * `<optgroup>` is the native answer and only nests one level, while folders
 * nest as deep as somebody wants — so the whole path becomes the heading:
 * "Midweek / Youth". That reads correctly at any depth and stays a plain
 * select, which matters more here than a tree would: this is a field on a
 * form, used once, on a phone as often as not.
 *
 * Order is the source's, not alphabetical. Planning Center returns them in
 * the order the church arranged them, and re-sorting would throw that away.
 */
export function byFolder(groups: PlanGroup[]): { label: string; groups: PlanGroup[] }[] {
  const out: { label: string; groups: PlanGroup[] }[] = []
  const byLabel = new Map<string, { label: string; groups: PlanGroup[] }>()

  for (const group of groups) {
    const label = (group.path ?? []).join(' / ')
    let bucket = byLabel.get(label)
    if (!bucket) {
      bucket = { label, groups: [] }
      byLabel.set(label, bucket)
      out.push(bucket)
    }
    bucket.groups.push(group)
  }
  return out
}
