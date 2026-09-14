# 08 — Roadmap and risks

Each phase ends in something runnable. No phase is "build the abstractions for
the next phase".

## Phase 0 — Skeleton

Monorepo, Drizzle schema and migrations, config directory resolution, secret vault
with all backends, React shell, REST + WebSocket scaffolding, Electron tray,
Dockerfile, CI pipeline.

**Deliverable:** the app installs and runs on macOS, Windows and Docker, and does
nothing useful. Worth doing first anyway — packaging pain discovered in month four
is much more expensive than in week one.

## Phase 1 — Devices

`ConnectionManager`, the plugin SDK v1 contract, and the ATEM, Web Presenter,
HyperDeck and mock adapters, each with a protocol-level fake. Device inventory UI
with discovery, manual add, health and probed capabilities. Manual "start stream
now" / "start recording now" buttons.

**Deliverable:** control real hardware from the app. No scheduling yet. This is
the phase that retires the largest technical risk — if `atem-connection` doesn't
behave against real gear, everything downstream changes and we want to know now.

## Phase 2 — YouTube

BYO OAuth setup wizard (including the "In production" check), token vault, the
account/destination model, broadcast creation with full metadata, reusable
ingestion streams, playlist insertion, the quota ledger, and the fake YouTube
server for tests.

**Deliverable:** "Create a broadcast now" from the UI, end to end, with the key
pushed to a real encoder and the stream live on YouTube.

## Phase 3 — Scheduling

RRULE series, materialization and reconciliation, the run state machine, durable
steps, crash recovery, compensation, missed-event policy, the templating engine
with live preview, calendar and list views, the run-detail timeline.

**Deliverable:** the actual product. A recurring Sunday service that creates its
own broadcast, starts, records and stops without anyone touching it.

## Phase 4 — Pipelines and routing

The full graph model and editor, capability negotiation in the UI, router
adapters (ATEM aux, Videohub), the built-in ffmpeg/SRT relay for multi-destination
fan-out, and a second real destination plugin to prove the sink abstraction.

**Deliverable:** one source to several destinations, with the routing visible and
editable.

## Phase 5 — Hardening

Failure notifications (email, Slack, generic webhook) with a pre-flight alert at
prepare time. Backup and restore. Log rotation and a diagnostics bundle. Signed
and notarized installers. Auto-update. Documentation.

**Deliverable:** shippable to someone who is not you.

## v2 candidates

Out-of-tree plugin loading. iCal/Google Calendar import as a schedule source
(the RRULE model makes this small). Multi-node. Simulated live. A hosted verified
OAuth client. Companion integration in both directions — expose an HTTP API
Companion triggers can call, and ship a Companion module so a Stream Deck button
can start the next scheduled event early.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Unattended reliability is the whole product** | A silent failure at 09:00 Sunday loses the user permanently | The prepare-at-T−30m design exists for this; pre-flight alerts, verify-after-write, crash-recovery tests in CI, and a run timeline good enough to diagnose from |
| **ATEM protocol is reverse-engineered** | Firmware update breaks control | Pin `atem-connection`; loud named error on protocol mismatch at probe time; recorded-state fakes in CI; never fail silently |
| **Google OAuth "Testing" 7-day token expiry** | Every install works for a week then breaks | Wizard requires "In production"; runtime maps `invalid_grant` to a specific actionable message; alert fires before the next prepare window, not during it |
| **YouTube quota exhaustion** | Sunday's stream fails to get a broadcast | Quota ledger with reserve; polling backoff; `search.list` banned and CI-enforced; usage visible in the UI before it matters |
| **Code signing cost and CI complexity** | Unshippable to non-technical users | Budget it into Phase 5 explicitly, don't discover it at release |
| **Scope creep toward being Resi** | Never ships | Cloud transcoding, VOD hosting and simulated live are out of scope in writing; the value here is scheduling commodity hardware, not rebuilding a CDN |
| **Plugin API churn after third parties adopt it** | Ecosystem breaks | Freeze and semver `plugin-sdk` at v1; `apiVersion` checked at load; serialization discipline enforced by tests from day one |
| **Unauthenticated control protocols** | Anyone on the LAN controls the gear | Can't be fixed by this app; document the control-VLAN expectation and at minimum don't add a new hole — localhost bind by default, password required before exposing the UI |

## The two things most likely to go wrong

Worth stating plainly, because they are not the things that look hard:

1. **Timezones.** Not the hard part of the code, but the part most likely to be
   quietly wrong. The mitigations — expanding recurrence in local time, storing
   `occurrence.local_date`, rendering templates from the occurrence's timezone,
   and a DST test suite — are cheap and must be in from the start, because
   retrofitting correct timezone handling means re-testing everything.

2. **Crash recovery.** Easy to skip, and untested recovery code is worse than
   none — it runs at the worst possible moment. The idempotency-key-before-call
   invariant only works if every step follows it, which is why it belongs in the
   step executor rather than in each step's implementation, and why the test
   suite kills the process at every step boundary and asserts exactly one
   broadcast exists afterwards.
