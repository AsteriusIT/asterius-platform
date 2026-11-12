# syntax=docker/dockerfile:1.7
# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/brand/package.json packages/brand/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
# Slim and non-root; works with a read-only root filesystem (only /tmp and DATA_DIR are writable when SQLite is used).
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist \
    CONFIG_DIR=/etc/asterius/config \
    DATA_DIR=/data \
    NODE_OPTIONS=--enable-source-maps
# git: organizations can pull their configuration as code from their own repository (shallow, hardened clones).
# Package managers are not needed at runtime (CMD runs node directly) and their bundled dependencies (npm's undici,
# brace-expansion...) only add CVEs to the image scan: removed.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/packages/shared ./packages/shared
# Workspace-local node_modules hold versions that conflict with the hoisted ones (e.g. ajv 8 vs eslint's ajv 6).
COPY --from=build --chown=root:root /src/apps/server/package.json ./apps/server/
COPY --from=build --chown=root:root /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=root:root /src/apps/server/dist ./apps/server/dist
# Built-in connector definitions (YAML, read at startup).
COPY --from=build --chown=root:root /src/apps/server/connectors ./apps/server/connectors
COPY --from=build --chown=root:root /src/apps/web/dist ./apps/web/dist
COPY --chown=root:root config /etc/asterius/config
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
WORKDIR /app/apps/server
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
CMD ["node", "dist/index.js"]
