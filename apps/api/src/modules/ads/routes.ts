import {
  approvalDecisionSchema,
  AD_ACCOUNT_PLATFORM,
  campaignDraftSchema,
  variationMedia,
  type ApprovalDetail,
  type ApprovalListItem,
  type CampaignDraft,
} from '@wings/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adApprovalRequests,
  adCreativeUploads,
  adVideoUploads,
  auditLog,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { decideApproval, gateChange } from './approvals.js';
import { reserveCampaignCreation } from './budget-guard.js';
import { nextPendingInGroup, pendingGroups } from './batches.js';
import { stepsOfExecution } from './ad-tree.js';
import { executeApprovedChange, preflightChange } from './executor.js';
import { createApprovalNotifier } from './notifiers/factory.js';
import { requestCampaignChange } from './ops.js';
import { createPlatformClient } from './platform/factory.js';
import { simulateChange } from './simulate.js';

/**
 * HTTP surface for the approvals panel.
 *
 * Thin by design: these routes read the approval tables and call the decision
 * logic built in Stage 4. No spending rule lives here — the gate and the
 * budget guard remain the only authorities.
 */

const idParamSchema = z.object({ id: z.string().uuid() });

/** An alternative daily budget to explore, in cents. Exploration only. */
const simulationQuerySchema = z.object({
  dailyBudgetCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
});

/** A change to a campaign that exists, asked for by a person from the screen. */
const changeRequestSchema = z
  .object({
    accountExternalId: z.string().trim().min(1),
    campaignExternalId: z.string().trim().min(1),
    kind: z.enum(['set_daily_budget', 'pause_campaign', 'resume_campaign']),
    toDailyBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
    reason: z.string().trim().min(3, 'Informe o motivo').max(500),
  })
  .refine((value) => value.kind !== 'set_daily_budget' || value.toDailyBudgetCents !== undefined, {
    message: 'Informe o novo orçamento diário',
    path: ['toDailyBudgetCents'],
  });

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

type ListRow = {
  id: string;
  status: ApprovalListItem['status'];
  trigger: ApprovalListItem['trigger'];
  amount_cents: string;
  account_name: string;
  platform: ApprovalListItem['platform'];
  campaign_name: string;
  change_kind: string;
  requested_at: Date | string;
  escalated_at: Date | string | null;
  decided_at: Date | string | null;
  requested_by_name: string | null;
  requested_by_agent: boolean;
  suggested_by_agent: boolean;
} & Record<string, unknown>;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toListItem(row: ListRow): ApprovalListItem {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    amountCents: Number(row.amount_cents),
    accountName: row.account_name,
    platform: row.platform,
    campaignName: row.campaign_name,
    changeKind: row.change_kind,
    requestedAt: iso(row.requested_at) ?? new Date(0).toISOString(),
    escalatedAt: iso(row.escalated_at),
    decidedAt: iso(row.decided_at),
    requestedByName: row.requested_by_name,
    requestedByAgent: row.requested_by_agent,
    suggestedByAgent: row.suggested_by_agent,
  };
}

export const adsRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, platformFetch } = app.wings;

  /** Pending first, then escalated, then decided as history. */
  app.get(
    '/ads/approvals',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      const rows = await db.execute<ListRow>(sql`
        select ar.id, ar.status, ar.trigger, ar.amount_cents::text as amount_cents,
               acc.name as account_name, acc.platform,
               coalesce(c.name, d.name) as campaign_name, cr.kind as change_kind,
               ar.requested_at, ar.escalated_at, ar.decided_at,
               req.full_name as requested_by_name, ar.requested_by_agent,
               cr.suggested_by_agent
          from ad_approval_requests ar
          join ad_change_requests cr on cr.id = ar.change_request_id
          join ad_accounts acc on acc.id = ar.ad_account_id
          left join ad_campaigns c on c.id = cr.campaign_id
          left join ad_campaign_drafts d on d.id = cr.draft_id
          left join employees req on req.id = ar.requested_by
         order by
           case ar.status when 'pending' then 0 when 'escalated' then 1 else 2 end,
           ar.requested_at desc
         limit 200
      `);
      return reply.send({ approvals: rows.rows.map(toListItem) });
    },
  );

  app.get(
    '/ads/approvals/:id',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const rows = await db.execute<
        ListRow & {
          account_external_id: string;
          campaign_external_id: string;
          budget_level: ApprovalDetail['budgetLevel'];
          from_value_cents: string | null;
          to_value_cents: string | null;
          exposure_delta_cents: string;
          request_reason: string | null;
          decision_reason: string | null;
          decided_by_name: string | null;
          cap_cents: string;
          usable_cents: string;
          committed_cents: string;
          spent_cents: string;
          notified_at: Date | string | null;
          notification_error: string | null;
          change_status: ApprovalDetail['changeStatus'];
          executed_at: Date | string | null;
          last_execution_outcome: 'applied' | 'rejected' | 'unknown' | null;
          last_execution_id: string | null;
          draft_payload: CampaignDraft | null;
        }
      >(sql`
        select ar.id, ar.status, ar.trigger, ar.amount_cents::text as amount_cents,
               acc.name as account_name, acc.platform, acc.external_id as account_external_id,
               coalesce(c.name, d.name) as campaign_name,
               coalesce(c.external_id, '') as campaign_external_id,
               coalesce(c.budget_level, 'campaign') as budget_level, d.payload as draft_payload,
               cr.kind as change_kind, cr.from_value_cents::text as from_value_cents,
               cr.to_value_cents::text as to_value_cents,
               cr.exposure_delta_cents::text as exposure_delta_cents, cr.reason as request_reason,
               cr.status as change_status, cr.executed_at,
               (select ex.outcome from ad_executions ex
                 where ex.change_request_id = cr.id
                 order by ex.started_at desc limit 1) as last_execution_outcome,
               (select ex.id from ad_executions ex
                 where ex.change_request_id = cr.id
                 order by ex.started_at desc limit 1) as last_execution_id,
               ar.requested_at, ar.escalated_at, ar.decided_at, ar.decision_reason,
               ar.notified_at, ar.notification_error,
               req.full_name as requested_by_name, ar.requested_by_agent,
               cr.suggested_by_agent,
               dec.full_name as decided_by_name,
               p.cap_cents::text as cap_cents, p.usable_cents::text as usable_cents,
               p.committed_cents::text as committed_cents, p.spent_cents::text as spent_cents
          from ad_approval_requests ar
          join ad_change_requests cr on cr.id = ar.change_request_id
          join ad_accounts acc on acc.id = ar.ad_account_id
          left join ad_campaigns c on c.id = cr.campaign_id
          left join ad_campaign_drafts d on d.id = cr.draft_id
          join ad_budget_periods p on p.id = cr.budget_period_id
          left join employees req on req.id = ar.requested_by
          left join employees dec on dec.id = ar.decided_by
         where ar.id = ${params.data.id}
      `);

      const row = rows.rows[0];
      if (!row) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      // The audit trail of this specific request, newest last.
      const trail = await db
        .select({
          at: auditLog.at,
          action: auditLog.action,
          metadata: auditLog.metadata,
          actorName: sql<string | null>`actor.full_name`,
        })
        .from(auditLog)
        .leftJoin(sql`employees as actor`, sql`actor.id = ${auditLog.actorEmployeeId}`)
        .where(and(eq(auditLog.entity, 'ad_approval_request'), eq(auditLog.entityId, row.id)))
        .orderBy(auditLog.at);

      const detail: ApprovalDetail = {
        ...toListItem(row),
        accountExternalId: row.account_external_id,
        campaignExternalId: row.campaign_external_id,
        budgetLevel: row.budget_level,
        fromValueCents: row.from_value_cents === null ? null : Number(row.from_value_cents),
        toValueCents: row.to_value_cents === null ? null : Number(row.to_value_cents),
        exposureDeltaCents: Number(row.exposure_delta_cents),
        requestReason: row.request_reason,
        decisionReason: row.decision_reason,
        decidedByName: row.decided_by_name,
        periodCapCents: Number(row.cap_cents),
        periodUsableCents: Number(row.usable_cents),
        periodCommittedCents: Number(row.committed_cents),
        periodSpentCents: Number(row.spent_cents),
        notifiedAt: iso(row.notified_at),
        notificationError: row.notification_error,
        changeStatus: row.change_status,
        executedAt: iso(row.executed_at),
        lastExecutionOutcome: row.last_execution_outcome,
        // Object by object, what the last execution made on the platform.
        executionSteps: row.last_execution_id
          ? await stepsOfExecution(db, row.last_execution_id)
          : [],
        executionAvailable: createPlatformClient(env, {
          platform: row.platform,
          externalId: row.account_external_id,
        }).canWrite,
        // Shaped for display only; the approval hash is over the stored payload.
        // A draft from before the map existed has no customLocations.
        draft:
          row.change_kind === 'create_campaign' && row.draft_payload
            ? {
                ...row.draft_payload,
                reach: {
                  ...row.draft_payload.reach,
                  customLocations: row.draft_payload.reach.customLocations ?? [],
                },
              }
            : null,
        auditTrail: trail.map((entry) => ({
          at: entry.at.toISOString(),
          action: entry.action,
          actorName: entry.actorName,
          metadata: (entry.metadata ?? {}) as Record<string, unknown>,
        })),
      };

      return reply.send({ approval: detail });
    },
  );

  /**
   * Scenario simulator: what this change would mean against the month's cap.
   *
   * Read-only. `dailyBudgetCents` explores an alternative value — it never
   * edits the request, which can only ever be approved as it was made.
   */
  app.get(
    '/ads/approvals/:id/simulation',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const query = simulationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: query.error.issues[0]?.message ?? 'Valor inválido para simulação.',
        });
      }

      const approval = await db.query.adApprovalRequests.findFirst({
        where: eq(adApprovalRequests.id, params.data.id),
      });
      if (!approval) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const simulation = await simulateChange(db, approval.changeRequestId, {
        alternativeDailyBudgetCents: query.data.dailyBudgetCents,
      });
      if (!simulation) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const next = await nextPendingInGroup(db, approval.id);
      return reply.send({ simulation, nextPending: next });
    },
  );

  /**
   * Waiting approvals grouped by campaign.
   *
   * A view only: there is no bulk decision here and never will be. Each item
   * links to its own screen, where the decision is taken and recorded alone.
   */
  app.get(
    '/ads/approvals-groups',
    { preHandler: app.requirePermission('ads.read') },
    async (_request, reply) => {
      return reply.send({ groups: await pendingGroups(db) });
    },
  );

  /** Approve or reject. The service re-checks the approver's role itself. */
  app.post(
    '/ads/approvals/:id/decision',
    { preHandler: app.requirePermission('ads.approve') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const parsed = approvalDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }

      const result = await decideApproval(db, {
        approvalId: params.data.id,
        approverEmployeeId: request.session.actor.employeeId,
        decision: parsed.data.decision,
        reason: parsed.data.reason,
        notifier: createApprovalNotifier(env, db, (message) => request.log.info(message)),
        ...requestContext(request),
      });

      if (!result.ok) {
        const status =
          result.reason === 'not_found' ? 404 : result.reason === 'already_decided' ? 409 : 403;
        return reply.status(status).send({ error: result.reason, message: result.message });
      }

      return reply.send({ ok: true, status: result.status });
    },
  );

  /**
   * Asks for a campaign to be created. This is the whole of "Lançar campanha":
   * the draft is validated, its exposure reserved, and the request put in
   * front of an approver. Nothing here can reach an ad platform — there is no
   * client in this handler to reach it with.
   */
  app.post(
    '/ads/campaign-requests',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      // The same schema the form uses, compliance rules included: blocked copy
      // is refused here even if a client skipped the on-screen warning.
      const parsed = campaignDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.status(400).send({
          error: 'invalid_request',
          message: issue?.message ?? 'Dados inválidos',
          path: issue?.path ?? [],
        });
      }

      // Every variation points at an image that was really uploaded here.
      // Google drafts carry none: their campaigns are born as a shell.
      const media = parsed.data.variations.map(variationMedia);
      const creativeIds = [...new Set(media.flatMap((item) => item.creativeIds))];
      const videoIds = [...new Set(media.flatMap((item) => item.videoIds))];
      const known =
        creativeIds.length === 0
          ? []
          : await db
              .select({ id: adCreativeUploads.id })
              .from(adCreativeUploads)
              .where(inArray(adCreativeUploads.id, creativeIds));
      if (known.length !== creativeIds.length) {
        return reply.status(400).send({
          error: 'creative_not_found',
          message: 'Um dos criativos não foi encontrado. Envie a imagem de novo.',
        });
      }
      const knownVideos =
        videoIds.length === 0
          ? []
          : await db
              .select({ id: adVideoUploads.id })
              .from(adVideoUploads)
              .where(inArray(adVideoUploads.id, videoIds));
      if (knownVideos.length !== videoIds.length) {
        return reply.status(400).send({
          error: 'video_not_found',
          message: 'Um dos vídeos não foi encontrado. Envie o vídeo de novo.',
        });
      }

      // The account the studio works on: for Meta, the one the cockpit shows;
      // for Google Pesquisa and YouTube, the Google Ads account.
      const accountPlatform = AD_ACCOUNT_PLATFORM[parsed.data.platform];
      const account = await db.query.adAccounts.findFirst({
        where: and(eq(adAccounts.platform, accountPlatform), isNull(adAccounts.archivedAt)),
        orderBy: asc(adAccounts.createdAt),
      });
      if (!account) {
        return reply.status(409).send({
          error: 'account_not_found',
          message:
            accountPlatform === 'google'
              ? 'Nenhuma conta Google Ads ativa neste ambiente.'
              : 'Nenhuma conta Meta ativa.',
        });
      }

      const reserved = await reserveCampaignCreation(db, {
        adAccountId: account.id,
        draft: parsed.data,
        requestedBy: request.session.actor.employeeId,
        reason: 'Campanha montada no studio',
      });
      if (!reserved.ok) {
        return reply.status(409).send({ error: reserved.reason, message: reserved.message });
      }

      const gate = await gateChange(db, {
        changeRequestId: reserved.value.changeRequestId,
        notifier: createApprovalNotifier(env, db, (message) => request.log.info(message)),
      });

      return reply.status(201).send({
        approvalId: gate.approvalId ?? null,
        changeRequestId: reserved.value.changeRequestId,
        exposureDeltaCents: reserved.value.exposureDeltaCents,
      });
    },
  );

  /**
   * Asks for a change to a campaign that exists: budget, pause or resume.
   * The same road the ops CLI and the agent's cards take — the budget guard
   * reserves, the gate puts it in front of an approver, nothing is sent.
   */
  app.post(
    '/ads/change-requests',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const parsed = changeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply
          .status(400)
          .send({ error: 'invalid_request', message: issue?.message ?? 'Dados inválidos' });
      }
      const result = await requestCampaignChange(db, {
        ...parsed.data,
        requestedBy: request.session.actor.employeeId,
        notifier: createApprovalNotifier(env, db, (message) => request.log.info(message)),
      });
      if (!result.ok) {
        const status = result.reason === 'reservation_refused' ? 409 : 404;
        return reply.status(status).send({ error: result.reason, message: result.message });
      }
      return reply.status(201).send({
        approvalId: result.value.approvalId ?? null,
        changeRequestId: result.value.changeRequestId,
        exposureDeltaCents: result.value.exposureDeltaCents,
      });
    },
  );

  /**
   * Rehearses a change against the real account without writing anything:
   * the exact request the executor would send, validated by the platform
   * (Google's `validateOnly`). Any credentials will do, a reader's included,
   * and the write switch is not consulted — nothing here can write.
   */
  app.post(
    '/ads/approvals/:id/preflight',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }
      const approval = await db.query.adApprovalRequests.findFirst({
        where: eq(adApprovalRequests.id, params.data.id),
      });
      const account = approval
        ? await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, approval.adAccountId) })
        : undefined;
      if (!approval || !account) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }
      // Always a reader: a rehearsal must be possible with writes switched off.
      const { client } = createPlatformClient(
        { ...env, ADS_WRITES_ENABLED: false },
        account,
        platformFetch,
      );
      if (!client) {
        return reply.status(409).send({
          error: 'no_credentials',
          message: 'Sem credenciais configuradas para esta conta.',
        });
      }

      const result = await preflightChange(db, client, approval.changeRequestId);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'ads.preflight',
        entity: 'ad_approval_request',
        entityId: approval.id,
        ip: request.ip,
        metadata: {
          platform: account.platform,
          status: result.status,
          ...(result.status === 'rejected' ? { code: result.code } : {}),
          ...(result.status === 'ok' ? { operations: result.operations.length } : {}),
        },
      });
      if (result.status === 'refused') {
        return reply.status(409).send({ error: result.reason, message: result.message });
      }
      return reply.send(result);
    },
  );

  /**
   * Executes an approved change against the real platform.
   *
   * Triggered by a person pressing a button, never by a worker: the first real
   * writes happen with someone watching. The executor re-checks every guarantee
   * itself; this route only carries the request to it.
   */
  app.post(
    '/ads/approvals/:id/execute',
    { preHandler: app.requirePermission('ads.approve') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const approval = await db.query.adApprovalRequests.findFirst({
        where: eq(adApprovalRequests.id, params.data.id),
      });
      if (!approval) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      // The client is built for the account this change belongs to, never for
      // whichever account the environment happens to name.
      const account = await db.query.adAccounts.findFirst({
        where: eq(adAccounts.id, approval.adAccountId),
      });
      if (!account) {
        return reply
          .status(404)
          .send({ error: 'not_found', message: 'Solicitação não encontrada.' });
      }

      const { client, canWrite, reason } = createPlatformClient(env, account, platformFetch);
      if (!client || !canWrite) {
        return reply.status(409).send({
          error: reason ?? 'writes_disabled',
          message:
            reason === 'no_credentials'
              ? 'Sem credenciais de escrita configuradas para esta conta.'
              : 'A execução em contas reais está desligada. Habilite ADS_WRITES_ENABLED para liberar.',
        });
      }

      const result = await executeApprovedChange(db, client, approval.changeRequestId, {
        allowWrites: true,
        actorEmployeeId: request.session.actor.employeeId,
        metaPixelId: env.META_PIXEL_ID,
        videoDir: env.CREATIVE_VIDEO_DIR,
      });

      if (result.outcome === 'applied') return reply.send({ ok: true, outcome: 'applied' });

      if (result.outcome === 'refused') {
        return reply.status(409).send({ error: result.reason, message: result.message });
      }
      if (result.outcome === 'rejected') {
        return reply
          .status(422)
          .send({ error: 'platform_rejected', message: result.message, code: result.code });
      }
      // Unknown: the account is frozen and reconciliation must resolve it.
      return reply.status(202).send({
        error: 'unknown_outcome',
        message:
          'A plataforma não confirmou o resultado. A conta foi congelada; verifique no Gerenciador de Anúncios antes de tentar novamente.',
        reason: result.reason,
      });
    },
  );
};
