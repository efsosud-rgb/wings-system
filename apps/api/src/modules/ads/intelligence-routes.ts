import {
  adCopyRequestSchema,
  auditRunRequestSchema,
  type AdPlatform,
  type DashboardWindow,
  type IntelligenceOverview,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adAlerts,
  adApprovalRequests,
  adAuditRuns,
  adCampaigns,
  adChangeRequests,
  adCopyDrafts,
  employees,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createOpenRouterLlm, type AgentLlm } from '../agent/llm.js';
import { conversionsApiStatus } from '../leads/meta-capi.js';
import { copyDraftsOf, copyUsageExhausted, generateAdCopy, type AdCopyDeps } from './ad-copy.js';
import { gateChange } from './approvals.js';
import {
  auditRunSummaries,
  dismissFinding,
  findingsOf,
  requestFromFinding,
  runAudit,
} from './audit.js';
import { activeAccounts } from './dashboard/queries.js';
import { ingestionStatus } from './dashboard/ingestion.js';
import { createApprovalNotifier } from './notifiers/factory.js';
import { hasPlatformCredentials } from './platform/factory.js';

const idParam = z.object({ id: z.uuid() });
/** Per person, counted in the database so every API instance agrees. */
const AUDITS_PER_MINUTE = 6;
const COPY_PER_MINUTE = 6;

/**
 * Marketing → Wings Ads Intelligence (docs/ads/intelligence.md).
 *
 * Reading, auditing and the overview need `ads.read`. Turning a finding into a
 * request, setting one aside and generating an ad package need `ads.request`.
 * Nothing here calls an ad platform: the audit reads the mirror, a request goes
 * through the budget guard and the approval gate, and approving and executing
 * stay where they always were (Aprovações, `ads.approve`).
 */
export const intelligenceRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => (app.wings.now ?? (() => new Date()))();
  const read = { preHandler: app.requirePermission('ads.read') };
  const ask = { preHandler: app.requirePermission('ads.request') };

  /** Null while the key is missing: generating then answers 503, never a made-up ad. */
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);
  const copyDeps = (): AdCopyDeps | null =>
    llm ? { db, llm, model: env.AGENT_MODEL, dailyLimitUsd: env.AGENT_DAILY_USD, now } : null;

  app.get('/ads/intelligence/overview', read, async (_request, reply) => {
    const at = now();
    const accounts = await activeAccounts(db);
    const ids = accounts.map((account) => account.id);
    const [synced, pending, unknown, alerts, ingest, operations, capi, [latestAudit]] =
      await Promise.all([
        db
          .select({
            id: adCampaigns.adAccountId,
            at: sql<Date | null>`max(${adCampaigns.lastSyncedAt})`,
          })
          .from(adCampaigns)
          .where(inArray(adCampaigns.adAccountId, ids))
          .groupBy(adCampaigns.adAccountId),
        db
          .select({ count: sql<string>`count(*)` })
          .from(adApprovalRequests)
          .where(inArray(adApprovalRequests.status, ['pending', 'escalated'])),
        db
          .select({ count: sql<string>`count(*)` })
          .from(adChangeRequests)
          .where(eq(adChangeRequests.status, 'unknown')),
        db
          .select({
            total: sql<string>`count(*)`,
            critical: sql<string>`count(*) filter (where ${adAlerts.severity} = 'critical')`,
          })
          .from(adAlerts)
          .where(and(inArray(adAlerts.adAccountId, ids), isNull(adAlerts.resolvedAt))),
        ingestionStatus(db, env, ids, at),
        db
          .select({
            id: adChangeRequests.id,
            kind: adChangeRequests.kind,
            status: adChangeRequests.status,
            campaignName: adCampaigns.name,
            platform: adAccounts.platform,
            requestedByName: employees.fullName,
            suggestedByAgent: adChangeRequests.suggestedByAgent,
            createdAt: adChangeRequests.createdAt,
            executedAt: adChangeRequests.executedAt,
            approvalId: adApprovalRequests.id,
          })
          .from(adChangeRequests)
          .innerJoin(adAccounts, eq(adAccounts.id, adChangeRequests.adAccountId))
          .leftJoin(adCampaigns, eq(adCampaigns.id, adChangeRequests.campaignId))
          .leftJoin(employees, eq(employees.id, adChangeRequests.requestedBy))
          .leftJoin(adApprovalRequests, eq(adApprovalRequests.changeRequestId, adChangeRequests.id))
          .orderBy(desc(adChangeRequests.createdAt))
          .limit(15),
        conversionsApiStatus(db, env, at),
        auditRunSummaries(db, { limit: 1 }),
      ]);
    const syncedById = new Map(synced.map((row) => [row.id, row.at]));
    const overview: IntelligenceOverview = {
      credentials: {
        meta: hasPlatformCredentials(env, 'meta'),
        google: hasPlatformCredentials(env, 'google'),
      },
      accounts: accounts.map((account) => {
        const last = syncedById.get(account.id);
        return {
          id: account.id,
          platform: account.platform as AdPlatform,
          name: account.name,
          externalId: account.externalId,
          killSwitchEngaged: account.killSwitchEngaged,
          lastSyncedAt: last ? new Date(last).toISOString() : null,
        };
      }),
      pendingApprovals: Number(pending[0]?.count ?? 0),
      unknownExecutions: Number(unknown[0]?.count ?? 0),
      openAlerts: {
        total: Number(alerts[0]?.total ?? 0),
        critical: Number(alerts[0]?.critical ?? 0),
      },
      ingestFailures:
        ingest.lastRunStatus === 'failed'
          ? ingest.lastRunFailures.map((failure) => ({
              step: failure.step,
              platform: String(failure.platform),
            }))
          : [],
      lastIngestAt: ingest.lastRunAt,
      operations: operations.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        campaignName: row.campaignName,
        platform: row.platform === 'meta' || row.platform === 'google' ? row.platform : null,
        requestedByName: row.requestedByName,
        suggestedByAgent: row.suggestedByAgent,
        createdAt: row.createdAt.toISOString(),
        executedAt: row.executedAt?.toISOString() ?? null,
        approvalId: row.approvalId,
      })),
      conversionsApi: capi,
      aiConfigured: llm !== null,
      latestAudit: latestAudit ?? null,
    };
    return reply.send(overview);
  });

  // --- audits --------------------------------------------------------------------

  app.get('/ads/intelligence/audits', read, async (_request, reply) =>
    reply.send({ runs: await auditRunSummaries(db, { limit: 30 }) }),
  );

  app.post('/ads/intelligence/audits', read, async (request, reply) => {
    const body = auditRunRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Inválido' });
    }
    const employeeId = request.session.actor.employeeId;
    const [recent] = await db
      .select({ count: sql<string>`count(*)` })
      .from(adAuditRuns)
      .where(
        and(
          eq(adAuditRuns.requestedBy, employeeId),
          gte(adAuditRuns.createdAt, new Date(now().getTime() - 60_000)),
        ),
      );
    if (Number(recent?.count ?? 0) >= AUDITS_PER_MINUTE) {
      return reply
        .status(429)
        .send({ error: 'rate_limited', message: 'Muitas auditorias seguidas. Aguarde um minuto.' });
    }
    const runId = await runAudit(db, env, {
      scope: body.data.scope,
      days: body.data.days as DashboardWindow,
      requestedBy: employeeId,
      ip: request.ip,
      now: now(),
    });
    const [run] = await auditRunSummaries(db, { id: runId });
    return reply.status(201).send({ run, findings: await findingsOf(db, runId) });
  });

  app.get('/ads/intelligence/audits/:id', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const [run] = params.success ? await auditRunSummaries(db, { id: params.data.id }) : [];
    if (!run) {
      return reply.status(404).send({ error: 'not_found', message: 'Auditoria não encontrada.' });
    }
    return reply.send({ run, findings: await findingsOf(db, run.id) });
  });

  app.post('/ads/intelligence/findings/:id/request', ask, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'Recomendação não encontrada.' });
    }
    const employeeId = request.session.actor.employeeId;
    const result = await requestFromFinding(db, {
      findingId: params.data.id,
      employeeId,
      now: now(),
    });
    if (!result.ok) {
      if (
        result.status === 409 &&
        result.error !== 'already_handled' &&
        result.error !== 'not_requestable'
      ) {
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'audit_finding.refused_by_guard',
          entity: 'ad_audit_finding',
          entityId: params.data.id,
          ip: request.ip,
          metadata: { reason: result.error },
        });
      }
      return reply.status(result.status).send({ error: result.error, message: result.message });
    }
    const gate = await gateChange(db, {
      changeRequestId: result.changeRequestId,
      notifier: createApprovalNotifier(env, db, (message) => request.log.info(message)),
    });
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: 'audit_finding.requested',
      entity: 'ad_audit_finding',
      entityId: params.data.id,
      ip: request.ip,
      metadata: {
        changeRequestId: result.changeRequestId,
        changeKind: result.kind,
        exposureDeltaCents: result.exposureDeltaCents,
      },
    });
    return reply
      .status(201)
      .send({ changeRequestId: result.changeRequestId, approvalId: gate.approvalId ?? null });
  });

  app.post('/ads/intelligence/findings/:id/dismiss', ask, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const employeeId = request.session.actor.employeeId;
    const done =
      params.success &&
      (await dismissFinding(db, { findingId: params.data.id, employeeId, now: now() }));
    if (!done) {
      return reply
        .status(409)
        .send({ error: 'already_handled', message: 'Esta recomendação já foi tratada.' });
    }
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: 'audit_finding.dismissed',
      entity: 'ad_audit_finding',
      entityId: params.data.id,
      ip: request.ip,
    });
    return reply.send({ ok: true });
  });

  // --- AI ad packages -------------------------------------------------------------

  app.get('/ads/intelligence/copy-drafts', read, async (request, reply) =>
    reply.send({ drafts: await copyDraftsOf(db, request.session.actor.employeeId) }),
  );

  app.post('/ads/intelligence/copy-drafts', ask, async (request, reply) => {
    const deps = copyDeps();
    if (!deps) {
      return reply.status(503).send({
        error: 'ai_not_configured',
        message: 'A IA não está configurada (falta a chave do OpenRouter).',
      });
    }
    const body = adCopyRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Inválido' });
    }
    const employeeId = request.session.actor.employeeId;
    const [recent] = await db
      .select({ count: sql<string>`count(*)` })
      .from(adCopyDrafts)
      .where(
        and(
          eq(adCopyDrafts.employeeId, employeeId),
          gte(adCopyDrafts.createdAt, new Date(now().getTime() - 60_000)),
        ),
      );
    if (Number(recent?.count ?? 0) >= COPY_PER_MINUTE) {
      return reply
        .status(429)
        .send({ error: 'rate_limited', message: 'Muitos pedidos seguidos. Aguarde um minuto.' });
    }
    if (await copyUsageExhausted(deps, employeeId)) {
      return reply.status(429).send({
        error: 'daily_limit',
        message: 'O teto diário de uso da IA foi atingido. Volta amanhã.',
      });
    }
    const draftId = await generateAdCopy(deps, { employeeId, request: body.data });
    const [draft] = await copyDraftsOf(db, employeeId, { id: draftId, limit: 1 });
    await writeAudit(db, {
      actorEmployeeId: employeeId,
      action: 'ads.copy_generated',
      entity: 'ad_copy_draft',
      entityId: draftId,
      ip: request.ip,
      // Kinds and counts only: the words stay in their own table.
      metadata: {
        platform: body.data.platform,
        variations: draft?.package?.variations.length ?? 0,
        refused: draft?.refused.length ?? 0,
        error: draft?.error ?? null,
      },
    });
    return reply.status(201).send({ draft });
  });
};
