import {
  sitePostSchema,
  type SitePostOutcome,
  type SitePostRecord,
  type SiteStatus,
} from '@wings/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { employees, sitePosts } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { writeAudit } from '../../lib/audit.js';
import { plainTextToHtml, WordPressClient } from '../../lib/wordpress.js';

/**
 * Owned channels: Wings' own WordPress site.
 *
 * The one thing these routes can cause is a DRAFT post on the site. There is
 * no approvals gate here because nothing becomes public and no money moves:
 * publishing stays a person's act inside WordPress.
 */

export interface SiteRoutesOptions {
  /** Injected in tests; production builds the client from the environment. */
  wordpressFetch?: typeof fetch;
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

export const siteRoutes: FastifyPluginAsync<SiteRoutesOptions> = async (app, options) => {
  const { db, env } = app.wings;

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
          createdAt: sitePosts.createdAt,
          createdByName: employees.fullName,
        })
        .from(sitePosts)
        .leftJoin(employees, eq(employees.id, sitePosts.createdBy))
        .orderBy(desc(sitePosts.createdAt))
        .limit(10);

      const posts: SitePostRecord[] = rows.map((row) => ({
        ...row,
        outcome: row.outcome as SitePostOutcome,
        createdAt: row.createdAt.toISOString(),
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

      const client = clientFrom(env, options.wordpressFetch);
      if (!client) {
        // Same rule as e-mail without SMTP: say so, never pretend it was sent.
        return reply.status(503).send({
          error: 'site_not_configured',
          message: 'A integração com o WordPress ainda não foi configurada no servidor.',
        });
      }

      const outcome = await client.createDraftPost({
        title: parsed.data.title,
        excerpt: parsed.data.excerpt,
        contentHtml: plainTextToHtml(parsed.data.content),
      });

      const [record] = await db
        .insert(sitePosts)
        .values({
          title: parsed.data.title,
          outcome: outcome.status,
          wordpressPostId: outcome.status === 'draft_created' ? outcome.postId : null,
          editUrl: outcome.status === 'draft_created' ? outcome.editUrl : null,
          detail:
            outcome.status === 'failed'
              ? outcome.code
              : outcome.status === 'unknown'
                ? outcome.reason
                : null,
          createdBy: request.session.actor.employeeId,
        })
        .returning({ id: sitePosts.id });

      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: `site.post_${outcome.status}`,
        entity: 'site_post',
        entityId: record?.id ?? null,
        metadata: { site: client.siteHost },
      });

      if (outcome.status === 'draft_created') {
        return reply.status(201).send({ outcome: outcome.status, editUrl: outcome.editUrl });
      }
      if (outcome.status === 'failed') {
        return reply.status(502).send({
          error: 'site_refused',
          message: `O WordPress recusou o rascunho: ${outcome.message}`,
        });
      }
      return reply.status(202).send({
        error: 'unknown_outcome',
        message:
          'O site não confirmou. O rascunho pode ter sido criado: confira no painel do WordPress antes de enviar de novo.',
      });
    },
  );
};
