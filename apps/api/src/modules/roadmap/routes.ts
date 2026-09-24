import {
  roadmapDeliverableUpdateSchema,
  roadmapRecipientCreateSchema,
  roadmapRecipientUpdateSchema,
} from '@wings/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import {
  approveReportRun,
  createRecipient,
  deleteRecipient,
  getReportRun,
  listRecipients,
  listReportRuns,
  snapshotOf,
  updateDeliverable,
  updateRecipient,
} from './service.js';

const idParam = z.object({ id: z.uuid() });

const invalid = (reply: import('fastify').FastifyReply, message?: string) =>
  reply.status(400).send({ error: 'invalid_request', message: message ?? 'Dados inválidos' });

/**
 * Administração → Roadmap: módulos e entregáveis, os relatórios diários e os
 * destinatários. Every route requires `roadmap.manage`, held only by Admin
 * Master; the frontend gate is convenience only, this is the authority
 * (docs/roadmap.md).
 */
export const roadmapRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();

  app.get(
    '/roadmap/modules',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (_request, reply) => {
      const snapshot = await snapshotOf(db, now());
      return reply.send(snapshot);
    },
  );

  app.patch(
    '/roadmap/deliverables/:id',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = roadmapDeliverableUpdateSchema.safeParse(request.body);
      if (!params.success) return invalid(reply);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);

      const deliverable = await updateDeliverable(
        db,
        params.data.id,
        request.session.actor.employeeId,
        body.data,
      );
      if (!deliverable) {
        return reply.status(404).send({ error: 'not_found', message: 'Entregável não encontrado' });
      }
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'roadmap.deliverable_changed',
        entity: 'roadmap_deliverable',
        entityId: deliverable.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: { status: deliverable.status, weight: deliverable.weight },
      });
      return reply.send({ deliverable });
    },
  );

  app.get(
    '/roadmap/reports',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (_request, reply) => reply.send({ runs: await listReportRuns(db) }),
  );

  app.get(
    '/roadmap/reports/:id',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const run = await getReportRun(db, params.data.id);
      if (!run) return reply.status(404).send({ error: 'not_found', message: 'Relatório não encontrado' });
      return reply.send({ run });
    },
  );

  app.post(
    '/roadmap/reports/:id/approve',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const outcome = await approveReportRun(db, params.data.id, request.session.actor.employeeId);
      if (outcome === 'not_found') {
        return reply.status(404).send({ error: 'not_found', message: 'Relatório não encontrado' });
      }
      if (outcome === 'not_draft') {
        return reply
          .status(409)
          .send({ error: 'not_draft', message: 'Só um relatório em rascunho pode ser aprovado' });
      }
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'roadmap.report_approved',
        entity: 'roadmap_report_run',
        entityId: params.data.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      const run = await getReportRun(db, params.data.id);
      return reply.send({ run });
    },
  );

  app.get(
    '/roadmap/recipients',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (_request, reply) => reply.send({ recipients: await listRecipients(db) }),
  );

  app.post(
    '/roadmap/recipients',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const body = roadmapRecipientCreateSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const recipient = await createRecipient(db, body.data);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'roadmap.recipient_created',
        entity: 'roadmap_report_recipient',
        entityId: recipient.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: { role: recipient.role },
      });
      return reply.status(201).send({ recipient });
    },
  );

  app.patch(
    '/roadmap/recipients/:id',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = roadmapRecipientUpdateSchema.safeParse(request.body);
      if (!params.success) return invalid(reply);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const recipient = await updateRecipient(db, params.data.id, body.data);
      if (!recipient) {
        return reply.status(404).send({ error: 'not_found', message: 'Destinatário não encontrado' });
      }
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'roadmap.recipient_updated',
        entity: 'roadmap_report_recipient',
        entityId: recipient.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ recipient });
    },
  );

  app.delete(
    '/roadmap/recipients/:id',
    { preHandler: app.requirePermission('roadmap.manage') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const removed = await deleteRecipient(db, params.data.id);
      if (!removed) {
        return reply.status(404).send({ error: 'not_found', message: 'Destinatário não encontrado' });
      }
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'roadmap.recipient_deleted',
        entity: 'roadmap_report_recipient',
        entityId: params.data.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.status(204).send();
    },
  );
};
