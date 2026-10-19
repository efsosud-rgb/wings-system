import {
  waBulkApplySchema,
  waBulkCreateSchema,
  waBulkItemApplySchema,
  waBulkItemPatchSchema,
  waBulkItemSchema,
} from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import {
  BulkError,
  addBulkItem,
  applyBulkItem,
  bulkOf,
  bulkReport,
  createBulk,
  startBulk,
  undoBulk,
  updateBulkItem,
  type BulkErrorCode,
} from './import-bulk.js';

/**
 * "Importar em lote" (docs/whatsapp/importar-conversa.md), Admin Master only
 * (`whatsapp.import_bulk`, scope all). The browser takes each conversation's text out of its file
 * and sends one conversation per request; the media stays inside the exported file, which goes
 * straight to storage as a file of the paired deal. Audit entries carry ids and counts only.
 */

const bulkParams = z.object({ id: z.uuid() });
const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

// One conversation's text per request (up to WA_IMPORT_MAX_CHARS), as in the single import.
const BODY_LIMIT = 48 * 1024 * 1024;

const STATUS: Record<BulkErrorCode, number> = {
  not_found: 404,
  not_in_preview: 409,
  too_many: 409,
  lead_not_found: 404,
  file_not_found: 404,
  not_pending: 409,
  unknown_side: 400,
};

const MESSAGES: Record<BulkErrorCode, string> = {
  not_found: 'Lote ou conversa não encontrada.',
  not_in_preview: 'Este lote já foi confirmado: a prévia não muda mais.',
  too_many: 'O lote chegou ao máximo de conversas. Abra outro lote para o resto.',
  lead_not_found: 'Negociação não encontrada.',
  file_not_found: 'O arquivo exportado não está entre os arquivos desta negociação.',
  not_pending: 'Esta conversa não está esperando para ser gravada.',
  unknown_side: 'Escolha um nome que aparece nas conversas como a Wings.',
};

const refuse = (reply: FastifyReply, error: BulkError) =>
  reply.status(STATUS[error.code]).send({ error: error.code, message: MESSAGES[error.code] });

export const whatsappImportBulkRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const use = { preHandler: app.requirePermission('whatsapp.import_bulk') };
  const upload = { ...use, bodyLimit: BODY_LIMIT };

  const invalid = (reply: FastifyReply, message?: string) =>
    reply.status(400).send({ error: 'invalid_request', message: message ?? 'Dados inválidos' });
  const notFound = (reply: FastifyReply) => refuse(reply, new BulkError('not_found'));

  /** Runs a step, answering a `BulkError` as its status and message. */
  async function answer(reply: FastifyReply, run: () => Promise<FastifyReply>) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BulkError) return refuse(reply, error);
      throw error;
    }
  }

  app.post('/whatsapp/bulk-imports', use, async (request, reply) => {
    const body = waBulkCreateSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    const id = await createBulk(db, {
      source: 'tela',
      createdBy: request.session.actor.employeeId,
      ...(body.data.nameMap ? { nameMap: body.data.nameMap } : {}),
    });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'whatsapp.bulk_import_created',
      entity: 'whatsapp_bulk_import',
      entityId: id,
      ip: request.ip,
    });
    return reply.status(201).send({ bulk: await bulkOf(db, id) });
  });

  app.get('/whatsapp/bulk-imports/:id', use, async (request, reply) => {
    const params = bulkParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    return answer(reply, async () => reply.send({ bulk: await bulkOf(db, params.data.id) }));
  });

  app.get('/whatsapp/bulk-imports/:id/report', use, async (request, reply) => {
    const params = bulkParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    return answer(reply, async () =>
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="lote-${params.data.id}.csv"`)
        .send(bulkReport(await bulkOf(db, params.data.id))),
    );
  });

  app.post('/whatsapp/bulk-imports/:id/items', upload, async (request, reply) => {
    const params = bulkParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waBulkItemSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    return answer(reply, async () =>
      reply.status(201).send({ item: await addBulkItem(db, params.data.id, body.data) }),
    );
  });

  app.patch('/whatsapp/bulk-imports/:id/items/:itemId', use, async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waBulkItemPatchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    return answer(reply, async () =>
      reply.send({
        item: await updateBulkItem(db, params.data.id, params.data.itemId, body.data),
      }),
    );
  });

  app.post('/whatsapp/bulk-imports/:id/apply', use, async (request, reply) => {
    const params = bulkParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waBulkApplySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    return answer(reply, async () => {
      await startBulk(db, params.data.id, body.data.ourName);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.bulk_import_confirmed',
        entity: 'whatsapp_bulk_import',
        entityId: params.data.id,
        ip: request.ip,
      });
      return reply.send({ bulk: await bulkOf(db, params.data.id) });
    });
  });

  app.post('/whatsapp/bulk-imports/:id/items/:itemId/apply', use, async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = waBulkItemApplySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    return answer(reply, async () =>
      reply.send({
        item: await applyBulkItem(db, params.data.id, params.data.itemId, {
          fileId: body.data.fileId,
          actorEmployeeId: request.session.actor.employeeId,
          ip: request.ip,
        }),
      }),
    );
  });

  app.post('/whatsapp/bulk-imports/:id/undo', use, async (request, reply) => {
    const params = bulkParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    return answer(reply, async () => {
      const undone = await undoBulk(db, params.data.id, {
        actorEmployeeId: request.session.actor.employeeId,
        ip: request.ip,
      });
      return reply.send({ ...undone, bulk: await bulkOf(db, params.data.id) });
    });
  });

  app.post('/whatsapp/bulk-imports/:id/items/:itemId/undo', use, async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    return answer(reply, async () => {
      const undone = await undoBulk(db, params.data.id, {
        itemId: params.data.itemId,
        actorEmployeeId: request.session.actor.employeeId,
        ip: request.ip,
      });
      return reply.send({ ...undone, bulk: await bulkOf(db, params.data.id) });
    });
  });
};
