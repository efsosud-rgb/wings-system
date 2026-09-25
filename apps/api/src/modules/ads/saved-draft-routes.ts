import { campaignDraftSchema, type SavedCampaignDraft } from '@wings/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adCampaignSavedDrafts, employees } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * Campaigns saved in the builder to come back to.
 *
 * A saved draft is the whole form, validated by the same schema as a request,
 * and nothing more: saving asks for no approval, notifies nobody and reserves
 * no budget. Loading one only fills the builder; launching stays the person's
 * own button, which files a request like any other.
 */
const idParamSchema = z.object({ id: z.string().uuid() });
const saveSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  draft: campaignDraftSchema,
});

export const savedDraftRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get(
    '/ads/saved-drafts',
    { preHandler: app.requirePermission('ads.request') },
    async (_request, reply) => {
      const rows = await db
        .select({
          id: adCampaignSavedDrafts.id,
          name: adCampaignSavedDrafts.name,
          platform: adCampaignSavedDrafts.platform,
          updatedAt: adCampaignSavedDrafts.updatedAt,
          createdByName: employees.fullName,
        })
        .from(adCampaignSavedDrafts)
        .leftJoin(employees, eq(employees.id, adCampaignSavedDrafts.createdBy))
        .orderBy(desc(adCampaignSavedDrafts.updatedAt))
        .limit(50);
      const drafts: SavedCampaignDraft[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform as SavedCampaignDraft['platform'],
        updatedAt: row.updatedAt.toISOString(),
        createdByName: row.createdByName,
      }));
      return reply.send({ drafts });
    },
  );

  app.get(
    '/ads/saved-drafts/:id',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      const row = params.success
        ? await db.query.adCampaignSavedDrafts.findFirst({
            where: eq(adCampaignSavedDrafts.id, params.data.id),
          })
        : undefined;
      if (!row) {
        return reply.status(404).send({ error: 'not_found', message: 'Rascunho não encontrado.' });
      }
      // Re-validated on the way out: storage is data too.
      const parsed = campaignDraftSchema.safeParse(row.payload);
      if (!parsed.success) {
        return reply.status(409).send({
          error: 'draft_invalid',
          message: 'Este rascunho foi salvo com um formulário antigo e não abre mais.',
        });
      }
      return reply.send({ id: row.id, name: row.name, draft: parsed.data });
    },
  );

  app.post(
    '/ads/saved-drafts',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = saveSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.status(400).send({
          error: 'invalid_request',
          message: issue?.message ?? 'Dados inválidos',
          path: issue?.path ?? [],
        });
      }
      const { draft } = parsed.data;
      const [row] = await db
        .insert(adCampaignSavedDrafts)
        .values({
          name: parsed.data.name ?? draft.name,
          platform: draft.platform,
          payload: draft,
          createdBy: request.session.actor.employeeId,
        })
        .returning({ id: adCampaignSavedDrafts.id });
      if (!row) throw new Error('failed to save the draft');
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.draft_saved',
        entity: 'ad_campaign_saved_draft',
        entityId: row.id,
        ip: request.ip,
        metadata: { platform: draft.platform },
      });
      return reply.status(201).send({ id: row.id });
    },
  );

  app.delete(
    '/ads/saved-drafts/:id',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: 'not_found', message: 'Rascunho não encontrado.' });
      }
      const deleted = await db
        .delete(adCampaignSavedDrafts)
        .where(eq(adCampaignSavedDrafts.id, params.data.id))
        .returning({ id: adCampaignSavedDrafts.id });
      if (deleted.length === 0) {
        return reply.status(404).send({ error: 'not_found', message: 'Rascunho não encontrado.' });
      }
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.draft_deleted',
        entity: 'ad_campaign_saved_draft',
        entityId: params.data.id,
        ip: request.ip,
      });
      return reply.status(204).send();
    },
  );
};
