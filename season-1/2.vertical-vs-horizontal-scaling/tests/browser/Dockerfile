FROM mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
RUN npm install --global pnpm@11.25.0
WORKDIR /tests
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-lock.yaml ./
RUN pnpm --pm-on-fail=ignore install --frozen-lockfile
COPY grafana.mjs ./
USER pwuser
CMD ["node", "grafana.mjs"]
