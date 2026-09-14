# 07 — Packaging and distribution

The target is the Companion install experience: a non-technical user downloads a
`.dmg` or `.exe`, runs it, and gets a tray icon and a browser tab — while a
rack-mount user runs the same thing as a container.

## Monorepo

pnpm workspaces + Turborepo. Layout in [01](./01-architecture.md).

- **Node 22 LTS**, pinned via `.nvmrc` and `engines`.
- **TypeScript strict**, `noUncheckedIndexedAccess` on.
- **Vitest** for unit and integration, **Playwright** for the web UI.
- **Drizzle** migrations checked in; the app migrates on startup and refuses to
  run against a schema newer than the binary (a downgrade after a bad update must
  fail loudly, not corrupt the database).

## Config directory

One directory holds everything — database, logs, key file, plugin data:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/StreamScheduler` |
| Windows | `%APPDATA%\StreamScheduler` |
| Linux | `$XDG_CONFIG_HOME/stream-scheduler` |
| Docker | `/config` (a volume) |

Overridable with `--config-dir` / `SCHEDULER_CONFIG_DIR`, which also makes it easy
to run two instances side by side for testing.

**Backup and restore is a first-class feature, not an export button.** A single
zip of the config directory, restorable into a fresh install, with secrets
re-wrapped under the new install's master key. The user's entire schedule lives in
one SQLite file; losing it should be a ten-minute recovery.

## Desktop (Electron)

`electron-builder`. The Electron main process imports the same `core` package the
headless entrypoint does, so there is exactly one code path.

The tray app deliberately does very little: status dot, "Open UI", "Start at
login", "Check for updates", "Quit". All real UI is the web UI, opened in the
default browser or an Electron `BrowserWindow` — the same React app either way.

**Quit needs care.** Quitting the tray app while a broadcast is live must warn,
and should offer "keep running in the background". A confirmation dialog is not
optional here.

Auto-update via `electron-updater` against GitHub Releases, with a setting to
defer updates — nobody wants an update prompt at 08:55 on a Sunday. Consider
suppressing update checks entirely within an hour of any scheduled occurrence.

### Signing and notarization

This is a real, non-negotiable cost line, and it is the thing most likely to be
underestimated:

- **macOS** — Apple Developer ID ($99/year), hardened runtime, and notarization
  through Apple's service in CI. Without it, Gatekeeper blocks the app for
  ordinary users and the workaround instructions are the kind of thing that makes
  people give up.
- **Windows** — a code-signing certificate. Without one, SmartScreen warns on
  every download until the binary builds reputation. An OV certificate is a few
  hundred dollars a year; EV clears SmartScreen immediately but costs more and
  usually needs a hardware token, which complicates CI.

Budget the money and the CI plumbing for both in Phase 5. An unsigned installer
is not shippable to the audience this is for.

## Docker

Multi-stage, no Electron:

```dockerfile
FROM node:22-bookworm-slim AS build
# pnpm install --frozen-lockfile; turbo build --filter=core --filter=web

FROM node:22-bookworm-slim
RUN adduser --system --group scheduler
COPY --from=build /app/dist /app
USER scheduler
VOLUME /config
EXPOSE 8500
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8500/healthz || exit 1
ENTRYPOINT ["node", "/app/main.js", "--config-dir", "/config"]
```

- Runs as non-root.
- `linux/amd64` and `linux/arm64` (people run these on a Pi or an ARM NAS).
- `SCHEDULER_SECRET` is required, and the container exits with a clear message if
  it is missing rather than falling back to plaintext secrets.
- The OAuth wizard detects the container and uses the paste-the-code flow
  described in [05](./05-youtube.md), since it cannot open a local browser.

## CI

GitHub Actions:

- **PR** — lint, typecheck, unit + integration tests against the fake devices and
  the fake YouTube server, `dependency-cruiser` boundary check, Playwright UI
  tests. No hardware, no network, no real Google project.
- **Tag** — build and publish the Docker image, build/sign/notarize the macOS and
  Windows installers, attach to a GitHub Release, publish `plugin-sdk` to npm.

The fake-device suite is what makes a green PR meaningful. If CI can only prove
that the code compiles, the scheduler's reliability claims are untested and the
rest of this plan is decoration.
