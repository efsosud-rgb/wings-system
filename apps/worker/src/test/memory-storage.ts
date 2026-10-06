import { writeFile } from 'node:fs/promises';
import type { ObjectStorage } from '../lib/storage.js';

/** An `ObjectStorage` backed by a `Map`, for job-handler tests: no bucket, no
 * volume, no network. */
export function createMemoryStorage(seed: Record<string, Buffer> = {}): ObjectStorage & {
  objects: Map<string, Buffer>;
} {
  const objects = new Map(Object.entries(seed));
  return {
    objects,
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, etag: null } : null;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async download(key, file) {
      const bytes = objects.get(key);
      if (!bytes) return false;
      await writeFile(file, bytes);
      return true;
    },
  };
}
