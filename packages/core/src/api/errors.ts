import type { Db } from '../db/index.js'

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** Something is still using it. Says what, so the user can go and unpick it. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

/**
 * Refuses to delete something an event's outputs still point at.
 *
 * The foreign keys would raise this anyway, as an opaque SQLITE_CONSTRAINT.
 * Naming the events that depend on it is the difference between a fixable
 * mistake and a puzzle.
 */
export function assertUnreferenced(
  db: Db,
  column: 'credential_id' | 'destination_id' | 'device_id',
  id: string,
  noun: string,
): void {
  const users = db
    .prepare(
      `SELECT DISTINCT s.label AS label
         FROM event_output o JOIN event_series s ON s.id = o.series_id
        WHERE o.${column} = ?
        ORDER BY s.label`,
    )
    .all(id) as { label: string }[]

  const sources =
    column === 'device_id'
      ? (db
          .prepare('SELECT label FROM event_series WHERE source_device_id = ? ORDER BY label')
          .all(id) as { label: string }[])
      : []

  const labels = [...new Set([...users, ...sources].map((row) => row.label))]
  if (labels.length === 0) return

  throw new ConflictError(
    `This ${noun} is still used by ${labels.map((label) => `"${label}"`).join(', ')}. ` +
      'Change those events first.',
  )
}
