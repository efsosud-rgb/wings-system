import {
  agentSendMessageSchema,
  type AgentConversationResponse,
  type AgentProposalRequestResponse,
  type AgentStatusResponse,
  type AgentStreamEvent,
} from '@wings/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  agentConversations,
  agentMessages,
  agentProposals,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { gateChange } from '../ads/approvals.js';
import { reserveChange } from '../ads/budget-guard.js';
import { createApprovalNotifier } from '../ads/notifiers/factory.js';
import { createOpenRouterLlm, type AgentLlm } from './llm.js';
import { cardOf, conversationMessages, runAgentTurn, usageToday } from './service.js';

const idParam = z.object({ id: z.uuid() });
const MESSAGES_PER_MINUTE = 12;

/**
 * The conversation with the traffic agent.
 *
 * Reading and talking need `ads.read`; turning a proposal into a request needs
 * `ads.request`, and that request is the person's own: it goes through the same
 * budget guard and the same approval gate as one typed by hand, marked
 * "sugerido pelo agente". Nothing in this file calls an ad platform.
 */
export const agentRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  /** Null while the key is missing: the routes then answer 503, never a fake reply. */
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);

  app.get(
    '/agent/status',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const body: AgentStatusResponse = {
        configured: llm !== null,
        usage: await usageToday(db, request.session.actor.employeeId, env.AGENT_DAILY_USD),
      };
      return reply.send(body);
    },
  );

  app.get(
    '/agent/conversations',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const rows = await db
        .select({
          id: agentConversations.id,
          title: agentConversations.title,
          updatedAt: agentConversations.updatedAt,
        })
        .from(agentConversations)
        .where(eq(agentConversations.employeeId, request.session.actor.employeeId))
        .orderBy(desc(agentConversations.updatedAt))
        .limit(30);
      return reply.send({
        conversations: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
      });
    },
  );

  app.get(
    '/agent/conversations/:id',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const conversation = params.success
        ? await db.query.agentConversations.findFirst({
            where: and(
              eq(agentConversations.id, params.data.id),
              eq(agentConversations.employeeId, request.session.actor.employeeId),
            ),
          })
        : undefined;
      if (!conversation) {
        return reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
      }
      const body: AgentConversationResponse = {
        conversation: {
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt.toISOString(),
        },
        messages: await conversationMessages(db, conversation.id),
      };
      return reply.send(body);
    },
  );

  app.post(
    '/agent/messages',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const parsed = agentSendMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues[0]?.message ?? 'Dados inválidos',
        });
      }
      if (!llm) {
        return reply.status(503).send({
          error: 'agent_not_configured',
          message: 'O agente ainda não está configurado neste ambiente.',
        });
      }
      const employeeId = request.session.actor.employeeId;

      // Per person, not per IP: the whole office leaves through one address.
      const [recent] = await db
        .select({ count: sql<string>`count(*)` })
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.employeeId, employeeId),
            eq(agentMessages.role, 'user'),
            gte(agentMessages.createdAt, new Date(Date.now() - 60_000)),
          ),
        );
      if (Number(recent?.count ?? 0) >= MESSAGES_PER_MINUTE) {
        return reply.status(429).send({
          error: 'too_many_messages',
          message: 'Muitas mensagens em pouco tempo. Espere um minuto.',
          retryAfterSeconds: 60,
        });
      }

      if (parsed.data.conversationId) {
        const owned = await db.query.agentConversations.findFirst({
          where: and(
            eq(agentConversations.id, parsed.data.conversationId),
            eq(agentConversations.employeeId, employeeId),
          ),
        });
        if (!owned) {
          return reply
            .status(404)
            .send({ error: 'not_found', message: 'Conversa não encontrada.' });
        }
      }

      // From here on the reply is a stream, and problems travel inside it.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tells nginx-style proxies not to hold the reply back.
        'X-Accel-Buffering': 'no',
      });
      const send = (event: AgentStreamEvent) => {
        if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      try {
        await runAgentTurn(
          { db, llm, model: env.AGENT_MODEL, dailyLimitUsd: env.AGENT_DAILY_USD },
          {
            employeeId,
            conversationId: parsed.data.conversationId,
            message: parsed.data.message,
            context: parsed.data.context,
            signal: abort.signal,
          },
          send,
        );
      } catch (error) {
        // The message never goes to the log: it may quote what the person typed.
        request.log.error({ err: error instanceof Error ? error.name : 'unknown' }, 'agent turn');
        send({
          type: 'error',
          code: 'internal_error',
          message: 'Não consegui responder agora. Nada foi alterado.',
        });
      } finally {
        reply.raw.end();
      }
    },
  );

  /** The proposal, if it is this person's and still exists. */
  async function ownProposal(id: string, employeeId: string) {
    const [row] = await db
      .select({
        id: agentProposals.id,
        kind: agentProposals.kind,
        payload: agentProposals.payload,
        status: agentProposals.status,
        createdAt: agentProposals.createdAt,
        changeRequestId: agentProposals.changeRequestId,
        conversationId: agentProposals.conversationId,
        approvalId: adApprovalRequests.id,
      })
      .from(agentProposals)
      .leftJoin(
        adApprovalRequests,
        eq(adApprovalRequests.changeRequestId, agentProposals.changeRequestId),
      )
      .where(and(eq(agentProposals.id, id), eq(agentProposals.employeeId, employeeId)));
    return row ?? null;
  }

  /** "Aplicar no construtor" was clicked. The form lives in the browser; this is the record. */
  app.post(
    '/agent/proposals/:id/applied',
    { preHandler: app.requirePermission('ads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const employeeId = request.session.actor.employeeId;
      const row = params.success ? await ownProposal(params.data.id, employeeId) : null;
      if (!row || row.kind !== 'campaign') {
        return reply.status(404).send({ error: 'not_found', message: 'Proposta não encontrada.' });
      }
      const now = new Date();
      await db
        .update(agentProposals)
        .set({ status: 'applied', actedBy: employeeId, actedAt: now })
        .where(eq(agentProposals.id, row.id));
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'agent.proposal_applied',
        entity: 'agent_proposal',
        entityId: row.id,
        ip: request.ip,
        metadata: { kind: row.kind, conversationId: row.conversationId },
      });
      const proposal = await cardOf(db, { ...row, status: 'applied' });
      return reply.send({ proposal });
    },
  );

  /**
   * "Criar pedido" was clicked. The request is the person's: the same budget
   * guard and the same approval gate as any other, plus the mark that the idea
   * came from the agent. One proposal makes at most one request.
   */
  app.post(
    '/agent/proposals/:id/request',
    { preHandler: app.requirePermission('ads.request') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const employeeId = request.session.actor.employeeId;
      const row = params.success ? await ownProposal(params.data.id, employeeId) : null;
      const card = row ? await cardOf(db, row) : null;
      if (!row || !card || card.kind !== 'change') {
        return reply.status(404).send({ error: 'not_found', message: 'Proposta não encontrada.' });
      }
      if (row.status !== 'open' || row.changeRequestId) {
        return reply.status(409).send({
          error: 'already_requested',
          message: 'Esta proposta já virou um pedido.',
        });
      }
      if (!card.requestable || card.payload.kind === 'add_negative_keyword') {
        return reply.status(409).send({
          error: 'not_requestable',
          message: card.notRequestableReason ?? 'Esta proposta não vira pedido.',
        });
      }

      const [campaign] = await db
        .select({ id: adCampaigns.id, adAccountId: adCampaigns.adAccountId })
        .from(adCampaigns)
        .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
        .where(eq(adCampaigns.externalId, card.payload.campaignExternalId));
      if (!campaign) {
        return reply.status(404).send({ error: 'not_found', message: 'Campanha não encontrada.' });
      }

      const reserved = await reserveChange(db, {
        adAccountId: campaign.adAccountId,
        campaignId: campaign.id,
        kind: card.payload.kind,
        toDailyBudgetCents: card.payload.toDailyBudgetCents,
        requestedBy: employeeId,
        requestedByAgent: false,
        suggestedByAgent: true,
        reason: `Sugerido pelo agente: ${card.payload.justification}`.slice(0, 500),
      });
      if (!reserved.ok) {
        await db
          .update(agentProposals)
          .set({ status: 'refused', actedBy: employeeId, actedAt: new Date() })
          .where(eq(agentProposals.id, row.id));
        await writeAudit(db, {
          actorEmployeeId: employeeId,
          action: 'agent.proposal_refused_by_guard',
          entity: 'agent_proposal',
          entityId: row.id,
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
        .update(agentProposals)
        .set({
          status: 'requested',
          actedBy: employeeId,
          actedAt: new Date(),
          changeRequestId: reserved.value.changeRequestId,
        })
        .where(eq(agentProposals.id, row.id));
      await writeAudit(db, {
        actorEmployeeId: employeeId,
        action: 'agent.proposal_requested',
        entity: 'agent_proposal',
        entityId: row.id,
        ip: request.ip,
        metadata: {
          changeRequestId: reserved.value.changeRequestId,
          changeKind: card.payload.kind,
          exposureDeltaCents: reserved.value.exposureDeltaCents,
        },
      });

      const body: AgentProposalRequestResponse = {
        proposal: { ...card, status: 'requested', approvalId: gate.approvalId ?? null },
        approvalId: gate.approvalId ?? null,
      };
      return reply.status(201).send(body);
    },
  );
};
