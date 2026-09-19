import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_VIDEO_BYTES,
  PREVIEW_PLACEMENTS,
  VIDEO_MIME_TYPES,
  metaIdentitySchema,
  type MetaIdentities,
  type OfficialPreview,
  type VideoUpload,
} from '@wings/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adApprovalRequests,
  adExecutions,
  adVideoUploads,
  marketingMetaDefaults,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { stepsOfExecution } from './ad-tree.js';
import { createMetaClient } from './platform/factory.js';
import { MetaReadOnlyClient } from './platform/meta-client.js';

/**
 * What the builder needs from Meta before anything is created — which Pages
 * and Instagram accounts exist — plus video uploads and, once the ads exist,
 * Meta's own preview of them.
 *
 * Everything here that touches Meta is a read, made with a client built with
 * the write switch off. The only thing written is on our side: a video on the
 * mounted volume, and Wings' default choice of Page.
 */

const idParamSchema = z.object({ id: z.string().uuid() });

/** Meta's `ad_format` for each placement the screen can ask about. */
const AD_FORMAT: Record<(typeof PREVIEW_PLACEMENTS)[number], string> = {
  facebook_feed: 'DESKTOP_FEED_STANDARD',
  instagram_feed: 'INSTAGRAM_STANDARD',
  facebook_stories: 'FACEBOOK_STORY_MOBILE',
  instagram_stories: 'INSTAGRAM_STORY',
  facebook_reels: 'FACEBOOK_REELS_MOBILE',
  instagram_reels: 'INSTAGRAM_REELS',
};

const PREVIEW_HOSTS = ['https://www.facebook.com/', 'https://business.facebook.com/'];

export const metaRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, platformFetch } = app.wings;

  /** A reader for the active Meta account, whatever the write switch says. */
  async function metaReader(reply: FastifyReply): Promise<MetaReadOnlyClient | null> {
    const account = await db.query.adAccounts.findFirst({
      where: and(eq(adAccounts.platform, 'meta'), isNull(adAccounts.archivedAt)),
      orderBy: asc(adAccounts.createdAt),
    });
    const { client } = account
      ? createMetaClient({ ...env, ADS_WRITES_ENABLED: false }, account.externalId, platformFetch)
      : { client: null };
    if (!(client instanceof MetaReadOnlyClient)) {
      await reply.status(503).send({
        error: 'meta_not_configured',
        message: 'A Meta não está configurada neste ambiente.',
      });
      return null;
    }
    return client;
  }

  const metaUnavailable = (reply: FastifyReply) =>
    reply.status(502).send({
      error: 'meta_unavailable',
      message: 'A Meta não respondeu. Tente de novo em instantes.',
    });

  app.get(
    '/ads/meta/identities',
    { preHandler: app.requirePermission('ads.request') },
    async (_request, reply) => {
      const client = await metaReader(reply);
      if (!client) return reply;

      let pages: MetaIdentities['pages'];
      try {
        ({ pages } = await client.listIdentities());
      } catch {
        return metaUnavailable(reply);
      }

      const saved = await db.query.marketingMetaDefaults.findFirst();
      const identities: MetaIdentities = {
        pages,
        default: saved
          ? { pageId: saved.pageId, instagramActorId: saved.instagramActorId ?? null }
          : null,
      };
      return reply.send({ identities });
    },
  );

  app.put(
    '/ads/meta/identities/default',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = metaIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }

      // Only a Page Meta really lists for this account can become the default:
      // an id typed by hand would surface as a refusal at the worst moment.
      const client = await metaReader(reply);
      if (!client) return reply;
      let pages: MetaIdentities['pages'];
      try {
        ({ pages } = await client.listIdentities());
      } catch {
        return metaUnavailable(reply);
      }
      const page = pages.find((item) => item.id === parsed.data.pageId);
      const instagramKnown =
        parsed.data.instagramActorId === null ||
        page?.instagramAccounts.some((item) => item.id === parsed.data.instagramActorId);
      if (!page || !instagramKnown) {
        return reply.status(400).send({
          error: 'identity_not_found',
          message: 'A Página ou a conta do Instagram não está entre as que a Meta lista.',
        });
      }

      const values = {
        pageId: parsed.data.pageId,
        instagramActorId: parsed.data.instagramActorId,
        updatedBy: request.session.actor.employeeId,
        updatedAt: new Date(),
      };
      await db
        .insert(marketingMetaDefaults)
        .values(values)
        .onConflictDoUpdate({ target: marketingMetaDefaults.tenantId, set: values });

      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.meta_identity_default_saved',
        entity: 'marketing_meta_defaults',
        entityId: parsed.data.pageId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: { pageId: parsed.data.pageId, instagramActorId: parsed.data.instagramActorId },
      });

      return reply.send({ default: parsed.data });
    },
  );

  // --- videos ---------------------------------------------------------------

  // Hand the raw stream to the handler: a 4 GB body is never buffered.
  app.addContentTypeParser([...VIDEO_MIME_TYPES], (_request, payload, done) => done(null, payload));

  app.post(
    '/ads/videos',
    { preHandler: app.requirePermission('ads.request'), bodyLimit: MAX_VIDEO_BYTES },
    async (request, reply) => {
      const directory = env.CREATIVE_VIDEO_DIR;
      if (!directory) {
        return reply.status(503).send({
          error: 'video_storage_not_configured',
          message:
            'O armazenamento de vídeos não está configurado neste ambiente. Nenhum vídeo foi guardado.',
        });
      }

      const mimeType = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim();
      if (!(VIDEO_MIME_TYPES as readonly string[]).includes(mimeType ?? '')) {
        return reply
          .status(400)
          .send({ error: 'invalid_video', message: 'Envie um vídeo MP4 ou MOV.' });
      }

      await mkdir(directory, { recursive: true });
      // The name on disk is ours. Nothing a client sends ever becomes a path.
      const storageKey = `${randomUUID()}.${mimeType === 'video/quicktime' ? 'mov' : 'mp4'}`;
      const partial = join(directory, `${storageKey}.part`);

      const hash = createHash('sha256');
      let byteSize = 0;
      let head = Buffer.alloc(0);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          byteSize += chunk.length;
          if (byteSize > MAX_VIDEO_BYTES) return done(new Error('too_large'));
          if (head.length < 12) head = Buffer.concat([head, chunk]).subarray(0, 12);
          hash.update(chunk);
          done(null, chunk);
        },
      });

      try {
        await pipeline(request.body as NodeJS.ReadableStream, meter, createWriteStream(partial));
      } catch (error) {
        await rm(partial, { force: true });
        const tooLarge = error instanceof Error && error.message === 'too_large';
        return reply.status(tooLarge ? 413 : 400).send({
          error: tooLarge ? 'video_too_large' : 'upload_interrupted',
          message: tooLarge ? 'O vídeo passa de 4 GB.' : 'O envio foi interrompido. Tente de novo.',
        });
      }

      // MP4 and MOV both carry an `ftyp` box at byte 4: what the header claims
      // is not proof, what the bytes say is.
      if (byteSize < 12 || head.subarray(4, 8).toString('latin1') !== 'ftyp') {
        await rm(partial, { force: true });
        return reply
          .status(400)
          .send({ error: 'invalid_video', message: 'O arquivo não é um vídeo MP4 ou MOV válido.' });
      }

      await rename(partial, join(directory, storageKey));
      const [stored] = await db
        .insert(adVideoUploads)
        .values({
          mimeType: mimeType as string,
          byteSize,
          sha256: hash.digest('hex'),
          storageKey,
          uploadedBy: request.session.actor.employeeId,
        })
        .returning({ id: adVideoUploads.id });
      if (!stored) throw new Error('failed to store video');

      const video: VideoUpload = {
        id: stored.id,
        mimeType: mimeType as VideoUpload['mimeType'],
        byteSize,
      };
      return reply.status(201).send({ video });
    },
  );

  app.get(
    '/ads/videos/:id',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await db.query.adVideoUploads.findFirst({ where: eq(adVideoUploads.id, params.data.id) })
        : undefined;
      const filePath =
        row && env.CREATIVE_VIDEO_DIR ? join(env.CREATIVE_VIDEO_DIR, row.storageKey) : null;
      const info = filePath ? await stat(filePath).catch(() => null) : null;
      if (!row || !filePath || !info) {
        return reply.status(404).send({ error: 'not_found', message: 'Vídeo não encontrado.' });
      }

      // Byte ranges, so the browser's player can seek without the whole file.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      const partial = Boolean(range) && start <= end && start < info.size;

      reply
        .header('Content-Type', row.mimeType)
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff');
      if (partial) {
        return reply
          .status(206)
          .header('Content-Range', `bytes ${start}-${end}/${info.size}`)
          .header('Content-Length', end - start + 1)
          .send(createReadStream(filePath, { start, end }));
      }
      return reply.header('Content-Length', info.size).send(createReadStream(filePath));
    },
  );

  // --- official preview, once the ads exist -------------------------------------

  app.get(
    '/ads/approvals/:id/previews',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const query = z.object({ placement: z.enum(PREVIEW_PLACEMENTS) }).safeParse(request.query);
      if (!params.success || !query.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: 'Posicionamento inválido.' });
      }

      const approval = await db.query.adApprovalRequests.findFirst({
        where: eq(adApprovalRequests.id, params.data.id),
      });
      if (!approval) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const [execution] = await db
        .select({ id: adExecutions.id })
        .from(adExecutions)
        .where(eq(adExecutions.changeRequestId, approval.changeRequestId))
        .orderBy(desc(adExecutions.startedAt))
        .limit(1);
      const ads = execution
        ? (await stepsOfExecution(db, execution.id)).filter(
            (step) => step.kind === 'ad' && step.status === 'created' && step.externalId,
          )
        : [];
      if (ads.length === 0) {
        return reply.status(409).send({
          error: 'not_created_yet',
          message: 'Os anúncios ainda não existem na Meta.',
        });
      }

      const client = await metaReader(reply);
      if (!client) return reply;

      const previews: OfficialPreview[] = [];
      try {
        for (const ad of ads) {
          const src = await client.getAdPreview(
            ad.externalId as string,
            AD_FORMAT[query.data.placement],
          );
          // Only Meta's own preview host is ever handed to the browser to frame.
          if (src && PREVIEW_HOSTS.some((host) => src.startsWith(host))) {
            previews.push({ adName: ad.label, iframeSrc: src });
          }
        }
      } catch {
        return metaUnavailable(reply);
      }
      return reply.send({ previews });
    },
  );
};
