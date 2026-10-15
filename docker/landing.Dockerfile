# Landing pages (apps/landing): fale.wingscompany.com.br and, later, the client
# pages under lpfranquias.wingscompany.com.br. Build context is the repository root.
FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/landing/package.json apps/landing/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/landing apps/landing
# The wing points and the OG image are committed, so the build needs no browser.
RUN pnpm --filter @wings/shared build && pnpm --filter @wings/landing build

# Runtime image contains ONLY the built static files — no source, no node_modules.
FROM nginx:alpine AS runner
# Defaults for the template (docker/landing-nginx.conf); Coolify sets the real
# values. With no LANDING_HOSTS every page answers 404 (only /healthz answers).
ENV LANDING_HOSTS="" \
    LANDING_ROOT_SLUGS="" \
    LANDING_API_BASE="" \
    LANDING_GTM_ID="" \
    LANDING_INDEXABLE="false" \
    NGINX_ENVSUBST_FILTER="^LANDING_"
RUN rm -rf /usr/share/nginx/html/*
COPY docker/landing-nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/landing/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
