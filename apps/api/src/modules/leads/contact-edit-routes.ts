import { checkLeadContactUpdate, leadContactUpdateSchema } from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, leadOwnerFilter } from './access.js';
import { changeLeadContact, contactChangesOf } from './contact-edit.js';
import { loadLead } from './service.js';

const idParam = z.object({ id: z.uuid() });
const invalid = (message?: string, field?: string | null) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
  ...(field ? { field } : {}),
});
const notFound = { error: 'not_found', message: 'Lead não encontrado.' };

/**
 * Editing a lead's contact data on the ficha (docs/crm/editar-contato.md): the owner, the managers
 * and the Admin (`leads.write` in the caller's scope; Diretoria does not hold it). A lead out of
 * reach is a 404. The history is read with `leads.read` in the same scope.
 */
export const contactEditRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  app.patch(
    '/leads/:id/contact',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = leadContactUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const checked = checkLeadContactUpdate(body.data);
      if (!checked.ok) return reply.status(400).send(invalid(checked.message, checked.field));
      const actor = request.session.actor;
      const lead = await leadInScope(db, actor, params.data.id, 'leads.write');
      if (!lead) return reply.status(404).send(notFound);
      const result = await changeLeadContact(db, {
        leadId: lead.id,
        patch: checked.patch,
        actorEmployeeId: actor.employeeId,
        ownerScope: leadOwnerFilter(actor, 'leads.write'),
      });
      if (!result.ok) {
        const refusal = {
          not_found: [404, notFound.error, notFound.message],
          no_contact_key: [
            400,
            'no_contact_key',
            'A negociação precisa ficar com telefone ou e-mail.',
          ],
          // Said without a word about the other deal: it is not the caller's to know.
          contact_in_use: [
            409,
            'contact_in_use',
            'Este telefone ou e-mail já está em outra negociação. Fale com a gerência.',
          ],
        } as const;
        const [status, error, message] = refusal[result.reason];
        return reply.status(status).send({ error, message });
      }
      if (result.changed.length > 0) {
        await writeAudit(db, {
          actorEmployeeId: actor.employeeId,
          action: 'lead.contact_updated',
          entity: 'lead',
          entityId: lead.id,
          ip: request.ip,
          metadata: { changed: result.changed },
        });
      }
      return reply.send(await loadLead(db, lead.id));
    },
  );

  app.get(
    '/leads/:id/contact-changes',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.read');
      if (!lead) return reply.status(404).send(notFound);
      return reply.send({ changes: await contactChangesOf(db, lead.id) });
    },
  );
};
