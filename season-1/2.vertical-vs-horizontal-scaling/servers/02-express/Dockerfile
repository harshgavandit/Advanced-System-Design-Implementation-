# syntax=docker/dockerfile:1
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS toolchain
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM toolchain AS build
RUN pnpm --pm-on-fail=ignore install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm --pm-on-fail=ignore typecheck && pnpm --pm-on-fail=ignore test && pnpm --pm-on-fail=ignore build

FROM toolchain AS dependencies
RUN pnpm --pm-on-fail=ignore install --prod --frozen-lockfile

FROM cgr.dev/chainguard/wolfi-base@sha256:00fd4e9cdd9c5576c336d979fa663f9976f160c456b6ae9fe87e19c4e9c759a2 AS runtime-root
COPY runtime-packages.lock /tmp/runtime-packages.lock
# Install signed, version-locked glibc runtime packages into a fresh root.
# Keep the package database for SBOM/scanning; no shell or installer is copied.
RUN xargs apk --root /runtime --initdb --no-scripts --keys-dir /etc/apk/keys \
    --repositories-file /etc/apk/repositories add --no-cache < /tmp/runtime-packages.lock

FROM scratch AS runtime
COPY --from=runtime-root /runtime/ /
ARG SOURCE_TREE_SHA256=unrecorded
LABEL org.scaling.source.sha256=$SOURCE_TREE_SHA256
ENV NODE_ENV=production PORT=5002 PATH=/usr/bin
WORKDIR /app
COPY --from=dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json runtime-packages.lock ./
USER 1000:1000
EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5002/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/container.js"]
