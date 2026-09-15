import { randomUUID } from 'node:crypto'

/**
 * Migrations are embedded as strings rather than shipped as .sql files so they
 * survive every packaging path unchanged — tsc output, an Electron asar, and
 * the Docker image all carry them without a copy step.
 *
 * Append only. Never edit a migration that has shipped.
 */
export interface Migration {
  id: number
  name: string
  sql: string
  /**
   * Data conversion the SQL cannot express readably.
   *
   * Runs inside the same transaction as `sql`, immediately after it. Needed
   * where old rows carry JSON that has to be reshaped into real tables:
   * doing that with `json_each` is possible but produces SQL nobody can
   * check, and getting a data migration wrong loses somebody's schedule.
   */
  convert?(db: MigrationDb): void
}

/** The slice of the database handle a conversion is allowed to use. */
export interface MigrationDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE device (
  id            TEXT PRIMARY KEY,
  plugin_id     TEXT NOT NULL,
  label         TEXT NOT NULL,
  config        TEXT NOT NULL,
  probed_model  TEXT,
  capabilities  TEXT,
  health        TEXT NOT NULL DEFAULT 'unknown',
  last_error    TEXT,
  last_seen_at  INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE pipeline (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  graph      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE account (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  secret_ref       TEXT NOT NULL,
  oauth_client_ref TEXT,
  scopes           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ok',
  created_at       INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE destination (
  id         TEXT PRIMARY KEY,
  plugin_id  TEXT NOT NULL,
  label      TEXT NOT NULL,
  account_id TEXT REFERENCES account(id),
  config     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE stream_credential (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  source      TEXT NOT NULL,
  ingest_url  TEXT,
  secret_ref  TEXT NOT NULL,
  external_id TEXT,
  account_id  TEXT REFERENCES account(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE event_series (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  pipeline_id         TEXT NOT NULL REFERENCES pipeline(id),
  timezone            TEXT NOT NULL,
  rrule               TEXT,
  dtstart             INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  exdates             TEXT NOT NULL DEFAULT '[]',
  prepare_lead_ms     INTEGER NOT NULL DEFAULT 1800000,
  preroll_ms          INTEGER NOT NULL DEFAULT 0,
  postroll_ms         INTEGER NOT NULL DEFAULT 0,
  late_start_grace_ms INTEGER NOT NULL DEFAULT 300000,
  templates           TEXT NOT NULL DEFAULT '{}',
  version             INTEGER NOT NULL DEFAULT 1,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE occurrence (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  scheduled_start INTEGER NOT NULL,
  scheduled_end   INTEGER NOT NULL,
  local_date      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  overrides       TEXT,
  series_version  INTEGER NOT NULL,
  UNIQUE (series_id, scheduled_start)
);
CREATE INDEX occurrence_start ON occurrence (scheduled_start);
CREATE INDEX occurrence_pending ON occurrence (status, scheduled_start);

CREATE TABLE run (
  id            TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
  state         TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  lease_owner   TEXT,
  lease_until   INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  resolved      TEXT,
  failure       TEXT
);
CREATE INDEX run_state ON run (state);
CREATE UNIQUE INDEX run_occurrence_attempt ON run (occurrence_id, attempt);

CREATE TABLE run_step (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  external_id     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  request         TEXT,
  response        TEXT,
  error           TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  UNIQUE (run_id, seq)
);

CREATE TABLE secret (
  id         TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  key_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE quota_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  day        TEXT NOT NULL,
  units      INTEGER NOT NULL,
  method     TEXT NOT NULL,
  run_id     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX quota_day ON quota_ledger (provider, client_ref, day);
`,
  },
  {
    id: 2,
    name: 'forced-runs',
    sql: `
-- When an operator starts an occurrence by hand, the run must go immediately
-- rather than waiting for its scheduled window, and must run for its normal
-- duration measured from when it actually started.
ALTER TABLE run ADD COLUMN forced_at INTEGER;
`,
  },
  {
    id: 3,
    name: 'oauth-clients',
    sql: `
-- Bring-your-own OAuth clients. Each install supplies its own Google Cloud
-- credentials, so no client secret is embedded in a distributed binary and
-- each install gets its own daily API budget.
CREATE TABLE oauth_client (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  label      TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    id: 4,
    name: 'notifications',
    sql: `
CREATE TABLE notification_channel (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  config       TEXT NOT NULL,
  events       TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_error   TEXT,
  last_sent_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- A durable outbox rather than fire-and-forget. A run that fails at 08:30
-- must still tell somebody even if the app is killed a second later, and the
-- unique key is what stops one failure being announced on every tick.
CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      TEXT NOT NULL REFERENCES notification_channel(id) ON DELETE CASCADE,
  dedupe_key      TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (channel_id, dedupe_key)
);
CREATE INDEX notification_due ON notification_outbox (status, next_attempt_at);

CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    id: 5,
    name: 'event-outputs',
    sql: `
-- An event is one source encoder and one long window, with several
-- independently scheduled outputs inside it.
--
-- The old model had an event point at a pipeline, and the pipeline start and
-- stop as a unit. A Sunday morning is not that shape: one campus feed runs
-- 7:00 to 12:45, and inside it two services stream to two channels each at
-- 9:00 and 11:00 while a recorder runs the whole way through. Expressed as
-- pipelines that is five events which all have to be kept in step by hand,
-- and nothing stops two of them fighting over the same encoder.

ALTER TABLE event_series ADD COLUMN source_device_id TEXT REFERENCES device(id);
ALTER TABLE event_series ADD COLUMN source_node_id TEXT;

CREATE TABLE event_output (
  id             TEXT PRIMARY KEY,
  series_id      TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  -- 'stream' or 'recording'.
  kind           TEXT NOT NULL,
  label          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  -- Both measured from the event window's start, so an output keeps its
  -- place when the event is moved and survives a DST change with the rest
  -- of the day.
  offset_ms      INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL,
  -- A stream goes to a service that issues a key (destination_id) or to a
  -- key entered by hand (credential_id). Never both.
  destination_id TEXT REFERENCES destination(id),
  credential_id  TEXT REFERENCES stream_credential(id),
  -- Null means "the event's source encoder". Set only when this output
  -- lives on different hardware, which is the usual case for a recorder.
  device_id      TEXT REFERENCES device(id),
  node_id        TEXT,
  -- Overrides the event's templates for this output, so two streams from
  -- one service can be titled differently.
  templates      TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE INDEX event_output_series ON event_output (series_id, position);

-- A step used to be identifiable from its kind alone, because there was one
-- of each. Now there is a start and a stop per output and the kind carries
-- an output id, which is stable but unreadable. The label is what the run
-- timeline shows a human.
ALTER TABLE run_step ADD COLUMN label TEXT;

-- A run that was in flight when this upgrade landed cannot be driven any
-- further: its steps were planned against the old shape, and the engine now
-- looks for different ones. Reconciling that is guesswork, and guessing is
-- how a run ends up telling an encoder to stop something it never started.
--
-- So they are ended here, visibly, rather than left to fail at the next
-- tick with something cryptic. Anything actually on air stays on air --
-- restarting the app was never going to stop an encoder -- and the message
-- says so.
UPDATE run
   SET state = 'failed',
       ended_at = COALESCE(ended_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
       failure = json_object(
         'code', 'interrupted_by_upgrade',
         'message', 'This run was part-way through when the app was upgraded to the event-and-outputs model.',
         'remediation', 'Nothing was stopped on your behalf. Check the encoder and any broadcast this run created, then start the event again if it is still wanted.'
       )
 WHERE state NOT IN ('completed', 'failed', 'cancelled');

UPDATE occurrence SET status = 'failed' WHERE status = 'running';
`,
    convert: convertPipelinesToOutputs,
  },
  {
    id: 6,
    name: 'drop-pipeline-link',
    sql: `
-- Migration 5 copied every pipeline onto its events. Nothing reads
-- pipeline_id now, so the column goes.
--
-- The 'pipeline' table itself stays, unreferenced, for one release. The
-- conversion above is the only thing standing between an operator and their
-- Sunday, it has never run against their data, and keeping the rows costs a
-- few kilobytes against being able to see what an event used to be. A later
-- migration drops it.
ALTER TABLE event_series DROP COLUMN pipeline_id;
`,
  },
  {
    id: 7,
    name: 'outputs-own-their-device',
    sql: `
-- Every output already had a device of its own; the event-level source was
-- the default it fell back to. Two of them saying where a thing runs is one
-- too many, and the event-level one could not express the ordinary case of
-- a morning split across two encoders.
--
-- Backfill first, so an output that was relying on the fallback keeps the
-- hardware it has been running on.
UPDATE event_output
   SET device_id = (SELECT s.source_device_id FROM event_series s WHERE s.id = event_output.series_id),
       node_id   = (SELECT s.source_node_id   FROM event_series s WHERE s.id = event_output.series_id)
 WHERE device_id IS NULL
   AND (SELECT s.source_device_id FROM event_series s WHERE s.id = event_output.series_id) IS NOT NULL;

ALTER TABLE event_series DROP COLUMN source_device_id;
ALTER TABLE event_series DROP COLUMN source_node_id;

-- What an output wants its device set to before it runs. Every key is
-- optional and absent means "leave the device as it is", which is the
-- setting most events want and the only safe default for hardware somebody
-- else may have configured by hand.
ALTER TABLE event_output ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    id: 8,
    name: 'sessions',
    sql: `
-- Signed-in sessions. Stored rather than signed so they can be taken away:
-- a signed cookie needs no table and cannot be revoked, which would make
-- "sign out everywhere" mean "change the password on everyone".
--
-- token_hash is a SHA-256 of a 32-byte random token. The token itself is
-- never written down, so a copy of this database is not a set of working
-- logins.
CREATE TABLE session (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  revoked_at   INTEGER
);

CREATE INDEX session_live ON session (token_hash) WHERE revoked_at IS NULL;
`,
  },
  {
    id: 9,
    name: 'telemetry',
    sql: `
-- What the devices were doing while an event was on air.
--
-- The status screen shows the last thing each one said, which answers "is
-- it working now". This is for the question asked afterwards — why it fell
-- apart at 09:40 — which is a shape over time and invisible in a single
-- reading.
--
-- Keyed by the instant so a retry or an overlapping tick cannot write the
-- same reading twice; WITHOUT ROWID because the key is the whole row's
-- identity and these are written far more often than they are read.
CREATE TABLE telemetry_sample (
  run_id            TEXT    NOT NULL,
  device_id         TEXT    NOT NULL,
  node_id           TEXT    NOT NULL,
  output_id         TEXT,
  at                INTEGER NOT NULL,
  bitrate_bps       INTEGER,
  remaining_ms      INTEGER,
  elapsed_ms        INTEGER,
  cache_percent     REAL,
  cache_buffered_ms INTEGER,
  input_present     INTEGER,
  streaming         INTEGER,
  recording         INTEGER,
  PRIMARY KEY (run_id, device_id, node_id, output_id, at)
) WITHOUT ROWID;

CREATE INDEX telemetry_age ON telemetry_sample (at);
`,
  },
  {
    id: 10,
    name: 'recording-artifacts',
    sql: `
-- What this scheduler recorded, and where it put it.
--
-- Retention needs to know what may be deleted, and a listing off the card
-- cannot answer that: a deck names its clips and will not say when they
-- were made, and half the files on a Sunday card were put there by a person
-- rather than by this app. A row written when a recording starts answers
-- both — this is ours, and it was made then.
--
-- Nothing deletes from this yet. Phase one is being able to say what would
-- go.
CREATE TABLE recording_artifact (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  output_id   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  slot        INTEGER,
  filename    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  -- Set once something actually removes it. Until then this table is a
  -- record of what exists.
  deleted_at  INTEGER,
  last_error  TEXT
);

CREATE INDEX recording_artifact_output ON recording_artifact (output_id, started_at);
CREATE INDEX recording_artifact_device ON recording_artifact (device_id, node_id);
`,
  },
  {
    id: 11,
    name: 'tags',
    sql: `
-- Labels somebody puts on things, so twenty devices in a rack can be
-- narrowed to the three in one building.
--
-- One table for every kind of resource rather than a column on each, so
-- adding tags to a new kind is a row, not a migration. The pair is the
-- primary key: tagging the same thing twice with the same word is the same
-- fact stated twice, not two facts.
--
-- The tag itself is just its text. No table of tags, no colours, no
-- hierarchy: a tag nobody has put on anything should stop existing, and
-- that falls out for free when the only record of a tag is its use.
CREATE TABLE tag (
  -- 'device', 'series'. Not constrained: a new kind of taggable thing
  -- should not need this file reopened.
  resource_kind TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  -- Stored as typed, matched case-insensitively. "Sanctuary" and
  -- "sanctuary" are one tag that two people spelled differently, and a
  -- filter that misses half a rack over a capital letter is worse than
  -- useless.
  tag           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (resource_kind, resource_id, tag COLLATE NOCASE)
) WITHOUT ROWID;

-- The two directions this is read: everything on one thing, and everything
-- with one tag.
CREATE INDEX tag_by_resource ON tag (resource_kind, resource_id);
CREATE INDEX tag_by_name ON tag (tag COLLATE NOCASE, resource_kind);
`,
  },
  {
    id: 12,
    name: 'credential-platform',
    sql: `
-- Which service a saved key belongs to.
--
-- Nothing depends on it: the ingest URL and the key are still the whole of
-- what gets sent, and a key with no platform works exactly as it did. It
-- is here so a list of six keys reads as six services rather than six
-- hostnames, and so the screen can say the thing about that service that
-- catches people out — a Facebook key that expires after one broadcast is
-- the example that costs somebody a Sunday.
--
-- Free text, matched against a catalogue in code rather than a table of
-- its own. Services come and go faster than migrations should, and a
-- stored id this app no longer recognises has to keep working rather than
-- fail a foreign key on somebody's only stream.
ALTER TABLE stream_credential ADD COLUMN platform TEXT;
`,
  },
]

interface GraphNode {
  id?: string
  deviceId?: string
  nodeId?: string
  credentialId?: string
  ingestFrom?: string
  filenameTemplate?: string
}

interface GraphDestination {
  id?: string
  destinationId?: string
}

/**
 * Rewrites each event's pipeline as a source encoder plus outputs.
 *
 * The mapping is the one the old graph already implied: a node pointed at an
 * ingest is a stream, a node that is not is a recorder, and the first
 * streaming node is the source. Everything converted keeps the window it had
 * — offset 0, the event's full duration — because that is what it did
 * before. Splitting a window into services is the new thing, and it is a
 * choice for whoever owns the event, not for a migration.
 */
function convertPipelinesToOutputs(db: MigrationDb): void {
  const series = db
    .prepare(
      `SELECT s.id AS id, s.duration_ms AS duration_ms, p.graph AS graph
         FROM event_series s JOIN pipeline p ON p.id = s.pipeline_id`,
    )
    .all() as { id: string; duration_ms: number; graph: string }[]
  if (series.length === 0) return

  const setSource = db.prepare(
    'UPDATE event_series SET source_device_id = ?, source_node_id = ? WHERE id = ?',
  )
  const insertOutput = db.prepare(
    `INSERT INTO event_output
       (id, series_id, kind, label, position, offset_ms, duration_ms, destination_id, credential_id,
        device_id, node_id, templates, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
  const labelOf = (
    table: 'device' | 'destination' | 'stream_credential',
    id: string | undefined,
  ): string | undefined => {
    if (!id) return undefined
    const row = db.prepare(`SELECT label FROM ${table} WHERE id = ?`).get(id) as
      { label: string } | undefined
    return row?.label
  }

  const now = Date.now()

  for (const row of series) {
    const graph = parseGraph(row.graph)
    const nodes = graph.nodes.filter((node) => node.deviceId && node.nodeId)
    const streaming = nodes.filter((node) => node.credentialId ?? node.ingestFrom)

    // The source is whatever was being pointed at an ingest. A pipeline with
    // no streaming node at all (a recorder on its own) still has a source:
    // there is one device, and it is that one.
    const source = streaming[0] ?? nodes[0]
    if (source) setSource.run(source.deviceId, source.nodeId, row.id)

    const destinationOf = (ingestFrom: string | undefined): string | undefined =>
      graph.destinations.find((spec) => spec.id === ingestFrom)?.destinationId

    // A node and the source may be the same hardware; that is expressed by
    // leaving the output's device null rather than repeating it.
    const deviceColumns = (node: GraphNode): [string | null, string | null] =>
      node.deviceId === source?.deviceId && node.nodeId === source?.nodeId
        ? [null, null]
        : [node.deviceId ?? null, node.nodeId ?? null]

    const claimed = new Set<string>()
    let position = 0

    for (const node of streaming) {
      const destinationId = destinationOf(node.ingestFrom) ?? null
      if (node.ingestFrom) claimed.add(node.ingestFrom)
      const [deviceId, nodeId] = deviceColumns(node)
      insertOutput.run(
        randomUUID(),
        row.id,
        'stream',
        labelOf('destination', destinationId ?? undefined) ??
          labelOf('stream_credential', node.credentialId) ??
          'Stream',
        position++,
        row.duration_ms,
        destinationId,
        node.credentialId ?? null,
        deviceId,
        nodeId,
        '{}',
        now,
      )
    }

    // A destination nothing was pointed at still had its broadcast created
    // and finalized by the old planner, so it survives as an output driven
    // by the source.
    for (const spec of graph.destinations) {
      if (!spec.destinationId || (spec.id && claimed.has(spec.id))) continue
      insertOutput.run(
        randomUUID(),
        row.id,
        'stream',
        labelOf('destination', spec.destinationId) ?? 'Stream',
        position++,
        row.duration_ms,
        spec.destinationId,
        null,
        null,
        null,
        '{}',
        now,
      )
    }

    for (const node of nodes) {
      if (streaming.includes(node)) continue
      const [deviceId, nodeId] = deviceColumns(node)
      insertOutput.run(
        randomUUID(),
        row.id,
        'recording',
        labelOf('device', node.deviceId) ?? 'Recording',
        position++,
        row.duration_ms,
        null,
        null,
        deviceId,
        nodeId,
        node.filenameTemplate ? JSON.stringify({ filename: node.filenameTemplate }) : '{}',
        now,
      )
    }
  }
}

function parseGraph(raw: string): { nodes: GraphNode[]; destinations: GraphDestination[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A graph nobody can parse converts to an event with no outputs rather
    // than aborting the whole upgrade. The event is still there to fix.
    return { nodes: [], destinations: [] }
  }
  const graph = (parsed ?? {}) as { nodes?: unknown; destinations?: unknown }
  return {
    nodes: Array.isArray(graph.nodes) ? (graph.nodes as GraphNode[]) : [],
    destinations: Array.isArray(graph.destinations)
      ? (graph.destinations as GraphDestination[])
      : [],
  }
}
