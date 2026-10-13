import {
  driveFileUpdateSchema,
  driveFolderCreateSchema,
  driveFolderUpdateSchema,
  driveTemplateNodeCreateSchema,
  driveTemplateNodeUpdateSchema,
  driveUploadRequestSchema,
  type DriveDepartment,
  type DriveTemplateKind,
  type DriveTemplateNode,
} from '@wings/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { driveTemplateNodes } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { storageOf } from '../../lib/storage/index.js';
import type { LocalStorage } from '../../lib/storage/local.js';
import { driveAccessOf, type DriveAccess } from './access.js';
import { syncDriveFolders } from './folders.js';
import {
  DriveError,
  completeUpload,
  createFolder,
  deleteFolder,
  linkFor,
  listFiles,
  listTrash,
  listTree,
  listVersions,
  purgeExpired,
  purgeFile,
  requestUpload,
  restoreFile,
  searchFiles,
  toFolder,
  trashFile,
  updateFile,
  updateFolder,
  type DriveDeps,
} from './service.js';

const idParam = z.object({ id: z.uuid() });
const SWEEP_MS = 6 * 3600_000;

const STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  name_taken: 409,
  managed_folder: 409,
  folder_not_empty: 409,
  into_itself: 400,
  too_large: 413,
  upload_incomplete: 409,
  upload_expired: 410,
  storage_unavailable: 503,
};

function refuse(reply: FastifyReply, error: DriveError) {
  return reply
    .status(STATUS[error.code] ?? 400)
    .send({ error: error.code, message: error.message, ...error.details });
}

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.status(400).send({
    error: 'invalid_request',
    message: error.issues[0]?.message ?? 'Dados inválidos',
  });

/**
 * The Drive. `drive.read` opens it, `drive.write` changes it, `drive.manage`
 * keeps the folder model; and under each of those, the department of every
 * folder is checked again for the person asking. Every operation that changes
 * something, and every address handed out for a file, is written to the audit
 * log by id: never a file name, which may hold somebody's name.
 */
export const driveRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const deps: DriveDeps = {
    db,
    storage: storageOf(app.wings),
    maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
    now: () => new Date(),
  };

  if (env.NODE_ENV !== 'test') {
    const sweep = () => void purgeExpired(deps).catch(() => undefined);
    setTimeout(sweep, 60_000).unref();
    setInterval(sweep, SWEEP_MS).unref();
  }

  /** Runs a handler for somebody who may use the Drive, turning refusals into answers. */
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
        if (error instanceof DriveError) return refuse(reply, error);
        throw error;
      }
    };

  const audit = (
    request: FastifyRequest,
    action: string,
    entity: 'drive_file' | 'drive_folder' | 'drive_template',
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

  const read = { preHandler: app.requirePermission('drive.read') };
  const write = { preHandler: app.requirePermission('drive.write') };
  const manage = { preHandler: app.requirePermission('drive.manage') };

  app.get(
    '/drive/tree',
    read,
    guarded(async (access, _request, reply) =>
      reply.send({
        folders: await listTree(deps, access),
        maxFileBytes: deps.maxFileBytes,
        storageAvailable: deps.storage !== null,
      }),
    ),
  );

  app.get(
    '/drive/folders/:id',
    read,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      const { folder, files } = await listFiles(deps, access, params.data.id);
      return reply.send({ folder: toFolder(folder, access), files });
    }),
  );

  app.post(
    '/drive/folders',
    write,
    guarded(async (access, request, reply) => {
      const body = driveFolderCreateSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const folder = await createFolder(deps, access, body.data);
      await audit(request, 'drive.folder_created', 'drive_folder', folder.id, {
        parentId: folder.parentId,
        department: folder.department,
      });
      return reply.status(201).send({ folder: toFolder(folder, access) });
    }),
  );

  app.patch(
    '/drive/folders/:id',
    write,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = driveFolderUpdateSchema.safeParse(request.body);
      if (!params.success) throw new DriveError('not_found');
      if (!body.success) return invalid(reply, body.error);
      const folder = await updateFolder(deps, access, params.data.id, body.data);
      await audit(request, 'drive.folder_updated', 'drive_folder', folder.id, {
        renamed: body.data.name !== undefined,
        movedTo: body.data.parentId ?? null,
      });
      return reply.send({ folder: toFolder(folder, access) });
    }),
  );

  app.delete(
    '/drive/folders/:id',
    write,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      const folder = await deleteFolder(deps, access, params.data.id);
      await audit(request, 'drive.folder_deleted', 'drive_folder', folder.id, {
        parentId: folder.parentId,
      });
      return reply.status(204).send();
    }),
  );

  app.get(
    '/drive/search',
    read,
    guarded(async (access, request, reply) => {
      const query = z
        .object({
          q: z.string().trim().min(1).max(80).optional(),
          clientId: z.uuid().optional(),
          tag: z.string().trim().min(1).max(40).optional(),
          folderId: z.uuid().optional(),
        })
        .safeParse(request.query);
      if (!query.success) return invalid(reply, query.error);
      return reply.send({ files: await searchFiles(deps, access, query.data) });
    }),
  );

  app.get(
    '/drive/trash',
    read,
    guarded(async (access, _request, reply) =>
      reply.send({ files: await listTrash(deps, access) }),
    ),
  );

  app.post(
    '/drive/uploads',
    write,
    guarded(async (access, request, reply) => {
      const body = driveUploadRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const ticket = await requestUpload(deps, access, body.data);
      await audit(request, 'drive.upload_requested', 'drive_folder', body.data.folderId, {
        uploadId: ticket.uploadId,
        byteSize: body.data.byteSize,
        mimeType: body.data.mimeType,
        replaces: body.data.replaceFileId ?? null,
      });
      return reply.status(201).send({ ticket });
    }),
  );

  app.post(
    '/drive/uploads/:id/complete',
    write,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      const { file, replaced } = await completeUpload(deps, access, params.data.id);
      await audit(
        request,
        replaced ? 'drive.file_replaced' : 'drive.file_uploaded',
        'drive_file',
        file.id,
        { folderId: file.folderId, byteSize: file.byteSize, version: file.version },
      );
      return reply.status(201).send({ file });
    }),
  );

  app.patch(
    '/drive/files/:id',
    write,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = driveFileUpdateSchema.safeParse(request.body);
      if (!params.success) throw new DriveError('not_found');
      if (!body.success) return invalid(reply, body.error);
      const { file, movedFrom } = await updateFile(deps, access, params.data.id, body.data);
      await audit(
        request,
        movedFrom ? 'drive.file_moved' : 'drive.file_updated',
        'drive_file',
        file.id,
        {
          renamed: body.data.name !== undefined,
          retagged: body.data.tags !== undefined,
          from: movedFrom,
          to: movedFrom ? file.folderId : null,
        },
      );
      return reply.send({ file });
    }),
  );

  for (const [path, action, run] of [
    ['trash', 'drive.file_trashed', trashFile],
    ['restore', 'drive.file_restored', restoreFile],
  ] as const) {
    app.post(
      `/drive/files/:id/${path}`,
      write,
      guarded(async (access, request, reply) => {
        const params = idParam.safeParse(request.params);
        if (!params.success) throw new DriveError('not_found');
        const file = await run(deps, access, params.data.id);
        await audit(request, action, 'drive_file', file.id, { folderId: file.folderId });
        return reply.send({ file });
      }),
    );
  }

  app.delete(
    '/drive/files/:id',
    manage,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      const file = await purgeFile(deps, access, params.data.id);
      await audit(request, 'drive.file_purged', 'drive_file', file.id, {
        folderId: file.folderId,
        byteSize: file.byteSize,
      });
      return reply.status(204).send();
    }),
  );

  app.get(
    '/drive/files/:id/link',
    read,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      const query = z
        .object({
          disposition: z.enum(['inline', 'attachment']).default('attachment'),
          version: z.coerce.number().int().positive().optional(),
        })
        .safeParse(request.query);
      if (!params.success) throw new DriveError('not_found');
      if (!query.success) return invalid(reply, query.error);
      const link = await linkFor(deps, access, params.data.id, query.data);
      await audit(
        request,
        query.data.disposition === 'inline' ? 'drive.file_previewed' : 'drive.file_downloaded',
        'drive_file',
        link.fileId,
        { version: link.version },
      );
      return reply
        .header('Cache-Control', 'no-store')
        .send({ url: link.url, expiresAt: link.expiresAt });
    }),
  );

  app.get(
    '/drive/files/:id/versions',
    read,
    guarded(async (access, request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new DriveError('not_found');
      return reply.send({ versions: await listVersions(deps, access, params.data.id) });
    }),
  );

  // -------------------------------------------------------------------------
  // The folder model
  // -------------------------------------------------------------------------

  const toNode = (row: typeof driveTemplateNodes.$inferSelect): DriveTemplateNode => ({
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    kind: row.kind as DriveTemplateKind,
    slot: (row.slot as DriveTemplateNode['slot']) ?? null,
    department: row.department as DriveDepartment,
    position: row.position,
  });
  const allNodes = async () =>
    (
      await db
        .select()
        .from(driveTemplateNodes)
        .orderBy(asc(driveTemplateNodes.position), asc(driveTemplateNodes.createdAt))
    ).map(toNode);

  app.get('/drive/template', manage, async (_request, reply) =>
    reply.send({ nodes: await allNodes() }),
  );

  app.post('/drive/template', manage, async (request, reply) => {
    const body = driveTemplateNodeCreateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const nodes = await allNodes();
    const parent = body.data.parentId ? nodes.find((node) => node.id === body.data.parentId) : null;
    if (body.data.parentId && !parent) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'Pasta do modelo não encontrada.' });
    }
    const department = body.data.department ?? parent?.department;
    if (!department) {
      return reply
        .status(400)
        .send({ error: 'invalid_request', message: 'Escolha o departamento da pasta.' });
    }
    // A "Clientes" inside a "Clientes" would make a folder per client inside every client.
    const insideClients = (node: DriveTemplateNode | null | undefined): boolean =>
      !!node &&
      (node.kind === 'clients' || insideClients(nodes.find((item) => item.id === node.parentId)));
    if (body.data.kind === 'clients' && insideClients(parent)) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Uma pasta de clientes não pode ficar dentro de outra.',
      });
    }
    const siblings = nodes.filter((node) => node.parentId === body.data.parentId);
    if (siblings.some((node) => node.name.toLowerCase() === body.data.name.toLowerCase())) {
      return reply
        .status(409)
        .send({ error: 'name_taken', message: 'Já existe uma pasta com este nome neste nível.' });
    }
    const [row] = await db
      .insert(driveTemplateNodes)
      .values({
        parentId: body.data.parentId,
        name: body.data.name,
        kind: body.data.kind,
        department,
        position: siblings.length,
      })
      .returning();
    if (!row) throw new Error('failed to create template node');
    await audit(request, 'drive.template_node_created', 'drive_template', row.id, {
      kind: row.kind,
      department: row.department,
    });
    return reply.status(201).send({ node: toNode(row) });
  });

  app.patch('/drive/template/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = driveTemplateNodeUpdateSchema.safeParse(request.body);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    if (!body.success) return invalid(reply, body.error);
    const [row] = await db
      .update(driveTemplateNodes)
      .set(body.data)
      .where(eq(driveTemplateNodes.id, params.data.id))
      .returning();
    if (!row) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'Pasta do modelo não encontrada.' });
    }
    await audit(request, 'drive.template_node_updated', 'drive_template', row.id, {
      renamed: body.data.name !== undefined,
      department: body.data.department ?? null,
    });
    return reply.send({ node: toNode(row) });
  });

  /** Leaves the model only. The folders already made from it stay, as ordinary folders. */
  app.delete('/drive/template/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const nodes = await allNodes();
    // The client tree's folders have a function (the Portal and the import find them by it).
    if (nodes.find((node) => node.id === params.data.id)?.slot) {
      return reply.status(409).send({
        error: 'folder_has_role',
        message:
          'Esta pasta faz parte da estrutura de cada cliente (o Portal do Cliente a usa). Renomeie, mas não exclua.',
      });
    }
    if (nodes.some((node) => node.parentId === params.data.id)) {
      return reply.status(409).send({
        error: 'folder_not_empty',
        message: 'Tire antes as pastas que estão dentro desta no modelo.',
      });
    }
    // `on delete set null` frees the link; here the folders become ordinary ones.
    await db.execute(
      sql`update drive_folders set origin = 'manual' where template_node_id = ${params.data.id}`,
    );
    await db.delete(driveTemplateNodes).where(eq(driveTemplateNodes.id, params.data.id));
    await audit(request, 'drive.template_node_deleted', 'drive_template', params.data.id);
    return reply.status(204).send();
  });

  app.post('/drive/sync', manage, async (request, reply) => {
    const result = await syncDriveFolders(db);
    await audit(request, 'drive.folders_synced', 'drive_template', null, { ...result });
    return reply.send(result);
  });
};

/**
 * Where the LOCAL backend's "pre-signed" addresses lead. No login: the token is
 * the permission, as a pre-signed R2 address would be, and it says nothing when
 * it refuses. With R2 configured these routes are never handed out.
 */
/**
 * The one range a `Range: bytes=a-b` header asks for, clamped to the file:
 * `a-` runs to the end, `-n` is the last n bytes. Anything else is served
 * whole; a start past the end is unsatisfiable.
 */
export function byteRangeOf(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Math.min(size, Number(to));
    return suffix <= 0 ? 'unsatisfiable' : { start: size - suffix, end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return 'unsatisfiable';
  const end = to === '' ? size - 1 : Math.min(size - 1, Number(to));
  return end < start ? 'unsatisfiable' : { start, end };
}

export const driveBlobRoutes: FastifyPluginAsync = async (app) => {
  const storage = storageOf(app.wings);
  if (storage?.kind !== 'local') return;
  const local = storage as LocalStorage;
  // Whatever the file's type, the body is a stream of bytes here, never parsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  const tokenOf = (request: FastifyRequest) =>
    z.object({ t: z.string().min(20).max(2000) }).safeParse(request.query).data?.t;

  // No login, as with R2: the signed, short-lived address is the credential.
  const signedLink = app.publicRoute('local stand-in for R2, signed address');
  app.put(
    '/drive/blob',
    { preHandler: signedLink, bodyLimit: app.wings.env.DRIVE_MAX_FILE_BYTES },
    async (request, reply) => {
      const grant = local.open(tokenOf(request) ?? '');
      const length = Number(request.headers['content-length'] ?? -1);
      if (
        grant?.verb !== 'PUT' ||
        grant.contentLength !== length ||
        (grant.contentType ?? '') !== (request.headers['content-type'] ?? '')
      ) {
        return reply.status(403).send({ error: 'forbidden' });
      }
      const stored = await local.receive(
        grant.key,
        request.body as NodeJS.ReadableStream as never,
        length,
      );
      return reply.status(stored ? 200 : 400).send();
    },
  );

  /**
   * Serves a file, whole or by byte range. Video and audio in the Studio ask
   * for ranges (a seek is a range request), as they would from R2; without
   * 206 answers the browser never gets a frame after the first.
   */
  app.get('/drive/blob', { preHandler: signedLink }, async (request, reply) => {
    const grant = local.open(tokenOf(request) ?? '');
    const size = grant?.verb === 'GET' ? await local.size(grant.key) : null;
    if (!grant || size === null) return reply.status(404).send({ error: 'not_found' });
    const range = byteRangeOf(request.headers.range, size);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('Content-Range', `bytes */${size}`).send();
    }
    const found = await local.stream(grant.key, range ?? undefined);
    if (!found) return reply.status(404).send({ error: 'not_found' });
    void reply
      .header('Content-Type', grant.contentType ?? 'application/octet-stream')
      .header('Content-Disposition', grant.disposition ?? 'attachment')
      .header('Cache-Control', 'private, no-store')
      .header('Accept-Ranges', 'bytes')
      .header('X-Content-Type-Options', 'nosniff');
    if (range) {
      return reply
        .status(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(found.stream);
    }
    return reply.header('Content-Length', size).send(found.stream);
  });
};
