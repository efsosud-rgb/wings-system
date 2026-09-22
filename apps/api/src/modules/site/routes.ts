import { createHash } from 'node:crypto';
import {
  OWNED_CHANNEL_WINDOWS,
  type OwnedChannelsResponse,
  FEATURED_MIN_HEIGHT,
  FEATURED_MIN_WIDTH,
  SITE_IMAGE_MAX_BYTES,
  SITE_IMAGE_TYPES,
  isBigEnoughToFeature,
  parseVideoLink,
  renderSitePost,
  sitePostSchema,
  utmSlug,
  type SiteImageUpload,
  type SitePostOutcome,
  type SitePostRecord,
  type SiteStatus,
  type SiteTerm,
  type SiteTerms,
} from '@wings/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { employees, siteMediaUploads, sitePosts } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { writeAudit } from '../../lib/audit.js';
import { WordPressClient } from '../../lib/wordpress.js';
import { readImageInfo } from '../ads/image-info.js';
import { addDays, dayIn } from '../ads/dashboard/window.js';
import { mirroredPosts } from './blog-sync.js';

/**
 * Owned channels: Wings' own WordPress site.
 *
 * The one thing these routes can cause on the site is a DRAFT post and the new
 * media that goes in it. There is no approvals gate here because nothing
 * becomes public and no money moves: publishing stays a person's act inside
 * WordPress. Nothing that already exists on the site is ever touched.
 *
 * Images wait in our own database until the draft is sent, so they can be
 * validated and previewed without putting anything on the site. When it is
 * sent they are uploaded first, one by one, and the post is created only once
 * every one of them has arrived.
 */

export interface SiteRoutesOptions {
  /** Injected in tests; production builds the client from the environment. */
  wordpressFetch?: typeof fetch;
}

const TERMS_TTL_MS = 60 * 60 * 1000;
/** A person clicking "atualizar" repeatedly must not hammer a shared host. */
const TERMS_MIN_REFRESH_MS = 15 * 1000;

const idParamSchema = z.object({ id: z.string().uuid() });
const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface MediaRecord {
  role: 'featured' | 'inline';
  /** 1-based position among the body images; 0 for the featured image. */
  position: number;
  uploadId: string;
  wordpressMediaId: number;
  caption: string;
  inGallery: boolean;
}

function clientFrom(env: Env, fetchImpl?: typeof fetch): WordPressClient | null {
  if (!env.WORDPRESS_BASE_URL || !env.WORDPRESS_USERNAME || !env.WORDPRESS_APP_PASSWORD) {
    return null;
  }
  return new WordPressClient({
    baseUrl: env.WORDPRESS_BASE_URL,
    username: env.WORDPRESS_USERNAME,
    applicationPassword: env.WORDPRESS_APP_PASSWORD,
    fetchImpl,
  });
}

const NOT_CONFIGURED = {
  // Same rule as e-mail without SMTP: say so, never pretend it worked.
  error: 'site_not_configured',
  message: 'A integração com o WordPress ainda não foi configurada no servidor.',
};

export const siteRoutes: FastifyPluginAsync<SiteRoutesOptions> = async (app, options) => {
  const { db, env } = app.wings;

  // Scoped to this plugin: the rest of the API keeps refusing non-JSON bodies.
  app.addContentTypeParser(
    [...SITE_IMAGE_TYPES],
    { parseAs: 'buffer', bodyLimit: SITE_IMAGE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  let termsCache: { terms: SiteTerms; at: number } | null = null;

  /** The site's categories and tags, read at most once an hour. */
  async function siteTerms(client: WordPressClient, refresh: boolean): Promise<SiteTerms> {
    const age = termsCache ? Date.now() - termsCache.at : Infinity;
    if (termsCache && (refresh ? age < TERMS_MIN_REFRESH_MS : age < TERMS_TTL_MS)) {
      return termsCache.terms;
    }
    const [categories, tags] = await Promise.all([client.listCategories(), client.listTags()]);
    const byName = (a: SiteTerm, b: SiteTerm) => a.name.localeCompare(b.name, 'pt-BR');
    const terms: SiteTerms = {
      categories: categories.sort(byName),
      tags: tags.sort(byName),
      fetchedAt: new Date().toISOString(),
    };
    termsCache = { terms, at: Date.now() };
    return terms;
  }

  app.get(
    '/marketing/site/status',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      const client = clientFrom(env, options.wordpressFetch);
      const status: SiteStatus = {
        configured: client !== null,
        siteHost: client?.siteHost ?? null,
      };
      return reply.send({ status });
    },
  );

  /**
   * Canais próprios on the dashboard: the blog's posts by period, from the
   * mirror the ingest job keeps. Never calls the site.
   */
  app.get(
    '/marketing/site/blog-posts',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const asked = Number((request.query as { days?: string }).days ?? 30);
      const days = (OWNED_CHANNEL_WINDOWS as readonly number[]).includes(asked) ? asked : null;
      if (days === null) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: `Período inválido: use ${OWNED_CHANNEL_WINDOWS.join(', ')} dias.`,
        });
      }
      const now = (app.wings.now ?? (() => new Date()))();
      const until = dayIn(now);
      const since = addDays(until, -(days - 1));
      const mirror = await mirroredPosts(
        db,
        new Date(`${since}T00:00:00-03:00`),
        new Date(`${until}T23:59:59.999-03:00`),
      );
      const body: OwnedChannelsResponse = {
        days,
        since,
        until,
        blog: { configured: clientFrom(env, options.wordpressFetch) !== null, ...mirror },
        social: null,
      };
      return reply.send(body);
    },
  );

  app.get(
    '/marketing/site/terms',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const client = clientFrom(env, options.wordpressFetch);
      if (!client) return reply.status(503).send(NOT_CONFIGURED);
      const refresh = (request.query as { refresh?: string }).refresh === '1';
      try {
        return reply.send({ terms: await siteTerms(client, refresh) });
      } catch {
        // A stale list is better than none: the ids are still the site's.
        if (termsCache) return reply.send({ terms: termsCache.terms, stale: true });
        return reply.status(502).send({
          error: 'site_unreachable',
          message: 'Não foi possível ler as categorias e tags do site agora.',
        });
      }
    },
  );

  /** Holds one image in OUR database. Nothing goes to the site from here. */
  app.post(
    '/marketing/site/images',
    { preHandler: app.requirePermission('site.publish'), bodyLimit: SITE_IMAGE_MAX_BYTES },
    async (request, reply) => {
      const bytes = request.body;
      const info = Buffer.isBuffer(bytes) && bytes.length > 0 ? readImageInfo(bytes) : null;
      if (!Buffer.isBuffer(bytes) || !info) {
        return reply.status(400).send({
          error: 'invalid_image',
          message: 'O arquivo não é uma imagem JPG, PNG ou WebP válida.',
        });
      }

      const [stored] = await db
        .insert(siteMediaUploads)
        .values({
          mimeType: info.mimeType,
          width: info.width,
          height: info.height,
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          data: bytes,
          uploadedBy: request.session.actor.employeeId,
        })
        .returning({ id: siteMediaUploads.id });
      if (!stored) throw new Error('failed to store image');

      const image: SiteImageUpload = {
        id: stored.id,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        byteSize: bytes.length,
      };
      return reply.status(201).send({ image });
    },
  );

  app.get(
    '/marketing/site/images/:id',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await db.query.siteMediaUploads.findFirst({
            where: eq(siteMediaUploads.id, params.data.id),
          })
        : undefined;
      if (!row) {
        return reply.status(404).send({ error: 'not_found', message: 'Imagem não encontrada.' });
      }
      return reply
        .header('Content-Type', row.mimeType)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(row.data);
    },
  );

  app.get(
    '/marketing/site/posts',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      const rows = await db
        .select({
          id: sitePosts.id,
          title: sitePosts.title,
          outcome: sitePosts.outcome,
          editUrl: sitePosts.editUrl,
          categories: sitePosts.categories,
          featuredMediaId: sitePosts.featuredMediaId,
          media: sitePosts.media,
          seo: sitePosts.seo,
          createdAt: sitePosts.createdAt,
          createdByName: employees.fullName,
        })
        .from(sitePosts)
        .leftJoin(employees, eq(employees.id, sitePosts.createdBy))
        .orderBy(desc(sitePosts.createdAt))
        .limit(10);

      const posts: SitePostRecord[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        outcome: row.outcome as SitePostOutcome,
        editUrl: row.editUrl,
        categoryNames: ((row.categories ?? []) as { name: string }[]).map((c) => c.name),
        hasFeaturedImage: row.featuredMediaId !== null,
        imageCount: ((row.media ?? []) as MediaRecord[]).filter((m) => m.role === 'inline').length,
        seo: (row.seo ?? null) as SitePostRecord['seo'],
        createdAt: row.createdAt.toISOString(),
        createdByName: row.createdByName,
      }));
      return reply.send({ posts });
    },
  );

  app.post(
    '/marketing/site/posts',
    { preHandler: app.requirePermission('site.publish') },
    async (request, reply) => {
      const parsed = sitePostSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      const post = parsed.data;

      const client = clientFrom(env, options.wordpressFetch);
      if (!client) return reply.status(503).send(NOT_CONFIGURED);

      // Only terms the site already has: an Author cannot create one, and an
      // unknown id would otherwise fail after the images had gone up.
      let terms: SiteTerms;
      try {
        terms = await siteTerms(client, false);
      } catch {
        return reply.status(502).send({
          error: 'site_unreachable',
          message: 'Não foi possível conferir categorias e tags no site. Tente de novo.',
        });
      }
      const categories = terms.categories.filter((term) => post.categories.includes(term.id));
      const tags = terms.tags.filter((term) => post.tags.includes(term.id));
      if (categories.length !== post.categories.length || tags.length !== post.tags.length) {
        return reply.status(400).send({
          error: 'unknown_term',
          message:
            'Uma categoria ou tag marcada não existe mais no site. Clique em Atualizar lista e marque de novo.',
        });
      }

      const wanted = [
        ...(post.featuredImageId ? [post.featuredImageId] : []),
        ...post.images.map((image) => image.uploadId),
      ];
      const stored =
        wanted.length === 0
          ? []
          : await db
              .select()
              .from(siteMediaUploads)
              .where(inArray(siteMediaUploads.id, [...new Set(wanted)]));
      const uploadById = new Map(stored.map((row) => [row.id, row]));
      if (wanted.some((id) => !uploadById.has(id))) {
        return reply.status(400).send({
          error: 'image_not_found',
          message:
            'Não encontramos uma das imagens deste post. Remova a imagem e envie o arquivo de novo.',
        });
      }
      const featured = post.featuredImageId ? uploadById.get(post.featuredImageId) : undefined;
      if (featured && !isBigEnoughToFeature(featured)) {
        return reply.status(400).send({
          error: 'featured_too_small',
          message: `A imagem destacada tem ${featured.width} × ${featured.height} px e o mínimo é ${FEATURED_MIN_WIDTH} × ${FEATURED_MIN_HEIGHT}. Escolha uma versão maior.`,
        });
      }

      // Everything is checked. From here on, things go to the site — images
      // first, so a post is never created pointing at media that is not there.
      const slug = utmSlug(post.title).slice(0, 50) || 'post';
      const media: MediaRecord[] = [];
      const record = async (
        outcome: SitePostOutcome,
        extra: Partial<typeof sitePosts.$inferInsert>,
      ) => {
        const [row] = await db
          .insert(sitePosts)
          .values({
            title: post.title,
            outcome,
            categories: categories.map(({ id, name }) => ({ id, name })),
            tags: tags.map(({ id, name }) => ({ id, name })),
            media,
            videoUrl: post.videoUrl || null,
            seo: post.seo,
            createdBy: request.session.actor.employeeId,
            ...extra,
          })
          .returning({ id: sitePosts.id });
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: `site.post_${outcome}`,
          entity: 'site_post',
          entityId: row?.id ?? null,
          metadata: { site: client.siteHost, media: media.length },
        });
      };

      const queue = [
        ...(featured
          ? [
              {
                role: 'featured' as const,
                position: 0,
                upload: featured,
                caption: '',
                alt: post.featuredImageAlt,
              },
            ]
          : []),
        ...post.images.map((image, index) => ({
          role: 'inline' as const,
          position: index + 1,
          upload: uploadById.get(image.uploadId) as (typeof stored)[number],
          caption: image.caption,
          alt: '',
        })),
      ];
      const sourceUrlOf = new Map<string, string>();

      for (const item of queue) {
        const label = item.role === 'featured' ? 'Imagem destacada' : `Imagem ${item.position}`;
        let mediaId = item.upload.wordpressMediaId;
        let sourceUrl = item.upload.wordpressSourceUrl;

        // Sent on an earlier attempt, or used twice in this post: reuse it
        // rather than put a second copy in the site's library.
        if (mediaId === null || sourceUrl === null) {
          const outcome = await client.uploadMedia({
            bytes: item.upload.data,
            mimeType: item.upload.mimeType,
            filename: `${slug}-${item.role === 'featured' ? 'destaque' : item.position}.${EXTENSION[item.upload.mimeType] ?? 'jpg'}`,
            title: `${post.title} (${label.toLowerCase()})`,
            altText: item.alt || item.caption || post.title,
            caption: item.caption,
          });

          if (outcome.status !== 'uploaded') {
            const unknown = outcome.status === 'unknown';
            await record('failed', {
              detail: `media:${item.role}:${item.position}:${unknown ? outcome.reason : outcome.code}`,
            });
            return reply.status(502).send({
              error: unknown ? 'media_upload_unknown' : 'media_upload_failed',
              failedImage: { role: item.role, position: item.position },
              message: unknown
                ? `${label} foi enviada, mas o site não confirmou se recebeu. O post não foi criado e o formulário continua como está. Confira a biblioteca de mídia do WordPress antes de tentar de novo.`
                : `${label} não subiu para o WordPress. O site respondeu: "${outcome.message}". O post não foi criado e o formulário continua como está. Troque a imagem ou tente de novo.`,
            });
          }

          mediaId = outcome.mediaId;
          sourceUrl = outcome.sourceUrl;
          await db
            .update(siteMediaUploads)
            .set({ wordpressMediaId: mediaId, wordpressSourceUrl: sourceUrl })
            .where(eq(siteMediaUploads.id, item.upload.id));
          item.upload.wordpressMediaId = mediaId;
          item.upload.wordpressSourceUrl = sourceUrl;
        }

        sourceUrlOf.set(item.upload.id, sourceUrl);
        media.push({
          role: item.role,
          position: item.position,
          uploadId: item.upload.id,
          wordpressMediaId: mediaId,
          caption: item.caption,
          inGallery: item.role === 'inline' && post.gallery.includes(item.position),
        });
      }

      const bodyImages = media.filter((item) => item.role === 'inline');
      const { html } = renderSitePost(
        {
          content: post.content,
          images: bodyImages.map((item) => ({
            src: sourceUrlOf.get(item.uploadId) ?? '',
            caption: item.caption,
            alt: item.caption || post.title,
            mediaId: item.wordpressMediaId,
          })),
          gallery: post.gallery,
          video: post.videoUrl ? parseVideoLink(post.videoUrl) : null,
        },
        'wordpress',
      );
      const featuredMediaId =
        media.find((item) => item.role === 'featured')?.wordpressMediaId ?? null;

      const outcome = await client.createDraftPost({
        title: post.title,
        excerpt: post.excerpt,
        contentHtml: html,
        categories: categories.map((term) => term.id),
        tags: tags.map((term) => term.id),
        featuredMediaId,
      });

      await record(outcome.status, {
        wordpressPostId: outcome.status === 'draft_created' ? outcome.postId : null,
        editUrl: outcome.status === 'draft_created' ? outcome.editUrl : null,
        featuredMediaId,
        detail:
          outcome.status === 'failed'
            ? outcome.code
            : outcome.status === 'unknown'
              ? outcome.reason
              : null,
      });

      if (outcome.status === 'draft_created') {
        return reply.status(201).send({ outcome: outcome.status, editUrl: outcome.editUrl });
      }
      if (outcome.status === 'failed') {
        return reply.status(502).send({
          error: 'site_refused',
          message: `O WordPress não aceitou o rascunho. O site respondeu: "${outcome.message}". Nada foi criado e o formulário continua como está.`,
        });
      }
      return reply.status(202).send({
        error: 'unknown_outcome',
        message:
          'O site não confirmou se criou o rascunho. Abra os posts no WordPress e confira antes de enviar de novo, para não duplicar.',
      });
    },
  );
};
