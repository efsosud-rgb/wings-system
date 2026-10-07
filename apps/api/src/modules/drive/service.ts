import { randomUUID } from 'node:crypto';
import {
  DRIVE_REFUSALS,
  DRIVE_TRASH_DAYS,
  type DriveFile,
  type DriveFileVersion,
  type DriveFolder,
  type DriveFolderOrigin,
  type DriveDepartment,
  type DriveLink,
  type DriveRefusal,
  type DriveUploadRequest,
  type DriveUploadTicket,
} from '@wings/shared';
import { and, asc, desc, eq, ilike, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  driveFiles,
  driveFileVersions,
  driveFolders,
  driveUploads,
  employees,
  mediaAssets,
} from '../../db/schema/index.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { folderReachSql, seesFolder, writesFolder, type DriveAccess } from './access.js';
import { moveFolderTree } from './folders.js';

/**
 * Files and folders. Every function takes WHO is asking (`DriveAccess`) and
 * checks the folder's department before anything else: a folder of another
 * department answers "not found", the same as one that does not exist.
 */

const UPLOAD_TTL_SECONDS = 15 * 60;
const LINK_TTL_SECONDS = 5 * 60;
const DAY_MS = 24 * 3600_000;

export interface DriveDeps {
  db: Database;
  storage: ObjectStorage | null;
  maxFileBytes: number;
  now: () => Date;
}

export class DriveError extends Error {
  constructor(
    readonly code: DriveRefusal,
    readonly details: Record<string, unknown> = {},
  ) {
    super(DRIVE_REFUSALS[code]);
    this.name = 'DriveError';
  }
}

type FolderRow = typeof driveFolders.$inferSelect;
type FileRow = typeof driveFiles.$inferSelect;

function storageOrRefuse(deps: DriveDeps): ObjectStorage {
  if (!deps.storage) throw new DriveError('storage_unavailable');
  return deps.storage;
}

/** `drive/2026-09/<uuid>`: made here, holding nothing of the file's name or place. */
export const newStorageKey = (now: Date) =>
  `drive/${now.toISOString().slice(0, 7)}/${randomUUID()}`;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function toFolder(row: FolderRow, access: DriveAccess): DriveFolder {
  const accessible = seesFolder(access, row);
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    department: row.department as DriveDepartment,
    clientId: row.clientId,
    origin: row.origin as DriveFolderOrigin,
    accessible,
    canWrite: accessible && writesFolder(access, row),
    managed: row.origin !== 'manual',
    slot: (row.slot as DriveFolder['slot']) ?? null,
  };
}

/**
 * The tree one person sees: the folders of their departments, plus the folders
 * above those so the tree can be walked. The ones above are marked not
 * accessible: they list no files and take none.
 */
export async function listTree(deps: DriveDeps, access: DriveAccess): Promise<DriveFolder[]> {
  const rows = await deps.db.select().from(driveFolders).orderBy(asc(driveFolders.path));
  if (access.all) return rows.map((row) => toFolder(row, access));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shown = new Set<string>();
  for (const row of rows) {
    if (!seesFolder(access, row)) continue;
    for (let at: FolderRow | undefined = row; at && !shown.has(at.id);) {
      shown.add(at.id);
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
  }
  return rows.filter((row) => shown.has(row.id)).map((row) => toFolder(row, access));
}

/** The folder, only for somebody who works in its department. */
export async function folderFor(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
  need: 'read' | 'write' = 'read',
): Promise<FolderRow> {
  const row = await deps.db.query.driveFolders.findFirst({ where: eq(driveFolders.id, id) });
  if (!row || !seesFolder(access, row)) throw new DriveError('not_found');
  if (need === 'write' && !writesFolder(access, row)) throw new DriveError('forbidden');
  return row;
}

async function siblingTaken(
  db: Database,
  parentId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: driveFolders.id })
    .from(driveFolders)
    .where(
      and(
        eq(driveFolders.parentId, parentId),
        sql`lower(${driveFolders.name}) = lower(${name})`,
        exceptId ? ne(driveFolders.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return hit !== undefined;
}

export async function createFolder(
  deps: DriveDeps,
  access: DriveAccess,
  input: { parentId: string; name: string },
): Promise<FolderRow> {
  const parent = await folderFor(deps, access, input.parentId, 'write');
  if (await siblingTaken(deps.db, parent.id, input.name)) throw new DriveError('name_taken');
  const [row] = await deps.db
    .insert(driveFolders)
    .values({
      parentId: parent.id,
      name: input.name,
      path: `${parent.path}/${input.name}`,
      // What is made inside a folder belongs to that folder's department and client.
      department: parent.department,
      clientId: parent.clientId,
      origin: 'manual',
      createdBy: access.employeeId,
      createdAt: deps.now(),
    })
    .returning();
  if (!row) throw new Error('failed to create folder');
  return row;
}

export async function updateFolder(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
  changes: { name?: string; parentId?: string },
): Promise<FolderRow> {
  const folder = await folderFor(deps, access, id, 'write');
  if (folder.origin !== 'manual' || !folder.parentId) throw new DriveError('managed_folder');
  const parent =
    changes.parentId && changes.parentId !== folder.parentId
      ? await folderFor(deps, access, changes.parentId, 'write')
      : await folderFor(deps, access, folder.parentId, 'read');
  if (parent.id === folder.id || parent.path.startsWith(`${folder.path}/`)) {
    throw new DriveError('into_itself');
  }
  const name = changes.name ?? folder.name;
  if (await siblingTaken(deps.db, parent.id, name, folder.id)) throw new DriveError('name_taken');

  await deps.db.transaction(async (tx) => {
    await moveFolderTree(tx, folder, { name, parentId: parent.id, parentPath: parent.path });
    if (parent.department !== folder.department || parent.clientId !== folder.clientId) {
      // Moved under another department or client: the whole subtree goes with it.
      const path = `${parent.path}/${name}`;
      await tx.execute(sql`
        update drive_folders set department = ${parent.department}, client_id = ${parent.clientId}
         where path = ${path} or starts_with(path, ${`${path}/`})`);
      await tx.execute(sql`
        update drive_files set client_id = ${parent.clientId}
         where folder_id in (select id from drive_folders
                              where path = ${path} or starts_with(path, ${`${path}/`}))`);
    }
  });
  const updated = await deps.db.query.driveFolders.findFirst({ where: eq(driveFolders.id, id) });
  if (!updated) throw new DriveError('not_found');
  return updated;
}

export async function deleteFolder(deps: DriveDeps, access: DriveAccess, id: string) {
  const folder = await folderFor(deps, access, id, 'write');
  if (folder.origin !== 'manual') throw new DriveError('managed_folder');
  const [child] = await deps.db
    .select({ id: driveFolders.id })
    .from(driveFolders)
    .where(eq(driveFolders.parentId, id))
    .limit(1);
  // Files in the trash still count: they can be restored into this folder.
  const [file] = await deps.db
    .select({ id: driveFiles.id })
    .from(driveFiles)
    .where(eq(driveFiles.folderId, id))
    .limit(1);
  if (child || file) throw new DriveError('folder_not_empty');
  await deps.db.delete(driveUploads).where(eq(driveUploads.folderId, id));
  await deps.db.delete(driveFolders).where(eq(driveFolders.id, id));
  return folder;
}

// ---------------------------------------------------------------------------
// Files: reading
// ---------------------------------------------------------------------------

const fileColumns = {
  file: driveFiles,
  folderPath: driveFolders.path,
  department: driveFolders.department,
  folderClientId: driveFolders.clientId,
  ownerName: employees.fullName,
  clientName: clients.name,
};

type FileJoin = {
  file: FileRow;
  folderPath: string;
  department: string;
  folderClientId: string | null;
  ownerName: string | null;
  clientName: string | null;
};

function toFile(row: FileJoin, access: DriveAccess): DriveFile {
  const { file } = row;
  return {
    id: file.id,
    folderId: file.folderId,
    folderPath: row.folderPath,
    name: file.name,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    version: file.version,
    ownerName: row.ownerName,
    clientId: file.clientId,
    clientName: row.clientName,
    tags: file.tags,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    trashedAt: file.trashedAt?.toISOString() ?? null,
    purgeAt: file.trashedAt
      ? new Date(file.trashedAt.getTime() + DRIVE_TRASH_DAYS * DAY_MS).toISOString()
      : null,
    canWrite: writesFolder(access, {
      department: row.department,
      clientId: row.folderClientId,
      path: row.folderPath,
    }),
  };
}

const selectFiles = (db: Database) =>
  db
    .select(fileColumns)
    .from(driveFiles)
    .innerJoin(driveFolders, eq(driveFolders.id, driveFiles.folderId))
    .leftJoin(employees, eq(employees.id, driveFiles.ownerId))
    .leftJoin(clients, eq(clients.id, driveFiles.clientId));

/** The department filter of every query over files: nothing outside it is ever matched. */
const withinReach = (access: DriveAccess) => folderReachSql(access);

export async function listFiles(deps: DriveDeps, access: DriveAccess, folderId: string) {
  const folder = await folderFor(deps, access, folderId);
  const rows = await selectFiles(deps.db)
    .where(and(eq(driveFiles.folderId, folder.id), isNull(driveFiles.trashedAt)))
    .orderBy(asc(driveFiles.name));
  return { folder, files: rows.map((row) => toFile(row, access)) };
}

export async function searchFiles(
  deps: DriveDeps,
  access: DriveAccess,
  query: { q?: string; clientId?: string; tag?: string; folderId?: string },
): Promise<DriveFile[]> {
  const within = query.folderId ? await folderFor(deps, access, query.folderId) : null;
  const rows = await selectFiles(deps.db)
    .where(
      and(
        withinReach(access),
        isNull(driveFiles.trashedAt),
        query.q ? ilike(driveFiles.name, `%${query.q.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
        query.clientId ? eq(driveFiles.clientId, query.clientId) : undefined,
        query.tag ? sql`${query.tag.toLowerCase()} = any(${driveFiles.tags})` : undefined,
        within
          ? or(
              eq(driveFolders.id, within.id),
              sql`starts_with(${driveFolders.path}, ${`${within.path}/`})`,
            )
          : undefined,
      ),
    )
    .orderBy(desc(driveFiles.updatedAt))
    .limit(200);
  return rows.map((row) => toFile(row, access));
}

export async function listTrash(deps: DriveDeps, access: DriveAccess): Promise<DriveFile[]> {
  await purgeExpired(deps);
  const rows = await selectFiles(deps.db)
    .where(and(withinReach(access), isNotNull(driveFiles.trashedAt)))
    .orderBy(desc(driveFiles.trashedAt))
    .limit(500);
  return rows.map((row) => toFile(row, access));
}

export async function fileFor(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
  need: 'read' | 'write' = 'read',
): Promise<FileJoin> {
  const [row] = await selectFiles(deps.db).where(eq(driveFiles.id, id));
  const reach = {
    department: row?.department ?? '',
    clientId: row?.folderClientId ?? null,
    path: row?.folderPath ?? '',
  };
  if (!row || !seesFolder(access, reach)) throw new DriveError('not_found');
  if (need === 'write' && !writesFolder(access, reach)) throw new DriveError('forbidden');
  return row;
}

export async function getFile(deps: DriveDeps, access: DriveAccess, id: string) {
  return toFile(await fileFor(deps, access, id), access);
}

/** A short address for one file: to download it, or to show it in place. */
export async function linkFor(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
  options: {
    disposition: 'inline' | 'attachment';
    version?: number;
    /** The Studio asks for longer than the default five minutes: a video element keeps reading through the link. */
    ttlSeconds?: number;
  },
): Promise<DriveLink & { fileId: string; version: number }> {
  const ttl = options.ttlSeconds ?? LINK_TTL_SECONDS;
  const storage = storageOrRefuse(deps);
  const { file } = await fileFor(deps, access, id);
  let source = { key: file.storageKey, mimeType: file.mimeType, version: file.version };
  if (options.version !== undefined && options.version !== file.version) {
    const old = await deps.db.query.driveFileVersions.findFirst({
      where: and(
        eq(driveFileVersions.fileId, file.id),
        eq(driveFileVersions.version, options.version),
      ),
    });
    if (!old) throw new DriveError('not_found');
    source = { key: old.storageKey, mimeType: old.mimeType, version: old.version };
  }
  const url = await storage.presignGet(source.key, {
    expiresSeconds: ttl,
    disposition: options.disposition,
    filename: file.name,
    contentType: source.mimeType,
  });
  return {
    url,
    expiresAt: new Date(deps.now().getTime() + ttl * 1000).toISOString(),
    fileId: file.id,
    version: source.version,
  };
}

export async function listVersions(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
): Promise<DriveFileVersion[]> {
  const { file } = await fileFor(deps, access, id);
  const rows = await deps.db
    .select({ version: driveFileVersions, replacedByName: employees.fullName })
    .from(driveFileVersions)
    .leftJoin(employees, eq(employees.id, driveFileVersions.replacedBy))
    .where(eq(driveFileVersions.fileId, file.id))
    .orderBy(desc(driveFileVersions.version));
  return rows.map(({ version, replacedByName }) => ({
    version: version.version,
    byteSize: version.byteSize,
    mimeType: version.mimeType,
    createdAt: version.createdAt.toISOString(),
    replacedByName,
  }));
}

// ---------------------------------------------------------------------------
// Files: uploading
// ---------------------------------------------------------------------------

async function nameTaken(db: Database, folderId: string, name: string, exceptId?: string) {
  const [hit] = await db
    .select({ id: driveFiles.id })
    .from(driveFiles)
    .where(
      and(
        eq(driveFiles.folderId, folderId),
        isNull(driveFiles.trashedAt),
        sql`lower(${driveFiles.name}) = lower(${name})`,
        exceptId ? ne(driveFiles.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return hit?.id ?? null;
}

/**
 * Step one of an upload: the person says what they will send, and gets an
 * address that takes exactly that. Nothing is a file yet.
 */
export async function requestUpload(
  deps: DriveDeps,
  access: DriveAccess,
  request: DriveUploadRequest,
): Promise<DriveUploadTicket> {
  const storage = storageOrRefuse(deps);
  if (request.byteSize > deps.maxFileBytes) {
    throw new DriveError('too_large', { maxFileBytes: deps.maxFileBytes });
  }
  const folder = await folderFor(deps, access, request.folderId, 'write');
  if (request.replaceFileId) {
    const { file } = await fileFor(deps, access, request.replaceFileId, 'write');
    if (file.folderId !== folder.id || file.trashedAt) throw new DriveError('not_found');
  } else {
    const existing = await nameTaken(deps.db, folder.id, request.name);
    if (existing) throw new DriveError('name_taken', { existingFileId: existing });
  }

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
  const [row] = await deps.db
    .insert(driveUploads)
    .values({
      folderId: folder.id,
      name: request.name,
      mimeType: request.mimeType,
      byteSize: request.byteSize,
      storageKey: newStorageKey(now),
      replaceFileId: request.replaceFileId ?? null,
      requestedBy: access.employeeId,
      expiresAt,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('failed to record upload');
  const signed = await storage.presignPut(row.storageKey, {
    contentType: row.mimeType,
    contentLength: row.byteSize,
    expiresSeconds: UPLOAD_TTL_SECONDS,
  });
  return {
    uploadId: row.id,
    method: 'PUT',
    url: signed.url,
    headers: signed.headers,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Step two: the browser says it is done, and the server goes and looks. Only
 * when storage holds an object of the promised size does the file exist.
 */
export async function completeUpload(
  deps: DriveDeps,
  access: DriveAccess,
  uploadId: string,
): Promise<{ file: DriveFile; replaced: boolean }> {
  const storage = storageOrRefuse(deps);
  const upload = await deps.db.query.driveUploads.findFirst({
    where: and(eq(driveUploads.id, uploadId), eq(driveUploads.requestedBy, access.employeeId)),
  });
  if (!upload || upload.completedAt) throw new DriveError('not_found');
  const folder = await folderFor(deps, access, upload.folderId, 'write');
  const now = deps.now();
  if (upload.expiresAt <= now) {
    await storage.delete(upload.storageKey).catch(() => undefined);
    throw new DriveError('upload_expired');
  }
  const found = await storage.head(upload.storageKey);
  if (!found || found.size !== upload.byteSize) {
    if (found) await storage.delete(upload.storageKey).catch(() => undefined);
    throw new DriveError('upload_incomplete');
  }
  const checksum = found.etag ? `md5:${found.etag}` : null;

  const fileId = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(driveUploads)
      .set({ completedAt: now })
      .where(and(eq(driveUploads.id, upload.id), isNull(driveUploads.completedAt)))
      .returning({ id: driveUploads.id });
    if (!claimed) throw new DriveError('not_found');

    if (upload.replaceFileId) {
      const [current] = await tx
        .select()
        .from(driveFiles)
        .where(eq(driveFiles.id, upload.replaceFileId))
        .for('update');
      if (!current) throw new DriveError('not_found');
      // The file that was there becomes a version; the new bytes take its place.
      await tx.insert(driveFileVersions).values({
        fileId: current.id,
        version: current.version,
        mimeType: current.mimeType,
        byteSize: current.byteSize,
        storageKey: current.storageKey,
        checksum: current.checksum,
        replacedBy: access.employeeId,
        createdAt: current.updatedAt,
      });
      await tx
        .update(driveFiles)
        .set({
          mimeType: upload.mimeType,
          byteSize: upload.byteSize,
          storageKey: upload.storageKey,
          checksum,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(eq(driveFiles.id, current.id));
      return current.id;
    }
    const [made] = await tx
      .insert(driveFiles)
      .values({
        folderId: folder.id,
        name: upload.name,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        storageKey: upload.storageKey,
        ownerId: access.employeeId,
        clientId: folder.clientId,
        checksum,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: driveFiles.id });
    if (!made) throw new Error('failed to record file');
    return made.id;
  });
  return { file: await getFile(deps, access, fileId), replaced: upload.replaceFileId !== null };
}

// ---------------------------------------------------------------------------
// Files: changing
// ---------------------------------------------------------------------------

export async function updateFile(
  deps: DriveDeps,
  access: DriveAccess,
  id: string,
  changes: { name?: string; folderId?: string; tags?: string[] },
): Promise<{ file: DriveFile; movedFrom: string | null }> {
  const { file } = await fileFor(deps, access, id, 'write');
  if (file.trashedAt) throw new DriveError('not_found');
  const target =
    changes.folderId && changes.folderId !== file.folderId
      ? await folderFor(deps, access, changes.folderId, 'write')
      : null;
  const name = changes.name ?? file.name;
  if (target || changes.name !== undefined) {
    if (await nameTaken(deps.db, target?.id ?? file.folderId, name, file.id)) {
      throw new DriveError('name_taken');
    }
  }
  await deps.db
    .update(driveFiles)
    .set({
      name,
      ...(target ? { folderId: target.id, clientId: target.clientId } : {}),
      ...(changes.tags ? { tags: changes.tags } : {}),
      updatedAt: deps.now(),
    })
    .where(eq(driveFiles.id, file.id));
  // A media asset follows its file: moved under a client, it is that client's.
  if (target?.clientId) {
    await deps.db
      .update(mediaAssets)
      .set({ clientId: target.clientId })
      .where(eq(mediaAssets.driveFileId, file.id));
  }
  return { file: await getFile(deps, access, id), movedFrom: target ? file.folderId : null };
}

export async function trashFile(deps: DriveDeps, access: DriveAccess, id: string) {
  const { file } = await fileFor(deps, access, id, 'write');
  if (!file.trashedAt) {
    await deps.db
      .update(driveFiles)
      .set({ trashedAt: deps.now(), trashedBy: access.employeeId })
      .where(eq(driveFiles.id, file.id));
  }
  return getFile(deps, access, id);
}

export async function restoreFile(deps: DriveDeps, access: DriveAccess, id: string) {
  const { file } = await fileFor(deps, access, id, 'write');
  if (file.trashedAt) {
    // Its name may have been taken while it was away.
    const taken = await nameTaken(deps.db, file.folderId, file.name, file.id);
    const dot = file.name.lastIndexOf('.');
    const name = !taken
      ? file.name
      : dot > 0
        ? `${file.name.slice(0, dot)} (restaurado)${file.name.slice(dot)}`
        : `${file.name} (restaurado)`;
    await deps.db
      .update(driveFiles)
      .set({ trashedAt: null, trashedBy: null, name })
      .where(eq(driveFiles.id, file.id));
  }
  return getFile(deps, access, id);
}

/** Gone for good: every version leaves storage, then the rows go. */
async function purge(deps: DriveDeps, file: FileRow): Promise<void> {
  const storage = storageOrRefuse(deps);
  const versions = await deps.db
    .select({ key: driveFileVersions.storageKey })
    .from(driveFileVersions)
    .where(eq(driveFileVersions.fileId, file.id));
  for (const key of [file.storageKey, ...versions.map((version) => version.key)]) {
    await storage.delete(key);
  }
  // A media asset whose file is gone stays as a record and leaves the library.
  await deps.db
    .update(mediaAssets)
    .set({ storageKey: '' })
    .where(eq(mediaAssets.driveFileId, file.id));
  await deps.db.delete(driveFiles).where(eq(driveFiles.id, file.id));
}

export async function purgeFile(deps: DriveDeps, access: DriveAccess, id: string) {
  if (!access.manage) throw new DriveError('forbidden');
  const { file } = await fileFor(deps, access, id);
  if (!file.trashedAt) throw new DriveError('not_found');
  await purge(deps, file);
  return file;
}

/** Empties what has been in the trash for thirty days, and forgets uploads that never arrived. */
export async function purgeExpired(deps: DriveDeps): Promise<number> {
  if (!deps.storage) return 0;
  const now = deps.now();
  const old = await deps.db
    .select()
    .from(driveFiles)
    .where(lt(driveFiles.trashedAt, new Date(now.getTime() - DRIVE_TRASH_DAYS * DAY_MS)))
    .limit(200);
  for (const file of old) await purge(deps, file);

  const stale = await deps.db
    .select()
    .from(driveUploads)
    .where(
      and(
        isNull(driveUploads.completedAt),
        lt(driveUploads.expiresAt, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .limit(200);
  for (const upload of stale) {
    await deps.storage.delete(upload.storageKey).catch(() => undefined);
    await deps.db.delete(driveUploads).where(eq(driveUploads.id, upload.id));
  }
  return old.length;
}
