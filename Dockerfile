# syntax=docker/dockerfile:1
#
# Production image of the app, for running it locally in a container (VS Code: `docker:run`).
#
#   docker build --pull -t ollama-bench:local .
#   docker run --rm --name ollama-bench-local --hostname ollama-bench-local -p 127.0.0.1:3300:3000 \
#     -v "$PWD/.env.docker:/app/.env:ro" ollama-bench:local
#
# Names: image <folder>:local, container and hostname <folder>-local (the VS Code tasks derive them from the
# workspace folder name).
#
# Secrets never enter the image: settings come only at run time (.env.docker mounted as /app/.env, which the server
# loads). The build needs none and gets none: .dockerignore keeps every .env* file out of the build context. That
# matters because `next build` copies every .env file it loads into the standalone output, which the image ships (a
# build-time .env once ended up in /app/.env this way); the build step also deletes any such copy, just in case.
#
# The image ships Next's standalone output (next.config.ts: output 'standalone'): server.js with only the node_modules
# the server actually loads, plus the files it reads by path (outputFileTracingIncludes: migrations, fixtures, sample
# files). One exception: the MCP test spawns scripts/mcp/benchmark-server.mjs as its own Node process, whose imports
# Next doesn't trace, so the builder bundles it with its dependencies into a single file.

# Node major only, never a patch version: each build with --pull gets the latest 24.x and its security fixes. Keep it
# equal to .nvmrc (the version for running the app on the host): test/node-version.test.ts fails if they differ.
ARG NODE_VERSION=24

# ---------- base: Node + pnpm at the version pinned in package.json ("packageManager")
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ---------- deps: every dependency, for the build
FROM base AS deps
# compilers for better-sqlite3, when no prebuilt binary matches musl + this Node version (build stages only)
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- builder: next build → .next/standalone
FROM deps AS builder
COPY . .
# no settings here (see the top); should a .env ever reach the context, its standalone copy must not reach the image
RUN pnpm build \
 && rm -f .next/standalone/.env*
# the MCP test's server, self-contained (see above); createRequire: its CommonJS dependencies inside an ES module
RUN pnpm exec esbuild scripts/mcp/benchmark-server.mjs --bundle --platform=node --format=esm --target=node24 \
      --log-level=warning \
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=.next/standalone/scripts/mcp/benchmark-server.mjs \
 && mkdir -p public .next/standalone/.next/cache

# ---------- runner: what the image ships
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Alpine security fixes released after the base image was built (e.g. openssl), and nothing the server doesn't use:
# it starts with `node` directly, so the npm, corepack and yarn bundled with the base image only add CVEs; the C
# headers are for compiling native addons, and the base image's APK index cache only feeds secret-scan false positives
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/include/node /var/cache/apk/*

# server.js, its traced node_modules and runtime files: owned by root, so the app can't rewrite its own code
COPY --from=builder /app/.next/standalone ./
# not part of the standalone output: the client assets and public files the server serves
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# the one place Next writes at run time
COPY --from=builder --chown=node:node /app/.next/standalone/.next/cache ./.next/cache

# not root; the database goes to /home/node/.ollama-bench/bench.db (BENCH_DB_PATH overrides it): mount a volume
# there to keep the history between runs
USER node
EXPOSE 3000
# HOSTNAME=0.0.0.0: all interfaces inside the container, since Docker's port mapping can't reach a loopback-only
# server. Publish the port on the host's loopback only (-p 127.0.0.1:3300:3000): the app has no authentication.
CMD ["node", "server.js"]
