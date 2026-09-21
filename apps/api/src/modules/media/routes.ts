import {
  MEDIA_ASPECTS,
  MEDIA_KINDS,
  MEDIA_MAX_TAGS,
  MEDIA_ORIGINS,
  MEDIA_UPLOAD_MAX_BYTES,
  MEDIA_UPLOAD_TYPES,
  mediaAspectOf,
} from '@wings/shared';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clients, employees, mediaAssets } from '../../db/schema/index.js';
import { activeClient } from '../clients/routes.js';
import { writeAudit } from '../../lib/audit.js';
import { mediaDirOf, openMedia, storeMedia, toMediaAsset } from './library.js';

const idParam = z.object({ id: z.uuid() });
const label = z.string().trim().max(80);
const tags = z.array(z.string().trim().min(1).max(40)).max(MEDIA_MAX_TAGS);

const listQuery = z.object({
  kind: z.enum(MEDIA_KINDS).optional(),
  origin: z.enum(MEDIA_ORIGINS).optional(),
  aspect: z.enum(MEDIA_ASPECTS).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  clientId: z.uuid().optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

const filing = z.object({
  clientId: z.uuid().optional(),
  folder: label.nullable().optional(),
  tags: tags.optional(),
});

/**
 * The media library. Reading needs `marketing.media.read`; adding and filing
 * need `marketing.media.generate`. A file is only ever served from here, to a
 * logged-in person with the permission: there is no public address to leak.
 */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const mediaDir = mediaDirOf(env);
  const unavailable = {
    error: 'media_storage_unavailable',
    message: 'O armazenamento de mídia não está configurado neste ambiente.',
  };

  // Scoped to this plugin: the rest of the API keeps refusing non-JSON bodies.
  app.addContentTypeParser(
    [...MEDIA_UPLOAD_TYPES],
    { parseAs: 'buffer', bodyLimit: MEDIA_UPLOAD_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get(
    '/media/assets',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Filtro inválido.' });
      }
      const { kind, origin, aspect, tag, clientId, q } = query.data;
      const rows = await db
        .select({ asset: mediaAssets, ownerName: employees.fullName, clientName: clients.name })
        .from(mediaAssets)
        .leftJoin(employees, eq(employees.id, mediaAssets.ownerId))
        .leftJoin(clients, eq(clients.id, mediaAssets.clientId))
        .where(
          and(
            kind ? eq(mediaAssets.kind, kind) : undefined,
            origin ? eq(mediaAssets.origin, origin) : undefined,
            tag ? sql`${tag} = any(${mediaAssets.tags})` : undefined,
            clientId ? eq(mediaAssets.clientId, clientId) : undefined,
            q
              ? or(
                  ilike(mediaAssets.prompt, `%${q.replace(/[%_\\]/g, '\\$&')}%`),
                  ilike(clients.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`),
                  ilike(mediaAssets.folder, `%${q.replace(/[%_\\]/g, '\\$&')}%`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(mediaAssets.createdAt))
        .limit(200);

      const assets = rows
        .filter((row) => !aspect || mediaAspectOf(row.asset.width, row.asset.height) === aspect)
        .map((row) => toMediaAsset(row.asset, { owner: row.ownerName, client: row.clientName }));
      return reply.send({ assets, storageAvailable: mediaDir !== null });
    },
  );

  app.get(
    '/media/assets/:id/file',
    { preHandler: app.requirePermission('marketing.media.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const asset = params.success
        ? await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, params.data.id) })
        : undefined;
      if (!asset)
        return reply.status(404).send({ error: 'not_found', message: 'Mídia não encontrada.' });
      if (!mediaDir) return reply.status(503).send(unavailable);

      const stream = await openMedia(mediaDir, asset.storageKey, asset.byteSize);
      if (!stream) {
        return reply
          .status(404)
          .send({ error: 'file_missing', message: 'O arquivo desta mídia não está no volume.' });
      }
      const extension = asset.storageKey.split('.').pop() ?? 'bin';
      return (
        reply
          .header('Content-Type', asset.mimeType)
          .header('Content-Length', asset.byteSize)
          // Private: a shared cache must never keep what needed a login to fetch.
          .header('Cache-Control', 'private, max-age=3600')
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Disposition',
            `inline; filename="wings-${asset.id.slice(0, 8)}.${extension}"`,
          )
          .send(stream)
      );
    },
  );

  app.post(
    '/media/assets',
    {
      preHandler: app.requirePermission('marketing.media.generate'),
      bodyLimit: MEDIA_UPLOAD_MAX_BYTES,
    },
    async (request, reply) => {
      if (!mediaDir) return reply.status(503).send(unavailable);
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.status(400).send({
          error: 'invalid_media',
          message: 'Envie uma imagem PNG, JPEG ou WebP, ou um vídeo MP4.',
        });
      }
      const employeeId = request.session.actor.employeeId;
      const stored = await storeMedia(db, mediaDir, {
        ownerId: employeeId,
        origin: 'upload',
        bytes,
      });
      if (!stored.ok) {
        return reply.status(400).send({
          error: 'invalid_media',
          message: 'O arquivo não é uma imagem PNG, JPEG ou WebP, nem um vídeo MP4 válido.',
        });
      }
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'media.asset_uploaded',
        entity: 'media_asset',
        entityId: stored.id,
        ip: request.ip,
        metadata: { byteSize: bytes.length },
      });
      const [row] = await db
        .select({ asset: mediaAssets, ownerName: employees.fullName, clientName: clients.name })
        .from(mediaAssets)
        .leftJoin(employees, eq(employees.id, mediaAssets.ownerId))
        .leftJoin(clients, eq(clients.id, mediaAssets.clientId))
        .where(eq(mediaAssets.id, stored.id));
      if (!row) throw new Error('asset vanished after insert');
      return reply
        .status(201)
        .send({ asset: toMediaAsset(row.asset, { owner: row.ownerName, client: row.clientName }) });
    },
  );

  app.patch(
    '/media/assets/:id',
    { preHandler: app.requirePermission('marketing.media.generate') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = filing.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos.' });
      }
      if (body.data.clientId && !(await activeClient(db, body.data.clientId))) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: 'Cliente não encontrado ou inativo.' });
      }
      const changes = {
        ...(body.data.clientId !== undefined ? { clientId: body.data.clientId } : {}),
        ...(body.data.folder !== undefined ? { folder: body.data.folder || null } : {}),
        ...(body.data.tags !== undefined
          ? { tags: [...new Set(body.data.tags.map((item) => item.toLowerCase()))] }
          : {}),
      };
      const [updated] =
        Object.keys(changes).length === 0
          ? await db.select().from(mediaAssets).where(eq(mediaAssets.id, params.data.id))
          : await db
              .update(mediaAssets)
              .set(changes)
              .where(eq(mediaAssets.id, params.data.id))
              .returning();
      if (!updated)
        return reply.status(404).send({ error: 'not_found', message: 'Mídia não encontrada.' });
      const [owner, client] = await Promise.all([
        db.query.employees.findFirst({ where: eq(employees.id, updated.ownerId) }),
        db.query.clients.findFirst({ where: eq(clients.id, updated.clientId) }),
      ]);
      return reply.send({
        asset: toMediaAsset(updated, {
          owner: owner?.fullName ?? null,
          client: client?.name ?? null,
        }),
      });
    },
  );
};
