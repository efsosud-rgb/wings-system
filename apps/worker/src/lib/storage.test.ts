import { describe, expect, it } from 'vitest';
import { createS3Storage, StorageError } from './storage.js';

/**
 * No test here reaches a real bucket: `fetch` is played by a fake, exactly
 * as `apps/api/src/lib/storage/storage.test.ts` does for the API's own copy
 * of this signer.
 */
describe('the worker’s copy of the R2 client', () => {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const bucket: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method: init?.method ?? 'GET', url: url.toString(), headers });
    const key = decodeURIComponent(url.pathname.replace('/wings-files/', ''));
    if (key.includes('broken')) return new Response('<Error>secret detail</Error>', { status: 500 });
    if (init?.method === 'PUT') {
      objects.set(key, Buffer.from(init.body as Buffer));
      return new Response(null, { status: 200 });
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

  it('writes, measures and reads, signing every request and never sending the secret', async () => {
    await storage.put('drive/2026-09/a.mp4', Buffer.from('bytes'), 'video/mp4');
    expect(await storage.head('drive/2026-09/a.mp4')).toEqual({ size: 5, etag: 'abc123' });
    expect((await storage.get('drive/2026-09/a.mp4'))?.toString()).toBe('bytes');

    for (const call of calls) {
      expect(call.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKID\/20260921\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
      );
      expect(JSON.stringify(call)).not.toContain('very-secret-key');
    }
  });

  it('reports a failure by its status, without the key or the bucket’s words', async () => {
    const failure = await storage.head('drive/broken').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('storage head failed with status 500');
  });

  it('a missing object is null, not an error', async () => {
    expect(await storage.get('drive/2026-09/missing.mp4')).toBeNull();
    expect(await storage.head('drive/2026-09/missing.mp4')).toBeNull();
  });
});
