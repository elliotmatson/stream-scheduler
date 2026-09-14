# syntax=docker/dockerfile:1

# --- build ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# Copy manifests first so dependency installation caches independently of source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/plugin-sdk/package.json  packages/plugin-sdk/
COPY packages/core/package.json        packages/core/
COPY packages/plugin-mock/package.json packages/plugin-mock/
COPY packages/host/package.json        packages/host/
COPY packages/web/package.json         packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Production-only, so the runtime image carries no build tooling.
RUN pnpm prune --prod

# Load the entrypoint under native ESM without starting it. The module graph
# resolving here is what proves the pruned tree is complete and that no
# dependency is imported in a way that only works under a bundler — the exact
# failure a CommonJS package imported by name produces at startup.
RUN node --input-type=module -e "await import('/app/packages/host/dist/main.js'); console.log('entrypoint loads')"

# --- runtime -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 scheduler

COPY --from=build --chown=scheduler:scheduler /app/node_modules          ./node_modules
COPY --from=build --chown=scheduler:scheduler /app/packages              ./packages
COPY --from=build --chown=scheduler:scheduler /app/package.json          ./package.json

USER scheduler

# The config directory holds the database, logs and the master key. A single
# archive of it is the entire backup, and restoring it is the entire recovery.
VOLUME ["/config"]
ENV SCHEDULER_CONFIG_DIR=/config \
    SCHEDULER_PORT=8500 \
    SCHEDULER_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 8500

# SCHEDULER_SECRET is required: without a key source the app refuses to start
# rather than writing stream keys and OAuth tokens to disk in the clear.
# SCHEDULER_UI_PASSWORD is required too, because SCHEDULER_HOST is 0.0.0.0 here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8500/healthz || exit 1

ENTRYPOINT ["node", "packages/host/dist/main.js"]
