# 02 — Domain model

## The central abstraction: an event and its outputs

An **event** is one source encoder and one long window. Inside that window sit
several **outputs**, each with its own start, its own length, and its own name.

```
EventSeries  "Sunday // Anderson"      source: Web Presenter   window 07:00-12:45
  ├─ Output  "Grace Anderson // 9:00"   +2h00   75m   -> YouTube (main channel)
  ├─ Output  "AND Worship // 9:00"      +2h00   75m   -> YouTube (worship channel)
  ├─ Output  "Grace Anderson // 11:00"  +4h00   75m   -> YouTube (main channel)
  ├─ Output  "AND Worship // 11:00"     +4h00   75m   -> YouTube (worship channel)
  └─ Output  "Archive"                  +0h00  345m   -> HyperDeck
```

This is the shape a Sunday actually has, and it is the shape Resi uses. The
alternative — one event per stream — makes five things a human has to keep in
step by hand, gives no way to say "this encoder is busy until 12:45", and has
no place to hang the recording that spans all of it.

Offsets are stored relative to the window, never as absolute times. Move the
event and everything moves with it; cross a clock change and the whole morning
shifts together rather than the 11:00 service landing an hour out from the
9:00 one.

### What a plugin provides

Every device is provided by a plugin and exposes **nodes**, each declaring a
**role** and **capabilities**:

| Role | Means | Examples |
|---|---|---|
| `source` | produces video, and may itself push a stream | ATEM Mini Pro, Web Presenter, Streaming Bridge |
| `router` | selects or routes an existing signal | ATEM aux output, Videohub, ATEM macro. Implemented by the ATEM adapter; nothing schedules it, and [04](./04-plugin-sdk.md#routing) says why |
| `relay` | ingests a stream and re-emits one or more | built-in ffmpeg/SRT relay, external restreamer |
| `sink` | terminates the chain | YouTube, generic RTMP/RTMPS/SRT, HyperDeck recording |

A node can hold more than one role — an ATEM Mini Pro is both a `source` (it has
a hardware H.264 streamer) and a `router` (its aux output). Roles are a set, not
an enum.

Adding Vimeo means writing a plugin that declares a destination provider. The
core, the scheduler, the calendar and the templating engine need no changes.

### One encoder, one stream at a time

A Blackmagic encoder holds one stream target and pushes one stream. Point it
somewhere else while it is live and the first stream drops — and the device
accepts the command and says nothing, which is exactly the class of failure
that only shows up on a Sunday.

Two consequences run right through the design:

- **The target is applied when an output goes on air, not during prepare.** An
  encoder feeding four services across a morning cannot hold four targets at
  T-30; it is retargeted at 09:00 and again at 11:00.
- **Two outputs wanting the same device at the same time is a real clash**, and
  it is reported when the event is saved and again at pre-flight rather than
  discovered live. Two YouTube channels *simultaneously* needs a relay in front
  of the encoder, which is
  [issue #5](https://github.com/elliotmatson/stream-scheduler/issues/5).

A recording and a stream can share one device — a Web Presenter records to USB
while it streams — so the check is per device *and* per kind, not per device.

## Entities

```
Device            a physical box on the network (IP, credentials, model, health)
  └─ Node         a logical capability of that device, in the plugin's terms
Destination       a configured sink target (a YouTube channel + defaults, an RTMP URL)
Account           an OAuth identity (a YouTube channel), owning refresh tokens
StreamCredential  a stream key, from manual entry / YouTube / a reusable stream
EventSeries       a named recurring (or one-off) event: schedule + source encoder + defaults
  └─ EventOutput  one stream or recording, with its own slot inside the window
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
  source_device_id TEXT REFERENCES device(id),  -- the one feed this event comes off
  source_node_id TEXT,
  timezone       TEXT NOT NULL,              -- IANA, e.g. 'America/Chicago'
  rrule          TEXT,                       -- NULL for a one-off
  dtstart        INTEGER NOT NULL,           -- first occurrence, UTC epoch ms
  duration_ms    INTEGER NOT NULL,
  exdates        TEXT NOT NULL DEFAULT '[]', -- JSON array of excluded instants
  prepare_lead_ms INTEGER NOT NULL DEFAULT 1800000,   -- T-30m
  preroll_ms     INTEGER NOT NULL DEFAULT 0,
  postroll_ms    INTEGER NOT NULL DEFAULT 0,
  late_start_grace_ms INTEGER NOT NULL DEFAULT 300000,
  templates      TEXT NOT NULL,              -- JSON defaults; an output overrides per key
  enabled        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE event_output (
  id             TEXT PRIMARY KEY,
  series_id      TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,              -- 'stream' | 'recording'
  label          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  offset_ms      INTEGER NOT NULL,           -- from the window's start, never absolute
  duration_ms    INTEGER NOT NULL,
  destination_id TEXT REFERENCES destination(id),        -- a service that issues a key
  credential_id  TEXT REFERENCES stream_credential(id),  -- ...or a key entered by hand
  device_id      TEXT REFERENCES device(id), -- NULL means the event's source encoder
  node_id        TEXT,
  templates      TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX event_output_series ON event_output (series_id, position);

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
  kind            TEXT NOT NULL,             -- '<output id>.startStreaming' | ...
  label           TEXT,                      -- the readable half, for the timeline
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

- **`event_output.offset_ms`** is measured from the window's start rather than
  stored as a time of day. It is what keeps a morning together when the event
  moves, and what makes a clock change shift the whole thing rather than
  putting the 11:00 service an hour out from the 9:00 one.
- **`event_output.device_id` being NULL** means "the event's source encoder".
  Repeating the source on every output would be a second copy of the same fact,
  and changing the source would then have to be a fan-out write.
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
