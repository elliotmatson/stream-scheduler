import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, openTestDatabase, SchemaTooNewError } from './index.js'
import { migrations } from './migrations.js'

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
  db.prepare(
    `INSERT INTO event_series (id, label, timezone, dtstart, duration_ms, created_at, updated_at)
     VALUES ('s1', 'Sunday Service', 'America/Chicago', ?, 5400000, ?, ?)`,
  ).run(now, now, now)
}

describe('the event-output migration', () => {
  it('turns a pipeline into a source encoder and its outputs', () => {
    const db = openOldDatabase()
    db.prepare("INSERT INTO device (id, plugin_id, label, config, created_at) VALUES ('enc', 'x', 'Web Presenter', '{}', 0)").run()
    db.prepare("INSERT INTO device (id, plugin_id, label, config, created_at) VALUES ('deck', 'x', 'HyperDeck', '{}', 0)").run()
    db.prepare("INSERT INTO destination (id, plugin_id, label, config, created_at) VALUES ('yt', 'youtube', 'Grace Anderson', '{}', 0)").run()
    seedOldSeries(db, {
      nodes: [
        { id: 'n1', deviceId: 'enc', nodeId: 'stream', ingestFrom: 'd1' },
        { id: 'n2', deviceId: 'deck', nodeId: 'rec', filenameTemplate: '{{event.name}}' },
      ],
      destinations: [{ id: 'd1', destinationId: 'yt' }],
    })

    migrate(db)

    const series = db.prepare('SELECT source_device_id, source_node_id FROM event_series WHERE id = ?').get('s1')
    expect(series).toEqual({ source_device_id: 'enc', source_node_id: 'stream' })

    const outputs = db
      .prepare('SELECT kind, label, position, offset_ms, duration_ms, destination_id, device_id, node_id, templates FROM event_output ORDER BY position')
      .all()
    expect(outputs).toEqual([
      {
        kind: 'stream',
        label: 'Grace Anderson',
        position: 0,
        offset_ms: 0,
        duration_ms: 3_600_000,
        destination_id: 'yt',
        // Null because this output runs on the event's own source encoder.
        device_id: null,
        node_id: null,
        templates: '{}',
      },
      {
        kind: 'recording',
        label: 'HyperDeck',
        position: 1,
        offset_ms: 0,
        duration_ms: 3_600_000,
        destination_id: null,
        device_id: 'deck',
        node_id: 'rec',
        templates: '{"filename":"{{event.name}}"}',
      },
    ])
  })

  it('converts a recorder-only pipeline, which has no streaming node to source from', () => {
    const db = openOldDatabase()
    db.prepare("INSERT INTO device (id, plugin_id, label, config, created_at) VALUES ('deck', 'x', 'HyperDeck', '{}', 0)").run()
    seedOldSeries(db, { nodes: [{ id: 'n1', deviceId: 'deck', nodeId: 'rec' }] })

    migrate(db)

    expect(db.prepare('SELECT source_device_id FROM event_series WHERE id = ?').get('s1')).toEqual({
      source_device_id: 'deck',
    })
    expect(db.prepare('SELECT kind, device_id FROM event_output').all()).toEqual([
      { kind: 'recording', device_id: null },
    ])
  })

  it('leaves an event whose graph is unreadable in place, with no outputs', () => {
    const db = openOldDatabase()
    db.prepare("INSERT INTO pipeline (id, label, graph, created_at) VALUES ('p1', 'Main', 'not json', 0)").run()
    db.prepare(
      `INSERT INTO event_series (id, label, pipeline_id, timezone, dtstart, duration_ms, created_at, updated_at)
       VALUES ('s1', 'Sunday', 'p1', 'UTC', 0, 3600000, 0, 0)`,
    ).run()

    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_output').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT label FROM event_series').all()).toEqual([{ label: 'Sunday' }])
  })
})

/** A database at the schema as it stood before events owned their outputs. */
function openOldDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE schema_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
  const record = db.prepare('INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of migrations.filter((m) => m.id <= 4)) {
    db.exec(migration.sql)
    record.run(migration.id, migration.name, Date.now())
  }
  return db
}

function seedOldSeries(db: Database.Database, graph: unknown): void {
  db.prepare('INSERT INTO pipeline (id, label, graph, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'Main',
    JSON.stringify(graph),
    0,
  )
  db.prepare(
    `INSERT INTO event_series (id, label, pipeline_id, timezone, dtstart, duration_ms, created_at, updated_at)
     VALUES ('s1', 'Sunday', 'p1', 'UTC', 0, 3600000, 0, 0)`,
  ).run()
}
