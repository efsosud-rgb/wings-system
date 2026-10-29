import { leadHidesWings, type LeadEmailSent } from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { crmEmailOutbox, crmEmailTemplates, employees } from '../../db/schema/index.js';
import { contactBlock } from './contact-block.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, type LeadPermission } from './access.js';
import { renderForLead, sendTemplateToLead } from './automations.js';
import { crmMailOf } from './crm-mail.js';

const idParam = z.object({ id: z.uuid() });
const bodySchema = z.object({ templateId: z.uuid() });
const invalid = { error: 'invalid_request', message: 'Dados inválidos' };
const notFound = (what = 'Negociação') => ({
  error: 'not_found',
  message: `${what} não encontrada.`,
});

const SEND_ERRORS = {
  template_gone: [404, 'Modelo não encontrado.'],
  template_off: [409, 'Este modelo está desativado.'],
  no_email: [422, 'Esta negociação não tem e-mail.'],
  brand_hidden: [
    409,
    'Expansão com marca: o lead não recebe e-mail da Wings. Fale por WhatsApp em nome da marca.',
  ],
  contact_blocked: [409, 'Pediu para não ser contatado por e-mail. Nada foi enviado.'],
  send_failed: [502, 'Não foi possível enviar o e-mail. Nada foi enviado.'],
} as const;

/**
 * E-mail to the lead from the deal's page: the person picks one of the active
 * templates, sees it filled in, and sends it. Same service as the automation
 * rules (`sendTemplateToLead`), same outbox and the same `lead.email_sent`
 * timeline event; in test mode (the default) nothing leaves, the message is only
 * recorded. Visibility follows the caller's scope on `leads.*` (a seller sees and
 * writes to their own leads). Audit entries carry ids, never the text.
 */
export const leadEmailRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  type Req = Parameters<typeof app.can>[0];

  const visibleLead = (request: Req, id: string, permission: LeadPermission) =>
    leadInScope(db, request.session.actor, id, permission);

  const read = { preHandler: app.requirePermission('leads.read') };
  const write = { preHandler: app.requirePermission('leads.write') };

  app.get('/leads/:id/emails', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid);
    const lead = await visibleLead(request, params.data.id, 'leads.read');
    if (!lead) return reply.status(404).send(notFound());
    const [templates, rows] = await Promise.all([
      db
        .select({ id: crmEmailTemplates.id, name: crmEmailTemplates.name })
        .from(crmEmailTemplates)
        .where(eq(crmEmailTemplates.active, true))
        .orderBy(crmEmailTemplates.name),
      db
        .select({
          id: crmEmailOutbox.id,
          subject: crmEmailOutbox.subject,
          body: crmEmailOutbox.body,
          mode: crmEmailOutbox.mode,
          status: crmEmailOutbox.status,
          createdAt: crmEmailOutbox.createdAt,
          templateName: crmEmailTemplates.name,
          sentByName: employees.fullName,
          fromEmail: crmEmailOutbox.fromEmail,
        })
        .from(crmEmailOutbox)
        .leftJoin(crmEmailTemplates, eq(crmEmailTemplates.id, crmEmailOutbox.templateId))
        .leftJoin(employees, eq(employees.id, crmEmailOutbox.sentBy))
        .where(eq(crmEmailOutbox.leadId, lead.id))
        .orderBy(desc(crmEmailOutbox.createdAt))
        .limit(50),
    ]);
    const sent: LeadEmailSent[] = rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      body: r.body,
      mode: r.mode === 'smtp' || r.mode === 'gmail' ? r.mode : 'test',
      status: r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : 'recorded',
      at: r.createdAt.toISOString(),
      templateName: r.templateName,
      sentByName: r.sentByName,
      fromEmail: r.fromEmail,
    }));
    const transport = crmMailOf(app.wings);
    return reply.send({
      to: lead.email,
      // Expansão with a brand: the lead must not see the Wings, so no e-mail leaves (brand rule).
      hidden: leadHidesWings(lead),
      // A "não me contate" by e-mail: why nothing can be sent, or null.
      blocked: (await contactBlock(db, 'email', { leadId: lead.id })).reason,
      mode: transport.mode,
      // Where a message sent now by this person would leave from (their Gmail, or the company's).
      from: await transport.senderOf(request.session.actor.employeeId),
      templates,
      sent,
    });
  });

  /** The template filled in for this lead; nothing is recorded or sent. */
  app.post('/leads/:id/emails/preview', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(invalid);
    const lead = await visibleLead(request, params.data.id, 'leads.write');
    if (!lead) return reply.status(404).send(notFound());
    const template = await db.query.crmEmailTemplates.findFirst({
      where: and(
        eq(crmEmailTemplates.id, body.data.templateId),
        eq(crmEmailTemplates.active, true),
      ),
    });
    if (!template) return reply.status(404).send(notFound('Modelo'));
    return reply.send(await renderForLead(db, lead, template));
  });

  app.post('/leads/:id/emails', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(invalid);
    const lead = await visibleLead(request, params.data.id, 'leads.write');
    if (!lead) return reply.status(404).send(notFound());
    const actor = request.session.actor.employeeId;
    const outcome = await sendTemplateToLead(db, {
      lead,
      templateId: body.data.templateId,
      transport: crmMailOf(app.wings),
      runId: null,
      sentBy: actor,
    });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: outcome.ok ? 'lead.email_sent' : 'lead.email_failed',
      entity: 'lead',
      entityId: lead.id,
      ip: request.ip,
      metadata: {
        templateId: body.data.templateId,
        ...(outcome.ok
          ? { mode: outcome.mode, outboxId: outcome.outboxId }
          : { reason: outcome.reason }),
      },
    });
    if (!outcome.ok) {
      const [status, message] = SEND_ERRORS[outcome.reason];
      return reply
        .status(status)
        .send({ error: outcome.reason, message: outcome.message ?? message });
    }
    return reply.status(201).send({ outboxId: outcome.outboxId, mode: outcome.mode });
  });
};
