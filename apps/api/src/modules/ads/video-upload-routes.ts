import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_VIDEO_BYTES,
  VIDEO_MIME_TYPES,
  VIDEO_UPLOAD_PART_BYTES,
  type VideoUpload,
  type VideoUploadSession,
} from '@wings/shared';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adVideoUploadSessions, adVideoUploads } from '../../db/schema/index.js';

/**
 * Ad videos, uploaded in parts.
 *
 * One request per part of `VIDEO_UPLOAD_PART_BYTES`, sent in order. A single
 * 4 GB request does not survive the proxy's read timeout nor Node's request
 * timeout, and gives the screen no bar to move; parts do both. The bytes land
 * in `<storageKey>.part` on the video volume; `complete` checks the size and
 * the `ftyp` box, hashes the file once, renames it and records it exactly as
 * the one-request upload does. Nothing here reaches an ad platform.
 *
 * A session is its opener's: anyone else gets 404, never 403 — an id must not
 * confirm that someone else's upload exists.
 */

const SESSION_HOURS = 24;

const idParamSchema = z.object({ id: z.string().uuid() });
const partParamSchema = z.object({ id: z.string().uuid(), n: z.coerce.number().int().min(1) });
const openSchema = z.object({
  mimeType: z.enum(VIDEO_MIME_TYPES),
  byteSize: z.number().int().positive(),
});

type SessionRow = typeof adVideoUploadSessions.$inferSelect;

function partsOf(byteSize: number, partSize: number): number {
  return Math.ceil(byteSize / partSize);
}

function publicSession(row: SessionRow): VideoUploadSession {
  return {
    id: row.id,
    partSize: row.partSize,
    parts: partsOf(row.byteSize, row.partSize),
    receivedBytes: row.receivedBytes,
    nextPart: row.nextPart,
  };
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ error: 'not_found', message: 'Envio não encontrado.' });
}

function noVolume(reply: FastifyReply) {
  return reply.status(503).send({
    error: 'video_storage_not_configured',
    message:
      'O armazenamento de vídeos não está configurado neste ambiente. Nenhum vídeo foi guardado.',
  });
}

export const videoUploadRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  // One part at a time reaches the handler as a stream: never a whole part in memory.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );

  /** The opener's own session, or nothing. */
  async function sessionOf(id: string, employeeId: string): Promise<SessionRow | undefined> {
    return db.query.adVideoUploadSessions.findFirst({
      where: and(
        eq(adVideoUploadSessions.id, id),
        eq(adVideoUploadSessions.uploadedBy, employeeId),
      ),
    });
  }

  /** Sessions nobody finished in a day: rows and their partial files. Best effort. */
  async function purgeExpired(directory: string) {
    const expired = await db
      .delete(adVideoUploadSessions)
      .where(lt(adVideoUploadSessions.expiresAt, new Date()))
      .returning({ storageKey: adVideoUploadSessions.storageKey });
    for (const row of expired) {
      await rm(join(directory, `${row.storageKey}.part`), { force: true }).catch(() => undefined);
    }
  }

  app.post(
    '/ads/videos/uploads',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const directory = env.CREATIVE_VIDEO_DIR;
      if (!directory) return noVolume(reply);

      const parsed = openSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_video', message: 'Envie um vídeo MP4 ou MOV.' });
      }
      const { mimeType, byteSize } = parsed.data;
      if (byteSize > MAX_VIDEO_BYTES) {
        return reply
          .status(413)
          .send({ error: 'video_too_large', message: 'O vídeo passa de 4 GB.' });
      }

      await mkdir(directory, { recursive: true });
      await purgeExpired(directory);

      // The name on disk is ours. Nothing a client sends ever becomes a path.
      const storageKey = `${randomUUID()}.${mimeType === 'video/quicktime' ? 'mov' : 'mp4'}`;
      const now = new Date();
      const [row] = await db
        .insert(adVideoUploadSessions)
        .values({
          mimeType,
          byteSize,
          partSize: VIDEO_UPLOAD_PART_BYTES,
          storageKey,
          uploadedBy: request.session.actor.employeeId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000),
        })
        .returning();
      if (!row) throw new Error('failed to open video upload');
      // The partial file exists from the start, so a part can always append.
      await (await open(join(directory, `${storageKey}.part`), 'w')).close();
      return reply.status(201).send({ upload: publicSession(row) });
    },
  );

  app.get(
    '/ads/videos/uploads/:id',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await sessionOf(params.data.id, request.session.actor.employeeId)
        : undefined;
      if (!row) return notFound(reply);
      return reply.send({ upload: publicSession(row) });
    },
  );

  app.put(
    '/ads/videos/uploads/:id/parts/:n',
    { preHandler: app.requirePermission('ads.request'), bodyLimit: VIDEO_UPLOAD_PART_BYTES },
    async (request, reply) => {
      const directory = env.CREATIVE_VIDEO_DIR;
      if (!directory) return noVolume(reply);
      const params = partParamSchema.safeParse(request.params);
      const row = params.success
        ? await sessionOf(params.data.id, request.session.actor.employeeId)
        : undefined;
      if (!row || !params.success) return notFound(reply);

      const { n } = params.data;
      const parts = partsOf(row.byteSize, row.partSize);
      // A retry of something already here: say yes again, write nothing.
      if (n < row.nextPart) return reply.send({ upload: publicSession(row) });
      if (n > parts || n !== row.nextPart) {
        return reply.status(409).send({
          error: 'part_out_of_order',
          message: `Esperava a parte ${row.nextPart}.`,
          expected: row.nextPart,
        });
      }
      const expectedSize = n === parts ? row.byteSize - (parts - 1) * row.partSize : row.partSize;

      // Counted on the way in and refused as a whole: a wrong-sized part never
      // lands in the file, so the offset of the next one stays right. The body
      // is read to its end either way (the route's bodyLimit caps it at one
      // part), so the connection is left clean for the answer.
      const chunks: Buffer[] = [];
      let received = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received <= expectedSize) chunks.push(chunk);
          done();
        },
      });
      try {
        await pipeline(request.body as NodeJS.ReadableStream, meter);
      } catch {
        return reply
          .status(400)
          .send({
            error: 'upload_interrupted',
            message: 'O envio foi interrompido. Tente de novo.',
          });
      }
      if (received !== expectedSize) {
        return reply.status(400).send({
          error: 'part_size_mismatch',
          message: `A parte ${n} tem ${received} bytes; esperava ${expectedSize}.`,
        });
      }

      const partial = join(directory, `${row.storageKey}.part`);
      const handle = await open(partial, 'r+').catch(() => null);
      if (!handle) return notFound(reply);
      try {
        await handle.write(Buffer.concat(chunks), 0, received, (n - 1) * row.partSize);
      } finally {
        await handle.close();
      }

      const [updated] = await db
        .update(adVideoUploadSessions)
        .set({ receivedBytes: row.receivedBytes + received, nextPart: n + 1 })
        .where(eq(adVideoUploadSessions.id, row.id))
        .returning();
      if (!updated) throw new Error('failed to record video part');
      return reply.send({ upload: publicSession(updated) });
    },
  );

  app.post(
    '/ads/videos/uploads/:id/complete',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const directory = env.CREATIVE_VIDEO_DIR;
      if (!directory) return noVolume(reply);
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await sessionOf(params.data.id, request.session.actor.employeeId)
        : undefined;
      if (!row) return notFound(reply);
      const partial = join(directory, `${row.storageKey}.part`);

      if (row.receivedBytes !== row.byteSize) {
        return reply.status(409).send({
          error: 'upload_incomplete',
          message: `Faltam partes: ${row.receivedBytes} de ${row.byteSize} bytes chegaram.`,
          upload: publicSession(row),
        });
      }

      // MP4 and MOV both carry an `ftyp` box at byte 4: what the header claims
      // is not proof, what the bytes say is.
      const hash = createHash('sha256');
      let head = Buffer.alloc(0);
      let byteSize = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          byteSize += chunk.length;
          if (head.length < 12) head = Buffer.concat([head, chunk]).subarray(0, 12);
          hash.update(chunk);
          done();
        },
      });
      const readable = await pipeline(createReadStream(partial), meter)
        .then(() => true)
        .catch(() => false);
      const isVideo =
        readable &&
        byteSize === row.byteSize &&
        byteSize >= 12 &&
        head.subarray(4, 8).toString('latin1') === 'ftyp';
      if (!isVideo) {
        await rm(partial, { force: true });
        await db.delete(adVideoUploadSessions).where(eq(adVideoUploadSessions.id, row.id));
        return reply
          .status(400)
          .send({ error: 'invalid_video', message: 'O arquivo não é um vídeo MP4 ou MOV válido.' });
      }

      await rename(partial, join(directory, row.storageKey));
      const [stored] = await db
        .insert(adVideoUploads)
        .values({
          mimeType: row.mimeType,
          byteSize: row.byteSize,
          sha256: hash.digest('hex'),
          storageKey: row.storageKey,
          uploadedBy: request.session.actor.employeeId,
        })
        .returning({ id: adVideoUploads.id });
      if (!stored) throw new Error('failed to store video');
      await db.delete(adVideoUploadSessions).where(eq(adVideoUploadSessions.id, row.id));

      const video: VideoUpload = {
        id: stored.id,
        mimeType: row.mimeType as VideoUpload['mimeType'],
        byteSize: row.byteSize,
      };
      return reply.status(201).send({ video });
    },
  );

  app.delete(
    '/ads/videos/uploads/:id',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await sessionOf(params.data.id, request.session.actor.employeeId)
        : undefined;
      if (!row) return notFound(reply);
      if (env.CREATIVE_VIDEO_DIR) {
        await rm(join(env.CREATIVE_VIDEO_DIR, `${row.storageKey}.part`), { force: true });
      }
      await db.delete(adVideoUploadSessions).where(eq(adVideoUploadSessions.id, row.id));
      return reply.status(204).send();
    },
  );
};
