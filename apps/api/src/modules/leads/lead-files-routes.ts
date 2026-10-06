import { grantedScope, leadFileUploadSchema } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { storageOf } from '../../lib/storage/index.js';
import { driveAccessOf } from '../drive/access.js';
import { DriveError, fileFor, type DriveDeps } from '../drive/service.js';
import {
  attachFile,
  completeLeadUpload,
  detachFile,
  listLeadFiles,
  requestLeadUpload,
} from './files.js';

const idParam = z.object({ id: z.uuid() });
const uploadParams = z.object({ id: z.uuid(), uploadId: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const attachBody = z.object({ fileId: z.uuid() });

const STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  name_taken: 409,
  too_large: 413,
  upload_incomplete: 409,
  upload_expired: 410,
  storage_unavailable: 503,
};

const MESSAGES: Record<string, string> = {
  name_taken: 'Já existe um arquivo com este nome nesta negociação.',
  too_large: 'O arquivo é maior do que o Drive aceita.',
  upload_incomplete: 'O arquivo não chegou inteiro. Tente de novo.',
  upload_expired: 'O envio demorou demais. Tente de novo.',
  storage_unavailable: 'O Drive não está disponível agora.',
  forbidden: 'Você não pode enviar arquivos para o Drive.',
  not_found: 'Arquivo não encontrado.',
};

const refuse = (reply: FastifyReply, error: DriveError) =>
  reply
    .status(STATUS[error.code] ?? 400)
    .send({ error: error.code, message: MESSAGES[error.code] ?? error.message, ...error.details });

/**
 * Files of a deal (ficha do cliente, Etapa 3): listed with `leads.read`,
 * added and removed with `leads.write`, both in the caller's scope (a seller
 * only on their own leads). The upload itself is the Drive's: the person also
 * needs `drive.write` in Comercial, and the Drive checks the folder again.
 */
export const leadFilesRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  type Req = Parameters<typeof app.can>[0];
  const deps: DriveDeps = {
    db,
    storage: storageOf(app.wings),
    maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
    now: () => new Date(),
  };

  async function visibleLead(request: Req, id: string, permission: 'leads.read' | 'leads.write') {
    const row = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    if (!row) return null;
    const scope = grantedScope(request.session.actor, permission);
    return scope !== 'own' || row.ownerEmployeeId === request.session.actor.employeeId
      ? row
      : null;
  }

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Lead não encontrado.' });
  const read = { preHandler: app.requirePermission('leads.read') };
  const write = { preHandler: app.requirePermission('leads.write') };

  const audit = (request: Req, action: string, leadId: string, fileId: string) =>
    writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action,
      entity: 'lead',
      entityId: leadId,
      ip: request.ip,
      metadata: { fileId },
    });

  app.get('/leads/:id/files', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await visibleLead(request, params.data.id, 'leads.read');
    if (!row) return notFound(reply);
    return reply.send({ files: await listLeadFiles(db, row.id) });
  });

  app.post('/leads/:id/files/uploads', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = leadFileUploadSchema.safeParse(request.body);
    if (!params.success) return notFound(reply);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return notFound(reply);
    const access = driveAccessOf(request.session.actor);
    if (!access?.write) return refuse(reply, new DriveError('forbidden'));
    try {
      const ticket = await requestLeadUpload(deps, access, row, body.data);
      await writeAudit(db, {
        actorEmployeeId: access.employeeId,
        action: 'lead.file_upload_requested',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { uploadId: ticket.uploadId, byteSize: body.data.byteSize },
      });
      return reply.status(201).send({ ticket });
    } catch (error) {
      if (error instanceof DriveError) return refuse(reply, error);
      throw error;
    }
  });

  app.post('/leads/:id/files/uploads/:uploadId/complete', write, async (request, reply) => {
    const params = uploadParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return notFound(reply);
    const access = driveAccessOf(request.session.actor);
    if (!access?.write) return refuse(reply, new DriveError('forbidden'));
    try {
      const file = await completeLeadUpload(deps, access, row.id, params.data.uploadId);
      await audit(request, 'lead.file_added', row.id, file.fileId);
      return reply.status(201).send({ file });
    } catch (error) {
      if (error instanceof DriveError) return refuse(reply, error);
      throw error;
    }
  });

  // Attaches a file that is already in the Drive (one the person may open).
  app.post('/leads/:id/files', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = attachBody.safeParse(request.body);
    if (!params.success) return notFound(reply);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos' });
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return notFound(reply);
    const access = driveAccessOf(request.session.actor);
    if (!access) return refuse(reply, new DriveError('forbidden'));
    try {
      await fileFor(deps, access, body.data.fileId);
      const file = await attachFile(db, {
        leadId: row.id,
        driveFileId: body.data.fileId,
        actorEmployeeId: access.employeeId,
      });
      await audit(request, 'lead.file_added', row.id, file.fileId);
      return reply.status(201).send({ file });
    } catch (error) {
      if (error instanceof DriveError) return refuse(reply, error);
      throw error;
    }
  });

  app.delete('/leads/:id/files/:fileId', write, async (request, reply) => {
    const params = fileParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return notFound(reply);
    const removed = await detachFile(db, {
      leadId: row.id,
      driveFileId: params.data.fileId,
      actorEmployeeId: request.session.actor.employeeId,
    });
    if (!removed) return refuse(reply, new DriveError('not_found'));
    await audit(request, 'lead.file_removed', row.id, params.data.fileId);
    return reply.status(204).send();
  });
};
