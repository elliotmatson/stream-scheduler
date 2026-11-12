# Contributing

## Prerequisites

- Node 22, at least 22.11. `.nvmrc` pins the major version, and `engines` in
  `package.json` sets the floor.
- pnpm 9.12.3, the version in `packageManager`. The easiest way to get it is
  `corepack enable`, which reads that field.

## Getting started

```bash
pnpm install
pnpm build
node packages/host/dist/main.js   # the app, on http://127.0.0.1:8500
pnpm dev                          # in another terminal
```

`pnpm dev` runs only the web UI's Vite dev server, on
`http://localhost:5173`. It proxies `/api` and `/ws` to the app on
`127.0.0.1:8500`, so the app has to be running too. Rebuild and restart it
after changing anything outside `packages/web`.

Use a scratch config directory while you work, so you do not touch a real
install: `node packages/host/dist/main.js --config-dir ./tmp-config`.

## Checks

CI runs these, in this order. Run them before you push.

```bash
pnpm run format:check   # Prettier
pnpm run lint           # ESLint
pnpm run typecheck
pnpm run boundaries     # dependency-cruiser: the plugin rules
pnpm run test           # Vitest, no hardware or network needed
pnpm run build
pnpm run smoke          # boots the built app and drives one event end to end
pnpm exec playwright install chromium   # once
pnpm run ui-check       # loads the UI in a real browser
```

`pnpm format` fixes formatting.

CI then builds the Docker image, starts it, and checks it serves the UI and
the API, with and without a password.

## The desktop app

The Electron app in `packages/desktop` is experimental. It registers only the
mock device plugin.

```bash
pnpm build
cp -R packages/host/web packages/desktop/web
pnpm --filter @scheduler/desktop start   # run it
pnpm --filter @scheduler/desktop dist    # build installers into release/ at the repo root
```

The web UI is built into `packages/host/web`, and the desktop app serves it
from `packages/desktop/web`, hence the copy. Installers are not signed (#11).

## Writing a plugin

A device plugin is a package that depends on `@scheduler/plugin-sdk`. It must
not import `@scheduler/core`.
`pnpm run boundaries` fails if it does.

1. Read the contract in `packages/plugin-sdk/src/types.ts`. Background is in
   [docs/plan/04-plugin-sdk.md](./docs/plan/04-plugin-sdk.md).
2. Start from `packages/plugin-mock`. It is one file, and implements a fake
   encoder and recorder.
3. Export a function that returns a `PluginDefinition` with
   `apiVersion: '1'` (`SDK_API_VERSION`), a `configSchema` for the form, and
   `createDevice`.
4. Register it in `bundledPlugins()` in `packages/host/src/plugins.ts`, and add
   the package to `packages/host/package.json`.
5. Test it against a fake of the device's protocol, as the other plugins do.
   `withSerializingTransport` from `@scheduler/plugin-sdk` catches a
   value that could not cross a process boundary.

Streaming services implement `DestinationProvider`
(`packages/plugin-sdk/src/destination.ts`), and schedule sources implement
`PlanSource` (`packages/plugin-sdk/src/plan-source.ts`). Both are registered
in the same file.
