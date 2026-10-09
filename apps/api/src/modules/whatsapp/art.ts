import { createHash, randomUUID } from 'node:crypto';
import {
  WA_ART_REFUSALS,
  waArtRefusal,
  type DriveUploadTicket,
  type WaArtRefusal,
  type WaArtUpload,
} from '@wings/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, driveFiles, driveUploads, waMediaUploads } from '../../db/schema/index.js';
import { readImageHeader } from '../../lib/image-header.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { mediaFolderFor } from '../drive/folders.js';
import { newStorageKey } from '../drive/service.js';
import { uploadWhatsAppMedia, type WhatsAppConfig } from './graph.js';

/**
 * The art at the head of the WhatsApp templates (docs/whatsapp/arte-modelos.md).
 * A brand's art is a file of its own Mídia folder in the Drive; the Wings art,
 * of Formatação/Marketing/Mídia, kept on the Wings Company record. The browser
 * sends the bytes straight to storage; the server then reads them and keeps
 * the file only when it is a PNG or JPEG of 1125 × 600 and up to 2 MB, by its
 * content, never by its name. Meta gets the art once per number and the id is
 * kept (`wa_media_uploads`).
 */

const UPLOAD_TTL_SECONDS = 15 * 60;
const LINK_TTL_SECONDS = 5 * 60;
/** Meta keeps an uploaded file 30 days; ours goes up again after 25. */
export const ART_MEDIA_FRESH_MS = 25 * 24 * 3_600_000;

/**
 * Meta's answers to a send that point at the file (the id is gone or
 * unreadable): the id is dropped and the next send uploads the art again.
 * A wrong guess costs one upload.
 */
export const ART_MEDIA_GONE_CODES: ReadonlySet<number> = new Set([100, 131009, 131052, 131053]);

export type ArtFile = typeof driveFiles.$inferSelect;

export interface ArtDeps {
  db: Database;
  storage: ObjectStorage | null;
  now: () => Date;
}

export type ArtErrorCode =
  | 'storage_unavailable'
  | 'not_found'
  | 'no_folder'
  | 'upload_expired'
  | 'upload_incomplete'
  | 'refused';

export class ArtError extends Error {
  constructor(
    readonly code: ArtErrorCode,
    readonly reason: WaArtRefusal | null = null,
  ) {
    super(reason ? WA_ART_REFUSALS[reason] : code);
    this.name = 'ArtError';
  }
}

const storageOrRefuse = (deps: ArtDeps) => {
  if (!deps.storage) throw new ArtError('storage_unavailable');
  return deps.storage;
};

/** The art registered for a client (Wings Company: the Wings art), while its file is out of the trash. */
export async function artFileOf(db: Database, clientId: string): Promise<ArtFile | null> {
  const [row] = await db
    .select({ file: driveFiles })
    .from(clients)
    .innerJoin(driveFiles, eq(driveFiles.id, clients.whatsappArtFileId))
    .where(and(eq(clients.id, clientId), isNull(driveFiles.trashedAt)));
  return row?.file ?? null;
}

/**
 * What a file is, read from its bytes: the refusal (type, size, dimensions,
 * a content that is not what it says), or null when it can be the art.
 */
export function inspectArt(bytes: Buffer, declared: string | null): WaArtRefusal | null {
  const header = readImageHeader(bytes);
  if (!header) return declared && /^image\/(png|jpeg)$/.test(declared) ? 'unreadable' : 'type';
  if (declared && header.type !== declared) return 'mismatch';
  return waArtRefusal({
    type: header.type,
    byteSize: bytes.length,
    width: header.width,
    height: header.height,
  });
}

/** Step one: an address that takes exactly this file, into the client's Mídia folder. */
export async function requestArtUpload(
  deps: ArtDeps,
  employeeId: string,
  clientId: string,
  input: WaArtUpload,
): Promise<DriveUploadTicket> {
  const storage = storageOrRefuse(deps);
  const folder = await mediaFolderFor(deps.db, clientId);
  if (!folder) throw new ArtError('no_folder');
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
  const [row] = await deps.db
    .insert(driveUploads)
    .values({
      folderId: folder.id,
      name: artFileName(input.mimeType, now),
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      storageKey: newStorageKey(now),
      requestedBy: employeeId,
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

const artFileName = (mimeType: string, now: Date) =>
  `Arte do WhatsApp ${now.toISOString().slice(0, 10)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;

/**
 * Step two: the server reads what arrived. A file that is not the art is
 * deleted from storage and refused with the reason; a good one becomes a
 * Drive file and the client's art. The art it replaces stays in the Drive.
 */
export async function completeArtUpload(
  deps: ArtDeps,
  employeeId: string,
  clientId: string,
  uploadId: string,
): Promise<{ fileId: string; previousFileId: string | null }> {
  const storage = storageOrRefuse(deps);
  const upload = await deps.db.query.driveUploads.findFirst({
    where: and(
      eq(driveUploads.id, uploadId),
      eq(driveUploads.requestedBy, employeeId),
      isNull(driveUploads.completedAt),
    ),
  });
  const folder = await mediaFolderFor(deps.db, clientId);
  // Only an upload asked for this client's art: never a Drive upload of another folder.
  if (!upload || !folder || upload.folderId !== folder.id || upload.replaceFileId)
    throw new ArtError('not_found');
  const now = deps.now();
  const claim = async (tx: Pick<Database, 'update'>) => {
    const [claimed] = await tx
      .update(driveUploads)
      .set({ completedAt: now })
      .where(and(eq(driveUploads.id, upload.id), isNull(driveUploads.completedAt)))
      .returning({ id: driveUploads.id });
    return Boolean(claimed);
  };
  if (upload.expiresAt <= now) {
    await storage.delete(upload.storageKey).catch(() => undefined);
    await claim(deps.db);
    throw new ArtError('upload_expired');
  }
  const found = await storage.head(upload.storageKey);
  if (!found || found.size !== upload.byteSize) {
    if (found) await storage.delete(upload.storageKey).catch(() => undefined);
    throw new ArtError('upload_incomplete');
  }
  const bytes = await storage.get(upload.storageKey);
  if (!bytes || bytes.length !== upload.byteSize) throw new ArtError('upload_incomplete');
  const refused = inspectArt(bytes, upload.mimeType);
  if (refused) {
    await storage.delete(upload.storageKey).catch(() => undefined);
    await claim(deps.db);
    throw new ArtError('refused', refused);
  }
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return deps.db.transaction(async (tx) => {
    if (!(await claim(tx))) throw new ArtError('not_found');
    const name = await freeName(tx, folder.id, upload.name);
    const [made] = await tx
      .insert(driveFiles)
      .values({
        folderId: folder.id,
        name,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        storageKey: upload.storageKey,
        ownerId: employeeId,
        clientId: folder.clientId,
        checksum,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: driveFiles.id });
    if (!made) throw new Error('failed to record file');
    const [current] = await tx
      .select({ fileId: clients.whatsappArtFileId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .for('update');
    await tx
      .update(clients)
      .set({ whatsappArtFileId: made.id, whatsappArtSetAt: now })
      .where(eq(clients.id, clientId));
    return { fileId: made.id, previousFileId: current?.fileId ?? null };
  });
}

/** "Arte do WhatsApp 2026-10-09.png", or "… (2).png" when the folder has one already. */
async function freeName(tx: Pick<Database, 'select'>, folderId: string, name: string) {
  const dot = name.lastIndexOf('.');
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
    const [hit] = await tx
      .select({ id: driveFiles.id })
      .from(driveFiles)
      .where(
        and(
          eq(driveFiles.folderId, folderId),
          isNull(driveFiles.trashedAt),
          sql`lower(${driveFiles.name}) = lower(${candidate})`,
        ),
      )
      .limit(1);
    if (!hit) return candidate;
  }
  return `${name.slice(0, dot)} ${randomUUID().slice(0, 8)}${name.slice(dot)}`;
}

/** The client goes without art; the file stays in the Drive. Returns the art it had. */
export async function clearArt(db: Database, clientId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ fileId: clients.whatsappArtFileId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .for('update');
    await tx
      .update(clients)
      .set({ whatsappArtFileId: null, whatsappArtSetAt: null })
      .where(eq(clients.id, clientId));
    return current?.fileId ?? null;
  });
}

/** An address that shows the art for 5 minutes. The caller checked who asks and writes the audit. */
export async function artLink(deps: ArtDeps, file: ArtFile) {
  const storage = storageOrRefuse(deps);
  const url = await storage.presignGet(file.storageKey, {
    expiresSeconds: LINK_TTL_SECONDS,
    disposition: 'inline',
    filename: file.name,
    contentType: file.mimeType,
  });
  return {
    fileId: file.id,
    url,
    expiresAt: new Date(deps.now().getTime() + LINK_TTL_SECONDS * 1000).toISOString(),
  };
}

// --- the art on Meta -------------------------------------------------------------------------

export type ArtMedia =
  | { ok: true; mediaId: string; uploaded: boolean }
  | { ok: false; why: 'storage' | 'refused' | 'meta'; code: number | null };

/**
 * The Meta media id of the art for this number: the one kept while it is
 * younger than 25 days, of the same file version and not refused by Meta;
 * otherwise the art goes up again now (an upload sends nothing to anybody).
 */
export async function artMediaId(
  deps: ArtDeps & { fetchImpl: typeof fetch; config: WhatsAppConfig },
  file: ArtFile,
): Promise<ArtMedia> {
  const { db, config } = deps;
  const now = deps.now();
  const kept = await db.query.waMediaUploads.findFirst({
    where: and(
      eq(waMediaUploads.driveFileId, file.id),
      eq(waMediaUploads.phoneNumberId, config.phoneNumberId),
    ),
  });
  if (
    kept &&
    kept.invalidAt === null &&
    kept.fileVersion === file.version &&
    now.getTime() - kept.uploadedAt.getTime() < ART_MEDIA_FRESH_MS
  )
    return { ok: true, mediaId: kept.mediaId, uploaded: false };

  const bytes = deps.storage ? await deps.storage.get(file.storageKey).catch(() => null) : null;
  if (!bytes) return { ok: false, why: 'storage', code: null };
  // The bytes are read again before they leave: only an art that passes the rule goes.
  if (inspectArt(bytes, file.mimeType)) return { ok: false, why: 'refused', code: null };
  const sent = await uploadWhatsAppMedia(deps.fetchImpl, config, {
    bytes,
    mimeType: file.mimeType,
    filename: `arte.${file.mimeType === 'image/png' ? 'png' : 'jpg'}`,
  });
  if (!sent.ok) return { ok: false, why: 'meta', code: sent.code };
  await db
    .insert(waMediaUploads)
    .values({
      driveFileId: file.id,
      fileVersion: file.version,
      phoneNumberId: config.phoneNumberId,
      mediaId: sent.data.id,
      uploadedAt: now,
    })
    .onConflictDoUpdate({
      target: [waMediaUploads.tenantId, waMediaUploads.driveFileId, waMediaUploads.phoneNumberId],
      set: {
        fileVersion: file.version,
        mediaId: sent.data.id,
        uploadedAt: now,
        invalidAt: null,
      },
    });
  return { ok: true, mediaId: sent.data.id, uploaded: true };
}

/** Meta said the file behind this id is gone: the next send uploads the art again. */
export async function invalidateArtMedia(db: Database, mediaId: string, at: Date) {
  await db
    .update(waMediaUploads)
    .set({ invalidAt: at })
    .where(and(eq(waMediaUploads.mediaId, mediaId), isNull(waMediaUploads.invalidAt)));
}
