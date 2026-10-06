import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * The Drive's storage, read and written the same way `apps/api` does it
 * (`apps/api/src/lib/storage/s3.ts`): AWS Signature Version 4, by hand, no
 * SDK, R2's path-style addressing. Duplicated rather than imported because
 * the worker is a separate deployable and must not depend on `@wings/api`.
 * Only what a job needs is here: no presigning, because nobody outside the
 * server ever touches these bytes.
 */
export interface ObjectStorage {
  head(key: string): Promise<{ size: number; etag: string | null } | null>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Streams the object into `file` (never whole in memory); false when it does not exist. */
  download(key: string, file: string): Promise<boolean>;
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class StorageError extends Error {
  constructor(
    readonly status: number,
    verb: string,
  ) {
    // The status and the verb: never the key, the address or the response body.
    super(`storage ${verb} failed with status ${status}`);
    this.name = 'StorageError';
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function createS3Storage(options: S3Options): ObjectStorage {
  const region = options.region || 'auto';
  const base = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const pathOf = (key: string) =>
    `${base.pathname.replace(/\/$/, '')}/${encode(options.bucket)}/${key.split('/').map(encode).join('/')}`;

  function signingKey(day: string): Buffer {
    const date = hmac(`AWS4${options.secretAccessKey}`, day);
    return hmac(hmac(hmac(date, region), 's3'), 'aws4_request');
  }

  function sign(input: {
    method: string;
    key: string;
    headers: Record<string, string>;
    payloadHash: string;
    stamp: string;
  }): string {
    const day = input.stamp.slice(0, 8);
    const names = Object.keys(input.headers).sort();
    const canonical = [
      input.method,
      pathOf(input.key),
      '',
      names.map((name) => `${name}:${(input.headers[name] ?? '').trim()}\n`).join(''),
      names.join(';'),
      input.payloadHash,
    ].join('\n');
    const toSign = [
      'AWS4-HMAC-SHA256',
      input.stamp,
      `${day}/${region}/s3/aws4_request`,
      sha256(canonical),
    ].join('\n');
    return hmac(signingKey(day), toSign).toString('hex');
  }

  const stampOf = (date: Date) => date.toISOString().replace(/[-:]|\.\d{3}/g, '');

  async function request(
    method: 'GET' | 'HEAD' | 'PUT',
    key: string,
    body?: Buffer,
    contentType?: string,
    timeoutMs = 300_000,
  ): Promise<Response> {
    const stamp = stampOf(now());
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signature = sign({ method, key, headers, payloadHash, stamp });
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
    return doFetch(`${base.origin}${pathOf(key)}`, {
      method,
      body,
      headers: {
        ...sent,
        Authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${stamp.slice(0, 8)}/${region}/s3/aws4_request, SignedHeaders=${Object.keys(headers).sort().join(';')}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async head(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageError(response.status, 'head');
      return {
        size: Number(response.headers.get('content-length') ?? 0),
        etag: response.headers.get('etag')?.replace(/"/g, '') ?? null,
      };
    },
    async put(key, bytes, contentType) {
      const response = await request('PUT', key, bytes, contentType);
      if (!response.ok) throw new StorageError(response.status, 'put');
    },
    async get(key) {
      const response = await request('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageError(response.status, 'get');
      return Buffer.from(await response.arrayBuffer());
    },
    async download(key, file) {
      // A meeting recording can reach 1.5 GB: an hour to arrive, straight to disk.
      const response = await request('GET', key, undefined, undefined, 3_600_000);
      if (response.status === 404) return false;
      if (!response.ok || !response.body) throw new StorageError(response.status, 'get');
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(file),
      );
      return true;
    },
  };
}
