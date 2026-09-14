# syntax=docker/dockerfile:1

# --- build ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# Three files, none of which change when a package is added, so this layer
# caches on the dependency graph rather than on source.
#
# It used to copy each workspace manifest by hand, which is what broke this
# image: five were listed, ten existed, and the five packages added later
# installed nothing — `tsc` then could not resolve @scheduler/plugin-sdk.
# A hand-written list goes stale the moment a package is added, and the
# failure only ever surfaces inside Docker. `pnpm fetch` reads the lockfile,
# so it cannot go stale.
#
# package.json is not optional here: corepack reads `packageManager` from it
# to decide which pnpm to run. Without it corepack silently fetches the
# latest pnpm instead of the pinned one, and a major version with different
# defaults fails on a lockfile the pinned version accepts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm --version && pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --prefer-offline
RUN pnpm run build

# A self-contained production tree for the host alone: its own dist, the
# built web assets, and only the dependencies it actually imports.
#
# `pnpm prune --prod` stood here and did nothing useful. It prunes the root
# project only — pnpm leaves workspace devDependencies linked — so the
# runtime stage was copying TypeScript, Turbo, Vitest and ESLint into the
# shipped image. `pnpm deploy` resolves the workspace graph properly: 108 MB
# against 787 MB.
#
# The tree is flat, not a workspace: the host's own files land at the root
# of it, which is why the runtime paths below have no packages/host prefix.
RUN pnpm deploy --filter @scheduler/host --prod /deploy

# Load the entrypoint under native ESM without starting it. The module graph
# resolving here is what proves the tree is complete and that no dependency
# is imported in a way that only works under a bundler — the exact failure a
# CommonJS package imported by name produces at startup.
#
# It runs against /deploy rather than the build tree, which is the whole
# point: verifying the fat tree proves nothing about the one that ships.
RUN node --input-type=module -e "await import('/deploy/dist/main.js'); console.log('entrypoint loads')"

# --- runtime -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 scheduler

COPY --from=build --chown=scheduler:scheduler /deploy ./

# Created in the image, owned by the runtime user. Without this Docker
# creates the volume mountpoint itself, owned by root, and the container —
# which runs as uid 10001 — cannot write to it: every first start died with
# EACCES on mkdir '/config/logs'.
#
# Docker seeds a named or anonymous volume from the image directory,
# ownership included, so this covers `docker run` with no mount and the
# named volume in docker-compose.yml. A bind mount of a host directory keeps
# the host's ownership instead and has to be chowned to 10001 by hand.
RUN install -d -o scheduler -g scheduler /config

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
#
# SCHEDULER_HOST is 0.0.0.0 because a container has to listen on all of its
# own interfaces for -p to reach it. That is not the same as being on the
# LAN: what decides who can reach it is the address you publish to. There is
# no authentication yet, so publish to 127.0.0.1 unless you mean to share it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8500/healthz || exit 1

ENTRYPOINT ["node", "dist/main.js"]
