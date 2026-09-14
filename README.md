# stream-scheduler

A self-hosted scheduler for live streaming and recording pipelines built on
commonly available Blackmagic hardware — ATEM switchers, Web Presenters and
HyperDecks — with automated YouTube broadcast creation.

The goal is the operational experience of [Resi](https://resi.io) (scheduled
events that start and stop themselves, recurring services, one console for
encoders and destinations) on gear you already own, packaged the way
[Bitfocus Companion](https://github.com/bitfocus/companion) is: a headless
service with a local web UI, an optional tray app for Mac and Windows, and the
same image for Docker.

## Status

Early, but it does the job end to end: a recurring event creates its own
YouTube broadcast, points an encoder at the key YouTube issued, goes live,
records, stops and tidies up — without anyone touching it.

**Working now**

- Recurring events via RFC 5545 `RRULE`, timezone- and DST-correct, with
  per-occurrence skips and edits that survive changes to the series
- A durable run engine: prepare/start/stop/complete phases, retries,
  compensation, and crash recovery that cannot create duplicate work
- Date-aware name templates with a live preview of the next occurrences
- Encrypted stream keys and device passwords, write-only over the API
- Device connection management with capability probing and verify-after-write
- **HyperDeck** adapter (TCP 9993), tested against a protocol-level emulator
- **ATEM** adapter, with capabilities read from what the switcher reports
  rather than a model table that goes stale on the next firmware release
- **Streaming Encoder** (HD / 4K) adapter over the documented Control REST
  API, tested against a fake serving that API over real HTTP
- **YouTube**: bring-your-own OAuth, automated broadcast creation with
  templated title and description, automatic playlist insertion, a reusable
  ingestion stream so the encoder key never changes, and a quota ledger that
  keeps a reserve for the calls that make a stream happen
- Alerts to **Google Chat**, Slack, a generic webhook or email when a run
  fails, plus a pre-flight check the evening before that catches an expired
  YouTube token or an unplugged encoder while there is still time
- Calendar and list views, a run timeline, and a device health page
- Setup entirely in the browser: adding a device (with network discovery
  where a plugin supports it), connecting a YouTube account, building a
  pipeline, and writing a recurring event against a live preview of what the
  rule and the name templates would actually produce
- Runs headless, in Docker, or as an Electron tray app from one codebase

**Not built yet**

- Fanning one encoder out to several services at once, which needs a relay
  in the pipeline
- Week and day calendar views, and dragging an occurrence to reschedule it
- Backup and restore, and signed installers

None of the adapters has met real hardware yet, which is the biggest open
question about all of this.

Remaining work is tracked in
[issues](https://github.com/elliotmatson/stream-scheduler/issues). The
[risks](./docs/plan/08-roadmap-and-risks.md#risks) are worth reading before
you rely on this for a Sunday.

## Try it

```bash
pnpm install
pnpm build
pnpm smoke          # boots the built server and drives one event end to end
```

To run it for real:

```bash
export SCHEDULER_SECRET="a long random string"
node packages/host/dist/main.js
# then open http://127.0.0.1:8500
```

On a desktop the Electron build uses the OS keychain instead, so no
`SCHEDULER_SECRET` is needed.

### Docker

```bash
SCHEDULER_SECRET="a long random string" \
SCHEDULER_UI_PASSWORD="something only you know" \
docker compose up --build
```

The container binds `0.0.0.0`, so it refuses to start without
`SCHEDULER_UI_PASSWORD`: an unauthenticated page that can start broadcasts and
reveal stream keys is a worse hole than the unauthenticated device protocols
themselves. It also refuses to start without a key source rather than writing
secrets to disk in the clear.

Everything lives in one config directory (`/config` in Docker). A single
archive of it is the entire backup.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULER_CONFIG_DIR` | per-platform | Database, logs, master key |
| `SCHEDULER_SECRET` | — | Derives the master key when no keychain or key file is available |
| `SCHEDULER_UI_PASSWORD` | — | Required to bind anywhere but loopback |
| `SCHEDULER_HOST` | `127.0.0.1` | Listen address |
| `SCHEDULER_PORT` | `8500` | Listen port |
| `SCHEDULER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Connecting YouTube

Each install uses its own Google Cloud OAuth client. No client secret is
embedded in the binary, nothing waits on Google's verification review, and
each install gets its own 10,000 unit/day API budget rather than sharing one.

`GET /api/oauth/youtube/instructions` returns the exact steps and the redirect
URI to paste. One of them matters more than the rest:

> **Set the OAuth consent screen to "In production".** Left on "Testing",
> Google expires refresh tokens after 7 days, so every scheduled stream works
> for a week and then starts failing. The app names this specific cause when a
> refresh is rejected, but it is much easier to avoid.

## Layout

```
packages/
  plugin-sdk/       the versioned extension contract
  core/             scheduling, runs, secrets, devices, API
  plugin-atem/      Blackmagic ATEM switchers
  plugin-hyperdeck/ Blackmagic HyperDeck recorders
  plugin-streaming-encoder/  Blackmagic Streaming Encoder HD / 4K
  plugin-youtube/   YouTube broadcasts, OAuth and quota
  plugin-mock/      a fake encoder and recorder, for tests and evaluation
  host/             the composition root: the only place that names plugins
  web/              the React UI
  desktop/          the Electron tray shell
```

`core` never imports a plugin — it discovers them through a registry — and
plugins depend only on `plugin-sdk`. A dependency-cruiser rule in CI enforces
both, which is what keeps adding an encoder a matter of writing a package.

## Development

```bash
pnpm test          # unit and integration, no hardware or network needed
pnpm lint
pnpm typecheck
pnpm boundaries    # the plugin dependency rules
pnpm smoke         # runs the built artifact, as Docker does
```

`pnpm smoke` exists because Vitest bundles, which hides problems that only
appear in the shipped output under native ESM. Run it before trusting a build.

## Read the plan

Start with [`docs/plan/README.md`](./docs/plan/README.md).

| Document | Covers |
|---|---|
| [01 Architecture](./docs/plan/01-architecture.md) | Process model, runtime topology, what's borrowed from Companion |
| [02 Domain model](./docs/plan/02-domain-model.md) | The pipeline graph, entities, database schema |
| [03 Scheduling engine](./docs/plan/03-scheduling-engine.md) | Recurrence, run state machine, crash recovery |
| [04 Plugin SDK](./docs/plan/04-plugin-sdk.md) | The extension contract and the Phase 1 device adapters |
| [05 YouTube](./docs/plan/05-youtube.md) | OAuth, broadcast lifecycle, quota budget |
| [06 Templating & secrets](./docs/plan/06-templating-and-secrets.md) | Name templates, key management, encryption at rest |
| [07 Packaging](./docs/plan/07-packaging.md) | Monorepo, Electron, Docker, signing, CI |
| [08 Roadmap & risks](./docs/plan/08-roadmap-and-risks.md) | What shipped, and the risks worth keeping in view |

## Alerts

Add a channel under **Alerts**. Google Chat needs a webhook from the space
(Apps & integrations > Webhooks); the URL carries a key and token, so it is
stored encrypted and never shown again.

Send a test before trusting it. A channel nobody has proved works is worse
than none, because it reads as coverage while being silence.

Two things happen automatically once a channel exists: a failed run is
reported with the step that broke and a link into its timeline, and every
event is checked around 18 hours ahead — templates render, devices answer,
the YouTube authorization is still good. Messages about one event are
threaded together in Chat rather than scattered across the space.

## A note on network security

The Blackmagic control interfaces are all unauthenticated and unencrypted —
the ATEM protocol, HyperDeck on TCP 9993, and the Streaming Encoder's REST
API on port 80. Anyone who can reach the device can take it over, regardless
of what this app does. Put the gear and this app on a trusted control VLAN.

## License

[MIT](./LICENSE)
