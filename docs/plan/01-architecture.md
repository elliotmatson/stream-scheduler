# 01 — Architecture

## Runtime topology

One codebase produces three deployment shapes, all running the same core:

```
                  ┌──────────────────────────────────────────┐
                  │                 core                     │
  Electron tray ──┤  scheduler tick · run engine · plugin     ├── SQLite (single file)
  (Mac / Windows) │  host · connection manager · HTTP+WS API  │
                  └────────────────┬─────────────────────────┘
   Docker ────────────────────────►│
                                   │  http://127.0.0.1:8500
                                   ▼
                            React web UI
```

- **Headless** (`node packages/core/dist/main.js`) — what Docker runs, and what
  a Mac/PC user can run from a terminal if they prefer.
- **Electron** — the *same* core imported in the main process, plus a tray icon,
  "Open UI", launch-at-login, and an update checker. Electron is a shell around
  the core, never a fork of it. Companion does this via an `ELECTRON=0` build
  flag; we use the same idea with separate entrypoints against a shared core.
- **Docker** — multi-stage build, no Electron, `/config` volume.

The web UI is served by the core and talks to it over REST (mutations, queries)
plus a WebSocket (live run state, device health, bitrate telemetry). The UI is a
pure client; there is no UI-only state that matters. Closing the tray app's
window does not stop a running broadcast.

## What we borrow from Companion, and what we don't

Companion is the reference for *packaging and extensibility*, not for *execution*.

**Borrowed:**

- Headless core + local web UI + optional Electron wrapper, one image for Docker.
- Plugins as independent packages against a versioned `@scheduler/plugin-sdk`,
  mirroring `@companion-module/base`.
- Declarative config fields per connection, from which the UI is auto-rendered.
  Nobody hand-writes a settings form for a new encoder.
- Plugins isolated in child processes, communicating over IPC, so a misbehaving
  third-party adapter cannot take down the scheduler.

**Deliberately not borrowed:**

Companion's execution model is *button press → fire-and-forget action*. Ours is
*scheduled, stateful, long-running job that must survive a crash*. A Companion
action that fails just doesn't happen; a run step that fails at 09:58 on a Sunday
needs retry, compensation and an alert. So the core is built around a durable run
engine (see [03](./03-scheduling-engine.md)), not an action dispatcher.

Companion also has time-based *triggers*. They are intentionally simple — interval
and time-of-day — with no notion of an event that occupies a span of time, has a
prepare phase, or can be individually skipped. That gap is this project.

## Process isolation, staged

Running every plugin in a child process from day one is real overhead for
first-party in-tree adapters. But retrofitting it later is a rewrite.

**The discipline:** the plugin API is defined as *message-passing shaped* from the
first commit — every method is `async`, every argument and return value is
structured-clone serializable, no shared object references across the boundary, no
callbacks except through a typed event channel. Plugins are loaded in-process in
v1 for speed of iteration. Moving to child processes is then a transport swap
behind `PluginHost`, not an API change.

Enforced with a lint rule and by running the whole plugin test suite through a
serializing in-memory transport in CI, so a non-serializable value fails a test
long before it fails in production.

## Module boundaries

```
packages/
  plugin-sdk/      types + base classes + test harness. Published, versioned, semver'd.
  core/
    db/            schema, migrations, repositories
    schedule/      RRULE expansion, materialization, timezone handling
    runs/          run state machine, step executor, recovery, compensation
    plugins/       PluginHost, registry, capability negotiation, config schema
    devices/       ConnectionManager — one long-lived connection per device
    secrets/       envelope encryption, keychain / key-file backends, log scrubber
    template/      the name templating engine
    api/           REST + WebSocket
  web/             React UI
  desktop/         Electron main + tray + updater
  plugin-atem/
  plugin-webpresenter/
  plugin-hyperdeck/
  plugin-youtube/
  plugin-rtmp/     generic RTMP/SRT destination
  plugin-mock/     fake devices for tests and for evaluating the app without hardware
```

Dependency rule, enforced by `dependency-cruiser` in CI: plugins depend only on
`plugin-sdk`. Plugins never import from `core`. `core` never imports a specific
plugin — it discovers them through the registry. This is what keeps "extendable"
true over time rather than aspirational.

## Connection manager

Adapters do not open sockets. The `ConnectionManager` owns exactly one long-lived
connection per physical device and hands adapters a handle.

- Reconnect with exponential backoff and jitter; a device that has been down for
  an hour should not be hammered.
- Health state per device: `connected | degraded | disconnected`, with the last
  error and the time it entered that state.
- Capability probing on connect. An ATEM reports its model; the adapter maps model
  → feature matrix (does it stream? record? how many outputs?) rather than
  trusting what the user selected in a dropdown. Firmware differences are real.
- Telemetry fan-out: bitrate, dropped frames, disk remaining, transport state,
  pushed to the UI over the WebSocket and sampled into the run log.

This matters because two runs can target the same ATEM, and because the UI needs
live state whether or not anything is scheduled.

## Discovery

- **ATEM** — responds to the protocol's broadcast discovery.
- **HyperDeck / Web Presenter** — mDNS/Bonjour where the firmware advertises it.
- **Always** — manual IP entry, because control VLANs frequently block multicast.

Discovery is a convenience. Every device can be added by hand, and the app must
be fully usable with discovery disabled.

## Testability as a first-class constraint

Nothing about this product is testable if it requires hardware and a live YouTube
channel. Three things are therefore built in Phase 1, not bolted on later:

1. **Protocol-level fake devices.** The Web Presenter (TCP 9977) and HyperDeck
   (TCP 9993) protocols are line-oriented text — a faithful fake is a few hundred
   lines each, and `hyperdeck-server-connection` already exists for the HyperDeck
   side. The ATEM fake replays captured state dumps.
2. **A YouTube API fake** that enforces the real quota costs, so a change that
   accidentally introduces a `search.list` call fails CI rather than exhausting a
   user's daily quota in production.
3. **An injectable clock.** The scheduler never reads `Date.now()` directly. Every
   time source goes through a `Clock` interface, so tests can fast-forward through
   DST transitions, leap days, and machine-sleep gaps.
