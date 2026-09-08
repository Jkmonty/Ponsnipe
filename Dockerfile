# Ponsnipe — read-only public instance.
#
# Node 24 because the app uses node:sqlite, which is still flagged as
# experimental on 22 and stable enough to rely on here. package.json asks for
# >=22.5.0; the container pins higher on purpose so the runtime matches what
# this has actually been run and tested on.
#
# Three stages so the runtime image carries neither the toolchain nor the full
# node_modules tree: deps installs, build compiles, runtime carries the traced
# standalone server and nothing else.

# ── deps ────────────────────────────────────────────────────────────────
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` needs the dev dependencies: next build runs TypeScript.
#
# This also picks sharp's binary for THIS platform, which is why the install
# happens in the container rather than being copied in from the host — a
# node_modules built on Windows carries @img/sharp-win32-x64 and nothing that
# Linux can load. The lockfile lists all 26 platform packages, so x64 and
# arm64 hosts both resolve correctly.
RUN npm ci

# ── build ───────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Set at build time so anything reading it during the build agrees with the
# runtime. .dockerignore keeps .env and data/ out of the context entirely, so
# there is nothing secret here to bake in.
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* is inlined into the client bundle by `next build`, so it has to
# exist HERE, at build time. Setting it as a runtime secret does nothing at all
# — the value never reaches the browser, which is exactly what happened the
# first time this was wired up.
ARG NEXT_PUBLIC_REPO_URL=""
ENV NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL

RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Next's standalone server binds 127.0.0.1 unless told otherwise, which
    # inside a container means "reachable by nothing".
    HOSTNAME=0.0.0.0 \
    # Serve the feed and nothing else: no wallet, no trading UI. See README.
    PUBLIC_MODE=1 \
    # On the mounted volume, so the index survives a restart or redeploy.
    DATABASE_PATH=/data/positions.sqlite

# Runs as a non-root user that the base image already provides.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# public/ holds the brand artwork and is served from the site root. It is
# copied separately because `output: "standalone"` traces server code and does
# not carry static files with it.
#
# The directory must exist in the repo. A COPY of one that does not is a hard
# build failure rather than a no-op, which is what broke the very first deploy
# back when this line referred to a folder the project did not have.
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

# The standalone entrypoint, not `npm start` — there is no npm script in this
# image, and next start would want the full build output.
CMD ["node", "server.js"]
