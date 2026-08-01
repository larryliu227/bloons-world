# syntax=docker/dockerfile:1
#
# BLOONS WORLD — production image.
#
# One process, one port. The server serves the built client out of `dist` over
# HTTP *and* accepts the WebSocket upgrade on the same socket, so there is
# nothing to reverse-proxy and no second container to run. That is also why the
# client never has to be told where the server is: same origin, always.
#
# The runtime runs the TypeScript sources under `tsx` — the exact thing
# `npm start` runs locally. The price is ~11 MB (tsx + its esbuild binary); the
# payoff is that there is no build step whose output can differ from what was
# tested. Everything else `npm ci` pulls in (typescript, vite, concurrently)
# stays in the build stage.
#
#   docker build -t bloons-world .
#   docker run --rm -p 8080:8080 bloons-world     # then open http://localhost:8080

ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------------------
# Stage 1 — build the client
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build

WORKDIR /app
ENV CI=true

# Deps first so the layer caches until the lockfile actually changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Everything Vite needs to produce dist/. `server/` is here too because
# `npm run build` typechecks the whole project before it bundles.
COPY tsconfig.json vite.config.ts index.html ./
COPY shared ./shared
COPY client ./client
COPY server ./server

RUN npm run build && test -f dist/index.html

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

# tini is PID 1: it forwards SIGTERM/SIGINT to node (so the server's exit
# handlers actually run) and reaps zombies.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Runtime deps only: `ws` is the single production dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# tsx + its esbuild binary, lifted from the build stage rather than installed,
# so the lockfile-pinned versions are used and no dev tree is unpacked here.
# tsx@4 depends on esbuild only; if that ever changes this COPY fails loudly at
# build time rather than at boot.
COPY --from=build /app/node_modules/tsx ./node_modules/tsx
COPY --from=build /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=build /app/node_modules/@esbuild ./node_modules/@esbuild

COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server

# The built client, served by the same process on the same port.
COPY --from=build /app/dist ./dist

# `node` (uid 1000) ships with the base image. Nothing here needs to be writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# The server answers /health with JSON as soon as it is listening. Node is
# already in the image, so no curl/wget dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# `node --import tsx` keeps node as the direct child of tini — one process, and
# SIGTERM lands on the handler in server/index.ts.
CMD ["node", "--import", "tsx", "server/index.ts"]
