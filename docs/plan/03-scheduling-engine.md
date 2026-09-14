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
  scheduled ──► preparing ──► ready ──► running ──► completing ──► completed
       │            │                      │             │
       └────────────┴──────────────┬───────┴─────────────┘
                                   ▼
                           failed  /  cancelled
```

`running` is one state covering the whole window, not a moment. An event has
several outputs inside that window and they go on and come off on their own
clocks, so there is no single instant at which the run is "live". What each
output is doing is read back from its own step rows rather than stored a second
time — the steps are already the durable record of what was attempted and what
landed, and a second copy of the same fact is a second thing that can be wrong
after a crash.

| Phase | At | Does |
|---|---|---|
| prepare | `window start − prepare_lead_ms` (default T−30m) | For **every** output at once: render templates, create the broadcast, ensure and bind the ingestion stream, resolve the key. |
| ready | — | Everything staged. The UI shows a green "ready" and the resolved titles, so an operator can eyeball them before anything goes out. |
| start | per output, at `window start + offset − preroll_ms` | Point the encoder at this output's key and read it back, then tell it to start. Or roll the recorder. |
| stop | per output, at `... + duration + postroll_ms` | Stop that output, releasing the encoder for whatever comes next. |
| complete | window end | Let each broadcast finish. Insert into playlists. Apply final metadata. |

Stops are serviced before starts on any given tick, so an encoder handing over
from the 9:00 service to the 11:00 one is released before the next output
claims it.

A long prepare lead is the single highest-value reliability feature: it moves
every failure that can be detected in advance — expired token, unreachable
encoder, quota exhausted, bad template — from 09:00:00 to 08:30:00, where a
human can still fix it. Preparing *all* the outputs then, rather than each just
before it airs, is the same argument: finding out at 08:30 that the 11:00
broadcast cannot be created is worth something; finding out at 11:00 is not.

### One output failing does not abandon the event

A broadcast that cannot be created for the 9:00 service is no reason to give up
on the 11:00 one or to stop recording. A failure takes that output out and
leaves the rest running, and is reported on its own.

Whether its work is undone depends on whether it ever got on air:

- **Never on air** (prepare or start failed) → the broadcast it created is
  litter, and is discarded.
- **On air, then failed to stop** → the broadcast is kept and closed out
  normally at the end. Deleting it would delete a service people watched. The
  alert says the encoder may still be streaming, because it may be.

The run itself fails only when nothing at all made it to air, and it keeps the
cause a step recorded rather than replacing it with the summary: "the stored
YouTube authorization was rejected, reconnect the account" is the sentence
somebody can act on, and "every output failed" is not.

### Late is per output, not per event

An app that comes back at 10:00 has missed the 9:00 service, but the 11:00 one
and the recording that runs to 12:45 are still perfectly deliverable. See
[Missed events](#missed-events) below for the policy.

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
3. **Resume or compensate.** If the run's window is still open, continue from
   the first incomplete step. If the window has passed, run compensation.

A crash part-way through a window is the one case where the single prepare gate
is not enough: the run comes back in `running`, with later outputs never
prepared and no second prepare gate coming. So starting an output also picks up
any of its prepare steps still outstanding. In the ordinary case they are all
done already and it costs nothing.

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

- **Start late** if now is within `late_start_grace_ms` (default 5 minutes) of
  the output's own start. The run proceeds with a shortened prepare phase and
  the UI flags it as a late start.
- **Skip that output** otherwise, writing the reason onto its start steps. The
  rest of the event carries on.
- **Fail the run** as `missed_window` only when every output is past saving,
  firing the notification.

Never silently start a 90-minute stream four hours late.

## Manual override

The scheduler must never be the only way to control the hardware. Every run
surface has a manual "Start now", "Stop now" and "Abandon" control, and a
manually-stopped run records that a human stopped it rather than treating it as a
failure. An operator standing in a control room at 09:02 needs a stop button, not
a support ticket.

Below the runs, the Devices page drives a node directly: read its state, start
and stop a stream, start and stop a recording. Each of those goes through the
same verify-after-write as a scheduled step, because a button that goes green
without the device doing anything is worse than no button. The page names any
event mid-run on that device before you touch it, and points at the run's own
stop button as the thing that ends it properly.

`applyStreamTarget` is deliberately not on that surface. It takes a stream key,
so offering it would mean posting a key in the clear to be pushed at a device
outside any run, with nothing to clean it up afterwards. Getting a key onto an
encoder is what stream credentials and the prepare phase are for.

## Observability

The run detail view is a timeline of steps: what ran, when, how long it took, the
request and response (redacted), and the error with a remediation hint. This is
normally the last thing built and it should be among the first — it is the
difference between "the stream didn't start" and "the refresh token was rejected
at 08:30, here's the reconnect button".

Structured logs (`pino`) to a rotating file in the config directory, with the
secret scrubber applied at the transport level so a key cannot leak through a log
line that forgot to redact.
