import { createHash, createHmac } from 'node:crypto';
import { contentDisposition, type ObjectStorage } from './index.js';

/**
 * An S3-compatible bucket, spoken to with AWS Signature Version 4 and nothing
 * else: no SDK, because all this needs is four verbs and two kinds of
 * pre-signed address. Path-style (`endpoint/bucket/key`), which is what
 * Cloudflare R2 documents; its region is always `auto`.
 *
 * The secret key signs and is never sent, logged or put in an error.
 */
export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** The bucket is already in the endpoint's host name (`bucket.host`), not in the path. */
  virtualHost?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986: everything but unreserved characters, which is stricter than encodeURIComponent. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

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

export interface S3Storage extends ObjectStorage {
  /** The bare pre-signer, exposed so the signature can be checked against AWS's published example. */
  presign(
    method: 'GET' | 'PUT',
    key: string,
    expiresSeconds: number,
    signedHeaders?: Record<string, string>,
    extraQuery?: Record<string, string>,
  ): string;
}

export function createS3Storage(options: S3Options): S3Storage {
  const region = options.region || 'auto';
  const base = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const pathOf = (key: string) =>
    `${base.pathname.replace(/\/$/, '')}${options.virtualHost ? '' : `/${encode(options.bucket)}`}/${key.split('/').map(encode).join('/')}`;

  function signingKey(day: string): Buffer {
    const date = hmac(`AWS4${options.secretAccessKey}`, day);
    return hmac(hmac(hmac(date, region), 's3'), 'aws4_request');
  }

  function sign(input: {
    method: string;
    key: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    payloadHash: string;
    stamp: string;
  }): string {
    const day = input.stamp.slice(0, 8);
    const names = Object.keys(input.headers).sort();
    const canonical = [
      input.method,
      pathOf(input.key),
      Object.keys(input.query)
        .sort()
        .map((name) => `${encode(name)}=${encode(input.query[name] ?? '')}`)
        .join('&'),
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

  /** An address with the signature in its query: whoever holds it may do this one thing. */
  function presign(
    method: 'GET' | 'PUT',
    key: string,
    expiresSeconds: number,
    signedHeaders: Record<string, string> = {},
    extraQuery: Record<string, string> = {},
  ): string {
    const stamp = stampOf(now());
    const headers = { host: base.host, ...signedHeaders };
    const query: Record<string, string> = {
      ...extraQuery,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${options.accessKeyId}/${stamp.slice(0, 8)}/${region}/s3/aws4_request`,
      'X-Amz-Date': stamp,
      'X-Amz-Expires': String(Math.max(1, Math.min(expiresSeconds, 7 * 24 * 3600))),
      'X-Amz-SignedHeaders': Object.keys(headers).sort().join(';'),
    };
    const signature = sign({ method, key, query, headers, payloadHash: 'UNSIGNED-PAYLOAD', stamp });
    const text = Object.keys(query)
      .sort()
      .map((name) => `${encode(name)}=${encode(query[name] ?? '')}`)
      .join('&');
    return `${base.origin}${pathOf(key)}?${text}&X-Amz-Signature=${signature}`;
  }

  /** A request the server makes itself, signed in its headers. */
  async function request(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const stamp = stampOf(now());
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signature = sign({ method, key, query: {}, headers, payloadHash, stamp });
    // `fetch` sets Host by itself; it is signed, not sent by hand.
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
    return doFetch(`${base.origin}${pathOf(key)}`, {
      method,
      body,
      headers: {
        ...sent,
        Authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${stamp.slice(0, 8)}/${region}/s3/aws4_request, SignedHeaders=${Object.keys(headers).sort().join(';')}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(120_000),
    });
  }

  return {
    kind: 's3',
    presign,
    async presignPut(key, { contentType, contentLength, expiresSeconds }) {
      // Both are signed: the address takes this type and this many bytes, and nothing else.
      const headers = { 'content-length': String(contentLength), 'content-type': contentType };
      return {
        url: presign('PUT', key, expiresSeconds, headers),
        // The browser sets Content-Length by itself, from the file.
        headers: { 'Content-Type': contentType },
      };
    },
    async presignGet(key, { expiresSeconds, disposition, filename, contentType }) {
      return presign(
        'GET',
        key,
        expiresSeconds,
        {},
        {
          'response-content-disposition': contentDisposition(disposition, filename),
          ...(contentType ? { 'response-content-type': contentType } : {}),
        },
      );
    },
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
    async delete(key) {
      const response = await request('DELETE', key);
      if (!response.ok && response.status !== 404)
        throw new StorageError(response.status, 'delete');
    },
  };
}
