import { leadFileUploadSchema } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, type LeadPermission } from './access.js';
import { storageOf } from '../../lib/storage/index.js';
import { createOpenRouterLlm, type AgentLlm } from '../agent/llm.js';
import { dealRouteAccessOf, driveAccessOf } from '../drive/access.js';
import { DriveError, fileFor, linkFor, type DriveDeps } from '../drive/service.js';
import {
  attachFile,
  completeLeadUpload,
  detachFile,
  leadHasFile,
  listLeadFiles,
  requestLeadUpload,
} from './files.js';
import { loadLead } from './service.js';
import { answerQuestion, generateSummary, SummaryError } from './summary.js';

const idParam = z.object({ id: z.uuid() });
const uploadParams = z.object({ id: z.uuid(), uploadId: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const attachBody = z.object({ fileId: z.uuid() });
const questionBody = z.object({
  question: z.string().trim().min(3, 'Escreva a pergunta').max(500),
});

const SUMMARY_MESSAGES: Record<SummaryError['code'], string> = {
  ai_unavailable: 'A IA não está configurada neste ambiente.',
  ai_failed: 'A IA não respondeu agora. Tente de novo em instantes.',
};

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

  const visibleLead = (request: Req, id: string, permission: LeadPermission) =>
    leadInScope(db, request.session.actor, id, permission);

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Lead não encontrado.' });
  const read = { preHandler: app.requirePermission('leads.read') };
  const write = { preHandler: app.requirePermission('leads.write') };

  /** Null while the key is missing: the summary then answers 503 and the screen shows "—" with the reason. */
  const llm: AgentLlm | null =
    app.wings.agentLlm ??
    (env.OPENROUTER_API_KEY ? createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY }) : null);

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

  // The address to open one of the deal's files. The Drive routes do not open the deals' folders for a
  // seller (the folder is named after the deal), so this is the way: the lead is checked first, then the
  // file must be one of this lead's own.
  app.get('/leads/:id/files/:fileId/link', read, async (request, reply) => {
    const params = fileParams.safeParse(request.params);
    const query = z
      .object({ disposition: z.enum(['inline', 'attachment']).default('attachment') })
      .safeParse(request.query);
    if (!params.success) return notFound(reply);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos' });
    const row = await visibleLead(request, params.data.id, 'leads.read');
    if (!row) return notFound(reply);
    // A seller has no Drive (Eric, 14/10) but opens the files of their own deal.
    const access = dealRouteAccessOf(request.session.actor);
    if (!(await leadHasFile(db, row.id, params.data.fileId))) {
      return refuse(reply, new DriveError('not_found'));
    }
    try {
      const link = await linkFor(deps, access, params.data.fileId, query.data);
      await writeAudit(db, {
        actorEmployeeId: access.employeeId,
        action:
          query.data.disposition === 'inline' ? 'drive.file_previewed' : 'drive.file_downloaded',
        entity: 'drive_file',
        entityId: link.fileId,
        ip: request.ip,
        metadata: { version: link.version, leadId: row.id },
      });
      return reply
        .header('Cache-Control', 'no-store')
        .send({ url: link.url, expiresAt: link.expiresAt });
    } catch (error) {
      if (error instanceof DriveError) return refuse(reply, error);
      throw error;
    }
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
    const access = dealRouteAccessOf(request.session.actor);
    if (!access.write) return refuse(reply, new DriveError('forbidden'));
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
    const access = dealRouteAccessOf(request.session.actor);
    if (!access.write) return refuse(reply, new DriveError('forbidden'));
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

  // --- the AI summary (Etapa 4) --------------------------------------------------------------

  const refuseSummary = (reply: FastifyReply, error: SummaryError) =>
    reply
      .status(error.code === 'ai_unavailable' ? 503 : 502)
      .send({ error: error.code, message: SUMMARY_MESSAGES[error.code] });

  app.post('/leads/:id/resumo', write, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await visibleLead(request, params.data.id, 'leads.write');
    if (!row) return notFound(reply);
    const data = await loadLead(db, row.id);
    if (!data) return notFound(reply);
    try {
      const summary = await generateSummary(db, llm, data, request.session.actor.employeeId);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'lead.summary_generated',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { model: summary.model, ...summary.basedOn },
      });
      return reply.send({ summary });
    } catch (error) {
      if (error instanceof SummaryError) return refuseSummary(reply, error);
      throw error;
    }
  });

  app.post('/leads/:id/resumo/pergunta', read, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = questionBody.safeParse(request.body);
    if (!params.success) return notFound(reply);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    const row = await visibleLead(request, params.data.id, 'leads.read');
    if (!row) return notFound(reply);
    const data = await loadLead(db, row.id);
    if (!data) return notFound(reply);
    try {
      return reply.send(await answerQuestion(llm, data, body.data.question));
    } catch (error) {
      if (error instanceof SummaryError) return refuseSummary(reply, error);
      throw error;
    }
  });
};
