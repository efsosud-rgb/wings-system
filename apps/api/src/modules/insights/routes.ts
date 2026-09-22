import {
  campaignSuggestionSchema,
  insightSchema,
  type AdPlatform,
  type CampaignSuggestionCard,
  type InsightCard,
  type InsightRunKind,
  type InsightsResponse,
  type SuggestionsResponse,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  campaignSuggestions,
  employees,
  insightRuns,
  insights,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { gateChange } from '../ads/approvals.js';
import { reserveChange } from '../ads/budget-guard.js';
import { createApprovalNotifier } from '../ads/notifiers/factory.js';
import { createOpenRouterLlm, type AgentLlm } from '../agent/llm.js';
import { changeCard, pendingFor } from '../agent/tools.js';
import { nextScheduledAt } from './scheduler.js';
import {
  executeRun,
  insightsUsageToday,
  latestRun,
  openRun,
  runOf,
  runningRun,
  type InsightsDeps,
} from './service.js';

const idParam = z.object({ id: z.uuid() });
const HISTORY_LIMIT = 100;

/**
 * Dashboard → Marketing → Insights e sugestões.
 *
 * Reading and generating need `ads.read`; turning an insight's action into a
 * request needs `ads.request`, and that request is the person's own: the same
 * budget guard and the same approval gate as one typed by hand, marked
 * "sugerido pela IA". A suggestion only ever fills the builder. Nothing in
 * this file calls an ad platform.
 */
export const insightsRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => (app.wings.now ?? (() => new Date()))();
  const read = { preHandler: app.requirePermission('ads.read') };

  /** Null while the key is missing: generating then answers 503, never a fake card. */
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);

  const deps = (): InsightsDeps | null =>
    llm
      ? {
          db,
          llm,
          model: env.AGENT_MODEL,
          dailyLimitUsd: env.INSIGHTS_DAILY_USD,
          now,
          log: (facts) => app.log.info(facts),
        }
      : null;

  // --- cards ------------------------------------------------------------------

  async function campaignsByExternal() {
    const rows = await db
      .select({
        externalId: adCampaigns.externalId,
        name: adCampaigns.name,
        platform: adAccounts.platform,
      })
      .from(adCampaigns)
      .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
      .where(isNull(adAccounts.archivedAt));
    return new Map(rows.map((row) => [row.externalId, row]));
  }

  type InsightRow = typeof insights.$inferSelect;

  /** Stored rows as cards. Re-validated: a row is data too. */
  async function insightCards(rows: InsightRow[]): Promise<InsightCard[]> {
    if (rows.length === 0) return [];
    const runIds = [...new Set(rows.map((row) => row.runId))];
    const [runs, campaigns, actors, approvals] = await Promise.all([
      db.select().from(insightRuns).where(inArray(insightRuns.id, runIds)),
      campaignsByExternal(),
      db
        .select({ id: employees.id, fullName: employees.fullName })
        .from(employees)
        .where(
          inArray(
            employees.id,
            rows
              .flatMap((row) => (row.actedBy ? [row.actedBy] : []))
              .concat(['00000000-0000-0000-0000-000000000000']),
          ),
        ),
      db
        .select({ id: adApprovalRequests.id, changeRequestId: adApprovalRequests.changeRequestId })
        .from(adApprovalRequests)
        .where(
          inArray(
            adApprovalRequests.changeRequestId,
            rows
              .flatMap((row) => (row.changeRequestId ? [row.changeRequestId] : []))
              .concat(['00000000-0000-0000-0000-000000000000']),
          ),
        ),
    ]);
    const runById = new Map(runs.map((run) => [run.id, run]));
    const actorById = new Map(actors.map((actor) => [actor.id, actor.fullName]));
    const approvalByChange = new Map(
      approvals.map((approval) => [approval.changeRequestId, approval.id]),
    );

    const cards: InsightCard[] = [];
    for (const row of rows) {
      const payload = insightSchema.safeParse(row.payload);
      if (!payload.success) continue;
      const campaign = row.campaignExternalId ? campaigns.get(row.campaignExternalId) : undefined;
      const action = payload.data.action
        ? await changeCard(
            db,
            { id: row.id, status: 'open', createdAt: row.createdAt, approvalId: null },
            payload.data.action,
          )
        : null;
      cards.push({
        id: row.id,
        runId: row.runId,
        kind: payload.data.kind,
        title: payload.data.title,
        findings: payload.data.findings,
        evidence: payload.data.evidence,
        suggestion: payload.data.suggestion,
        impact: payload.data.impact,
        confidence: payload.data.confidence,
        campaignExternalId: row.campaignExternalId,
        campaignName: campaign?.name ?? null,
        platform: (campaign?.platform as AdPlatform | undefined) ?? null,
        action: action
          ? {
              payload: action.payload,
              campaignName: action.campaignName,
              platform: action.platform as AdPlatform,
              currentDailyBudgetCents: action.currentDailyBudgetCents,
              requestable: action.requestable,
              notRequestableReason: action.notRequestableReason,
            }
          : null,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        actedAt: row.actedAt?.toISOString() ?? null,
        actedByName: row.actedBy ? (actorById.get(row.actedBy) ?? null) : null,
        approvalId: row.changeRequestId
          ? (approvalByChange.get(row.changeRequestId) ?? null)
          : null,
        consulted: (runById.get(row.runId)?.consulted as InsightCard['consulted']) ?? [],
      });
    }
    return cards;
  }

  async function insightCard(id: string): Promise<InsightCard | null> {
    const [row] = await db.select().from(insights).where(eq(insights.id, id));
    if (!row) return null;
    const [card] = await insightCards([row]);
    return card ?? null;
  }

  type SuggestionRow = typeof campaignSuggestions.$inferSelect;

  async function suggestionCards(rows: SuggestionRow[]): Promise<CampaignSuggestionCard[]> {
    if (rows.length === 0) return [];
    const actors = await db
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(
        inArray(
          employees.id,
          rows
            .flatMap((row) => (row.actedBy ? [row.actedBy] : []))
            .concat(['00000000-0000-0000-0000-000000000000']),
        ),
      );
    const actorById = new Map(actors.map((actor) => [actor.id, actor.fullName]));
    return rows.flatMap((row) => {
      const payload = campaignSuggestionSchema.safeParse(row.payload);
      if (!payload.success) return [];
      return [
        {
          id: row.id,
          runId: row.runId,
          proposal: payload.data.proposal,
          expectedCplCents: payload.data.expectedCplCents,
          expectedLeads: payload.data.expectedLeads,
          motivation: payload.data.motivation,
          pending: pendingFor(payload.data.proposal),
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          actedAt: row.actedAt?.toISOString() ?? null,
          actedByName: row.actedBy ? (actorById.get(row.actedBy) ?? null) : null,
        },
      ];
    });
  }

  async function suggestionCard(id: string): Promise<CampaignSuggestionCard | null> {
    const [row] = await db.select().from(campaignSuggestions).where(eq(campaignSuggestions.id, id));
    if (!row) return null;
    const [card] = await suggestionCards([row]);
    return card ?? null;
  }

  // --- generating ---------------------------------------------------------------

  /** "Gerar agora": opens the run, answers 202 and lets the model work in the background. */
  async function generate(kind: InsightRunKind, request: FastifyRequest, reply: FastifyReply) {
    const ready = deps();
    if (!ready) {
      return reply.status(503).send({
        error: 'insights_not_configured',
        message: 'A IA ainda não está configurada neste ambiente.',
      });
    }
    const employeeId = request.session.actor.employeeId;
    const opened = await openRun(ready, { kind, trigger: 'manual', requestedBy: employeeId });
    if (!opened.ok) {
      if (opened.code === 'daily_limit') {
        return reply.status(429).send({
          error: 'daily_limit',
          message: 'O teto diário de IA dos insights foi atingido. Volta a gerar amanhã.',
        });
      }
      return reply.status(409).send({
        error: 'already_running',
        message: 'Uma geração já está em andamento. Aguarde ela terminar.',
      });
    }
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: kind === 'insights' ? 'insights.generate' : 'suggestions.generate',
      entity: 'marketing_insight_run',
      entityId: opened.runId,
      ip: request.ip,
    });
    // Not awaited: the model may take a minute or two. Failures land on the run row.
    void executeRun(ready, opened.runId, kind).catch((error: unknown) => {
      request.log.error(
        { err: error instanceof Error ? error.name : 'unknown', runId: opened.runId },
        'insights run',
      );
    });
    return reply.status(202).send({ run: await runOf(db, opened.runId) });
  }

  // --- insights -------------------------------------------------------------------

  app.get('/ads/insights', read, async (_request, reply) => {
    const at = now();
    const [usage, latest, running, openRows, historyRows] = await Promise.all([
      insightsUsageToday(db, env.INSIGHTS_DAILY_USD, at),
      latestRun(db, 'insights'),
      runningRun(db, 'insights', at),
      db
        .select()
        .from(insights)
        .where(eq(insights.status, 'open'))
        .orderBy(desc(insights.createdAt)),
      db
        .select()
        .from(insights)
        .where(inArray(insights.status, ['seen', 'requested', 'refused']))
        .orderBy(desc(insights.actedAt), desc(insights.createdAt))
        .limit(HISTORY_LIMIT),
    ]);
    const body: InsightsResponse = {
      configured: llm !== null,
      usage,
      latestRun: latest,
      runningRun: running,
      open: await insightCards(openRows),
      history: await insightCards(historyRows),
      nextScheduledAt: nextScheduledAt(at).toISOString(),
    };
    return reply.send(body);
  });

  app.post('/ads/insights/generate', read, (request, reply) =>
    generate('insights', request, reply),
  );

  app.get('/ads/insights/runs/:id', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const run = params.success ? await runOf(db, params.data.id) : null;
    if (!run)
      return reply.status(404).send({ error: 'not_found', message: 'Geração não encontrada.' });
    return reply.send({ run });
  });

  /** "Marcar como visto": the recommendation was read; it moves to the history. */
  app.post('/ads/insights/:id/seen', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const [row] = params.success
      ? await db.select().from(insights).where(eq(insights.id, params.data.id))
      : [];
    if (!row)
      return reply.status(404).send({ error: 'not_found', message: 'Insight não encontrado.' });
    const employeeId = request.session.actor.employeeId;
    if (row.status === 'open') {
      await db
        .update(insights)
        .set({ status: 'seen', actedBy: employeeId, actedAt: now() })
        .where(eq(insights.id, row.id));
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'insight.seen',
        entity: 'marketing_insight',
        entityId: row.id,
        ip: request.ip,
        metadata: { kind: row.kind, runId: row.runId },
      });
    }
    return reply.send({ insight: await insightCard(row.id) });
  });

  /**
   * "Criar pedido" was clicked. The request is the person's: the same budget
   * guard and the same approval gate as any other, plus the mark that the idea
   * came from the AI. One insight makes at most one request.
   */
  app.post(
    '/ads/insights/:id/request',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const employeeId = request.session.actor.employeeId;
      const card = params.success ? await insightCard(params.data.id) : null;
      if (!card || !card.action) {
        return reply.status(404).send({ error: 'not_found', message: 'Insight não encontrado.' });
      }
      if (card.status !== 'open') {
        return reply
          .status(409)
          .send({ error: 'already_requested', message: 'Este insight já foi tratado.' });
      }
      if (!card.action.requestable || card.action.payload.kind === 'add_negative_keyword') {
        return reply.status(409).send({
          error: 'not_requestable',
          message: card.action.notRequestableReason ?? 'Esta sugestão não vira pedido.',
        });
      }

      const [campaign] = await db
        .select({ id: adCampaigns.id, adAccountId: adCampaigns.adAccountId })
        .from(adCampaigns)
        .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
        .where(
          and(
            eq(adCampaigns.externalId, card.action.payload.campaignExternalId),
            isNull(adAccounts.archivedAt),
          ),
        );
      if (!campaign) {
        return reply.status(404).send({ error: 'not_found', message: 'Campanha não encontrada.' });
      }

      const reserved = await reserveChange(db, {
        adAccountId: campaign.adAccountId,
        campaignId: campaign.id,
        kind: card.action.payload.kind,
        toDailyBudgetCents: card.action.payload.toDailyBudgetCents,
        requestedBy: employeeId,
        requestedByAgent: false,
        suggestedByAgent: true,
        reason: `Sugerido pela IA (insight): ${card.action.payload.justification}`.slice(0, 500),
      });
      if (!reserved.ok) {
        await db
          .update(insights)
          .set({ status: 'refused', actedBy: employeeId, actedAt: now() })
          .where(eq(insights.id, card.id));
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'insight.refused_by_guard',
          entity: 'marketing_insight',
          entityId: card.id,
          ip: request.ip,
          metadata: { reason: reserved.reason },
        });
        return reply.status(409).send({ error: reserved.reason, message: reserved.message });
      }

      const gate = await gateChange(db, {
        changeRequestId: reserved.value.changeRequestId,
        notifier: createApprovalNotifier(env, db, (message) => request.log.info(message)),
      });
      await db
        .update(insights)
        .set({
          status: 'requested',
          actedBy: employeeId,
          actedAt: now(),
          changeRequestId: reserved.value.changeRequestId,
        })
        .where(eq(insights.id, card.id));
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'insight.requested',
        entity: 'marketing_insight',
        entityId: card.id,
        ip: request.ip,
        metadata: {
          changeRequestId: reserved.value.changeRequestId,
          changeKind: card.action.payload.kind,
          exposureDeltaCents: reserved.value.exposureDeltaCents,
        },
      });
      return reply
        .status(201)
        .send({ insight: await insightCard(card.id), approvalId: gate.approvalId ?? null });
    },
  );

  // --- campaign suggestions ----------------------------------------------------

  app.get('/ads/insights/suggestions', read, async (_request, reply) => {
    const at = now();
    const [usage, latest, running, rows] = await Promise.all([
      insightsUsageToday(db, env.INSIGHTS_DAILY_USD, at),
      latestRun(db, 'campaign_suggestions'),
      runningRun(db, 'campaign_suggestions', at),
      db
        .select()
        .from(campaignSuggestions)
        .orderBy(desc(campaignSuggestions.createdAt))
        .limit(HISTORY_LIMIT),
    ]);
    const body: SuggestionsResponse = {
      configured: llm !== null,
      usage,
      latestRun: latest,
      runningRun: running,
      suggestions: await suggestionCards(rows),
      nextScheduledAt: nextScheduledAt(at).toISOString(),
    };
    return reply.send(body);
  });

  app.post('/ads/insights/suggestions/generate', read, (request, reply) =>
    generate('campaign_suggestions', request, reply),
  );

  /** "Abrir no construtor" / "Descartar" were clicked. The form lives in the browser; this is the record. */
  for (const [path, status, action] of [
    ['applied', 'applied', 'suggestion.applied'],
    ['dismiss', 'dismissed', 'suggestion.dismissed'],
  ] as const) {
    app.post(`/ads/insights/suggestions/:id/${path}`, read, async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const [row] = params.success
        ? await db
            .select()
            .from(campaignSuggestions)
            .where(eq(campaignSuggestions.id, params.data.id))
        : [];
      if (!row)
        return reply.status(404).send({ error: 'not_found', message: 'Sugestão não encontrada.' });
      const employeeId = request.session.actor.employeeId;
      await db
        .update(campaignSuggestions)
        .set({ status, actedBy: employeeId, actedAt: now() })
        .where(eq(campaignSuggestions.id, row.id));
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action,
        entity: 'marketing_campaign_suggestion',
        entityId: row.id,
        ip: request.ip,
        metadata: { runId: row.runId },
      });
      return reply.send({ suggestion: await suggestionCard(row.id) });
    });
  }
};
