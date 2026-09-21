import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { contentDisposition, type ObjectStorage } from './index.js';

/**
 * The local volume, for development and tests. There is no bucket to pre-sign
 * for, so a "pre-signed address" here is a route of this API
 * (`/drive/blob?t=<token>`) carrying an HMAC over the key, the verb, the size and
 * the expiry: the same promise, kept by us. The key travels sealed inside the
 * token's signature check, never as a path in the address.
 */
export interface LocalStorageOptions {
  dir: string;
  publicApiBase: string;
  linkKey: Buffer;
  now?: () => Date;
}

export interface LocalGrant {
  verb: 'GET' | 'PUT';
  key: string;
  expiresAt: number;
  contentType: string | null;
  contentLength: number | null;
  disposition: string | null;
}

export interface LocalStorage extends ObjectStorage {
  readonly kind: 'local';
  /** What a token allows, or null when it is forged, altered or past its time. */
  open(token: string): LocalGrant | null;
  stream(key: string): Promise<{ stream: ReadStream; size: number } | null>;
  /** Writes what arrives at the blob route. More bytes than were promised, and the file is dropped. */
  receive(key: string, body: Readable, contentLength: number): Promise<boolean>;
}

export function createLocalStorage(options: LocalStorageOptions): LocalStorage {
  const root = resolve(options.dir);
  const now = options.now ?? (() => new Date());

  /** A key only ever names a file under the root: anything else is nothing. */
  function pathOf(key: string): string | null {
    const path = resolve(root, key);
    return path.startsWith(root + sep) ? path : null;
  }

  function seal(grant: LocalGrant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
    const mac = createHmac('sha256', options.linkKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  const storage: LocalStorage = {
    kind: 'local',
    open(token) {
      const [body, mac] = token.split('.');
      if (!body || !mac) return null;
      const expected = createHmac('sha256', options.linkKey).update(body).digest();
      const given = Buffer.from(mac, 'base64url');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const grant = JSON.parse(Buffer.from(body, 'base64url').toString()) as LocalGrant;
        return grant.expiresAt > now().getTime() ? grant : null;
      } catch {
        return null;
      }
    },
    async stream(key) {
      const path = pathOf(key);
      const info = path ? await stat(path).catch(() => null) : null;
      return path && info?.isFile() ? { stream: createReadStream(path), size: info.size } : null;
    },
    async receive(key, body, contentLength) {
      const path = pathOf(key);
      if (!path) return false;
      await mkdir(dirname(path), { recursive: true });
      let seen = 0;
      try {
        await pipeline(
          body,
          async function* (source) {
            for await (const chunk of source) {
              seen += (chunk as Buffer).length;
              if (seen > contentLength) throw new Error('too many bytes');
              yield chunk;
            }
          },
          createWriteStream(path),
        );
      } catch {
        await rm(path, { force: true });
        return false;
      }
      if (seen === contentLength) return true;
      await rm(path, { force: true });
      return false;
    },
    async presignPut(key, { contentType, contentLength, expiresSeconds }) {
      const token = seal({
        verb: 'PUT',
        key,
        expiresAt: now().getTime() + expiresSeconds * 1000,
        contentType,
        contentLength,
        disposition: null,
      });
      return {
        url: `${options.publicApiBase}/drive/blob?t=${token}`,
        headers: { 'Content-Type': contentType },
      };
    },
    async presignGet(key, { expiresSeconds, disposition, filename, contentType }) {
      const token = seal({
        verb: 'GET',
        key,
        expiresAt: now().getTime() + expiresSeconds * 1000,
        contentType: contentType ?? null,
        contentLength: null,
        disposition: contentDisposition(disposition, filename),
      });
      return `${options.publicApiBase}/drive/blob?t=${token}`;
    },
    async head(key) {
      const path = pathOf(key);
      const info = path ? await stat(path).catch(() => null) : null;
      if (!path || !info?.isFile()) return null;
      const md5 = createHash('md5');
      for await (const chunk of createReadStream(path)) md5.update(chunk as Buffer);
      return { size: info.size, etag: md5.digest('hex') };
    },
    async put(key, bytes) {
      const path = pathOf(key);
      if (!path) throw new Error('invalid storage key');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      const path = pathOf(key);
      return path ? readFile(path).catch(() => null) : null;
    },
    async delete(key) {
      const path = pathOf(key);
      if (path) await rm(path, { force: true });
    },
  };
  return storage;
}
