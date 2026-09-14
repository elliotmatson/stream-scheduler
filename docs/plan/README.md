# Stream & Recording Scheduler — Construction Plan

An open, self-hosted scheduler for live streaming and recording pipelines built on
commonly available Blackmagic hardware. It aims to replicate the operational
experience of [Resi](https://resi.io) — scheduled events that start and stop
themselves, a single console for encoders and destinations, recurring services —
without the proprietary encoder or the subscription.

It is packaged the way [Bitfocus Companion](https://github.com/bitfocus/companion)
is: a headless Node service with a local web UI, wrapped in an optional Electron
tray app for Mac/PC, and shipped as the same image for Docker.

## Documents

| # | Document | Covers |
|---|---|---|
| 01 | [Architecture](./01-architecture.md) | Process model, runtime topology, how Companion's patterns are and aren't borrowed |
| 02 | [Domain model](./02-domain-model.md) | Entities, the pipeline graph, database schema |
| 03 | [Scheduling engine](./03-scheduling-engine.md) | Recurrence, materialization, the run state machine, crash recovery |
| 04 | [Plugin SDK](./04-plugin-sdk.md) | The extension contract for encoders, destinations and routers |
| 05 | [YouTube integration](./05-youtube.md) | OAuth, broadcast lifecycle, quota budget, playlists |
| 06 | [Templating & secrets](./06-templating-and-secrets.md) | Name templates, stream key management, encryption at rest |
| 07 | [Packaging & distribution](./07-packaging.md) | Monorepo layout, Electron, Docker, signing, updates |
| 08 | [Roadmap & risks](./08-roadmap-and-risks.md) | What shipped, open risks, decisions already made. Remaining work lives in issues |

## Scope

**In scope for v1**

- Calendar and list views of every scheduled stream and recording
- Recurring series with per-occurrence overrides, skips and exceptions
- OAuth login to YouTube, automated broadcast creation (title, description,
  privacy, thumbnail, category), automated playlist insertion
- Stream key management, including pushing keys into encoders
- Encoder inventory, health and capability probing
- Date-aware name templates everywhere a name is entered
- Blackmagic ATEM (Mini Pro / Extreme and larger), Web Presenter HD/4K,
  and HyperDeck adapters
- Runs on macOS, Windows and Docker from one codebase

**Explicitly out of scope for v1**

- A hosted/cloud service. This is a local-first application.
- Cloud transcoding, simulated live, or VOD hosting. Resi does these; they
  require infrastructure this project deliberately does not have.
- A third-party plugin marketplace. The SDK contract is defined in v1;
  out-of-tree loading lands in v2.
- Multi-node / HA operation. The schema leaves room for it, nothing more.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Stack | TypeScript/Node + React, Electron shell | The Blackmagic protocol libraries (`atem-connection`, `hyperdeck-connection`) are already TypeScript, maintained by the Sofie project. Re-implementing the ATEM protocol in another language is the single largest avoidable risk. |
| Phase 1 hardware | ATEM Mini Pro/Extreme, Web Presenter HD/4K, HyperDeck | Covers the stream path and the record path with commonly owned gear. |
| YouTube auth | Bring-your-own OAuth client first, hosted client possible later | Avoids shipping a client secret in a desktop binary and avoids blocking v1 on Google's verification review. The credential layer is abstracted so a verified hosted client can be added without a schema change. |
| Recurrence | RFC 5545 `RRULE` + IANA timezone | Cron has no timezone, DST or exception-date semantics. A weekly church service across a DST boundary is the core use case and cron gets it wrong. |
