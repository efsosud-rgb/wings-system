import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  MEDIA_UPLOAD_TYPES,
  WINGS_CLIENT_ID,
  mediaAspectOf,
  type MediaAsset,
  type MediaKind,
  type MediaOrigin,
} from '@wings/shared';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { driveFiles, mediaAssets } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { createLocalStorage, type LocalStorage } from '../../lib/storage/local.js';
import { mediaFolderFor } from '../drive/folders.js';
import { newStorageKey } from '../drive/service.js';
import { readImageInfo } from '../ads/image-info.js';

/**
 * The media library is a view over the Drive: every asset is a Drive file in
 * Formatação/Marketing/Mídia, or in the "Mídia" of a client's folder there when
 * it was made for a client. The bytes live in the Drive's storage, under a key
 * the server made, and are read back only through an authenticated route or a
 * short pre-signed address.
 */

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

/** MEDIA_DIR, or a `media` folder inside the video volume. Null when neither is mounted. */
export function mediaDirOf(env: Pick<Env, 'MEDIA_DIR' | 'CREATIVE_VIDEO_DIR'>): string | null {
  if (env.MEDIA_DIR) return env.MEDIA_DIR;
  return env.CREATIVE_VIDEO_DIR ? join(env.CREATIVE_VIDEO_DIR, 'media') : null;
}

export interface InspectedMedia {
  kind: MediaKind;
  mimeType: (typeof MEDIA_UPLOAD_TYPES)[number];
  width: number | null;
  height: number | null;
}

/** What the bytes are, read from the bytes: a declared type or a file name proves nothing. */
export function inspectMedia(bytes: Buffer): InspectedMedia | null {
  const image = readImageInfo(bytes);
  if (image) {
    return {
      kind: 'image',
      mimeType: image.mimeType as InspectedMedia['mimeType'],
      width: image.width,
      height: image.height,
    };
  }
  // ISO base media (MP4): a box whose type, at byte 4, is `ftyp`.
  if (bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return { kind: 'video', mimeType: 'video/mp4', width: null, height: null };
  }
  return null;
}

export interface NewMedia {
  ownerId: string;
  origin: MediaOrigin;
  bytes: Buffer;
  prompt?: string | null;
  model?: string | null;
  credits?: number | null;
  externalGenerationId?: string | null;
  sourceAssetId?: string | null;
  durationSeconds?: number | null;
  /** Defaults to Wings Company, in the table itself. */
  clientId?: string;
  folder?: string | null;
  tags?: string[];
  now?: Date;
}

export type StoreFailure = 'unsupported_media';

/** Tests and scripts hand in a folder; the app hands in the environment's storage. */
const storageFrom = (where: string | ObjectStorage): ObjectStorage =>
  typeof where === 'string'
    ? createLocalStorage({ dir: where, publicApiBase: '', linkKey: Buffer.alloc(32) })
    : where;

export async function storeMedia(
  db: Database,
  where: string | ObjectStorage,
  input: NewMedia,
): Promise<{ ok: true; id: string } | { ok: false; reason: StoreFailure }> {
  const inspected = inspectMedia(input.bytes);
  if (!inspected) return { ok: false, reason: 'unsupported_media' };

  const now = input.now ?? new Date();
  const clientId = input.clientId ?? WINGS_CLIENT_ID;
  const folder =
    (await mediaFolderFor(db, clientId)) ?? (await mediaFolderFor(db, WINGS_CLIENT_ID));
  if (!folder) throw new Error('the Drive has no media folder: run the seed');

  // The key is ours; so is the name, which says what made the file and when.
  const storageKey = newStorageKey(now);
  await storageFrom(where).put(storageKey, input.bytes, inspected.mimeType);
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const made = input.origin === 'kairogen' ? (input.model ?? 'kairogen') : 'envio';
  const name = `${made}-${stamp}-${randomBytes(2).toString('hex')}.${EXTENSION[inspected.mimeType]}`;

  return db.transaction(async (tx) => {
    const [file] = await tx
      .insert(driveFiles)
      .values({
        folderId: folder.id,
        name,
        mimeType: inspected.mimeType,
        byteSize: input.bytes.length,
        storageKey,
        ownerId: input.ownerId,
        clientId: folder.clientId,
        tags: input.tags ?? [],
        checksum: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: driveFiles.id });
    if (!file) throw new Error('failed to record drive file');
    const [stored] = await tx
      .insert(mediaAssets)
      .values({
        ownerId: input.ownerId,
        origin: input.origin,
        kind: inspected.kind,
        mimeType: inspected.mimeType,
        byteSize: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        width: inspected.width,
        height: inspected.height,
        durationSeconds: input.durationSeconds ?? null,
        storageKey,
        driveFileId: file.id,
        prompt: input.prompt ?? null,
        model: input.model ?? null,
        credits: input.credits ?? null,
        externalGenerationId: input.externalGenerationId ?? null,
        sourceAssetId: input.sourceAssetId ?? null,
        clientId,
        folder: input.folder ?? null,
        tags: input.tags ?? [],
        createdAt: now,
      })
      .returning({ id: mediaAssets.id });
    if (!stored) throw new Error('failed to record media asset');
    return { ok: true as const, id: stored.id };
  });
}

/** An asset is in the library while its Drive file is neither in the trash nor gone. */
export const inLibrary = and(
  ne(mediaAssets.storageKey, ''),
  or(isNull(mediaAssets.driveFileId), isNull(driveFiles.trashedAt)),
);
export const libraryJoin = eq(driveFiles.id, mediaAssets.driveFileId);

/** The file of a stored asset, or null when it is gone or the key points outside the volume. */
export async function openMedia(mediaDir: string, storageKey: string, byteSize: number) {
  const root = resolve(mediaDir);
  const path = resolve(root, storageKey);
  if (!path.startsWith(root + sep)) return null;
  const info = await stat(path).catch(() => null);
  // A file whose size changed is not the file that was stored.
  if (!info?.isFile() || info.size !== byteSize) return null;
  return createReadStream(path);
}

export interface MediaSource {
  storage: ObjectStorage | null;
  /** Where assets lived before the Drive: read from until the migration script has run. */
  legacyDir: string | null;
}

type Stored = Pick<AssetRow, 'storageKey' | 'byteSize' | 'mimeType' | 'driveFileId'>;
const inBucket = (source: MediaSource, asset: Stored) =>
  source.storage?.kind === 's3' && asset.storageKey.startsWith('drive/');

/**
 * How a logged-in browser gets an asset: a short pre-signed address when it is
 * in the bucket, the bytes themselves when it is on the volume.
 */
export async function serveMedia(
  source: MediaSource,
  asset: Stored,
  options: { expiresSeconds: number },
): Promise<{ redirect: string } | { stream: NodeJS.ReadableStream } | null> {
  if (!asset.storageKey) return null;
  if (source.storage && inBucket(source, asset)) {
    return {
      redirect: await source.storage.presignGet(asset.storageKey, {
        expiresSeconds: options.expiresSeconds,
        disposition: 'inline',
        contentType: asset.mimeType,
      }),
    };
  }
  const dir =
    source.storage?.kind === 'local' ? (source.storage as LocalStorage).dir : source.legacyDir;
  const stream = dir ? await openMedia(dir, asset.storageKey, asset.byteSize) : null;
  return stream ? { stream } : null;
}

/** The whole asset in memory: for what the server itself has to read (the bridge to the builder). */
export async function readMedia(source: MediaSource, asset: Stored): Promise<Buffer | null> {
  if (!asset.storageKey) return null;
  const fromStorage =
    source.storage && (source.storage.kind === 'local' || inBucket(source, asset))
      ? await source.storage.get(asset.storageKey)
      : null;
  const bytes =
    fromStorage ??
    (source.legacyDir
      ? await readFile(join(source.legacyDir, asset.storageKey)).catch(() => null)
      : null);
  return bytes && bytes.length === asset.byteSize ? bytes : null;
}

type AssetRow = typeof mediaAssets.$inferSelect;

export function toMediaAsset(
  row: AssetRow,
  names: { owner: string | null; client: string | null },
): MediaAsset {
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    aspect: mediaAspectOf(row.width, row.height),
    durationSeconds: row.durationSeconds,
    prompt: row.prompt,
    model: row.model,
    credits: row.credits,
    clientId: row.clientId,
    client: names.client,
    folder: row.folder,
    tags: row.tags,
    ownerName: names.owner,
    createdAt: row.createdAt.toISOString(),
    downloadPath: `/media/assets/${row.id}/file`,
  };
}
