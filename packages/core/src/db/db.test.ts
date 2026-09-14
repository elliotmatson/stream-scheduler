import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, openTestDatabase, SchemaTooNewError } from './index.js'

describe('migrations', () => {
  it('creates the schema and is safe to run twice', () => {
    const db = openTestDatabase()
    expect(() => migrate(db)).not.toThrow()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toContain('event_series')
    expect(tables).toContain('run_step')
    expect(tables).toContain('quota_ledger')
  })

  it('refuses to run against a database written by a newer build', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare('INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)').run(9999, 'future', Date.now())
    expect(() => migrate(db)).toThrow(SchemaTooNewError)
  })

  it('enforces the unique occurrence-per-instant constraint', () => {
    const db = openTestDatabase()
    seedSeries(db)
    const insert = db.prepare(
      `INSERT INTO occurrence (id, series_id, scheduled_start, scheduled_end, local_date, series_version)
       VALUES (?, 's1', 1000, 2000, '2026-03-08', 1)`,
    )
    insert.run('o1')
    expect(() => insert.run('o2')).toThrow(/UNIQUE/)
  })
})

function seedSeries(db: Database.Database): void {
  const now = Date.now()
  db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run('p1', 'Main', '{}', now)
  db.prepare(
    `INSERT INTO event_series (id, label, pipeline_id, timezone, dtstart, duration_ms, created_at, updated_at)
     VALUES ('s1', 'Sunday Service', 'p1', 'America/Chicago', ?, 5400000, ?, ?)`,
  ).run(now, now, now)
}
