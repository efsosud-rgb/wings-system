import {
  expansionAreaSchema,
  generateTrackingCode,
  grantedScope,
  leadCreateSchema,
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
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clients, leadSourceRules, leadTrackingLinks, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { activeClient, toClient } from '../clients/routes.js';
import { enqueueResearch, listLeads, loadLead, upsertLead } from './service.js';

const idParam = z.object({ id: z.uuid() });

const invalid = (message?: string) => ({ error: 'invalid_request', message: message ?? 'Dados inválidos' });
const notFound = { error: 'not_found', message: 'Lead não encontrado.' };

type LinkRow = typeof leadTrackingLinks.$inferSelect;
const toLink = (row: LinkRow): LeadTrackingLink => ({
  id: row.id,
  clientId: row.clientId,
  channel: row.channel as LeadLinkChannel,
  code: row.code,
  phone: row.phone,
  url: whatsappLinkOf(row.phone, row.code),
  hits: row.hits,
  lastHitAt: row.lastHitAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * CRM Vendas → Funil (leads) and the pieces of Administração → Clientes the
 * intake needs: source rules, tracked links and the expansion area. The
 * webhooks live in `webhooks.ts`, outside any session.
 */
export const leadRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;

  /** `own` scope sees only leads it owns; a lead nobody owns is out of that scope. */
  const ownerFilter = (request: Parameters<typeof app.can>[0]) =>
    grantedScope(request.session.actor, 'leads.read') === 'own' ? request.session.actor.employeeId : undefined;

  app.get('/leads', { preHandler: app.requirePermission('leads.read') }, async (request, reply) => {
    const query = leadListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid('Filtro inválido.'));
    const items = await listLeads(db, { ...query.data, ownerEmployeeId: ownerFilter(request) });
    return reply.send({ leads: items });
  });

  app.post('/leads', { preHandler: app.requirePermission('leads.write') }, async (request, reply) => {
    const body = leadCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    if (!body.data.email && !body.data.phone) {
      return reply.status(400).send(invalid('Informe um e-mail ou um telefone.'));
    }
    const clientId = body.data.clientId;
    if (clientId && !(await activeClient(db, clientId))) {
      return reply.status(400).send(invalid('Cliente inativo ou inexistente.'));
    }
    const actor = request.session.actor.employeeId;
    const result = await upsertLead(db, {
      source: 'manual',
      name: body.data.name,
      email: body.data.email || null,
      phone: body.data.phone || null,
      clientId: clientId ?? WINGS_CLIENT_ID,
      clientMapped: Boolean(clientId),
      channel: body.data.channel ?? null,
      legalBasis: body.data.legalBasis,
      consentedAt: new Date(),
      consentSource: 'manual',
      consentText: body.data.consentText,
      ownerEmployeeId: actor,
      event: { kind: 'lead.created_manually', actorEmployeeId: actor },
    });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: result.created ? 'lead.created' : 'lead.merged',
      entity: 'lead',
      entityId: result.lead.id,
      ip: request.ip,
      metadata: { source: 'manual', researchQueued: result.researchQueued },
    });
    const loaded = await loadLead(db, result.lead.id);
    return reply.status(result.created ? 201 : 200).send({ lead: loaded?.lead, created: result.created });
  });

  app.get('/leads/:id', { preHandler: app.requirePermission('leads.read') }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const loaded = await loadLead(db, params.data.id);
    if (!loaded || !visible(request, loaded.lead.ownerEmployeeId)) return reply.status(404).send(notFound);
    return reply.send(loaded);
  });

  app.post('/leads/:id/research', { preHandler: app.requirePermission('leads.write') }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const row = await db.query.leads.findFirst({ where: eq(leads.id, params.data.id) });
    if (!row || !visible(request, row.ownerEmployeeId)) return reply.status(404).send(notFound);
    if (row.enrichmentState === 'pending' || row.enrichmentState === 'running') {
      return reply.status(409).send({
        error: 'research_in_progress',
        message: 'A pesquisa deste lead já está na fila. Aguarde ela terminar.',
      });
    }
    const actor = request.session.actor.employeeId;
    await enqueueResearch(db, row.id, actor);
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'lead.research_requested',
      entity: 'lead',
      entityId: row.id,
      ip: request.ip,
    });
    const loaded = await loadLead(db, row.id);
    return reply.status(202).send(loaded);
  });

  // --- source rules (Administração → Clientes) ------------------------------------

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
        createdAt: leadSourceRules.createdAt,
      })
      .from(leadSourceRules)
      .innerJoin(clients, eq(clients.id, leadSourceRules.clientId))
      .orderBy(asc(clients.name), asc(leadSourceRules.kind), asc(leadSourceRules.pattern));
    return rows.map((row) => ({
      ...row,
      kind: row.kind as LeadSourceRuleKind,
      pipeline: (row.pipeline as LeadPipeline | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  app.get('/leads/source-rules', manage, async (_request, reply) => reply.send({ rules: await listRules() }));

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
      return reply.status(409).send({ error: 'rule_exists', message: 'Já existe uma regra com este padrão.' });
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
    const [row] = await db.delete(leadSourceRules).where(eq(leadSourceRules.id, params.data.id)).returning();
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'Regra não encontrada.' });
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
    const rows = await db
      .select()
      .from(leadTrackingLinks)
      .where(eq(leadTrackingLinks.clientId, params.data.id))
      .orderBy(asc(leadTrackingLinks.channel), desc(leadTrackingLinks.createdAt));
    return reply.send({ links: rows.map(toLink), phoneConfigured: Boolean(env.WINGS_WHATSAPP_NUMBER) });
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
    if (!(await activeClient(db, params.data.id))) {
      return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
    }
    const actor = request.session.actor.employeeId;
    // The code is unique by index; a collision (1 in a billion) just draws again.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await db
        .insert(leadTrackingLinks)
        .values({
          clientId: params.data.id,
          channel: body.data.channel,
          code: generateTrackingCode(),
          phone: env.WINGS_WHATSAPP_NUMBER,
          createdBy: actor,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead_tracking_link.created',
        entity: 'lead_tracking_link',
        entityId: row.id,
        ip: request.ip,
        metadata: { clientId: row.clientId, channel: row.channel },
      });
      return reply.status(201).send({ link: toLink(row) });
    }
    return reply.status(500).send({ error: 'code_collision', message: 'Não foi possível gerar um código. Tente de novo.' });
  });

  app.patch('/clients/:id/expansion-area', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = expansionAreaSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    }
    const [row] = await db
      .update(clients)
      .set({ expansionArea: body.data.expansionArea })
      .where(eq(clients.id, params.data.id))
      .returning();
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
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

  // --- helpers ----------------------------------------------------------------------

  function visible(request: Parameters<typeof app.can>[0], ownerEmployeeId: string | null): boolean {
    const owner = ownerFilter(request);
    return owner === undefined || ownerEmployeeId === owner;
  }
};
