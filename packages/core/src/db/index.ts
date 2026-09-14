import Database from 'better-sqlite3'
import { migrations } from './migrations.js'

export type Db = Database.Database

export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `This database is at schema version ${found} but this build only understands ${supported}. ` +
        `You are probably running an older version after an update. Install the newer build again, ` +
        `or restore a backup taken before the update.`,
    )
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Opens the database and brings it up to date.
 *
 * A downgrade after a bad update must fail loudly rather than run against a
 * schema it does not understand and corrupt the only copy of the schedule.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migration').all().map((row) => (row as { id: number }).id),
  )
  const latest = migrations.reduce((max, m) => Math.max(max, m.id), 0)
  const highestApplied = applied.size === 0 ? 0 : Math.max(...applied)
  if (highestApplied > latest) throw new SchemaTooNewError(highestApplied, latest)

  const record = db.prepare('INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.id, migration.name, Date.now())
    })()
  }
}

/** An in-memory database with the schema applied. Used throughout the tests. */
export function openTestDatabase(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
