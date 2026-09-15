import type { Db } from '../db/index.js'

/**
 * Labels somebody puts on things.
 *
 * Deliberately the thinnest thing that could work. A tag is its text —
 * there is no tag table, no colours, no hierarchy, no rename. A tag
 * nobody has put on anything should stop existing, and that falls out for
 * free when the only record of a tag is its use.
 *
 * Matched case-insensitively, stored as typed. "Sanctuary" and
 * "sanctuary" are one tag that two people spelled differently, and a
 * filter that misses half a rack over a capital letter is worse than no
 * filter. The spelling kept is the one most recently written, because the
 * alternative is arguing about whose capitalisation wins.
 */

/** What can carry tags. Not constrained in the database: a new kind of
 *  taggable thing should not need a migration. */
export type TaggableKind = 'device' | 'series'

/** Long enough to be a phrase, short enough to stay a label. */
export const MAX_TAG_LENGTH = 40

export class Tags {
  private readonly db: Db

  constructor(init: { db: Db }) {
    this.db = init.db
  }

  /** Everything on one thing, alphabetical so the order never surprises. */
  forResource(kind: TaggableKind, id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT tag FROM tag WHERE resource_kind = ? AND resource_id = ?
            ORDER BY tag COLLATE NOCASE`,
        )
        .all(kind, id) as { tag: string }[]
    ).map((row) => row.tag)
  }

  /**
   * Every tag on a kind of thing, with how many carry it.
   *
   * What a filter control is built from: the list is the tags that exist,
   * because a tag exists only by being used.
   */
  known(kind: TaggableKind): { tag: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT tag, COUNT(*) AS count FROM tag WHERE resource_kind = ?
          GROUP BY tag COLLATE NOCASE
          ORDER BY tag COLLATE NOCASE`,
      )
      .all(kind) as { tag: string; count: number }[]
  }

  /** Tags for several things at once, so a list does not query per row. */
  forMany(kind: TaggableKind, ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (ids.length === 0) return out

    const rows = this.db
      .prepare(
        `SELECT resource_id, tag FROM tag
          WHERE resource_kind = ? AND resource_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY tag COLLATE NOCASE`,
      )
      .all(kind, ...ids) as { resource_id: string; tag: string }[]

    for (const row of rows) {
      const list = out.get(row.resource_id) ?? []
      list.push(row.tag)
      out.set(row.resource_id, list)
    }
    return out
  }

  /**
   * Replaces everything on one thing.
   *
   * Set rather than add-and-remove: the UI edits a whole list, and two
   * calls to reach one state is a state that can be half-reached.
   */
  set(kind: TaggableKind, id: string, tags: string[], at: number): string[] {
    const cleaned = normalize(tags)
    const replace = this.db.transaction((values: string[]) => {
      this.db.prepare('DELETE FROM tag WHERE resource_kind = ? AND resource_id = ?').run(kind, id)
      const insert = this.db.prepare(
        'INSERT INTO tag (resource_kind, resource_id, tag, created_at) VALUES (?, ?, ?, ?)',
      )
      for (const tag of values) insert.run(kind, id, tag, at)
    })
    replace(cleaned)
    return cleaned
  }

  /** Called when the thing itself goes, so its tags do not outlive it. */
  clear(kind: TaggableKind, id: string): void {
    this.db.prepare('DELETE FROM tag WHERE resource_kind = ? AND resource_id = ?').run(kind, id)
  }
}

/**
 * Trimmed, de-duplicated case-insensitively, and capped.
 *
 * Exported because the API validates with it too: what is stored and what
 * is accepted should be decided in one place, or they drift.
 */
export function normalize(tags: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '') continue
    // Last spelling wins, so correcting a capital is a matter of retyping
    // it rather than deleting and re-adding.
    seen.set(tag.toLocaleLowerCase(), tag)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
