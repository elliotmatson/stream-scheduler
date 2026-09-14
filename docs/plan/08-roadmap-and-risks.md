# 08 — Roadmap and risks

The phase plan this document opened with has been delivered and is recorded
below as history. **Work still to do is tracked in
[GitHub Issues](https://github.com/elliotmatson/stream-scheduler/issues), not
here** — a roadmap kept in a markdown file goes stale the moment something
lands, which is exactly what happened to the original.

The risks section below is not history. It is still the best statement of
what can go wrong with this thing, and it should be kept current.

## What shipped

Each phase ended in something runnable, and none of them was "build the
abstractions for the next phase".

| Phase | Delivered |
|---|---|
| **0 — Skeleton** | Monorepo, SQLite schema and migrations, config directory resolution, secret vault with every backend, React shell, REST + WebSocket API, Electron tray, Dockerfile, CI |
| **1 — Devices** | `ConnectionManager`, plugin SDK v1, and the HyperDeck, ATEM, Streaming Encoder and mock adapters, each with a protocol-level fake. Device inventory with discovery, health and probed capabilities |
| **2 — YouTube** | BYO OAuth with the "In production" warning, token vault, the account/destination model, broadcast creation with full metadata, reusable ingestion streams, playlist insertion, quota ledger, fake YouTube server |
| **3 — Scheduling** | RRULE series, materialization and reconciliation, the run state machine, durable steps, crash recovery, compensation, missed-event policy, templating with live preview, calendar and list views, run timeline |
| **4 — Events and outputs** | An event owns a window; the streams and recordings inside it each own their hardware and start and stop independently. Fanning one encoder out to two services *simultaneously* was **not** built and is issue #5 |
| **5 — Hardening** | Failure notifications with pre-flight. Backup/restore (#10), diagnostics bundle and signed installers (#11) were not built |

Two deviations from the original plan worth recording:

- **Web Presenter.** Phase 1 named a Web Presenter adapter speaking its own
  TCP protocol. What was built instead is a Streaming Encoder adapter over the
  documented `/control/api/v1/` REST API, because current Blackmagic firmware
  exposes that API on Web Presenter hardware too. Older firmware that predates
  it is not supported. See #4.
- **Setup UI.** The plan assumed the UI grew with each phase. It did not — for
  most of the build everything was API-only, and the setup screens landed in
  one piece near the end. Phases 1 and 2 were really "works over the API"
  until then.

## v2 candidates

Out-of-tree plugin loading. iCal/Google Calendar import as a schedule source
(the RRULE model makes this small). Multi-node. Simulated live. A hosted
verified OAuth client. Companion integration in both directions — expose an
HTTP API Companion triggers can call, and ship a Companion module so a Stream
Deck button can start the next scheduled event early.

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
