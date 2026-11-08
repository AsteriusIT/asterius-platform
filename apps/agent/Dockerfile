# Catalog watcher. Build context: this directory (docker build -t asterius-agent:dev apps/agent).
# No dependencies: Node runs the TypeScript sources directly (type stripping), so there is no install or build step.
FROM node:24-alpine
ENV NODE_ENV=production \
    METRICS_PORT=9464
# Package managers are not needed at runtime (CVE surface).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY package.json ./
COPY src ./src
USER 1000:1000
EXPOSE 9464
CMD ["node", "src/index.ts"]
