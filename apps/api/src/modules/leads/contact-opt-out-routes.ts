import {
  CONTACT_CHANNEL_LABELS,
  contactOptOutCreateSchema,
  contactOptOutRevokeSchema,
  grantedScope,
} from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { leadEvents } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope } from './access.js';
import { leadContactOptOuts, recordContactOptOut, revokeContactOptOuts } from './contact-block.js';
import { addNote } from './crm.js';

const idParam = z.object({ id: z.uuid() });
const invalid = (message?: string) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
});
const notFound = { error: 'not_found', message: 'Lead não encontrado.' };

/**
 * "Não me contate" on the deal page (docs/crm/nao-me-contate.md). Seeing it follows the lead's
 * scope; recording it is `leads.write` on the lead; revoking it only a manager or the board
 * (`leads.assign` over every lead), with a reason, an audit entry and a note on the timeline.
 */
export const contactOptOutRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();

  app.get(
    '/leads/:id/contact-opt-outs',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.read');
      if (!lead) return reply.status(404).send(notFound);
      return reply.send(await leadContactOptOuts(db, lead.id));
    },
  );

  app.post(
    '/leads/:id/contact-opt-outs',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = contactOptOutCreateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.write');
      if (!lead) return reply.status(404).send(notFound);
      const actor = request.session.actor.employeeId;
      const added = await recordContactOptOut(db, {
        leadId: lead.id,
        channels: body.data.channels,
        origin: 'crm',
        reason: body.data.reason,
        createdBy: actor,
      });
      await db.insert(leadEvents).values({
        leadId: lead.id,
        kind: 'lead.contact_opt_out',
        actorEmployeeId: actor,
        detail: { channels: body.data.channels, rows: added },
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.contact_opt_out_recorded',
        entity: 'lead',
        entityId: lead.id,
        ip: request.ip,
        metadata: { channels: body.data.channels, rows: added },
      });
      return reply.status(201).send(await leadContactOptOuts(db, lead.id));
    },
  );

  app.post(
    '/leads/:id/contact-opt-outs/revoke',
    { preHandler: app.requirePermission('leads.assign') },
    async (request, reply) => {
      const actor = request.session.actor;
      if (grantedScope(actor, 'leads.assign') !== 'all')
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Só a gerência e a diretoria revogam um "não me contate".',
        });
      const params = idParam.safeParse(request.params);
      const body = contactOptOutRevokeSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const lead = await leadInScope(db, actor, params.data.id, 'leads.read');
      if (!lead) return reply.status(404).send(notFound);
      const revoked = await revokeContactOptOuts(db, {
        leadId: lead.id,
        channel: body.data.channel,
        reason: body.data.reason,
        by: actor.employeeId,
        at: now(),
      });
      if (revoked === 0)
        return reply.status(409).send({
          error: 'nothing_to_revoke',
          message: 'Não há "não me contate" do CRM ativo neste canal.',
        });
      await addNote(db, {
        leadId: lead.id,
        body: `"Não me contate" revogado (${CONTACT_CHANNEL_LABELS[body.data.channel]}): ${body.data.reason}`,
        authorEmployeeId: actor.employeeId,
      });
      await writeAudit(db, {
        actorEmployeeId: actor.employeeId,
        action: 'lead.contact_opt_out_revoked',
        entity: 'lead',
        entityId: lead.id,
        ip: request.ip,
        // Who and when are the entry's own; why is the manager's reason (Eric, 31/10).
        metadata: { channel: body.data.channel, rows: revoked, reason: body.data.reason },
      });
      return reply.send(await leadContactOptOuts(db, lead.id));
    },
  );
};
