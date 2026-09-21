import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { driveFiles, mediaAssets } from '../db/schema/index.js';
import { loadEnv } from '../env.js';
import { storageOf, type ObjectStorage } from '../lib/storage/index.js';
import { mediaFolderFor } from '../modules/drive/folders.js';
import { mediaDirOf } from '../modules/media/library.js';

/**
 * Moves the media library from the volume into the Drive.
 *
 * For every asset without a Drive file: reads its bytes from MEDIA_DIR, puts
 * them in the Drive's storage under `drive/media/<asset id>`, makes the Drive
 * file in the right "Mídia" folder and points the asset at it. For every asset
 * that already has one: makes sure the object is in the storage in use, so the
 * script also carries files over when an environment goes from the volume to R2.
 *
 * It can run any number of times: the key is derived from the asset, an object
 * already there is not sent again, and an asset already linked is not linked
 * twice. Nothing on the volume is deleted. It prints counts and ids, never a
 * name, a key or a path.
 */
export interface MigrationResult {
  linked: number;
  copied: number;
  alreadyDone: number;
  missing: string[];
}

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

export async function migrateMediaToDrive(
  db: Database,
  storage: ObjectStorage,
  volume: string | null,
): Promise<MigrationResult> {
  const result: MigrationResult = { linked: 0, copied: 0, alreadyDone: 0, missing: [] };
  const fromVolume = (key: string) =>
    volume ? readFile(join(volume, key)).catch(() => null) : Promise.resolve(null);

  const unlinked = await db.select().from(mediaAssets).where(isNull(mediaAssets.driveFileId));
  for (const asset of unlinked) {
    if (!asset.storageKey) continue;
    const key = `drive/media/${asset.id}`;
    const bytes = await fromVolume(asset.storageKey);
    if (!(await storage.head(key))) {
      if (!bytes || bytes.length !== asset.byteSize) {
        result.missing.push(asset.id);
        continue;
      }
      await storage.put(key, bytes, asset.mimeType);
      result.copied += 1;
    }
    const folder =
      (await mediaFolderFor(db, asset.clientId)) ?? (await mediaFolderFor(db, WINGS_CLIENT_ID));
    if (!folder) throw new Error('the Drive has no media folder: run the seed first');
    await db.transaction(async (tx) => {
      const [file] = await tx
        .insert(driveFiles)
        .values({
          folderId: folder.id,
          name: `${asset.origin === 'kairogen' ? (asset.model ?? 'kairogen') : 'envio'}-${asset.id.slice(0, 8)}.${EXTENSION[asset.mimeType] ?? 'bin'}`,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          storageKey: key,
          ownerId: asset.ownerId,
          clientId: folder.clientId,
          tags: asset.tags,
          checksum: bytes
            ? `sha256:${createHash('sha256').update(bytes).digest('hex')}`
            : `sha256:${asset.sha256}`,
          createdAt: asset.createdAt,
          updatedAt: asset.createdAt,
        })
        .returning({ id: driveFiles.id });
      if (!file) throw new Error('failed to record drive file');
      await tx
        .update(mediaAssets)
        .set({ driveFileId: file.id, storageKey: key })
        .where(eq(mediaAssets.id, asset.id));
    });
    result.linked += 1;
  }

  // Already in the Drive, but is the object in THIS storage? (volume first, R2 later)
  const linked = await db.select().from(mediaAssets).where(isNotNull(mediaAssets.driveFileId));
  for (const asset of linked) {
    if (!asset.storageKey || unlinked.some((item) => item.id === asset.id)) continue;
    if (await storage.head(asset.storageKey)) {
      result.alreadyDone += 1;
      continue;
    }
    const bytes = await fromVolume(asset.storageKey);
    if (!bytes || bytes.length !== asset.byteSize) {
      result.missing.push(asset.id);
      continue;
    }
    await storage.put(asset.storageKey, bytes, asset.mimeType);
    result.copied += 1;
  }
  return result;
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const storage = storageOf({ env });
  if (!storage) throw new Error('no storage configured: set the R2 variables or MEDIA_DIR');
  const { db, pool } = createDb(env.DATABASE_URL);
  const result = await migrateMediaToDrive(db, storage, mediaDirOf(env));
  await pool.end();
  console.warn(
    `media to drive (${storage.kind}): linked ${result.linked}, copied ${result.copied}, already done ${result.alreadyDone}, missing ${result.missing.length}`,
  );
  for (const id of result.missing) console.warn(`missing on the volume: asset ${id}`);
}

if (/migrate-media-to-drive\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration failed');
    process.exit(1);
  });
}
