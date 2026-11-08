# Plan / render service (V2 preview). Build: docker build -t asterius-render:dev apps/render-service
#   RENDER_MODE=tofu (default, lean path): `tofu plan` of the Portal repo (cached shallow clone, git over HTTPS).
#   RENDER_MODE=crossplane (optional profile): `crossplane render`; the crossplane CLI (crank) embeds the render engine,
#   the composition functions run as sidecars of the pod, so no Docker daemon is needed at runtime.
# Versions are pinned and checksum verified. TOFU_VERSION follows the Portal repo's pin (portal-resources
# hack/install-tools.sh), so the preview plans with the same OpenTofu as the apply pipeline.
ARG NODE_IMAGE=node:24-alpine

FROM alpine:3.22 AS cli
ARG CROSSPLANE_VERSION=v2.1.0
ARG TOFU_VERSION=1.13.9
ARG TARGETARCH=amd64
RUN apk add --no-cache curl \
 && base="https://releases.crossplane.io/stable/${CROSSPLANE_VERSION}/bin/linux_${TARGETARCH}" \
 && curl -fsSLo /crossplane "${base}/crank" \
 && echo "$(curl -fsSL "${base}/crank.sha256" | cut -d' ' -f1)  /crossplane" | sha256sum -c - \
 && chmod 0755 /crossplane \
 && rel="https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}" \
 && tgz="tofu_${TOFU_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSLo "/tmp/${tgz}" "${rel}/${tgz}" \
 && curl -fsSL "${rel}/tofu_${TOFU_VERSION}_SHA256SUMS" | grep " ${tgz}\$" | sed "s# ${tgz}# /tmp/${tgz}#" | sha256sum -c - \
 && tar -xzf "/tmp/${tgz}" -C / tofu \
 && chmod 0755 /tofu

FROM ${NODE_IMAGE}
WORKDIR /app
# git: the plan service's cached clone of the Portal repo; ca-certificates for ADO and the provider registry.
RUN apk add --no-cache git ca-certificates
ENV NODE_ENV=production PORT=8080 RENDER_MODE=tofu HOME=/tmp \
    COMPOSITIONS_DIR=/compositions CROSSPLANE_BIN=/usr/local/bin/crossplane \
    TOFU_BIN=/usr/local/bin/tofu REPO_CACHE_DIR=/tmp/portal-resources TF_PLUGIN_CACHE_DIR=/tmp/tofu-plugins
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY --from=cli /crossplane /usr/local/bin/crossplane
COPY --from=cli /tofu /usr/local/bin/tofu
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
