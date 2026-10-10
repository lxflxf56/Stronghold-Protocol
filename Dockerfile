# syntax=docker/dockerfile:1
# 卫戍协议：盟约 · production image (server + static client). Docs: docs/DEPLOY.md「Docker」.
#
# Code: GPL-3.0-or-later (LICENSE). Game art/audio is © Hypergryph / Yostar, not covered by the GPL, non-commercial use
# only (NOTICE.md), and never part of the repository. Two ways to get it into a container:
#   A) download it while building (~250 MB, needs internet during the build):
#        docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
#   B) build without it and mount the host's copy (prepared with `node tools/setup.mjs` on the host):
#        docker build -t stronghold-protocol .
#        docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
#          -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
#      (public/fonts, data/assets.json and data/local-assets.json are copied from the build context when present)
# Without any art the game still runs with placeholder visuals.
#
# Layer order (the build cache): every step needs only what the stages above it copied, and the
# least-changing inputs come first — a source edit re-runs nothing above it. The runtime image
# keeps one layer per concern, so a small update re-pulls only that layer, not the ~130 MB of
# dependencies. .dockerignore keeps the build context (what the client sends before anything runs)
# down to the files the image actually uses.
#
# Run:  docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol
# Env:  PORT (3000), HOST (0.0.0.0), SP_COMBAT (client|server), SP_VERIFY (off|sample|all), TRUST_PROXY (auto|1|0), DEBUG

ARG NODE_IMAGE=node:22-alpine

# ---- 1. production dependencies (cached while package*.json are unchanged) -------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall (tools/vendor.mjs) runs in the next stage, once the sources are there
# The npm cache is a BuildKit cache mount: it survives rebuilds (a lockfile change re-downloads only
# what changed) and never becomes an image layer, so no `npm cache clean` is needed here.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- 2. vendored client libraries (cached while the lockfile and tools/vendor.mjs are unchanged) ----
# vendor.mjs copies files out of node_modules into public/vendor — it reads no application source,
# so it runs before the sources are copied and stays cached across code edits.
FROM deps AS vendor
COPY tools ./tools
RUN node tools/vendor.mjs

# ---- 3. sources + optional art download (least-changing first) --------------------------------------
FROM vendor AS build
ARG FETCH_ASSETS=0
COPY data ./data
COPY docs/research ./docs/research
COPY shared ./shared
COPY server ./server
COPY public ./public
RUN if [ "$FETCH_ASSETS" = "1" ]; then \
      node tools/fetch-assets.mjs || echo "WARNING: art download incomplete; the image falls back to placeholder art"; \
    fi \
 && rm -rf .cache

# ---- 4. runtime ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
# research tables: read by server/sim/nodeData.js as a fallback
COPY --from=build /app/docs/research ./docs/research

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server/index.js"]
