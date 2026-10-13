import { DRIVE_NAME_MAX, type DriveUploadTicket, type LeadFile } from '@wings/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  driveFiles,
  driveFolders,
  employees,
  leadEvents,
  leadFiles,
} from '../../db/schema/index.js';
import type { DriveAccess } from '../drive/access.js';
import {
  DriveError,
  completeUpload,
  createFolder,
  requestUpload,
  type DriveDeps,
} from '../drive/service.js';

/**
 * Files of a deal (ficha do cliente, Etapa 3). They live in the Drive, under
 * Comercial / Negociações / <nome da negociação>, and `lead_files` says which
 * file belongs to which deal. The Drive keeps deciding who opens a file (the
 * department of the folder, on the server); this module only adds the link.
 * Nothing here logs a file name: audit rows carry ids.
 */

const DEALS_FOLDER = 'Negociações';

export async function listLeadFiles(db: Database, leadId: string): Promise<LeadFile[]> {
  const rows = await db
    .select({
      id: leadFiles.id,
      createdAt: leadFiles.createdAt,
      addedByName: employees.fullName,
      file: driveFiles,
    })
    .from(leadFiles)
    .innerJoin(driveFiles, eq(driveFiles.id, leadFiles.driveFileId))
    .leftJoin(employees, eq(employees.id, leadFiles.addedBy))
    .where(and(eq(leadFiles.leadId, leadId), isNull(driveFiles.trashedAt)))
    .orderBy(desc(leadFiles.createdAt));
  return rows.map((row) => ({
    id: row.id,
    fileId: row.file.id,
    name: row.file.name,
    mimeType: row.file.mimeType,
    byteSize: row.file.byteSize,
    version: row.file.version,
    addedByName: row.addedByName ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Whether the file is one of the deal's own (linked to it and not in the trash). */
export async function leadHasFile(
  db: Database,
  leadId: string,
  driveFileId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: leadFiles.id })
    .from(leadFiles)
    .innerJoin(driveFiles, eq(driveFiles.id, leadFiles.driveFileId))
    .where(
      and(
        eq(leadFiles.leadId, leadId),
        eq(leadFiles.driveFileId, driveFileId),
        isNull(driveFiles.trashedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A folder name the Drive accepts: no separators, no control characters, within the limit. */
export const folderNameFor = (leadName: string | null) => {
  const clean = (leadName ?? '')
    .replace(/[\\/\p{Cc}]/gu, '-')
    .trim()
    .slice(0, DRIVE_NAME_MAX - 6)
    .trim();
  return clean.length > 0 && clean !== '.' && clean !== '..' ? clean : 'Negociação';
};

async function childNamed(db: Database, parentId: string, name: string) {
  return db.query.driveFolders.findFirst({
    where: and(
      eq(driveFolders.parentId, parentId),
      sql`lower(${driveFolders.name}) = lower(${name})`,
    ),
  });
}

/**
 * The deal's folder: the one its files already sit in, else a new one under
 * Comercial / Negociações, named after the deal (with " (2)", " (3)"… when
 * another deal of the same name already has one).
 */
export async function folderOfLead(
  deps: DriveDeps,
  access: DriveAccess,
  lead: { id: string; name: string | null },
) {
  const [existing] = await deps.db
    .select({ folderId: driveFiles.folderId })
    .from(leadFiles)
    .innerJoin(driveFiles, eq(driveFiles.id, leadFiles.driveFileId))
    .where(eq(leadFiles.leadId, lead.id))
    .orderBy(desc(leadFiles.createdAt))
    .limit(1);
  if (existing) {
    const folder = await deps.db.query.driveFolders.findFirst({
      where: eq(driveFolders.id, existing.folderId),
    });
    if (folder) return folder;
  }
  const root = await deps.db.query.driveFolders.findFirst({
    where: and(isNull(driveFolders.parentId), eq(driveFolders.department, 'comercial')),
  });
  if (!root) throw new DriveError('not_found');
  const deals =
    (await childNamed(deps.db, root.id, DEALS_FOLDER)) ??
    (await createFolder(deps, access, { parentId: root.id, name: DEALS_FOLDER }));
  const base = folderNameFor(lead.name);
  for (let n = 1; n < 100; n += 1) {
    const name = n === 1 ? base : `${base} (${n})`;
    if (await childNamed(deps.db, deals.id, name)) continue;
    return createFolder(deps, access, { parentId: deals.id, name });
  }
  throw new DriveError('name_taken');
}

export async function requestLeadUpload(
  deps: DriveDeps,
  access: DriveAccess,
  lead: { id: string; name: string | null },
  file: { name: string; mimeType: string; byteSize: number },
): Promise<DriveUploadTicket> {
  const folder = await folderOfLead(deps, access, lead);
  return requestUpload(deps, access, { ...file, folderId: folder.id });
}

/** Confirms the upload with the Drive and links the file to the deal; one timeline event by id. */
export async function completeLeadUpload(
  deps: DriveDeps,
  access: DriveAccess,
  leadId: string,
  uploadId: string,
): Promise<LeadFile> {
  const { file } = await completeUpload(deps, access, uploadId);
  return attachFile(deps.db, { leadId, driveFileId: file.id, actorEmployeeId: access.employeeId });
}

export async function attachFile(
  db: Database,
  input: { leadId: string; driveFileId: string; actorEmployeeId: string },
): Promise<LeadFile> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leadFiles)
      .values({
        leadId: input.leadId,
        driveFileId: input.driveFileId,
        addedBy: input.actorEmployeeId,
      })
      .onConflictDoNothing()
      .returning({ id: leadFiles.id });
    if (row) {
      await tx.insert(leadEvents).values({
        leadId: input.leadId,
        kind: 'lead.file_added',
        actorEmployeeId: input.actorEmployeeId,
        detail: { fileId: input.driveFileId },
      });
    }
  });
  const files = await listLeadFiles(db, input.leadId);
  const linked = files.find((file) => file.fileId === input.driveFileId);
  if (!linked) throw new DriveError('not_found');
  return linked;
}

/** Unlinks the file from the deal; the file stays in the Drive. */
export async function detachFile(
  db: Database,
  input: { leadId: string; driveFileId: string; actorEmployeeId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(leadFiles)
      .where(and(eq(leadFiles.leadId, input.leadId), eq(leadFiles.driveFileId, input.driveFileId)))
      .returning({ id: leadFiles.id });
    if (removed.length === 0) return false;
    await tx.insert(leadEvents).values({
      leadId: input.leadId,
      kind: 'lead.file_removed',
      actorEmployeeId: input.actorEmployeeId,
      detail: { fileId: input.driveFileId },
    });
    return true;
  });
}
