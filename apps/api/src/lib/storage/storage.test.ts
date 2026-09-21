import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition } from './index.js';
import { createLocalStorage, type LocalStorage } from './local.js';
import { createS3Storage, StorageError } from './s3.js';

/**
 * No test here reaches a bucket. The signer is checked against the example
 * AWS publishes; everything else talks to a `fetch` that plays the bucket.
 */

describe('AWS Signature Version 4', () => {
  it('signs the pre-signed GET of AWS’s own documentation to the byte', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const storage = createS3Storage({
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      bucket: 'examplebucket',
      virtualHost: true,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: () => new Date('2013-05-24T00:00:00Z'),
    });
    expect(storage.presign('GET', 'test.txt', 86400)).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('the R2 backend, against a bucket played by fetch', () => {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const bucket: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method: init?.method ?? 'GET', url: url.toString(), headers });
    const key = decodeURIComponent(url.pathname.replace('/wings-files/', ''));
    if (key.includes('broken'))
      return new Response('<Error>secret detail</Error>', { status: 500 });
    if (init?.method === 'PUT') {
      objects.set(key, Buffer.from(init.body as Buffer));
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const found = objects.get(key);
    if (!found) return new Response(null, { status: 404 });
    return new Response(init?.method === 'HEAD' ? null : new Uint8Array(found), {
      status: 200,
      headers: { 'content-length': String(found.length), etag: '"abc123"' },
    });
  };
  const storage = createS3Storage({
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'wings-files',
    accessKeyId: 'AKID',
    secretAccessKey: 'very-secret-key',
    fetch: bucket,
    now: () => new Date('2026-09-21T12:00:00Z'),
  });

  it('writes, measures, reads and deletes, signing every request and never sending the secret', async () => {
    await storage.put('drive/2026-09/a.png', Buffer.from('bytes'), 'image/png');
    expect(await storage.head('drive/2026-09/a.png')).toEqual({ size: 5, etag: 'abc123' });
    expect((await storage.get('drive/2026-09/a.png'))?.toString()).toBe('bytes');
    await storage.delete('drive/2026-09/a.png');
    expect(await storage.head('drive/2026-09/a.png')).toBeNull();
    expect(await storage.get('drive/2026-09/a.png')).toBeNull();

    expect(calls.map((call) => call.method)).toEqual([
      'PUT',
      'HEAD',
      'GET',
      'DELETE',
      'HEAD',
      'GET',
    ]);
    for (const call of calls) {
      expect(call.url).toMatch(
        /^https:\/\/account\.r2\.cloudflarestorage\.com\/wings-files\/drive\//,
      );
      expect(call.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKID\/20260921\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
      );
      expect(JSON.stringify(call)).not.toContain('very-secret-key');
    }
  });

  it('pre-signs an upload for one type and one exact size, and a download with its file name', async () => {
    const put = await storage.presignPut('drive/2026-09/b', {
      contentType: 'application/pdf',
      contentLength: 1234,
      expiresSeconds: 600,
    });
    const putUrl = new URL(put.url);
    expect(putUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(putUrl.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(put.headers).toEqual({ 'Content-Type': 'application/pdf' });
    // Another size is another signature: the address cannot be used for a bigger file.
    const bigger = await storage.presignPut('drive/2026-09/b', {
      contentType: 'application/pdf',
      contentLength: 9_999_999,
      expiresSeconds: 600,
    });
    expect(new URL(bigger.url).searchParams.get('X-Amz-Signature')).not.toBe(
      putUrl.searchParams.get('X-Amz-Signature'),
    );

    const get = new URL(
      await storage.presignGet('drive/2026-09/b', {
        expiresSeconds: 900,
        disposition: 'attachment',
        filename: 'Proposta São João.pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(get.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Proposta S_o Jo_o.pdf"; filename*=UTF-8''Proposta%20S%C3%A3o%20Jo%C3%A3o.pdf`,
    );
    expect(get.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(get.toString()).not.toContain('very-secret-key');
  });

  it('reports a failure by its status, without the key, the address or the bucket’s words', async () => {
    const failure = await storage.head('drive/broken').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('storage head failed with status 500');
  });
});

describe('the local backend', () => {
  let dir: string;
  let storage: LocalStorage;
  let clock = new Date('2026-09-21T12:00:00Z');
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wings-storage-'));
    storage = createLocalStorage({
      dir,
      publicApiBase: 'http://localhost:5173/api',
      linkKey: Buffer.alloc(32, 7),
      now: () => clock,
    });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('keeps files under its folder and nowhere else', async () => {
    await storage.put('drive/2026-09/c.txt', Buffer.from('hello'), 'text/plain');
    expect(await storage.head('drive/2026-09/c.txt')).toEqual({
      size: 5,
      etag: '5d41402abc4b2a76b9719d911017c592',
    });
    await expect(storage.put('../outside.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    expect(await storage.get('../../etc/passwd')).toBeNull();
    expect(await storage.head('/etc/passwd')).toBeNull();
  });

  it('hands out addresses that carry no path, do one thing, and stop working on time', async () => {
    const url = await storage.presignGet('drive/2026-09/c.txt', {
      expiresSeconds: 300,
      disposition: 'inline',
    });
    expect(url).toMatch(/^http:\/\/localhost:5173\/api\/drive\/blob\?t=[\w-]+\.[\w-]+$/);
    expect(url).not.toContain(dir);
    const token = url.split('?t=').pop() ?? '';
    expect(storage.open(token)).toMatchObject({ verb: 'GET', key: 'drive/2026-09/c.txt' });
    // A changed token, or the sixth minute: nothing.
    expect(storage.open(`${token.slice(0, -2)}AA`)).toBeNull();
    expect(storage.open(token.replace(/^[\w-]{4}/, 'AAAA'))).toBeNull();
    clock = new Date('2026-09-21T12:05:01Z');
    expect(storage.open(token)).toBeNull();
  });
});

describe('the name a download carries', () => {
  it('survives accents and cannot break out of the header', () => {
    expect(contentDisposition('inline')).toBe('inline');
    expect(contentDisposition('attachment', 'a"b\\c.pdf')).toBe(
      `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`,
    );
  });
});
