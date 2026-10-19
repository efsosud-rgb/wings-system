import { waImportApplySchema, waImportPreviewSchema } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope } from '../leads/access.js';
import { leadHasFile } from '../leads/files.js';
import {
  ImportError,
  applyImport,
  listImports,
  previewImport,
  undoImport,
  type ImportErrorCode,
} from './import.js';
import { olderMessages } from './thread.js';

/**
 * Importing a conversation from a phone's export onto a deal
 * (docs/whatsapp/importar-conversa.md), and the deal's older messages a page
 * at a time. Same permission and scope as the deal's conversation:
 * `leads.whatsapp`, a seller only on their own deals; a deal out of scope
 * answers 404. Audit rows carry ids and counts, never a name or a text.
 */

const idParams = z.object({ id: z.uuid() });
const batchParams = z.object({ id: z.uuid(), batchId: z.uuid() });
const olderQuery = z.object({ before: z.uuid() });

// The export's text comes in the body (up to WA_IMPORT_MAX_CHARS, a few bytes each).
const BODY_LIMIT = 48 * 1024 * 1024;

const STATUS: Record<ImportErrorCode, number> = {
  not_an_export: 422,
  unknown_side: 400,
  nothing_new: 409,
  lead_without_phone: 409,
  not_found: 404,
  already_undone: 409,
};

const MESSAGES: Record<ImportErrorCode, string> = {
  not_an_export:
    'Este arquivo não parece uma conversa exportada do WhatsApp. Use o .txt ou o .zip do "Exportar conversa".',
  unknown_side: 'Escolha qual nome é a Wings.',
  nothing_new: 'Todas as mensagens deste arquivo já estão na conversa.',
  lead_without_phone: 'A negociação não tem telefone. Cadastre o número antes de importar.',
  not_found: 'Importação não encontrada.',
  already_undone: 'Esta importação já foi desfeita.',
};

const refuse = (reply: FastifyReply, error: ImportError) =>
  reply.status(STATUS[error.code]).send({ error: error.code, message: MESSAGES[error.code] });

export const whatsappImportRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const use = { preHandler: app.requirePermission('leads.whatsapp') };
  const upload = { ...use, bodyLimit: BODY_LIMIT };
  type Req = Parameters<typeof app.can>[0];

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Negociação não encontrada.' });
  const invalid = (reply: FastifyReply, message?: string) =>
    reply.status(400).send({ error: 'invalid_request', message: message ?? 'Dados inválidos' });
  const visibleLead = (request: Req, id: string) =>
    leadInScope(db, request.session.actor, id, 'leads.whatsapp');

  app.post('/leads/:id/whatsapp/imports/preview', upload, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waImportPreviewSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    const lead = await visibleLead(request, params.data.id);
    if (!lead) return notFound(reply);
    try {
      return reply.send({ preview: await previewImport(db, lead.id, body.data.text) });
    } catch (error) {
      if (error instanceof ImportError) return refuse(reply, error);
      throw error;
    }
  });

  app.post('/leads/:id/whatsapp/imports', upload, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waImportApplySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    const lead = await visibleLead(request, params.data.id);
    if (!lead) return notFound(reply);
    if (!(await leadHasFile(db, lead.id, body.data.fileId)))
      return reply.status(404).send({
        error: 'file_not_found',
        message: 'O arquivo exportado não está entre os arquivos desta negociação.',
      });
    try {
      const batch = await applyImport(db, {
        lead,
        text: body.data.text,
        ourName: body.data.ourName,
        fileId: body.data.fileId,
        actorEmployeeId: request.session.actor.employeeId,
      });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.conversation_imported',
        entity: 'lead',
        entityId: lead.id,
        ip: request.ip,
        metadata: {
          batchId: batch.id,
          fileId: body.data.fileId,
          platform: batch.platform,
          messages: batch.messageCount,
          from: batch.firstAt.toISOString(),
          to: batch.lastAt.toISOString(),
        },
      });
      const [item] = (await listImports(db, lead.id)).filter((row) => row.id === batch.id);
      return reply.status(201).send({ import: item });
    } catch (error) {
      if (error instanceof ImportError) return refuse(reply, error);
      throw error;
    }
  });

  app.get('/leads/:id/whatsapp/imports', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await visibleLead(request, params.data.id);
    if (!lead) return notFound(reply);
    return reply.send({ imports: await listImports(db, lead.id) });
  });

  app.delete('/leads/:id/whatsapp/imports/:batchId', use, async (request, reply) => {
    const params = batchParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await visibleLead(request, params.data.id);
    if (!lead) return notFound(reply);
    try {
      const undone = await undoImport(db, {
        leadId: lead.id,
        batchId: params.data.batchId,
        actorEmployeeId: request.session.actor.employeeId,
      });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.import_undone',
        entity: 'lead',
        entityId: lead.id,
        ip: request.ip,
        metadata: { batchId: undone.batch.id, removed: undone.removed },
      });
      const [item] = (await listImports(db, lead.id)).filter((row) => row.id === undone.batch.id);
      return reply.send({ import: item, removed: undone.removed });
    } catch (error) {
      if (error instanceof ImportError) return refuse(reply, error);
      throw error;
    }
  });

  // The deal's messages older than one already on screen ("Mostrar anteriores").
  app.get('/leads/:id/whatsapp/messages', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const query = olderQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const lead = await visibleLead(request, params.data.id);
    if (!lead) return notFound(reply);
    return reply.send({ messages: await olderMessages(db, lead.id, query.data.before) });
  });
};
