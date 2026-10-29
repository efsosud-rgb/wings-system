import {
  expansionAreaSchema,
  INSTAGRAM_MANUAL_VERDICTS,
  leadCreateSchema,
  funnelSummaryQuerySchema,
  leadListQuerySchema,
  sourceRuleCreateSchema,
  trackingLinkCreateSchema,
  whatsappLinkOf,
  WINGS_CLIENT_ID,
  type LeadSourceRule,
  type LeadPipeline,
  type LeadSourceRuleKind,
  type LeadTrackingLink,
  type LeadLinkChannel,
} from '@wings/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  clients,
  crmStages,
  employees,
  leadSourceRules,
  leadTrackingLinks,
  leads,
} from '../../db/schema/index.js';
import { leadCheckDepsOf, runLeadChecks } from './field-checks.js';
import { setInstagramManual } from './instagram-check.js';
import { writeAudit } from '../../lib/audit.js';
import { canChangeLeadOwner, leadInScope, leadOwnerFilter } from './access.js';
import { activeClient, toClient } from '../clients/routes.js';
import { changeLead } from './crm.js';
import {
  brandOfLink,
  enqueueResearch,
  ForeignLeadError,
  NumberInAttendanceError,
  funnelSummary,
  listLeads,
  loadLead,
  upsertLead,
} from './service.js';
import { createTrackingLink } from './tracking-links.js';

const idParam = z.object({ id: z.uuid() });

const invalid = (message?: string) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
});
const notFound = { error: 'not_found', message: 'Lead não encontrado.' };

type LinkRow = typeof leadTrackingLinks.$inferSelect;
/** Every link opens the Wings WhatsApp; the brand goes in the text (T6). */
const toLink = (row: LinkRow, brand: string | null, wingsPhone?: string): LeadTrackingLink => ({
  id: row.id,
  clientId: row.clientId,
  channel: row.channel as LeadLinkChannel,
  code: row.code,
  phone: row.phone,
  url: whatsappLinkOf(row.phone, row.code, brand),
  current: row.phone === wingsPhone,
  hits: row.hits,
  lastHitAt: row.lastHitAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * CRM Vendas → Funil (leads) and the pieces of Formatação → Clientes the
 * intake needs: source rules, tracked links and the expansion area. The
 * webhooks live in `webhooks.ts`, outside any session.
 */
export const leadRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  /** `own` scope sees only leads it owns; a lead nobody owns is out of that scope. */
  const ownerFilter = (request: Parameters<typeof app.can>[0]) =>
    leadOwnerFilter(request.session.actor, 'leads.read');

  app.get('/leads', { preHandler: app.requirePermission('leads.read') }, async (request, reply) => {
    const query = leadListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid('Filtro inválido.'));
    const listed = await listLeads(db, { ...query.data, ownerEmployeeId: ownerFilter(request) });
    return reply.send(listed);
  });

  app.get(
    '/leads/summary',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = funnelSummaryQuerySchema.safeParse(request.query);
      if (!query.success) return reply.status(400).send(invalid('Janela inválida.'));
      return reply.send(
        await funnelSummary(db, { days: query.data.days, ownerEmployeeId: ownerFilter(request) }),
      );
    },
  );

  app.post(
    '/leads',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const body = leadCreateSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
      if (!body.data.email && !body.data.phone) {
        return reply.status(400).send(invalid('Informe um e-mail ou um telefone.'));
      }
      const clientId = body.data.clientId || undefined;
      const client = clientId ? await activeClient(db, clientId) : null;
      if (clientId && !client) {
        return reply.status(400).send(invalid('Cliente inativo ou inexistente.'));
      }
      const actor = request.session.actor.employeeId;
      const pipeline = body.data.pipeline || null;
      // The owner: the one named (leads.assign to name someone else), the caller, or the rotation.
      let ownerEmployeeId: string | null | undefined;
      if (body.data.ownerEmployeeId === 'me') ownerEmployeeId = actor;
      else if (body.data.ownerEmployeeId) {
        if (body.data.ownerEmployeeId !== actor && !canChangeLeadOwner(request.session.actor))
          return reply.status(403).send({
            error: 'forbidden',
            message: 'Só quem pode atribuir negociações escolhe outro dono.',
          });
        const owner = await db.query.employees.findFirst({
          where: eq(employees.id, body.data.ownerEmployeeId),
          columns: { id: true, status: true },
        });
        if (!owner || owner.status !== 'active')
          return reply.status(400).send(invalid('Funcionário inexistente ou inativo.'));
        ownerEmployeeId = owner.id;
      } else
        ownerEmployeeId =
          pipeline && leadOwnerFilter(request.session.actor, 'leads.write') === undefined
            ? null
            : actor;
      const stage = body.data.stageId
        ? await db.query.crmStages.findFirst({ where: eq(crmStages.id, body.data.stageId) })
        : null;
      if (
        body.data.stageId &&
        (!stage || !stage.active || (pipeline && stage.pipeline !== pipeline))
      )
        return reply.status(400).send(invalid('Etapa inexistente ou de outro funil.'));
      let result: Awaited<ReturnType<typeof upsertLead>>;
      try {
        result = await upsertLead(db, {
          source: 'manual',
          name: body.data.name,
          email: body.data.email || null,
          phone: body.data.phone || null,
          clientId: clientId ?? WINGS_CLIENT_ID,
          clientMapped: Boolean(clientId),
          brand: client && client.id !== WINGS_CLIENT_ID ? client.name : null,
          pipeline: (stage?.pipeline as LeadPipeline | undefined) ?? pipeline,
          company: body.data.companyName ? { name: body.data.companyName } : null,
          valueCents: body.data.valueCents ?? null,
          channel: body.data.channel || null,
          legalBasis: body.data.legalBasis,
          consentedAt: new Date(),
          consentSource: 'manual',
          consentText: body.data.consentText || 'Negociação criada no Wings System',
          ownerEmployeeId,
          // A seller's new lead never merges into somebody else's (or nobody's): same phone or e-mail is refused.
          mergeOnlyIfOwnedBy: leadOwnerFilter(request.session.actor, 'leads.write'),
          event: { kind: 'lead.created_manually', actorEmployeeId: actor },
        });
      } catch (error) {
        if (error instanceof NumberInAttendanceError)
          return reply.status(409).send({
            error: 'number_in_attendance',
            message:
              'Esta pessoa já está em atendimento (com a Sofia ou com a equipe) e ainda não tem negociação. Peça à Diretoria para passar a conversa a você.',
          });
        if (error instanceof ForeignLeadError)
          return reply.status(409).send({
            error: 'duplicate',
            message: 'Já existe uma negociação com este telefone ou e-mail.',
          });
        throw error;
      }
      if (result.created && stage && result.lead.stageId !== stage.id) {
        await changeLead(db, {
          leadId: result.lead.id,
          stageId: stage.id,
          source: 'wings',
          actorEmployeeId: actor,
        });
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: result.created ? 'lead.created' : 'lead.merged',
        entity: 'lead',
        entityId: result.lead.id,
        ip: request.ip,
        metadata: { source: 'manual', researchQueued: result.researchQueued },
      });
      const loaded = await loadLead(db, result.lead.id);
      return reply
        .status(result.created ? 201 : 200)
        .send({ lead: loaded?.lead, created: result.created });
    },
  );

  app.get(
    '/leads/:id',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      // Authorized first: a lead out of reach is never even loaded.
      if (!(await leadInScope(db, request.session.actor, params.data.id, 'leads.read')))
        return reply.status(404).send(notFound);
      const loaded = await loadLead(db, params.data.id);
      if (!loaded) return reply.status(404).send(notFound);
      return reply.send(loaded);
    },
  );

  // "Não é robô": the seller clears the suspect mark; the reasons stay for history.
  app.post(
    '/leads/:id/suspect/clear',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const row = await leadInScope(db, request.session.actor, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      if (row.suspectAt && !row.suspectClearedAt) {
        await db
          .update(leads)
          .set({ suspectClearedAt: new Date(), suspectClearedBy: request.session.actor.employeeId })
          .where(eq(leads.id, row.id));
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: 'lead.suspect_cleared',
          entity: 'lead',
          entityId: row.id,
          ip: request.ip,
          metadata: { reasons: row.suspectReasons ?? [] },
        });
      }
      return reply.send(await loadLead(db, row.id));
    },
  );

  // "Conferir de novo": the arrival checks again (docs/leads/formularios.md). Answers when done.
  app.post(
    '/leads/:id/checks',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const row = await leadInScope(db, request.session.actor, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      const deps = leadCheckDepsOf(app);
      await runLeadChecks(db, row.id, deps, { manual: true });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'lead.checks_requested',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
      });
      return reply.send(await loadLead(db, row.id));
    },
  );

  // A seller's correction of the Instagram check: "confere", "falso", or null to take it back.
  app.post(
    '/leads/:id/instagram',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = z
        .object({ verdict: z.enum(INSTAGRAM_MANUAL_VERDICTS).nullable() })
        .safeParse(request.body);
      if (!params.success || !body.success) return reply.status(400).send(invalid());
      const row = await leadInScope(db, request.session.actor, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      await setInstagramManual(db, row.id, request.session.actor.employeeId, body.data.verdict);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'lead.instagram_corrected',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { verdict: body.data.verdict },
      });
      return reply.send(await loadLead(db, row.id));
    },
  );

  app.post(
    '/leads/:id/research',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const row = await leadInScope(db, request.session.actor, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      if (row.enrichmentState === 'pending' || row.enrichmentState === 'running') {
        return reply.status(409).send({
          error: 'research_in_progress',
          message: 'A pesquisa deste lead já está na fila. Aguarde ela terminar.',
        });
      }
      const actor = request.session.actor.employeeId;
      // The check above is only the fast answer; the claim inside enqueueResearch is the one
      // that holds when two clicks arrive together.
      const queued = await enqueueResearch(db, row.id, actor);
      if (!queued) {
        return reply.status(409).send({
          error: 'research_in_progress',
          message: 'A pesquisa deste lead já está na fila. Aguarde ela terminar.',
        });
      }
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.research_requested',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
      });
      const loaded = await loadLead(db, row.id);
      return reply.status(202).send(loaded);
    },
  );

  // --- source rules (Formatação → Clientes) ------------------------------------

  const manage = { preHandler: app.requirePermission('clients.manage') };

  async function listRules(): Promise<LeadSourceRule[]> {
    const rows = await db
      .select({
        id: leadSourceRules.id,
        kind: leadSourceRules.kind,
        pattern: leadSourceRules.pattern,
        clientId: clients.id,
        clientName: clients.name,
        pipeline: leadSourceRules.pipeline,
        brand: leadSourceRules.brand,
        active: leadSourceRules.active,
        createdAt: leadSourceRules.createdAt,
      })
      .from(leadSourceRules)
      // A rule may name a brand that is not a client yet: it is listed too.
      .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
      .orderBy(
        asc(sql`coalesce(${clients.name}, ${leadSourceRules.brand})`),
        asc(leadSourceRules.kind),
        asc(leadSourceRules.pattern),
      );
    return rows.map((row) => ({
      ...row,
      kind: row.kind as LeadSourceRuleKind,
      pipeline: (row.pipeline as LeadPipeline | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  app.get('/leads/source-rules', manage, async (_request, reply) =>
    reply.send({ rules: await listRules() }),
  );

  app.post('/leads/source-rules', manage, async (request, reply) => {
    const body = sourceRuleCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    if (!(await activeClient(db, body.data.clientId))) {
      return reply.status(400).send(invalid('Cliente inativo ou inexistente.'));
    }
    const actor = request.session.actor.employeeId;
    const [row] = await db
      .insert(leadSourceRules)
      .values({
        kind: body.data.kind,
        pattern: body.data.pattern,
        clientId: body.data.clientId,
        pipeline: body.data.pipeline ?? null,
        createdBy: actor,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      return reply
        .status(409)
        .send({ error: 'rule_exists', message: 'Já existe uma regra com este padrão.' });
    }
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead_source_rule.created',
      entity: 'lead_source_rule',
      entityId: row.id,
      ip: request.ip,
      metadata: { kind: row.kind, clientId: row.clientId },
    });
    const rule = (await listRules()).find((candidate) => candidate.id === row.id);
    return reply.status(201).send({ rule });
  });

  app.delete('/leads/source-rules/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const [row] = await db
      .delete(leadSourceRules)
      .where(eq(leadSourceRules.id, params.data.id))
      .returning();
    if (!row)
      return reply.status(404).send({ error: 'not_found', message: 'Regra não encontrada.' });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'lead_source_rule.deleted',
      entity: 'lead_source_rule',
      entityId: row.id,
      ip: request.ip,
      metadata: { kind: row.kind, clientId: row.clientId },
    });
    return reply.status(204).send();
  });

  // --- tracked links and expansion area (the client's screen) ---------------------

  app.get('/clients/:id/tracking-links', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const client = await db.query.clients.findFirst({ where: eq(clients.id, params.data.id) });
    if (!client) {
      return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
    }
    const brand = brandOfLink(client);
    const rows = await db
      .select()
      .from(leadTrackingLinks)
      .where(eq(leadTrackingLinks.clientId, params.data.id))
      .orderBy(asc(leadTrackingLinks.channel), desc(leadTrackingLinks.createdAt));
    return reply.send({
      links: rows.map((row) => toLink(row, brand, env.WINGS_WHATSAPP_NUMBER)),
      phoneConfigured: Boolean(env.WINGS_WHATSAPP_NUMBER),
    });
  });

  app.post('/clients/:id/tracking-links', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = trackingLinkCreateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(invalid());
    if (!env.WINGS_WHATSAPP_NUMBER) {
      return reply.status(503).send({
        error: 'whatsapp_number_not_configured',
        message: 'O número de WhatsApp da Wings (WINGS_WHATSAPP_NUMBER) não está configurado.',
      });
    }
    const client = await activeClient(db, params.data.id);
    if (!client) {
      return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
    }
    const actor = request.session.actor.employeeId;
    const row = await createTrackingLink(db, {
      clientId: params.data.id,
      channel: body.data.channel,
      phone: env.WINGS_WHATSAPP_NUMBER,
      createdBy: actor,
    });
    if (!row) {
      return reply.status(500).send({
        error: 'code_collision',
        message: 'Não foi possível gerar um código. Tente de novo.',
      });
    }
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead_tracking_link.created',
      entity: 'lead_tracking_link',
      entityId: row.id,
      ip: request.ip,
      metadata: { clientId: row.clientId, channel: row.channel },
    });
    return reply
      .status(201)
      .send({ link: toLink(row, brandOfLink(client), env.WINGS_WHATSAPP_NUMBER) });
  });

  app.patch('/clients/:id/expansion-area', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = expansionAreaSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    }
    const [row] = await db
      .update(clients)
      .set({ expansionArea: body.data.expansionArea })
      .where(eq(clients.id, params.data.id))
      .returning();
    if (!row)
      return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'client.expansion_area_updated',
      entity: 'client',
      entityId: row.id,
      ip: request.ip,
      metadata: { entries: body.data.expansionArea.length },
    });
    return reply.send({ client: toClient(row) });
  });
};
