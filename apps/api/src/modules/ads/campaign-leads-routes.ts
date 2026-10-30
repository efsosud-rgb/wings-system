import {
  CAMPAIGN_LEADS_SINCE,
  grantedScope,
  isOutOfAccountReason,
  temperatureOfRating,
  type AdPlatform,
  type AttributionMethod,
  type CampaignLeadRow,
  type CampaignLeadsResponse,
  type CampaignLeadsSummary,
  type UnattributedReason,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { adAds, adCampaigns, adSets, campaignLeads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createSecretBox } from '../../lib/secret-box.js';

/**
 * Dashboard → Leads das Campanhas. Diretoria and Gerente Comercial see every
 * lead, a Vendedor Formatação only the ones assigned to them (in the Wings CRM,
 * or by RD); everyone else gets 403. Phone and e-mail leave the server masked; the real value only
 * through the audited reveal, by POST so it never sits in a URL.
 */

type Row = typeof campaignLeads.$inferSelect;

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

const saoPauloDay = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(at);

export function summaryOf(rows: Row[], now: Date): CampaignLeadsSummary {
  const tests = rows.filter((row) => row.isTest).length;
  const real = rows.filter((row) => !row.isTest);
  // People who arrived before 28/09 (old leads copied to RD later) are listed by
  // reason so the account can be followed, but they are in no total or percentage.
  const outOfAccount = real.filter((row) => isOutOfAccountReason(row.unattributedReason));
  const counted = real.filter((row) => !isOutOfAccountReason(row.unattributedReason));
  const leads = counted.filter((row) => row.campaignId);
  const today = saoPauloDay(now);
  const weekStart = now.getTime() - 7 * 24 * 3600_000;
  const contacted = leads.filter((row) => row.firstContactAt);
  const count = <K extends string>(keys: K[]) => {
    const counts = new Map<K, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const stageOrder = new Map(leads.map((row) => [row.stage, row.stageOrder]));
  const unattributed = real.filter((row) => !row.campaignId);
  const unattributedCounted = counted.filter((row) => !row.campaignId);
  const fetched = rows.reduce<Date | null>(
    (latest, row) => (!latest || row.fetchedAt > latest ? row.fetchedAt : latest),
    null,
  );
  return {
    since: CAMPAIGN_LEADS_SINCE,
    fetchedAt: fetched?.toISOString() ?? null,
    today: leads.filter((row) => saoPauloDay(row.enteredAt) === today).length,
    week: leads.filter((row) => row.enteredAt.getTime() >= weekStart).length,
    total: leads.length,
    contactedPercent: leads.length ? Math.round((contacted.length / leads.length) * 100) : null,
    averageFirstContactMinutes: contacted.length
      ? Math.round(
          contacted.reduce(
            (total, row) => total + minutesBetween(row.enteredAt, row.firstContactAt!),
            0,
          ) / contacted.length,
        )
      : null,
    stages: count(leads.map((row) => row.stage))
      .map(([stage, n]) => ({ stage, count: n }))
      .sort((a, b) => (stageOrder.get(a.stage) ?? 0) - (stageOrder.get(b.stage) ?? 0)),
    lost: count(
      leads.filter((row) => row.win === false).map((row) => row.lostReason ?? '(sem motivo)'),
    ).map(([reason, n]) => ({ reason, count: n })),
    unattributed: count(
      unattributed.map((row) => (row.unattributedReason ?? 'not_paid') as UnattributedReason),
    ).map(([reason, n]) => ({ reason, count: n })),
    unattributedPercent: counted.length
      ? Math.round((unattributedCounted.length / counted.length) * 100)
      : null,
    outOfAccount: outOfAccount.length,
    tests,
    smallSample: leads.length < 10,
  };
}

/** Every row this person may see: all, or only the ones RD assigns to them. */
export async function visibleCampaignLeads(
  db: Database,
  owner: string | undefined,
): Promise<Row[]> {
  const filters: SQL[] = [gte(campaignLeads.enteredAt, new Date(CAMPAIGN_LEADS_SINCE))];
  if (owner) filters.push(eq(campaignLeads.ownerEmployeeId, owner));
  return db.query.campaignLeads.findMany({
    where: and(...filters),
    orderBy: desc(campaignLeads.enteredAt),
  });
}

const revealBody = z.object({ field: z.enum(['phone', 'email']) });
const idParam = z.object({ id: z.uuid() });

export const campaignLeadsRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();

  app.get(
    '/campaign-leads',
    { preHandler: app.requirePermission('campaign_leads.read') },
    async (request, reply) => {
      const scope =
        grantedScope(request.session.actor, 'campaign_leads.read') === 'all' ? 'all' : 'own';
      const rows = await visibleCampaignLeads(
        db,
        scope === 'own' ? request.session.actor.employeeId : undefined,
      );
      const listed = rows.filter((row) => !row.isTest && row.campaignId);
      const campaignIds = [...new Set(listed.map((row) => row.campaignId!))];
      const adIds = [
        ...new Set(listed.map((row) => row.adId).filter((id): id is string => Boolean(id))),
      ];
      const [campaignRows, adRows] = await Promise.all([
        campaignIds.length
          ? db.query.adCampaigns.findMany({ where: inArray(adCampaigns.id, campaignIds) })
          : [],
        adIds.length ? db.query.adAds.findMany({ where: inArray(adAds.id, adIds) }) : [],
      ]);
      const adSetIds = [
        ...new Set(adRows.map((row) => row.adSetId).filter((id): id is string => Boolean(id))),
      ];
      const adSetRows = adSetIds.length
        ? await db.query.adSets.findMany({ where: inArray(adSets.id, adSetIds) })
        : [];
      const campaignName = new Map(campaignRows.map((row) => [row.id, row.name]));
      const adName = new Map(adRows.map((row) => [row.id, row.name]));
      const adSetNameOfAd = new Map(
        adRows.map((row) => [
          row.id,
          adSetRows.find((adSet) => adSet.id === row.adSetId)?.name ?? null,
        ]),
      );
      const leads: CampaignLeadRow[] = listed.map((row) => ({
        id: row.id,
        enteredAt: row.enteredAt.toISOString(),
        name: row.name,
        company: row.company,
        segment: row.segment,
        city: row.city,
        platform: row.platform as AdPlatform | null,
        campaignName: campaignName.get(row.campaignId!) ?? null,
        adSetName: row.adId ? (adSetNameOfAd.get(row.adId) ?? null) : null,
        adName: row.adId ? (adName.get(row.adId) ?? null) : null,
        attribution: row.attribution as AttributionMethod | null,
        utmCampaign: row.utmCampaign,
        utmContent: row.utmContent,
        pipeline: row.pipeline,
        stage: row.stage,
        owner: row.ownerName,
        firstContactMinutes: row.firstContactAt
          ? minutesBetween(row.enteredAt, row.firstContactAt)
          : null,
        firstContactSource: row.firstContactSource as CampaignLeadRow['firstContactSource'],
        temperature: temperatureOfRating(row.rating),
        lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
        phoneMasked: row.phoneMasked,
        emailMasked: row.emailMasked,
        win: row.win,
        lostReason: row.lostReason,
      }));
      const body: CampaignLeadsResponse = { summary: summaryOf(rows, now()), leads, scope };
      return reply.send(body);
    },
  );

  /** The full phone or e-mail of one lead, written to the audit log first. */
  app.post(
    '/campaign-leads/:id/reveal',
    { preHandler: app.requirePermission('campaign_leads.reveal') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = revealBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Pedido inválido.' });
      }
      const row = await db.query.campaignLeads.findFirst({
        where: eq(campaignLeads.id, params.data.id),
      });
      const notFound = { error: 'not_found', message: 'Lead não encontrado.' };
      if (!row || row.isTest) return reply.status(404).send(notFound);
      const scope = grantedScope(request.session.actor, 'campaign_leads.reveal');
      // Outside their scope a lead does not exist for them.
      if (scope !== 'all' && row.ownerEmployeeId !== request.session.actor.employeeId) {
        return reply.status(404).send(notFound);
      }
      const sealed = body.data.field === 'phone' ? row.phoneEncrypted : row.emailEncrypted;
      if (!sealed)
        return reply.status(404).send({ error: 'not_found', message: 'Sem esse dado no RD.' });
      const value = createSecretBox(env.CPF_ENCRYPTION_KEY).open(sealed);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'campaign_lead.revealed',
        entity: 'campaign_lead',
        entityId: row.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: { field: body.data.field },
      });
      return reply.send({ value });
    },
  );
};
