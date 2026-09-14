# 02 — Domain model

## The central abstraction: a pipeline graph

The requirement is that new encoders, streaming services and "intermediaries to
route video" can all be added later. That only holds if they are the same kind of
thing to the core. So the core knows about exactly one structure: a **Pipeline**,
a directed graph of **Nodes** connected by **Links**.

```
   Source ──► [ Router ] ──► [ Relay ] ──► Sink
   (ATEM,     (ATEM aux,     (ffmpeg/SRT   (YouTube, RTMP,
    Web        Videohub)      restreamer)   HyperDeck record)
    Presenter)
```

Every node is provided by a plugin and declares a **role** and **capabilities**:

| Role | Means | Examples |
|---|---|---|
| `source` | produces video, and may itself push a stream | ATEM Mini Pro, Web Presenter, Streaming Bridge |
| `router` | selects or routes an existing signal | ATEM aux output, Videohub, ATEM macro |
| `relay` | ingests a stream and re-emits one or more | built-in ffmpeg/SRT relay, external restreamer |
| `sink` | terminates the pipeline | YouTube, generic RTMP/RTMPS/SRT, HyperDeck recording, local file |

A node can hold more than one role — an ATEM Mini Pro is both a `source` (it has
a hardware H.264 streamer) and a `router` (its aux output). Roles are a set, not
an enum.

### Capability negotiation

Links are typed. Each port declares what it emits or accepts:

```ts
interface Port {
  direction: 'out' | 'in'
  transport: ('rtmp' | 'rtmps' | 'srt' | 'sdi' | 'hdmi' | 'ndi' | 'file')[]
  maxLinks: number          // an ATEM Mini Pro has exactly one stream output
  requiresCredential?: 'stream-key' | 'none'
}
```

When the user draws a link, the core intersects the two ports. Incompatible links
are rejected in the UI with the reason, not silently accepted and then failed at
09:59 on Sunday morning. Examples the negotiation catches for free:

- A HyperDeck has no `out` port of transport `rtmp` — it cannot be a source for
  a YouTube sink.
- An ATEM Mini Pro's stream output has `maxLinks: 1` — fanning it out to YouTube
  *and* Facebook requires inserting a `relay` node, and the UI can suggest that.
- A YouTube sink declares `requiresCredential: 'stream-key'`, so the core knows a
  key must be resolved during the prepare phase.

This is what makes "extendable" structural rather than a promise. Adding Vimeo
means writing a plugin that declares a `sink` with an `rtmps` in-port. The core,
the scheduler, the calendar and the templating engine need no changes.

## Entities

```
Device            a physical box on the network (IP, credentials, model, health)
  └─ Node         a logical capability of that device, in the plugin's terms
Pipeline          a named graph of Nodes + Links + per-node settings
Destination       a configured sink target (a YouTube channel + defaults, an RTMP URL)
Account           an OAuth identity (a YouTube channel), owning refresh tokens
StreamCredential  a stream key, from manual entry / YouTube / a reusable stream
EventSeries       a named recurring (or one-off) event: schedule + pipeline + template set
Occurrence        one materialized instance of a series at a concrete instant
Run               the execution record of an Occurrence
  └─ RunStep      one idempotent unit of work within a Run
```

`EventSeries` is the thing a user creates. `Occurrence` is what appears on the
calendar. `Run` is what the engine executes and what you debug afterwards. Keeping
these three separate is what makes "skip next Sunday", "this week starts 30
minutes late", and "why did last week fail" all tractable.

## Schema

SQLite via Drizzle ORM, with migrations checked into the repo. SQLite is the right
call here: single-file backup, zero setup for a desktop user, and WAL mode handles
one writer plus many readers comfortably at this scale.

```sql
-- devices and the plugin nodes they expose -------------------------------
CREATE TABLE device (
  id            TEXT PRIMARY KEY,
  plugin_id     TEXT NOT NULL,              -- 'atem' | 'webpresenter' | 'hyperdeck' | ...
  label         TEXT NOT NULL,
  config        TEXT NOT NULL,              -- JSON, validated against the plugin's schema
  secret_ref    TEXT,                       -- FK into secret, for device passwords
  probed_model  TEXT,                       -- discovered on connect, not user-declared
  capabilities  TEXT,                       -- JSON, discovered on connect
  health        TEXT NOT NULL DEFAULT 'unknown',
  last_error    TEXT,
  last_seen_at  INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1
);

-- pipelines ---------------------------------------------------------------
CREATE TABLE pipeline (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  graph  TEXT NOT NULL                      -- JSON { nodes[], links[] }
);

-- destinations and identities ---------------------------------------------
CREATE TABLE account (                       -- one connected YouTube channel
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,             -- 'youtube'
  external_id     TEXT NOT NULL,             -- channel id
  display_name    TEXT NOT NULL,
  secret_ref      TEXT NOT NULL,             -- refresh token, encrypted
  oauth_client_ref TEXT,                     -- which BYO client issued it
  scopes          TEXT NOT NULL,
  status          TEXT NOT NULL,             -- 'ok' | 'reauth_required' | 'revoked'
  UNIQUE (provider, external_id)
);

CREATE TABLE destination (
  id          TEXT PRIMARY KEY,
  plugin_id   TEXT NOT NULL,
  label       TEXT NOT NULL,
  account_id  TEXT REFERENCES account(id),
  config      TEXT NOT NULL                  -- JSON: privacy, category, playlist, latency...
);

CREATE TABLE stream_credential (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- 'manual' | 'youtube-reusable' | 'youtube-per-event'
  ingest_url  TEXT,
  secret_ref  TEXT NOT NULL,                 -- the key itself, encrypted
  external_id TEXT,                          -- YouTube liveStream id when applicable
  account_id  TEXT REFERENCES account(id)
);

-- scheduling ---------------------------------------------------------------
CREATE TABLE event_series (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  pipeline_id    TEXT NOT NULL REFERENCES pipeline(id),
  timezone       TEXT NOT NULL,              -- IANA, e.g. 'America/Chicago'
  rrule          TEXT,                       -- NULL for a one-off
  dtstart        INTEGER NOT NULL,           -- first occurrence, UTC epoch ms
  duration_ms    INTEGER NOT NULL,
  exdates        TEXT NOT NULL DEFAULT '[]', -- JSON array of excluded instants
  prepare_lead_ms INTEGER NOT NULL DEFAULT 1800000,   -- T-30m
  preroll_ms     INTEGER NOT NULL DEFAULT 0,
  postroll_ms    INTEGER NOT NULL DEFAULT 0,
  late_start_grace_ms INTEGER NOT NULL DEFAULT 300000,
  templates      TEXT NOT NULL,              -- JSON: title, description, filename, ...
  enabled        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE occurrence (
  id             TEXT PRIMARY KEY,
  series_id      TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  scheduled_start INTEGER NOT NULL,          -- UTC epoch ms
  scheduled_end   INTEGER NOT NULL,
  local_date     TEXT NOT NULL,              -- 'YYYY-MM-DD' in the series timezone
  status         TEXT NOT NULL,              -- 'pending'|'skipped'|'cancelled'|'running'|'done'|'failed'
  overrides      TEXT,                       -- JSON; non-NULL means "detached from series edits"
  series_version INTEGER NOT NULL,           -- for reconciliation on series edit
  UNIQUE (series_id, scheduled_start)
);
CREATE INDEX occurrence_window ON occurrence (scheduled_start) WHERE status = 'pending';

-- execution ----------------------------------------------------------------
CREATE TABLE run (
  id             TEXT PRIMARY KEY,
  occurrence_id  TEXT NOT NULL REFERENCES occurrence(id),
  state          TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1,
  lease_owner    TEXT,                       -- unused in v1; reserved for multi-node
  lease_until    INTEGER,
  started_at     INTEGER,
  ended_at       INTEGER,
  resolved       TEXT,                       -- JSON: rendered templates, resolved keys (refs only)
  failure        TEXT                        -- JSON: code, message, step, remediation hint
);

CREATE TABLE run_step (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,             -- 'youtube.createBroadcast' | 'atem.setStreamKey' | ...
  state           TEXT NOT NULL,             -- 'pending'|'running'|'done'|'failed'|'compensated'
  idempotency_key TEXT NOT NULL,             -- generated BEFORE the external call
  external_id     TEXT,                      -- what the outside world called the thing we made
  attempts        INTEGER NOT NULL DEFAULT 0,
  request         TEXT,                      -- redacted
  response        TEXT,                      -- redacted
  error           TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  UNIQUE (run_id, seq)
);

-- secrets and quota ---------------------------------------------------------
CREATE TABLE secret (
  id          TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  nonce       BLOB NOT NULL,
  key_id      TEXT NOT NULL,                 -- which master key; enables rotation
  created_at  INTEGER NOT NULL
);

CREATE TABLE quota_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  client_ref TEXT NOT NULL,                  -- per BYO OAuth client / GCP project
  day        TEXT NOT NULL,                  -- 'YYYY-MM-DD' in America/Los_Angeles (Google's reset tz)
  units      INTEGER NOT NULL,
  method     TEXT NOT NULL,
  run_id     TEXT
);
CREATE INDEX quota_day ON quota_ledger (provider, client_ref, day);
```

### Notes on specific columns

- **`occurrence.local_date`** is stored, not derived at read time. Template
  rendering and the calendar both need the date *in the series' timezone*, and
  recomputing it from a UTC instant in a container running UTC is exactly where
  off-by-one-day bugs come from.
- **`occurrence.overrides`** being non-NULL marks the occurrence as detached.
  Editing the series reconciles every future occurrence whose `overrides` is NULL
  and leaves the detached ones alone — the behaviour every calendar app has, and
  the behaviour users expect.
- **`run_step.idempotency_key`** is written before the external call, never after.
  This is the entire crash-recovery story; see [03](./03-scheduling-engine.md).
- **`secret.key_id`** exists so the master key can be rotated without a migration.
- **`quota_ledger.day`** uses Pacific time because that is when Google's daily
  quota resets. Using local time here would make the ledger wrong for most of the
  world.
