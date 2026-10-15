import { siteFormSpecSchema, type SiteFormSpec } from '@wings/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adAccounts, clients, employees, leadSourceRules } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createMetaClient } from './platform/factory.js';
import { MetaReadOnlyClient } from './platform/meta-client.js';
import type { ExistingLeadForm, PageAccess } from './platform/types.js';

/**
 * What the campaign builder needs around the standard lead form, all reads
 * but the two site-form writes:
 *
 * - on Meta: whether the token can act for the Page (so the form step would
 *   not fail on the day), and the privacy policy the Page's current forms
 *   use, offered as the default;
 * - on the site: the pages that take the Wings System form (`/lp/<slug>`),
 *   with the form each one shows now and the change waiting for Diretoria;
 *   never a page apps/landing serves (`isLandingPageSpec`).
 *
 * Nothing here creates a form on Meta: that is the executor's step, behind
 * the approval gate and `ADS_WRITES_ENABLED`. Nothing here changes what the
 * site shows either: a proposal waits until someone with `ads.approve`
 * (Admin Master, Diretoria) approves it, with the preview in front of them.
 */

export interface MetaLeadFormReadiness {
  access: PageAccess;
  forms: ExistingLeadForm[];
  /** The policy link the Page's forms use (the most common one), or null. */
  privacyPolicyUrl: string | null;
}

export interface SiteFormPage {
  id: string;
  slug: string;
  /** `/lp/<slug>` on this origin. */
  path: string;
  brand: string;
  pipeline: string | null;
  clientId: string | null;
  /** What the page shows now; null is the plain form. */
  form: SiteFormSpec | null;
  /** A change waiting for Diretoria, with who proposed it and when. */
  pending: { form: SiteFormSpec; by: string | null; at: string } | null;
  approvedAt: string | null;
}

const idParam = z.object({ id: z.uuid() });

/**
 * A page served by apps/landing ("Fale com a Wings"): its live spec has codes
 * for the options or fields it makes required, which the `/lp/<slug>` page the
 * builder previews and targets does not have. Read on the stored JSON, so a
 * spec that no longer parses still counts. Such a page is the landing's, never
 * the builder's: not listed, not proposed to.
 */
export function isLandingPageSpec(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const { qualifierValues, requiredFields } = spec as Record<string, unknown>;
  return (
    (Array.isArray(qualifierValues) && qualifierValues.length > 0) ||
    (Array.isArray(requiredFields) && requiredFields.length > 0)
  );
}

const landingPageSpec = (reply: FastifyReply) =>
  reply.status(409).send({
    error: 'landing_page_spec',
    message: 'Esta página tem formulário próprio e não é alterada pelo construtor de campanhas.',
  });

export const leadFormRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, platformFetch } = app.wings;

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

  // --- Meta: is the Page ready for a form, and which policy do its forms use ----

  app.get(
    '/ads/meta/lead-forms',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const query = z.object({ pageId: z.string().regex(/^\d{5,25}$/) }).safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Página inválida.' });
      }
      const client = await metaReader(reply);
      if (!client) return reply;

      try {
        const access = await client.pageAccess(query.data.pageId);
        const forms = access.canManage ? await client.listLeadForms(query.data.pageId) : [];
        const counts = new Map<string, number>();
        for (const form of forms) {
          if (form.privacyPolicyUrl) {
            counts.set(form.privacyPolicyUrl, (counts.get(form.privacyPolicyUrl) ?? 0) + 1);
          }
        }
        const privacyPolicyUrl = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        return reply.send({ access, forms, privacyPolicyUrl } satisfies MetaLeadFormReadiness);
      } catch {
        return reply.status(502).send({
          error: 'meta_unavailable',
          message: 'A Meta não respondeu. Tente de novo em instantes.',
        });
      }
    },
  );

  // --- the site pages that take the standard form ------------------------------

  async function sitePages(): Promise<SiteFormPage[]> {
    const rows = await db
      .select({
        id: leadSourceRules.id,
        slug: leadSourceRules.pattern,
        brand: leadSourceRules.brand,
        clientName: clients.name,
        pipeline: leadSourceRules.pipeline,
        clientId: leadSourceRules.clientId,
        form: leadSourceRules.siteFormSpec,
        pendingForm: leadSourceRules.siteFormSpecPending,
        pendingBy: employees.fullName,
        pendingAt: leadSourceRules.siteFormPendingAt,
        approvedAt: leadSourceRules.siteFormApprovedAt,
      })
      .from(leadSourceRules)
      .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
      .leftJoin(employees, eq(employees.id, leadSourceRules.siteFormPendingBy))
      .where(
        and(
          eq(leadSourceRules.kind, 'landing_page'),
          eq(leadSourceRules.active, true),
          eq(leadSourceRules.siteFormEnabled, true),
        ),
      )
      .orderBy(asc(leadSourceRules.pattern));
    // A page apps/landing serves is never the builder's to show or change.
    const pages = rows.filter((row) => !isLandingPageSpec(row.form));
    return pages.map((row) => {
      const form = siteFormSpecSchema.safeParse(row.form);
      const pending = siteFormSpecSchema.safeParse(row.pendingForm);
      return {
        id: row.id,
        slug: row.slug,
        path: `/lp/${row.slug}`,
        brand: row.clientName ?? row.brand ?? 'Wings Company',
        pipeline: row.pipeline,
        clientId: row.clientId,
        form: form.success ? form.data : null,
        pending:
          pending.success && row.pendingAt
            ? { form: pending.data, by: row.pendingBy ?? null, at: row.pendingAt.toISOString() }
            : null,
        approvedAt: row.approvedAt?.toISOString() ?? null,
      };
    });
  }

  app.get(
    '/ads/lead-forms/site-pages',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => reply.send({ pages: await sitePages() }),
  );

  /** A change to a page's form: proposed by whoever builds campaigns, live only after approval. */
  app.post(
    '/ads/lead-forms/site-pages/:id/propose',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = siteFormSpecSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Formulário inválido.',
          issues: body.success ? [] : body.error.issues,
        });
      }
      const actor = request.session.actor.employeeId;
      const current = await db.query.leadSourceRules.findFirst({
        where: eq(leadSourceRules.id, params.data.id),
        columns: { siteFormSpec: true },
      });
      if (current && isLandingPageSpec(current.siteFormSpec)) return landingPageSpec(reply);
      const [updated] = await db
        .update(leadSourceRules)
        .set({
          siteFormSpecPending: body.data,
          siteFormPendingBy: actor,
          siteFormPendingAt: new Date(),
        })
        .where(
          and(
            eq(leadSourceRules.id, params.data.id),
            eq(leadSourceRules.kind, 'landing_page'),
            eq(leadSourceRules.siteFormEnabled, true),
          ),
        )
        .returning({ id: leadSourceRules.id });
      if (!updated) {
        return reply.status(404).send({ error: 'not_found', message: 'Página não encontrada.' });
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'site_form.change_proposed',
        entity: 'lead_source_rule',
        entityId: params.data.id,
        metadata: { qualifier: body.data.qualifier !== null },
      });
      const page = (await sitePages()).find((item) => item.id === params.data.id) ?? null;
      return reply.send({ page });
    },
  );

  /** Diretoria's (or an Admin Master's) click: what was proposed becomes what the page shows. */
  app.post(
    '/ads/lead-forms/site-pages/:id/approve',
    { preHandler: app.requirePermission('ads.approve') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Página inválida.' });
      }
      const rule = await db.query.leadSourceRules.findFirst({
        where: eq(leadSourceRules.id, params.data.id),
      });
      if (rule && isLandingPageSpec(rule.siteFormSpec)) return landingPageSpec(reply);
      const pending = siteFormSpecSchema.safeParse(rule?.siteFormSpecPending);
      if (!rule || !pending.success) {
        return reply
          .status(409)
          .send({ error: 'nothing_pending', message: 'Não há alteração aguardando aprovação.' });
      }
      const actor = request.session.actor.employeeId;
      // Whoever proposed it does not also approve it.
      if (rule.siteFormPendingBy && rule.siteFormPendingBy === actor) {
        return reply.status(403).send({
          error: 'self_approval',
          message: 'Quem propôs a alteração não pode aprová-la.',
        });
      }
      await db
        .update(leadSourceRules)
        .set({
          siteFormSpec: pending.data,
          siteFormSpecPending: null,
          siteFormPendingBy: null,
          siteFormPendingAt: null,
          siteFormApprovedBy: actor,
          siteFormApprovedAt: new Date(),
        })
        .where(eq(leadSourceRules.id, rule.id));
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'site_form.change_approved',
        entity: 'lead_source_rule',
        entityId: rule.id,
        metadata: {
          proposedBy: rule.siteFormPendingBy,
          qualifier: pending.data.qualifier !== null,
        },
      });
      const page = (await sitePages()).find((item) => item.id === rule.id) ?? null;
      return reply.send({ page });
    },
  );

  /** A proposal withdrawn or refused: the page keeps what it shows. */
  app.post(
    '/ads/lead-forms/site-pages/:id/reject',
    { preHandler: app.requirePermission('ads.approve') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Página inválida.' });
      }
      const actor = request.session.actor.employeeId;
      const [updated] = await db
        .update(leadSourceRules)
        .set({ siteFormSpecPending: null, siteFormPendingBy: null, siteFormPendingAt: null })
        .where(eq(leadSourceRules.id, params.data.id))
        .returning({ id: leadSourceRules.id });
      if (!updated) {
        return reply.status(404).send({ error: 'not_found', message: 'Página não encontrada.' });
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'site_form.change_rejected',
        entity: 'lead_source_rule',
        entityId: params.data.id,
        metadata: {},
      });
      const page = (await sitePages()).find((item) => item.id === params.data.id) ?? null;
      return reply.send({ page });
    },
  );
};
