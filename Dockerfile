# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Install all dependencies (needed to build web + server + shared)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/bridge/package.json packages/bridge/
COPY packages/web/package.json packages/web/
COPY packages/device/package.json packages/device/
COPY packages/device/scripts packages/device/scripts
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Production-only dependencies for the runtime image
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/bridge/package.json packages/bridge/
COPY packages/web/package.json packages/web/
COPY packages/device/package.json packages/device/
COPY packages/device/scripts packages/device/scripts
RUN pnpm install --prod --frozen-lockfile

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/zhunzou.db \
    GLOBAL_RULES_PATH=/app/data/GLOBAL_RULES.md \
    WEB_DIST_PATH=/app/packages/web/dist \
    SERVE_WEB=true

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=prod-deps --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=prod-deps --chown=node:node /app/packages/bridge/package.json ./packages/bridge/package.json
COPY --from=prod-deps --chown=node:node /app/packages/web/package.json ./packages/web/package.json

COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/bridge/dist ./packages/bridge/dist
COPY --from=build --chown=node:node /app/packages/web/dist ./packages/web/dist

COPY --chown=node:node GLOBAL_RULES.md ./data/GLOBAL_RULES.md
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
