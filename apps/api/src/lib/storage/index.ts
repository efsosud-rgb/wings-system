import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { Env } from '../../env.js';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

/**
 * Where files live. Two backends behind one interface: an S3-compatible bucket
 * (Cloudflare R2) where the system runs for real, and a folder on the local
 * volume for development and tests.
 *
 * A key is a name WE make (`drive/2026-09/<uuid>`): never a person's file name,
 * never a path anybody typed. Keys stay on the server. What leaves it is a
 * pre-signed address: good for one object, one verb and a few minutes.
 */
export interface ObjectStorage {
  readonly kind: 's3' | 'local';
  /** An address the BROWSER sends the bytes to. It only takes this type and this exact size. */
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** An address that serves the object, as a download or to be shown in place. */
  presignGet(
    key: string,
    options: {
      expiresSeconds: number;
      disposition: 'inline' | 'attachment';
      filename?: string;
      contentType?: string;
    },
  ): Promise<string>;
  /** Null when there is no such object: an upload that never arrived. */
  head(key: string): Promise<{ size: number; etag: string | null } | null>;
  /** Server-side writes: what the system itself produces (Kairogen outputs, the migration). */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Server-side reads, for small objects only: the whole thing comes into memory. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** `attachment; filename*=UTF-8''…`, with a plain-ASCII fallback for old clients. */
export function contentDisposition(disposition: 'inline' | 'attachment', filename?: string) {
  if (!filename) return disposition;
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface StorageWings {
  env: Env;
  /** Set only by tests: the S3 backend never reaches a real bucket. */
  storageFetch?: typeof fetch;
  /** Set only by tests: a storage of their own. */
  storage?: ObjectStorage;
}

/**
 * The storage this environment is configured for, or null when it has none.
 * R2 when its four variables are set; otherwise the local volume.
 */
export function storageOf(wings: StorageWings): ObjectStorage | null {
  if (wings.storage) return wings.storage;
  const { env } = wings;
  if (env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return createS3Storage({
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      region: env.R2_REGION,
      fetch: wings.storageFetch,
    });
  }
  const dir =
    env.MEDIA_DIR ?? (env.CREATIVE_VIDEO_DIR ? join(env.CREATIVE_VIDEO_DIR, 'media') : null);
  if (!dir) return null;
  return createLocalStorage({
    dir,
    publicApiBase: `${env.APP_BASE_URL}/api`,
    // A key of its own, derived: signing file links never reuses the cookie secret as it is.
    linkKey: createHmac('sha256', env.SESSION_SECRET).update('wings-drive-local-link').digest(),
  });
}
