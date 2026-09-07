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
# No `public/` copy: this project does not have one. Its only static asset is
# src/app/icon.svg, which is a Next file convention the framework compiles and
# serves itself. A COPY of a directory that does not exist is a hard build
# failure, not a no-op — it is what broke the first deploy.

USER node
EXPOSE 3000

# The standalone entrypoint, not `npm start` — there is no npm script in this
# image, and next start would want the full build output.
CMD ["node", "server.js"]
