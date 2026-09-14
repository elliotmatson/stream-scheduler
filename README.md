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

**Status: planning.** No implementation yet.

## Planned features

- Calendar and list views of every scheduled stream and recording
- Recurring series (RFC 5545 `RRULE`, timezone- and DST-correct) with
  per-occurrence overrides and skips
- OAuth login to YouTube; automated broadcast creation with title, description,
  privacy and category; automatic playlist insertion
- Stream key management, including pushing keys into encoders
- Encoder inventory with discovery, health and capability probing
- Date-aware name templates everywhere a name is entered
- Extensible: encoders, streaming services and video routing intermediaries are
  all plugins against one versioned SDK

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
| [08 Roadmap & risks](./docs/plan/08-roadmap-and-risks.md) | Phases with deliverables, open risks |

## License

[MIT](./LICENSE)
