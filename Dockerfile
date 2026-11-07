# syntax=docker/dockerfile:1.7
# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
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
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/packages/shared ./packages/shared
COPY --from=build --chown=root:root /src/apps/server/package.json ./apps/server/
COPY --from=build --chown=root:root /src/apps/server/dist ./apps/server/dist
COPY --from=build --chown=root:root /src/apps/web/dist ./apps/web/dist
COPY --chown=root:root config /etc/asterius/config
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
WORKDIR /app/apps/server
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
CMD ["node", "dist/index.js"]
