import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  MEDIA_UPLOAD_TYPES,
  mediaAspectOf,
  type MediaAsset,
  type MediaKind,
  type MediaOrigin,
} from '@wings/shared';
import type { Database } from '../../db/client.js';
import { mediaAssets } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { readImageInfo } from '../ads/image-info.js';

/**
 * The media library's files: written once under MEDIA_DIR, named by the server,
 * read back only through an authenticated route.
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

export async function storeMedia(
  db: Database,
  mediaDir: string,
  input: NewMedia,
): Promise<{ ok: true; id: string } | { ok: false; reason: StoreFailure }> {
  const inspected = inspectMedia(input.bytes);
  if (!inspected) return { ok: false, reason: 'unsupported_media' };

  const now = input.now ?? new Date();
  const month = now.toISOString().slice(0, 7);
  // Year-month folders keep any one directory small; the name is ours, never the uploader's.
  const storageKey = `${month}/${randomUUID()}.${EXTENSION[inspected.mimeType]}`;
  const path = join(mediaDir, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.bytes, { flag: 'wx' });

  const [stored] = await db
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
      prompt: input.prompt ?? null,
      model: input.model ?? null,
      credits: input.credits ?? null,
      externalGenerationId: input.externalGenerationId ?? null,
      sourceAssetId: input.sourceAssetId ?? null,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      createdAt: now,
    })
    .returning({ id: mediaAssets.id });
  if (!stored) throw new Error('failed to record media asset');
  return { ok: true, id: stored.id };
}

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
