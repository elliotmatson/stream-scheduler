# 03 — Scheduling engine

This is the part that has to be right. Everything else is a UI over it. A stream
that silently fails to start on a Sunday morning is worse than having no tool at
all, because the operator stopped watching for it.

## Recurrence

Series use **RFC 5545 `RRULE`** (via the `rrule` package) plus an IANA timezone,
not cron.

Cron is wrong for this domain in three specific ways: it has no timezone concept,
so a `0 9 * * 0` job in a UTC container fires at the wrong local time half the
year; it cannot express "the second Sunday of the month" without hacks; and it has
no way to say "except December 25th". `RRULE` handles all three, and it is the
format every calendar the user already has speaks — which makes an iCal import
path a small future feature rather than a rewrite.

```
FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0        # every Sunday 9:00 local
FREQ=MONTHLY;BYDAY=2SU                           # second Sunday monthly
FREQ=WEEKLY;BYDAY=WE;UNTIL=20270601T000000Z      # Wednesdays until June
```

**DST is handled by expanding in local time, then converting to UTC.** Expanding
in UTC and converting back produces a service that drifts an hour twice a year.
The test suite fast-forwards a weekly 9am series across both US and EU transitions
in both directions, plus the ambiguous hour in the autumn fall-back, and asserts
the local wall-clock time never moves.

## Materialization

A rolling job expands each enabled series into concrete `occurrence` rows for a
horizon (default 60 days) and refreshes nightly.

Occurrences are materialized rather than computed on demand because they need to
be individually addressable: skipped, time-shifted, given a different title, or
carry the run history of something that already happened. A purely computed view
cannot hold any of that.

**Reconciliation on series edit.** When a series changes, bump `series_version`,
then for every future occurrence:

- `overrides IS NULL` → regenerate from the new rule. If its instant no longer
  exists in the rule, delete it.
- `overrides IS NOT NULL` → leave it completely alone, and surface it in the UI
  as "modified" so the user can see what didn't get the update.

Past occurrences are never touched. They are history.

## The run lifecycle

Each occurrence produces exactly one `run` (plus retries as new attempts). The
state machine:

```
  scheduled ──► preparing ──► ready ──► starting ──► live ──► stopping ──► completing ──► completed
       │            │                       │                                   │
       └────────────┴───────────────┬───────┴───────────────────────────────────┘
                                    ▼
                            failed  /  cancelled
```

Phases, for a typical ATEM Mini Pro → YouTube run:

| Phase | At | Does |
|---|---|---|
| `preparing` | `start − prepare_lead_ms` (default T−30m) | Render templates. Create the YouTube broadcast. Ensure/bind the ingestion stream. Resolve the stream key. Push key + ingest URL to the encoder. Verify by reading back. |
| `ready` | — | Everything staged. The UI shows a green "ready" and the resolved title, so an operator can eyeball it before it goes out. |
| `starting` | `start − preroll_ms` | Tell the encoder to start streaming. Start the HyperDeck recording. Wait for YouTube to report ingest health. |
| `live` | — | Poll health on a backoff. Sample bitrate into the run log. |
| `stopping` | `end + postroll_ms` | Stop encoder streaming, stop recording. |
| `completing` | — | Let YouTube finish the broadcast. Insert into the playlist. Apply final metadata. |

A long prepare lead is the single highest-value reliability feature: it moves
every failure that can be detected in advance — expired token, unreachable
encoder, quota exhausted, bad template — from 09:00:00 to 08:30:00, where a human
can still fix it.

## Idempotency and crash recovery

The core invariant:

> **A step writes its `idempotency_key` and intent to the database, in a committed
> transaction, *before* making the external call. It writes `external_id` after.**

A crash can therefore leave a step in exactly one ambiguous state: `running`, with
a key but no external id. Recovery is then well-defined rather than a guess. On
startup, for every run not in a terminal state:

1. **Reconcile before acting.** For each `running` step, ask the outside world
   what happened. `liveBroadcasts.list` filtered by the ids we know, plus a check
   for a broadcast tagged with our idempotency key. Query the encoder for its
   actual transport state. Never re-execute a step blind — that is how you end up
   with three broadcasts for one service.
2. **Adopt or redo.** If the external resource exists, record its id and mark the
   step done. If it does not, the call never landed; re-run it with the same key.
3. **Resume or compensate.** If the run's window is still open, continue from the
   first incomplete step. If the window has passed, run compensation.

**Compensation** matters because a half-prepared run leaves litter. If preparation
fails after creating a broadcast, the cleanup step deletes it — or, if deletion
fails, sets it to private and tags it, so the channel doesn't accumulate a pile of
public empty "Sunday Service" broadcasts. Compensation steps are themselves
persisted steps with their own retries.

Every step declares its retry policy: max attempts, backoff, and — crucially —
whether it is safe to retry at all. `youtube.createBroadcast` is safe (guarded by
the key). `atem.startStreaming` is safe (idempotent by nature: starting an already
started stream is a no-op we verify by reading state back). A step that is not
safely retryable is marked and fails the run rather than guessing.

## The tick

A single scheduler loop runs every 5 seconds:

```
now = clock.now()
for each occurrence where status = 'pending' and scheduled_start < now + max_lead:
    ensure a run exists
for each run not in a terminal state:
    advance(run, now)
```

Deliberately a poll, not a `setTimeout` per event. Long timers do not survive
machine sleep, system clock changes, or NTP steps, and a desktop app sleeps
constantly. Recomputing from wall-clock every tick makes all three non-events.

**`lease_owner` / `lease_until`** are unused in v1 — one process, one writer. They
exist so that a future multi-node mode does not need a migration.

## Missed events

A laptop closed at 08:45 and opened at 09:05 has missed a 09:00 start. The policy
is per-series and explicit, because both answers are correct for different users:

- **Start late** if now is within `late_start_grace_ms` (default 5 minutes) of the
  scheduled start. The run proceeds with a shortened prepare phase and the UI
  flags it as a late start.
- **Skip** otherwise. The occurrence is marked `failed` with reason
  `missed_window`, and the notification fires.

Never silently start a 90-minute stream four hours late.

## Manual override

The scheduler must never be the only way to control the hardware. Every run
surface has a manual "Start now", "Stop now" and "Abandon" control, and a
manually-stopped run records that a human stopped it rather than treating it as a
failure. An operator standing in a control room at 09:02 needs a stop button, not
a support ticket.

## Observability

The run detail view is a timeline of steps: what ran, when, how long it took, the
request and response (redacted), and the error with a remediation hint. This is
normally the last thing built and it should be among the first — it is the
difference between "the stream didn't start" and "the refresh token was rejected
at 08:30, here's the reconnect button".

Structured logs (`pino`) to a rotating file in the config directory, with the
secret scrubber applied at the transport level so a key cannot leak through a log
line that forgot to redact.
