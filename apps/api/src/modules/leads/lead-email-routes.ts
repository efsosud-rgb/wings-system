import {
  leadEmailComposeSchema,
  leadHidesWings,
  type LeadEmailReceived,
  type LeadEmailSent,
} from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  crmEmailInbound,
  crmEmailOutbox,
  crmEmailTemplates,
  employees,
} from '../../db/schema/index.js';
import { contactBlock } from './contact-block.js';
import { writeAudit } from '../../lib/audit.js';
import { storageOf } from '../../lib/storage/index.js';
import { dealRouteAccessOf } from '../drive/access.js';
import { googleWorkspaceDepsOf, mailReadFor } from '../google-workspace/service.js';
import { leadInScope, type LeadPermission } from './access.js';
import { renderForLead, sendTemplateToLead, sendToLead } from './automations.js';
import { crmMailOf } from './crm-mail.js';
import { attachmentsFor, dealAddressesOf } from './lead-email.js';

const idParam = z.object({ id: z.uuid() });
const bodySchema = z.object({ templateId: z.uuid() });
const invalid = { error: 'invalid_request', message: 'Dados inválidos' };
/** One Gmail thread is one conversation; a message without a thread is a conversation of its own. */
const conversationOf = (threadId: string | null, outboxId: string) =>
  threadId ? `t:${threadId}` : `o:${outboxId}`;

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
  not_a_contact: [422, 'Este endereço não é de um contato desta negociação.'],
  file_not_found: [404, 'Anexo não encontrado nos arquivos desta negociação.'],
  file_type: [415, 'Programas e scripts não vão como anexo.'],
  too_large: [413, 'Os anexos passam de 20 MB juntos. Tire algum antes de enviar.'],
  reply_not_found: [404, 'O e-mail respondido não é desta negociação.'],
} as const;
type SendError = keyof typeof SEND_ERRORS;

/**
 * E-mail to the lead from the deal's page: the person writes it (to one of the
 * deal's addresses, with the deal's files as attachments), starting from one of
 * the active templates or not. A bare `{ templateId }` still sends the template
 * as it is. Same service as the automation rules (`sendToLead`), same outbox and
 * the same `lead.email_sent` timeline event; in test mode (the default) nothing
 * leaves, the message is only recorded. Visibility follows the caller's scope on
 * `leads.*` (a seller sees and writes to their own leads). Audit entries carry
 * ids, never the text, an address or a file name.
 */
export const leadEmailRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  type Req = Parameters<typeof app.can>[0];
  const driveDeps = {
    db,
    storage: storageOf(app.wings),
    maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
    now: () => new Date(),
  };

  const visibleLead = (request: Req, id: string, permission: LeadPermission) =>
    leadInScope(db, request.session.actor, id, permission);

  const read = { preHandler: app.requirePermission('leads.read') };
  const write = { preHandler: app.requirePermission('leads.write') };

  app.get('/leads/:id/emails', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid);
    const lead = await visibleLead(request, params.data.id, 'leads.read');
    if (!lead) return reply.status(404).send(notFound());
    const [templates, rows, inbound] = await Promise.all([
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
          toEmail: crmEmailOutbox.toEmail,
          attachments: crmEmailOutbox.attachments,
          gmailThreadId: crmEmailOutbox.gmailThreadId,
        })
        .from(crmEmailOutbox)
        .leftJoin(crmEmailTemplates, eq(crmEmailTemplates.id, crmEmailOutbox.templateId))
        .leftJoin(employees, eq(employees.id, crmEmailOutbox.sentBy))
        .where(eq(crmEmailOutbox.leadId, lead.id))
        .orderBy(desc(crmEmailOutbox.createdAt))
        .limit(50),
      db
        .select({
          inbound: crmEmailInbound,
          mailboxName: employees.fullName,
          outboxThread: crmEmailOutbox.gmailThreadId,
        })
        .from(crmEmailInbound)
        .leftJoin(employees, eq(employees.id, crmEmailInbound.mailboxEmployeeId))
        .leftJoin(crmEmailOutbox, eq(crmEmailOutbox.id, crmEmailInbound.outboxId))
        .where(eq(crmEmailInbound.leadId, lead.id))
        .orderBy(desc(crmEmailInbound.receivedAt))
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
      toEmail: r.toEmail,
      attachments: r.attachments,
      conversation: conversationOf(r.gmailThreadId, r.id),
    }));
    // The leads' e-mails read from the sellers' Gmail (t083), in the conversation they answer.
    const received: LeadEmailReceived[] = inbound.map(
      ({ inbound: r, mailboxName, outboxThread }) => ({
        id: r.id,
        fromName: r.fromName,
        fromEmail: r.fromEmail,
        subject: r.subject,
        body: r.body,
        at: r.receivedAt.toISOString(),
        attachments: r.attachments,
        conversation: r.outboxId
          ? conversationOf(outboxThread, r.outboxId)
          : `t:${r.gmailThreadId}`,
        mailboxName,
      }),
    );
    const transport = crmMailOf(app.wings);
    return reply.send({
      to: lead.email,
      // Where "Escrever e-mail" may send to: the deal's e-mail, then its other contacts'.
      addresses: await dealAddressesOf(db, lead),
      // Expansão with a brand: the lead must not see the Wings, so no e-mail leaves (brand rule).
      hidden: leadHidesWings(lead),
      // A "não me contate" by e-mail: why nothing can be sent, or null.
      blocked: (await contactBlock(db, 'email', { leadId: lead.id })).reason,
      mode: transport.mode,
      // Where a message sent now by this person would leave from (their Gmail, or the company's).
      from: await transport.senderOf(request.session.actor.employeeId),
      templates,
      sent,
      received,
      // Reading the replies: `reconnect` asks this person to connect their Google account once more.
      mailRead: await mailReadFor(
        googleWorkspaceDepsOf(app.wings),
        request.session.actor.employeeId,
      ),
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

  /** The template as it is, or the person's own text with attachments; every refusal is audited. */
  const send = async (
    request: Req,
    lead: NonNullable<Awaited<ReturnType<typeof visibleLead>>>,
    body: z.infer<typeof bodySchema> | z.infer<typeof leadEmailComposeSchema>,
  ) => {
    const actor = request.session.actor.employeeId;
    const transport = crmMailOf(app.wings);
    if (!('to' in body))
      return sendTemplateToLead(db, {
        lead,
        templateId: body.templateId,
        transport,
        runId: null,
        sentBy: actor,
      });
    if (leadHidesWings(lead)) return { ok: false as const, reason: 'brand_hidden' as const };
    const to = body.to.trim().toLowerCase();
    if (!(await dealAddressesOf(db, lead)).some((a) => a.email === to))
      return { ok: false as const, reason: 'not_a_contact' as const };
    if (
      body.templateId &&
      !(await db.query.crmEmailTemplates.findFirst({
        where: eq(crmEmailTemplates.id, body.templateId),
        columns: { id: true },
      }))
    )
      return { ok: false as const, reason: 'template_gone' as const };
    const files = await attachmentsFor(
      driveDeps,
      dealRouteAccessOf(request.session.actor),
      lead.id,
      body.fileIds,
    );
    if (!files.ok) return files;
    // An answer goes in the lead's conversation: the thread is the sender's own mailbox's.
    const answered = body.replyToId
      ? await db.query.crmEmailInbound.findFirst({
          where: and(eq(crmEmailInbound.id, body.replyToId), eq(crmEmailInbound.leadId, lead.id)),
        })
      : null;
    if (body.replyToId && !answered)
      return { ok: false as const, reason: 'reply_not_found' as const };
    return sendToLead(db, {
      lead,
      to,
      templateId: body.templateId,
      message: async () => ({ subject: body.subject, body: body.text }),
      attachments: files.attachments,
      files: files.files,
      transport,
      runId: null,
      sentBy: actor,
      reply: answered
        ? {
            threadId: answered.mailboxEmployeeId === actor ? answered.gmailThreadId : null,
            inReplyTo: answered.messageId,
          }
        : undefined,
    });
  };

  app.post('/leads/:id/emails', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const raw = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const body =
      'to' in raw || 'subject' in raw || 'text' in raw
        ? leadEmailComposeSchema.safeParse(raw)
        : bodySchema.safeParse(raw);
    if (!params.success) return reply.status(400).send(invalid);
    if (!body.success)
      return reply
        .status(400)
        .send({ ...invalid, message: body.error.issues[0]?.message ?? invalid.message });
    const lead = await visibleLead(request, params.data.id, 'leads.write');
    if (!lead) return reply.status(404).send(notFound());
    const outcome = await send(request, lead, body.data);
    const fileIds = 'fileIds' in body.data ? body.data.fileIds : [];
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: outcome.ok ? 'lead.email_sent' : 'lead.email_failed',
      entity: 'lead',
      entityId: lead.id,
      ip: request.ip,
      metadata: {
        templateId: body.data.templateId,
        composed: 'to' in body.data,
        fileIds,
        replyToId: 'replyToId' in body.data ? body.data.replyToId : null,
        ...(outcome.ok
          ? { mode: outcome.mode, outboxId: outcome.outboxId }
          : { reason: outcome.reason }),
      },
    });
    if (!outcome.ok) {
      const [status, message] = SEND_ERRORS[outcome.reason as SendError];
      return reply.status(status).send({
        error: outcome.reason,
        message: ('message' in outcome ? outcome.message : undefined) ?? message,
      });
    }
    return reply.status(201).send({ outboxId: outcome.outboxId, mode: outcome.mode });
  });
};
