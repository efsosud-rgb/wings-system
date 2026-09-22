import { STUDIO_LINK_TTL_SECONDS, studioRenderRequestSchema } from '@wings/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../lib/audit.js';
import { storageOf } from '../../lib/storage/index.js';
import { driveAccessOf, type DriveAccess } from '../drive/access.js';
import { DriveError, linkFor, type DriveDeps } from '../drive/service.js';
import { StudioError, enqueueRender, listRenders, renderOf, type StudioDeps } from './service.js';

const idParam = z.object({ id: z.uuid() });

const STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_project: 422,
  storage_unavailable: 503,
};

/**
 * Wings Studio, the manual video editor. `marketing.media.edit` opens it, and
 * under that every file and folder is checked against the person's Drive
 * departments, exactly as the Drive does. Links handed out here last an hour
 * instead of five minutes, because a video element keeps reading through the
 * same address for as long as the person edits; each one is audited by id.
 */
export const studioRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const drive: DriveDeps = {
    db,
    storage: storageOf(app.wings),
    maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
    now: () => new Date(),
  };
  const deps: StudioDeps = { db, drive, now: drive.now };
  const edit = { preHandler: app.requirePermission('marketing.media.edit') };

  const guarded =
    <T>(
      handler: (access: DriveAccess, request: FastifyRequest, reply: FastifyReply) => Promise<T>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const access = driveAccessOf(request.session.actor);
      if (!access) return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
      try {
        return await handler(access, request, reply);
      } catch (error) {
        if (error instanceof DriveError || error instanceof StudioError) {
          return reply
            .status(STATUS[error.code] ?? 400)
            .send({ error: error.code, message: error.message, ...error.details });
        }
        throw error;
      }
    };

  const audit = (
    request: FastifyRequest,
    action: string,
    entity: 'drive_file' | 'job',
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) =>
    writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action,
      entity,
      entityId,
      ip: request.ip,
      metadata,
    });

  const invalid = (reply: FastifyReply, error: z.ZodError) =>
    reply.status(400).send({
      error: 'invalid_request',
      message: error.issues[0]?.message ?? 'Dados inválidos',
    });

  /** A link to read one Drive file inside the editor, good for an hour. */
  app.get(
    '/studio/files/:id/link',
    edit,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      const link = await linkFor(drive, access, params.data.id, {
        disposition: 'inline',
        ttlSeconds: STUDIO_LINK_TTL_SECONDS,
      });
      await audit(request, 'studio.file_opened', 'drive_file', link.fileId, {
        version: link.version,
        ttlSeconds: STUDIO_LINK_TTL_SECONDS,
      });
      return reply
        .header('Cache-Control', 'no-store')
        .send({ url: link.url, expiresAt: link.expiresAt });
    }),
  );

  /** Puts a render on the worker's queue. The answer is the job, not the file. */
  app.post(
    '/studio/renders',
    edit,
    guarded(async (access, request, reply) => {
      const body = studioRenderRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const render = await enqueueRender(deps, access, body.data);
      await audit(request, 'studio.render_requested', 'job', render.id, {
        folderId: render.destination.folderId,
        replaced: render.destination.replaceFileId !== null,
        fps: body.data.fps,
        videoBitrate: body.data.videoBitrate,
      });
      return reply.status(202).send({ render });
    }),
  );

  app.get(
    '/studio/renders',
    edit,
    guarded(async (access, _request, reply) =>
      reply.send({ renders: await listRenders(deps, access) }),
    ),
  );

  app.get(
    '/studio/renders/:id',
    edit,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new StudioError('not_found', 'Render não encontrado.');
      const { render } = await renderOf(deps, access, params.data.id);
      return reply.header('Cache-Control', 'no-store').send({ render });
    }),
  );
};
