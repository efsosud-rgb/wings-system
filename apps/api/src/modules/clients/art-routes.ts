import {
  WA_ART_REFUSALS,
  WINGS_CLIENT_ID,
  waArticleSchema,
  waArtUploadSchema,
  type BrandArticle,
  type ClientWhatsAppArt,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clients } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { storageOf } from '../../lib/storage/index.js';
import {
  ArtError,
  artFileOf,
  artLink,
  clearArt,
  completeArtUpload,
  requestArtUpload,
  type ArtDeps,
} from '../whatsapp/art.js';

const idParam = z.object({ id: z.uuid() });
const uploadParams = z.object({ id: z.uuid(), uploadId: z.uuid() });

const STATUS: Record<ArtError['code'], number> = {
  storage_unavailable: 503,
  not_found: 404,
  no_folder: 409,
  upload_expired: 410,
  upload_incomplete: 409,
  refused: 422,
};

const MESSAGES: Record<Exclude<ArtError['code'], 'refused'>, string> = {
  storage_unavailable: 'O Drive não está disponível agora.',
  not_found: 'Envio não encontrado.',
  no_folder: 'A pasta Mídia deste cliente ainda não existe no Drive. Use "Sincronizar pastas".',
  upload_expired: 'O envio demorou demais. Tente de novo.',
  upload_incomplete: 'O arquivo não chegou inteiro. Tente de novo.',
};

/**
 * The WhatsApp header of a client (docs/whatsapp/arte-modelos.md): the art
 * (1125 × 600, PNG or JPEG, up to 2 MB) and the article of the brand's name.
 * A brand's are kept by who fills its record (`clients.edit`); the Wings art,
 * on the Wings Company record, by who manages the register (`clients.manage`).
 * The file lives in the client's Mídia folder in the Drive and is named here
 * by its id only; every change is in the audit log by id.
 */
export const clientArtRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const deps = (): ArtDeps => ({ db, storage: storageOf(app.wings), now });

  const mayRead = (request: FastifyRequest) =>
    app.can(request, 'clients.read') ||
    app.can(request, 'clients.edit') ||
    app.can(request, 'clients.manage');
  const mayWrite = (request: FastifyRequest, clientId: string) =>
    clientId === WINGS_CLIENT_ID
      ? app.can(request, 'clients.manage')
      : app.can(request, 'clients.edit');
  const readGate = app.requireAnyPermission(['clients.read', 'clients.edit', 'clients.manage']);
  const writeGate = app.requireAnyPermission(['clients.edit', 'clients.manage']);

  const forbidden = (reply: FastifyReply) =>
    reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Cliente não encontrado.' });
  const refuse = (reply: FastifyReply, error: ArtError) =>
    reply.status(STATUS[error.code]).send({
      error: error.code === 'refused' ? 'art_refused' : error.code,
      message:
        error.code === 'refused'
          ? WA_ART_REFUSALS[error.reason ?? 'unreadable']
          : MESSAGES[error.code],
      ...(error.reason ? { reason: error.reason } : {}),
    });

  const clientOf = (id: string) =>
    db.query.clients.findFirst({
      where: eq(clients.id, id),
      columns: { id: true, article: true, whatsappArtSetAt: true },
    });

  async function stateOf(client: {
    id: string;
    article: string | null;
    whatsappArtSetAt: Date | null;
  }): Promise<ClientWhatsAppArt> {
    const file = await artFileOf(db, client.id);
    const d = deps();
    const link = file && d.storage ? await artLink(d, file) : null;
    return {
      clientId: client.id,
      article:
        client.id === WINGS_CLIENT_ID
          ? null
          : client.article === 'o' || client.article === 'a'
            ? (client.article as BrandArticle)
            : null,
      art: link ? { ...link, setAt: client.whatsappArtSetAt?.toISOString() ?? null } : null,
    };
  }

  const audit = (
    request: FastifyRequest,
    action: string,
    clientId: string,
    metadata: Record<string, unknown>,
  ) =>
    writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action,
      entity: 'client',
      entityId: clientId,
      ip: request.ip,
      metadata,
    });

  app.get('/clients/:id/whatsapp', { preHandler: readGate }, async (request, reply) => {
    if (!mayRead(request)) return forbidden(reply);
    const params = idParam.safeParse(request.params);
    const client = params.success ? await clientOf(params.data.id) : null;
    if (!client) return notFound(reply);
    const state = await stateOf(client);
    if (state.art)
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'drive.file_previewed',
        entity: 'drive_file',
        entityId: state.art.fileId,
        ip: request.ip,
        metadata: { purpose: 'whatsapp_art', clientId: client.id },
      });
    return reply.header('Cache-Control', 'no-store').send(state);
  });

  app.put('/clients/:id/whatsapp/article', { preHandler: writeGate }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = waArticleSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'invalid_request', message: 'Artigo inválido.' });
    if (!mayWrite(request, params.data.id)) return forbidden(reply);
    if (params.data.id === WINGS_CLIENT_ID)
      return reply.status(409).send({
        error: 'client_fixed',
        message: 'Os modelos da Formatação já trazem "Wings Company" no texto.',
      });
    const [row] = await db
      .update(clients)
      .set({ article: body.data.article })
      .where(eq(clients.id, params.data.id))
      .returning({
        id: clients.id,
        article: clients.article,
        whatsappArtSetAt: clients.whatsappArtSetAt,
      });
    if (!row) return notFound(reply);
    await audit(request, 'client.whatsapp_article_set', row.id, { article: row.article });
    return reply.send(await stateOf(row));
  });

  app.post(
    '/clients/:id/whatsapp/art/uploads',
    { preHandler: writeGate },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return notFound(reply);
      if (!mayWrite(request, params.data.id)) return forbidden(reply);
      const body = waArtUploadSchema.safeParse(request.body);
      if (!body.success)
        return reply.status(422).send({
          error: 'art_refused',
          message: body.error.issues[0]?.message ?? 'Arquivo inválido.',
        });
      const client = await clientOf(params.data.id);
      if (!client) return notFound(reply);
      try {
        const ticket = await requestArtUpload(
          deps(),
          request.session.actor.employeeId,
          client.id,
          body.data,
        );
        await audit(request, 'client.whatsapp_art_upload_requested', client.id, {
          uploadId: ticket.uploadId,
          byteSize: body.data.byteSize,
          mimeType: body.data.mimeType,
        });
        return reply.status(201).send({ ticket });
      } catch (error) {
        if (error instanceof ArtError) return refuse(reply, error);
        throw error;
      }
    },
  );

  app.post(
    '/clients/:id/whatsapp/art/uploads/:uploadId/complete',
    { preHandler: writeGate },
    async (request, reply) => {
      const params = uploadParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      if (!mayWrite(request, params.data.id)) return forbidden(reply);
      const client = await clientOf(params.data.id);
      if (!client) return notFound(reply);
      try {
        const done = await completeArtUpload(
          deps(),
          request.session.actor.employeeId,
          client.id,
          params.data.uploadId,
        );
        await audit(request, 'client.whatsapp_art_set', client.id, done);
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: 'drive.file_uploaded',
          entity: 'drive_file',
          entityId: done.fileId,
          ip: request.ip,
          metadata: { purpose: 'whatsapp_art', clientId: client.id },
        });
        return reply.status(201).send(await stateOf((await clientOf(client.id)) ?? client));
      } catch (error) {
        if (error instanceof ArtError) {
          if (error.code === 'refused')
            await audit(request, 'client.whatsapp_art_refused', client.id, {
              uploadId: params.data.uploadId,
              reason: error.reason,
            });
          return refuse(reply, error);
        }
        throw error;
      }
    },
  );

  app.delete('/clients/:id/whatsapp/art', { preHandler: writeGate }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return notFound(reply);
    if (!mayWrite(request, params.data.id)) return forbidden(reply);
    const client = await clientOf(params.data.id);
    if (!client) return notFound(reply);
    const previousFileId = await clearArt(db, client.id);
    await audit(request, 'client.whatsapp_art_removed', client.id, { previousFileId });
    return reply.send(await stateOf({ ...client, whatsappArtSetAt: null }));
  });
};
