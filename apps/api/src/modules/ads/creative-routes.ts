import { createHash } from 'node:crypto';
import type { CreativeUpload } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adCreativeUploads } from '../../db/schema/index.js';
import { readImageInfo } from './image-info.js';

/**
 * Creative images for the campaign builder: upload one, read one back.
 *
 * Nothing here talks to an ad platform. An uploaded image lives in our
 * database only; getting it into Meta is a write that does not exist yet.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MIN_SIDE = 600;
const idParamSchema = z.object({ id: z.string().uuid() });

export const creativeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  // Scoped to this plugin: the rest of the API keeps refusing non-JSON bodies.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg'],
    { parseAs: 'buffer', bodyLimit: MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/ads/creatives',
    { preHandler: app.requirePermission('ads.request'), bodyLimit: MAX_BYTES },
    async (request, reply) => {
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply
          .status(400)
          .send({ error: 'invalid_image', message: 'Envie uma imagem PNG ou JPEG.' });
      }

      const info = readImageInfo(bytes);
      if (!info) {
        return reply.status(400).send({
          error: 'invalid_image',
          message: 'O arquivo não é uma imagem PNG ou JPEG válida.',
        });
      }
      if (Math.min(info.width, info.height) < MIN_SIDE) {
        return reply.status(400).send({
          error: 'image_too_small',
          message: `A imagem tem ${info.width} × ${info.height} px. O lado menor precisa de pelo menos ${MIN_SIDE} px.`,
        });
      }

      const [stored] = await db
        .insert(adCreativeUploads)
        .values({
          mimeType: info.mimeType,
          width: info.width,
          height: info.height,
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          data: bytes,
          uploadedBy: request.session.actor.employeeId,
        })
        .returning({ id: adCreativeUploads.id });
      if (!stored) throw new Error('failed to store creative');

      const creative: CreativeUpload = {
        id: stored.id,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        byteSize: bytes.length,
      };
      return reply.status(201).send({ creative });
    },
  );

  app.get(
    '/ads/creatives/:id',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await db.query.adCreativeUploads.findFirst({
            where: eq(adCreativeUploads.id, params.data.id),
          })
        : undefined;
      if (!row) {
        return reply.status(404).send({ error: 'not_found', message: 'Criativo não encontrado.' });
      }
      return (
        reply
          .header('Content-Type', row.mimeType)
          // The bytes under an id never change, so the browser may keep them.
          .header('Cache-Control', 'private, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .send(row.data)
      );
    },
  );
};
