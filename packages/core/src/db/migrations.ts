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
]
