# Build context is the repository root.
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app

# Install with the lockfile first so dependency layers cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @wings/shared build && pnpm --filter @wings/worker build

# Keep only production dependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production

# FFmpeg for ffprobe and render; Python for faster-whisper and auto-editor;
# fonts-dejavu-core is the one typeface the render job draws text with
# (apps/worker/src/jobs/render/fonts.ts) — never downloaded at render time.
# No CUDA: CPU only, same as staging and production hosts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# An isolated venv: Debian's system Python refuses `pip install` outside one.
# Left world-readable (the venv's own default) so the non-root runtime user
# below can run it; nothing needs to write to it after this build step.
RUN python3 -m venv /opt/wings-worker-venv
ENV PATH="/opt/wings-worker-venv/bin:${PATH}"
RUN pip install --no-cache-dir faster-whisper auto-editor opencv-python-headless

# Smart captions (caption_layout): YuNet for faces and the PP-OCRv3 text
# detector, from the OpenCV model zoo, baked in and checked by SHA-256 so the
# job never downloads anything at run time.
ENV CAPTION_MODELS_DIR=/opt/wings-worker-models/captions
COPY apps/worker/scripts/fetch_caption_models.py /tmp/fetch_caption_models.py
RUN python3 /tmp/fetch_caption_models.py && rm /tmp/fetch_caption_models.py

# Bake the "small" model into the image at build time: staging and production
# hosts should not depend on reaching Hugging Face at container start.
ENV HF_HOME=/opt/wings-worker-models
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

WORKDIR /app

# Never run as root.
USER node

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
# packages/shared has its own runtime dependencies (zod), so its node_modules
# must travel with it.
COPY --from=builder --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=node:node /app/apps/worker/scripts ./apps/worker/scripts
COPY --from=builder --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json

# No port: this is a polling loop, not a server. It expects the API container
# to have already run `db:migrate` (see docker/api.Dockerfile); it waits and
# retries a few times on the "jobs" table if it hasn't yet.
WORKDIR /app/apps/worker

# No HTTP port to probe, so liveness is a file the polling loop touches every
# round (src/liveness.ts): stale for over 2 minutes means the loop is stuck.
# Not jobs.heartbeat_at — that column is only written while a job is running,
# so an idle worker would look unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD test -f /tmp/worker-alive && [ "$(( $(date +%s) - $(stat -c %Y /tmp/worker-alive) ))" -lt 120 ] || exit 1

CMD ["node", "dist/index.js"]
