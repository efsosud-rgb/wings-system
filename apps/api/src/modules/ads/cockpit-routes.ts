import type {
  AlertItem,
  CampaignPerformanceItem,
  CockpitSnapshot,
  PacingSummary,
} from '@wings/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adAds,
  adAlerts,
  adCampaigns,
  adMetricsDaily,
  adSets,
  employees,
} from '../../db/schema/index.js';
import { acknowledgeAlert, pacingFacts } from './alerts.js';
import { campaignPerformance } from './metrics.js';

/**
 * HTTP surface for the traffic cockpit.
 *
 * Read-only apart from acknowledging an alert. Every number here comes from
 * data already mirrored by the ingest job — the cockpit never calls an ad
 * platform itself, so opening a screen can neither spend money nor burn rate
 * limit.
 */

const idParamSchema = z.object({ id: z.string().uuid() });

const querySchema = z.object({
  /** Performance window, in days. */
  days: z.coerce.number().int().min(1).max(90).default(7),
  accountId: z.string().uuid().optional(),
});

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export const cockpitRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.get(
    '/ads/cockpit',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: 'Parâmetros inválidos.' });
      }
      const { days, accountId } = parsed.data;

      // Archived accounts are history: reachable by explicit id, never the
      // default the cockpit opens on.
      const account = accountId
        ? await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) })
        : await db.query.adAccounts.findFirst({
            where: isNull(adAccounts.archivedAt),
            orderBy: asc(adAccounts.createdAt),
          });

      if (!account) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Nenhuma conta de anúncios configurada.' });
      }

      const now = new Date();
      const sinceDate = new Date(now.getTime() - days * 24 * 3_600_000).toISOString().slice(0, 10);

      const [campaigns, performance, facts, alertRows, adRows] = await Promise.all([
        db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, account.id) }),
        campaignPerformance(db, account.id, sinceDate),
        pacingFacts(db, account.id, now),
        db
          .select({
            id: adAlerts.id,
            kind: adAlerts.kind,
            severity: adAlerts.severity,
            title: adAlerts.title,
            detail: adAlerts.detail,
            entityLevel: adAlerts.entityLevel,
            entityExternalId: adAlerts.entityExternalId,
            firstSeenAt: adAlerts.firstSeenAt,
            lastSeenAt: adAlerts.lastSeenAt,
            resolvedAt: adAlerts.resolvedAt,
            acknowledgedAt: adAlerts.acknowledgedAt,
            acknowledgedByName: employees.fullName,
            notifiedAt: adAlerts.notifiedAt,
            notificationError: adAlerts.notificationError,
          })
          .from(adAlerts)
          .leftJoin(employees, eq(employees.id, adAlerts.acknowledgedBy))
          .where(and(eq(adAlerts.adAccountId, account.id), isNull(adAlerts.resolvedAt)))
          .orderBy(desc(adAlerts.severity), desc(adAlerts.lastSeenAt))
          .limit(100),
        db.query.adAds.findMany({ where: eq(adAds.adAccountId, account.id) }),
      ]);

      const storedAdSets = await db.query.adSets.findMany({
        where: sql`${adSets.campaignId} in (select id from ad_campaigns where ad_account_id = ${account.id})`,
      });

      // Map every entity id back to the campaign it belongs to, so an alert on
      // one ad shows up as a badge on its campaign row.
      const campaignById = new Map(campaigns.map((c) => [c.id, c.externalId]));
      const campaignOfEntity = new Map<string, string>();
      for (const campaign of campaigns)
        campaignOfEntity.set(campaign.externalId, campaign.externalId);
      for (const adSet of storedAdSets) {
        const external = campaignById.get(adSet.campaignId);
        if (external) campaignOfEntity.set(adSet.externalId, external);
      }
      for (const ad of adRows) {
        const external = ad.campaignId ? campaignById.get(ad.campaignId) : undefined;
        if (external) campaignOfEntity.set(ad.externalId, external);
      }

      const alertCountByCampaign = new Map<string, number>();
      for (const alert of alertRows) {
        const campaignExternalId = alert.entityExternalId
          ? campaignOfEntity.get(alert.entityExternalId)
          : undefined;
        if (!campaignExternalId) continue;
        alertCountByCampaign.set(
          campaignExternalId,
          (alertCountByCampaign.get(campaignExternalId) ?? 0) + 1,
        );
      }

      const performanceByExternal = new Map(
        performance.map((row) => [row.campaignExternalId, row]),
      );

      // Driven by the campaign list, not by the metrics: a campaign that has not
      // delivered still belongs on screen, with empty figures rather than none.
      const campaignItems: CampaignPerformanceItem[] = campaigns
        .map((campaign) => {
          const metrics = performanceByExternal.get(campaign.externalId);
          return {
            campaignExternalId: campaign.externalId,
            name: campaign.name,
            status: campaign.status,
            budgetLevel: campaign.budgetLevel,
            dailyBudgetCents: campaign.dailyBudgetCents || null,
            spendCents: metrics?.spendCents ?? 0,
            impressions: metrics?.impressions ?? 0,
            clicks: metrics?.clicks ?? 0,
            conversions: metrics?.conversions ?? 0,
            ctrMilli: metrics?.ctrMilli ?? null,
            frequencyMilli: metrics?.frequencyMilli ?? null,
            costPerLeadCents: metrics?.costPerLeadCents ?? null,
            alertCount: alertCountByCampaign.get(campaign.externalId) ?? 0,
          };
        })
        .sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name, 'pt-BR'));

      const [fetched] = await db
        .select({ fetchedAt: sql<Date | null>`max(${adMetricsDaily.fetchedAt})` })
        .from(adMetricsDaily)
        .where(eq(adMetricsDaily.adAccountId, account.id));

      const [pending] = await db
        .execute<{ count: string }>(
          sql`
      select count(*)::text as count
        from ad_approval_requests
       where ad_account_id = ${account.id} and status in ('pending', 'escalated')
    `,
        )
        .then((result) => result.rows);

      const pacing: PacingSummary | null = facts
        ? {
            periodMonth: facts.periodMonth,
            capCents: facts.capCents,
            usableCents: facts.usableCents,
            committedCents: facts.committedCents,
            spentCents: facts.spentCents,
            availableCents: facts.availableCents,
            expectedCents: facts.expectedCents,
            deviationPercent: facts.deviationPercent,
            elapsedDays: facts.elapsedDays,
            totalDays: facts.totalDays,
            killSwitchEngaged: account.killSwitchEngaged,
          }
        : null;

      const alerts: AlertItem[] = alertRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        detail: (row.detail ?? {}) as Record<string, unknown>,
        entityLevel: row.entityLevel,
        entityExternalId: row.entityExternalId,
        firstSeenAt: iso(row.firstSeenAt) ?? new Date(0).toISOString(),
        lastSeenAt: iso(row.lastSeenAt) ?? new Date(0).toISOString(),
        resolvedAt: iso(row.resolvedAt),
        acknowledgedAt: iso(row.acknowledgedAt),
        acknowledgedByName: row.acknowledgedByName,
        notifiedAt: iso(row.notifiedAt),
        notificationError: row.notificationError,
      }));

      const snapshot: CockpitSnapshot = {
        account: {
          id: account.id,
          name: account.name,
          platform: account.platform,
          externalId: account.externalId,
        },
        pacing,
        campaigns: campaignItems,
        alerts,
        metricsFetchedAt: iso(fetched?.fetchedAt ?? null),
        sinceDate,
        counts: {
          ads: adRows.length,
          disapprovedAds: adRows.filter((ad) => ad.effectiveStatus === 'DISAPPROVED').length,
          openAlerts: alerts.length,
          pendingApprovals: Number(pending?.count ?? 0),
        },
      };

      return reply.send({ cockpit: snapshot });
    },
  );

  /** Acknowledging records that a person saw it; it does not resolve it. */
  app.post(
    '/ads/alerts/:id/acknowledge',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: 'not_found', message: 'Alerta não encontrado.' });
      }

      const ok = await acknowledgeAlert(
        db,
        params.data.id,
        request.session.actor.employeeId,
        new Date(),
      );
      if (!ok) {
        return reply.status(409).send({
          error: 'already_acknowledged',
          message: 'Este alerta já foi reconhecido ou não existe.',
        });
      }
      return reply.send({ ok: true });
    },
  );
};
