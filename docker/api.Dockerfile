# Build context is the repository root.
FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

# Install with the lockfile first so dependency layers cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
# Only so the frozen lockfile matches the workspace; the API never builds the editor core.
COPY packages/studio/package.json packages/studio/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @wings/shared build && pnpm --filter @wings/api build

# Keep only production dependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Never run the API as root.
USER node

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
# packages/shared has its own runtime dependencies (zod), so its node_modules
# must travel with it.
COPY --from=builder --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json

EXPOSE 3000
WORKDIR /app/apps/api

# No curl (and no guarantee of wget either) on node:alpine, so Coolify's
# default curl-based probe silently no-ops as "healthy" without ever calling
# the API. node has fetch built in, so use that to hit the real endpoint and
# fail the container for real when it doesn't answer with 2xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations and reference-data seeding run before the API accepts traffic.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && node dist/server.js"]
