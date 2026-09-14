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
 * Refuses to delete something a pipeline graph still points at.
 *
 * Credentials and destinations live inside a pipeline's JSON graph rather
 * than in a foreign key, so nothing in the database stops the delete — the
 * pipeline would just fail at T−30m on the next run with a dangling id.
 */
export function assertUnreferenced(
  db: Db,
  field: 'credentialId' | 'ingestFrom' | 'destinationId',
  id: string,
  noun: string,
): void {
  const pipelines = db.prepare('SELECT label, graph FROM pipeline').all() as { label: string; graph: string }[]
  const users = pipelines.filter((row) => {
    const graph = JSON.parse(row.graph) as {
      nodes?: Record<string, unknown>[]
      destinations?: Record<string, unknown>[]
    }
    return [...(graph.nodes ?? []), ...(graph.destinations ?? [])].some((entry) => entry[field] === id)
  })
  if (users.length > 0) {
    throw new ConflictError(
      `This ${noun} is still used by ${users.map((row) => `"${row.label}"`).join(', ')}. ` +
        'Change those pipelines first.',
    )
  }
}
