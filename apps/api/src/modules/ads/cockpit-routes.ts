import {
  budgetCapUpdateSchema,
  type AdAccountBudgetCapView,
  type AlertItem,
  type CampaignPerformanceItem,
  type CockpitSnapshot,
  type PacingSummary,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adAds,
  adAlerts,
  adCampaigns,
  adMetricsDaily,
  adSets,
  budgetPeriods,
  employees,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { acknowledgeAlert, pacingFacts } from './alerts.js';
import { getPeriodState, openPeriod } from './budget-guard.js';
import { campaignPerformance } from './metrics.js';
import { createPlatformClient } from './platform/factory.js';
import { periodMonthOf, reconcileAccount } from './reconcile.js';

/**
 * HTTP surface for the traffic cockpit.
 *
 * Read-only apart from acknowledging an alert, editing the internal monthly
 * cap (Admin Master only) and forcing an account's reconciliation now (Admin
 * Master or Diretoria) — the same reads the scheduled tasks already do,
 * reachable from a screen instead of waiting for the next cycle.
 */

const idParamSchema = z.object({ id: z.string().uuid() });
const accountIdParamSchema = z.object({ accountId: z.string().uuid() });

const querySchema = z.object({
  /** Performance window, in days. */
  days: z.coerce.number().int().min(1).max(90).default(7),
  accountId: z.string().uuid().optional(),
  /**
   * The ad-account platform ('meta' | 'google') — NOT the campaign-level
   * placement ('meta' | 'google_search' | 'youtube'). The frontend maps one
   * to the other (`AD_ACCOUNT_PLATFORM`); this route only knows accounts.
   */
  platform: z.enum(['meta', 'google']).optional(),
});

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** One account's cap view for the admin editing screen, current month. */
async function budgetCapViewOf(
  db: import('../../db/client.js').Database,
  account: { id: string; platform: 'meta' | 'google' | 'tiktok'; name: string; externalId: string; timezone: string },
  now: Date,
): Promise<AdAccountBudgetCapView> {
  const periodMonth = periodMonthOf(now, account.timezone);
  const state = await getPeriodState(db, account.id, periodMonth);
  return {
    accountId: account.id,
    platform: account.platform,
    name: account.name,
    externalId: account.externalId,
    periodMonth,
    capCents: state?.capCents ?? null,
    usableCents: state?.usableCents ?? null,
    usablePercent:
      state && state.capCents > 0 ? Math.round((state.usableCents / state.capCents) * 100) : null,
  };
}

/**
 * How long a manual "Atualizar agora" click stays refused after the last one
 * for the same account — the trava against repeated clicks. Deliberately
 * short: this is a read against the platform, not a spend, so the risk of a
 * double click is wasted API calls, not money. Shorter than the 15-min
 * scheduled cadence, so a person can always get a fresher read than the last
 * cycle gave them.
 */
const MANUAL_RECONCILE_COOLDOWN_MS = 30_000;

export const cockpitRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, platformFetch } = app.wings;
  // In-flight guard only: two clicks a hairsbreadth apart, before either has
  // had time to move `lastReconciledAt`. Per process, not persisted — the
  // cooldown check below is what actually survives a restart or a second
  // instance.
  const reconcilingNow = new Set<string>();

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
      const { days, accountId, platform } = parsed.data;

      // Archived accounts are history: reachable by explicit id, never the
      // default the cockpit opens on. `platform` picks the account for that
      // ad-account platform; with neither given, Meta remains the default
      // this screen has always opened on.
      const account = accountId
        ? await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) })
        : await db.query.adAccounts.findFirst({
            where: and(
              eq(adAccounts.platform, platform ?? 'meta'),
              isNull(adAccounts.archivedAt),
            ),
            orderBy: asc(adAccounts.createdAt),
          });

      if (!account) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Nenhuma conta de anúncios configurada.' });
      }

      // Injectable so a test can pin "today" against the metric days it seeds.
      const now = app.wings.now?.() ?? new Date();
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
            platformRemainingCents: facts.platformRemainingCents,
            platformLimitSource: facts.platformLimitSource,
            platformLimitSyncedAtIso: facts.platformLimitSyncedAtIso,
            platformLimitNote: facts.platformLimitNote,
            lastReconciledAt: facts.lastReconciledAtIso,
          }
        : null;

      // The cross-platform figure: every non-archived account's currently
      // open period this month, summed. Independent of which account is
      // selected above — Meta and Google never share a pool, but a person
      // still wants to see the two side by side.
      const periodMonth = periodMonthOf(now);
      const [wingsTotalRow] = await db
        .select({
          count: sql<string>`count(*)`,
          capCents: sql<string>`coalesce(sum(${budgetPeriods.capCents}), 0)`,
          usableCents: sql<string>`coalesce(sum(${budgetPeriods.usableCents}), 0)`,
          committedCents: sql<string>`coalesce(sum(${budgetPeriods.committedCents}), 0)`,
          spentCents: sql<string>`coalesce(sum(${budgetPeriods.spentCents}), 0)`,
        })
        .from(budgetPeriods)
        .innerJoin(adAccounts, eq(adAccounts.id, budgetPeriods.adAccountId))
        .where(
          and(
            eq(budgetPeriods.periodMonth, periodMonth),
            isNull(budgetPeriods.closedAt),
            isNull(adAccounts.archivedAt),
          ),
        );
      const wingsTotal =
        wingsTotalRow && Number(wingsTotalRow.count) > 0
          ? {
              capCents: Number(wingsTotalRow.capCents),
              usableCents: Number(wingsTotalRow.usableCents),
              committedCents: Number(wingsTotalRow.committedCents),
              spentCents: Number(wingsTotalRow.spentCents),
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
        wingsTotal,
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

  /**
   * Administração → Integrações: every non-archived Meta/Google account with
   * this month's cap, for the admin edit form. Admin Master only — the same
   * hand that may write the cap below.
   */
  app.get(
    '/ads/accounts/budget-caps',
    { preHandler: app.requirePermission('ads.budget_caps.manage') },
    async (_request, reply) => {
      const now = app.wings.now?.() ?? new Date();
      const accounts = await db.query.adAccounts.findMany({
        where: and(isNull(adAccounts.archivedAt), inArray(adAccounts.platform, ['meta', 'google'])),
        orderBy: asc(adAccounts.createdAt),
      });
      const views = await Promise.all(
        accounts.map((account) => budgetCapViewOf(db, account, now)),
      );
      return reply.send({ accounts: views });
    },
  );

  /**
   * Opens or edits this month's internal cap for one account — the same
   * write `openPeriod` has always done from `ingest-cli --seed`/`verify-live`,
   * now reachable from a screen. Never touches `reserveChange` or any
   * enforcement path: it only records what the guardrail is judged against.
   */
  app.post(
    '/ads/accounts/:accountId/budget-cap',
    { preHandler: app.requirePermission('ads.budget_caps.manage') },
    async (request, reply) => {
      const params = accountIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: 'not_found', message: 'Conta não encontrada.' });
      }
      const body = budgetCapUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: body.error.issues[0]?.message ?? 'Dados inválidos.',
        });
      }

      const account = await db.query.adAccounts.findFirst({
        where: eq(adAccounts.id, params.data.accountId),
      });
      if (!account) {
        return reply.status(404).send({ error: 'not_found', message: 'Conta não encontrada.' });
      }

      const now = app.wings.now?.() ?? new Date();
      const periodMonth = periodMonthOf(now, account.timezone);
      await openPeriod(db, {
        adAccountId: account.id,
        periodMonth,
        capCents: body.data.capCents,
        usablePercent: body.data.usablePercent,
        changedBy: request.session.actor.employeeId,
        reason: body.data.reason,
      });

      return reply.send({ account: await budgetCapViewOf(db, account, now) });
    },
  );

  /**
   * "Atualizar agora": the same read `reconcileAccount` does every 15 minutes
   * on the scheduled task, run once on a click instead of waiting for the
   * next cycle. Never writes to the platform — always a reader, the same as
   * the scheduled job, whatever ADS_WRITES_ENABLED says.
   */
  app.post(
    '/ads/accounts/:accountId/reconcile-now',
    { preHandler: app.requirePermission('ads.reconcile.manual') },
    async (request, reply) => {
      const params = accountIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: 'not_found', message: 'Conta não encontrada.' });
      }
      const { accountId } = params.data;

      const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) });
      if (!account || account.archivedAt) {
        return reply.status(404).send({ error: 'not_found', message: 'Conta não encontrada.' });
      }

      const now = app.wings.now?.() ?? new Date();

      if (reconcilingNow.has(accountId)) {
        return reply.status(429).send({
          error: 'reconcile_in_progress',
          message: 'Já há uma reconciliação em andamento para esta conta.',
        });
      }
      const state = await getPeriodState(db, accountId, periodMonthOf(now, account.timezone));
      if (
        state?.lastReconciledAt &&
        now.getTime() - state.lastReconciledAt.getTime() < MANUAL_RECONCILE_COOLDOWN_MS
      ) {
        const retryAfterSeconds = Math.ceil(
          (MANUAL_RECONCILE_COOLDOWN_MS - (now.getTime() - state.lastReconciledAt.getTime())) /
            1000,
        );
        return reply.status(429).send({
          error: 'reconcile_cooldown',
          message: `Conta já foi atualizada há pouco. Tente de novo em ${retryAfterSeconds}s.`,
          retryAfterSeconds,
        });
      }

      const { client } = createPlatformClient(
        { ...env, ADS_WRITES_ENABLED: false },
        account,
        platformFetch,
      );
      if (!client) {
        return reply.status(503).send({
          error: 'no_credentials',
          message: 'Sem credenciais de leitura configuradas para esta conta.',
        });
      }

      reconcilingNow.add(accountId);
      try {
        await reconcileAccount(db, client, accountId, now);
      } catch (error) {
        return reply.status(502).send({
          error: 'reconcile_failed',
          message: 'A plataforma não respondeu. Tente de novo em instantes.',
          detail: error instanceof Error ? error.name : 'unknown',
        });
      } finally {
        reconcilingNow.delete(accountId);
      }

      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.reconciled_manually',
        entity: 'ad_account',
        entityId: accountId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: { accountExternalId: account.externalId, platform: account.platform },
      });

      const facts = await pacingFacts(db, accountId, now);
      return reply.send({ ok: true, lastReconciledAt: facts?.lastReconciledAtIso ?? null });
    },
  );
};
