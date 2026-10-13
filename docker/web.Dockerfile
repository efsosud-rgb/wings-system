# Build context is the repository root.
FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/studio/package.json packages/studio/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/studio packages/studio
COPY apps/web apps/web
# The editor core (packages/studio) is built before the web app that bundles it.
RUN pnpm --filter @wings/shared build && pnpm --filter @wings/studio build && pnpm --filter @wings/web build

# Runtime image contains ONLY the built static files — no source, no node_modules.
FROM nginx:alpine AS runner
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/web-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
