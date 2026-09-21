import { createHash, randomUUID } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  generationStartSchema,
  mediaEstimateRequestSchema,
  type MediaBridgeResponse,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  adCreativeUploads,
  adVideoUploads,
  agentProposals,
  mediaAssets,
  mediaGenerations,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { readFile } from 'node:fs/promises';
import { openMedia } from './library.js';
import {
  StudioRefusal,
  advanceGeneration,
  createEstimate,
  listModels,
  recentGenerations,
  resolvePublicLink,
  resumeGenerations,
  startGeneration,
  studioDepsOf,
  toGeneration,
  usageOf,
} from './studio.js';

const idParam = z.object({ id: z.uuid() });
/** The smallest side an ad image may have: the same rule as a direct upload. */
const MIN_AD_SIDE = 600;

const STATUS_OF: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  cannot_estimate: 422,
  kairogen_unavailable: 502,
  not_connected: 503,
};

function sendRefusal(reply: FastifyReply, error: StudioRefusal) {
  return reply
    .status(STATUS_OF[error.code] ?? 409)
    .send({ error: error.code, message: error.message });
}

/**
 * Marketing → Edição de Fotos e Vídeos. Reading needs `marketing.media.read`;
 * anything that can spend a credit needs `marketing.media.generate`, and even
 * then only a click on an estimate spends it.
 */
export const mediaStudioRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const deps = studioDepsOf(app.wings);
  void resumeGenerations(deps).catch(() => undefined);

  app.get(
    '/media/studio',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (request, reply) => {
      const row = await db.query.integrationConnections.findFirst();
      const connected = deps.kairogen !== null && row?.state === 'connected';
      return reply.send({
        connected,
        storageAvailable: deps.mediaDir !== null,
        usage: await usageOf(deps, request.session.actor.employeeId, { withBalance: connected }),
      });
    },
  );

  app.get(
    '/media/models',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (request, reply) => {
      const query = z
        .object({ kind: z.enum(['image', 'video']).optional() })
        .safeParse(request.query);
      try {
        const { models, cachedAt } = await listModels(deps);
        const kind = query.success ? query.data.kind : undefined;
        return reply.send({
          models: models.filter((model) => !kind || model.kind === kind),
          cachedAt,
        });
      } catch (error) {
        if (error instanceof StudioRefusal) return sendRefusal(reply, error);
        throw error;
      }
    },
  );

  app.post(
    '/media/estimates',
    { preHandler: app.requirePermission('marketing.media.generate') },
    async (request, reply) => {
      const body = mediaEstimateRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: body.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      try {
        const estimate = await createEstimate(deps, {
          employeeId: request.session.actor.employeeId,
          request: body.data,
        });
        return reply.status(201).send({ estimate });
      } catch (error) {
        if (error instanceof StudioRefusal) return sendRefusal(reply, error);
        throw error;
      }
    },
  );

  /** The click. The body names an estimate and nothing else: what is generated is what was priced. */
  app.post(
    '/media/generations',
    { preHandler: app.requirePermission('marketing.media.generate') },
    async (request, reply) => {
      const body = generationStartSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: 'Informe a estimativa.' });
      }
      const employeeId = request.session.actor.employeeId;
      try {
        const row = await startGeneration(deps, { employeeId, estimateId: body.data.estimateId });
        if (row.proposalId) {
          await db
            .update(agentProposals)
            .set({ status: 'requested', actedBy: employeeId, actedAt: new Date() })
            .where(eq(agentProposals.id, row.proposalId));
        }
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'media.generation_started',
          entity: 'media_generation',
          entityId: row.id,
          ip: request.ip,
          metadata: {
            operation: row.operation,
            model: row.model,
            creditsEstimated: row.creditsEstimated,
            status: row.status,
            fromAgentProposal: row.proposalId !== null,
          },
        });
        return reply.status(201).send({ generation: await toGeneration(db, row) });
      } catch (error) {
        if (error instanceof StudioRefusal) return sendRefusal(reply, error);
        throw error;
      }
    },
  );

  app.get(
    '/media/generations',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (_request, reply) => {
      const rows = await recentGenerations(db);
      return reply.send({
        generations: await Promise.all(rows.map((row) => toGeneration(db, row))),
      });
    },
  );

  /** The screen follows a generation here. Asking also moves it forward when it is due. */
  app.get(
    '/media/generations/:id',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const row = params.success ? await advanceGeneration(deps, params.data.id) : null;
      const current =
        row ??
        (params.success
          ? await db.query.mediaGenerations.findFirst({
              where: eq(mediaGenerations.id, params.data.id),
            })
          : null);
      if (!current)
        return reply.status(404).send({ error: 'not_found', message: 'Geração não encontrada.' });
      return reply.send({ generation: await toGeneration(db, current) });
    },
  );

  /**
   * The bridge to the campaign builder: a library asset becomes a creative (or
   * a video) the builder already knows how to publish, under the same checks as
   * a direct upload.
   */
  app.post(
    '/media/assets/:id/use-in-builder',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      if (!app.can(request, 'marketing.media.read')) {
        return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
      }
      const params = idParam.safeParse(request.params);
      const asset = params.success
        ? await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, params.data.id) })
        : undefined;
      if (!asset)
        return reply.status(404).send({ error: 'not_found', message: 'Mídia não encontrada.' });
      if (!deps.mediaDir) {
        return reply.status(503).send({
          error: 'media_storage_unavailable',
          message: 'O armazenamento de mídia não está configurado neste ambiente.',
        });
      }
      const root = resolve(deps.mediaDir);
      const path = resolve(root, asset.storageKey);
      const info = path.startsWith(root + sep) ? await stat(path).catch(() => null) : null;
      if (!info?.isFile() || info.size !== asset.byteSize) {
        return reply
          .status(404)
          .send({ error: 'file_missing', message: 'O arquivo desta mídia não está no volume.' });
      }
      const employeeId = request.session.actor.employeeId;
      const body: MediaBridgeResponse = { mediaAssetId: asset.id, creative: null, video: null };

      if (asset.kind === 'image') {
        if (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') {
          return reply.status(400).send({
            error: 'unsupported_for_ads',
            message: 'Anúncios aceitam PNG ou JPEG. Esta imagem é WebP.',
          });
        }
        if (Math.min(asset.width ?? 0, asset.height ?? 0) < MIN_AD_SIDE) {
          return reply.status(400).send({
            error: 'image_too_small',
            message: `A imagem tem ${asset.width} × ${asset.height} px. O lado menor precisa de pelo menos ${MIN_AD_SIDE} px.`,
          });
        }
        const bytes = await readFile(path);
        const [creative] = await db
          .insert(adCreativeUploads)
          .values({
            mimeType: asset.mimeType,
            width: asset.width ?? 0,
            height: asset.height ?? 0,
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            data: bytes,
            uploadedBy: employeeId,
          })
          .returning({ id: adCreativeUploads.id });
        if (!creative) throw new Error('failed to record creative');
        body.creative = {
          id: creative.id,
          mimeType: asset.mimeType,
          width: asset.width ?? 0,
          height: asset.height ?? 0,
          byteSize: bytes.length,
        };
      } else {
        if (!env.CREATIVE_VIDEO_DIR) {
          return reply.status(503).send({
            error: 'video_storage_unavailable',
            message: 'O armazenamento de vídeos de anúncio não está configurado neste ambiente.',
          });
        }
        const storageKey = `${randomUUID()}.mp4`;
        await copyFile(path, join(env.CREATIVE_VIDEO_DIR, storageKey));
        const [video] = await db
          .insert(adVideoUploads)
          .values({
            mimeType: 'video/mp4',
            byteSize: asset.byteSize,
            sha256: asset.sha256,
            storageKey,
            uploadedBy: employeeId,
          })
          .returning({ id: adVideoUploads.id });
        if (!video) throw new Error('failed to record video');
        body.video = { id: video.id, mimeType: 'video/mp4', byteSize: asset.byteSize };
      }

      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'media.asset_used_in_builder',
        entity: 'media_asset',
        entityId: asset.id,
        ip: request.ip,
        metadata: { kind: asset.kind },
      });
      return reply.status(201).send(body);
    },
  );

  /**
   * NO login: this is the address Kairogen reads a reference image from. It
   * opens one asset, for fifteen minutes, to whoever holds the signature — and
   * says nothing about why when it does not open.
   */
  app.get('/media/public/:id', async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const query = z.object({ sig: z.string().min(20).max(100) }).safeParse(request.query);
    const asset =
      params.success && query.success
        ? await resolvePublicLink(deps, params.data.id, query.data.sig)
        : null;
    const stream =
      asset && deps.mediaDir
        ? await openMedia(deps.mediaDir, asset.storageKey, asset.byteSize)
        : null;
    if (!asset || !stream) return reply.status(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', asset.mimeType)
      .header('Content-Length', asset.byteSize)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Robots-Tag', 'noindex')
      .send(stream);
  });
};
