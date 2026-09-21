import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, mediaAspectOf, type MediaAsset } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { mediaAssets } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { mediaDirOf, storeMedia } from './library.js';

/** The media library: files on a volume, rows in the database, a login in between. */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let mediaDir: string;

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    ...extra,
  });

/** The smallest thing the header reader accepts as a PNG of the given size. */
function pngOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33 + 8);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  randomBytes(8).copy(bytes, 33);
  return bytes;
}
function mp4(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftypisom', 4, 'latin1');
  return bytes;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  mediaDir = await mkdtemp(join(tmpdir(), 'wings-media-'));
  app = await buildApp({ env: env({ MEDIA_DIR: mediaDir }), db });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(mediaDir, { recursive: true, force: true });
});

async function sessionFor(role: 'marketing' | 'vendedor_expansao', on = app) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'comercial',
  });
  const login = await on.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const upload = (cookies: Record<string, string>, body: Buffer, type: string) =>
  app.inject({
    method: 'POST',
    url: '/media/assets',
    cookies,
    headers: { 'content-type': type },
    payload: body,
  });

describe('the media library', () => {
  it('stores an upload on the volume under a name of its own, and serves it back to a login', async () => {
    const { cookies } = await sessionFor('marketing');
    const bytes = pngOf(1080, 1350);
    // Declared as JPEG: what the file is comes from the bytes.
    const created = await upload(cookies, bytes, 'image/jpeg');
    expect(created.statusCode).toBe(201);
    const { asset } = created.json<{ asset: MediaAsset }>();
    expect(asset).toMatchObject({
      kind: 'image',
      origin: 'upload',
      mimeType: 'image/png',
      width: 1080,
      height: 1350,
      aspect: '4:5',
      downloadPath: `/media/assets/${asset.id}/file`,
    });

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(row?.storageKey).toMatch(/^\d{4}-\d{2}\/[0-9a-f-]{36}\.png$/);
    const [month] = await readdir(mediaDir);
    expect(await readdir(join(mediaDir, month ?? ''))).toHaveLength(1);

    const file = await app.inject({ url: asset.downloadPath, cookies });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toBe('private, max-age=3600');
    expect(file.rawPayload.equals(bytes)).toBe(true);
  });

  it('serves no file without a login or without the permission', async () => {
    const { cookies } = await sessionFor('marketing');
    const { asset } = (await upload(cookies, pngOf(1080, 1080), 'image/png')).json<{
      asset: MediaAsset;
    }>();
    expect((await app.inject({ url: asset.downloadPath })).statusCode).toBe(401);
    const seller = await sessionFor('vendedor_expansao');
    expect(
      (await app.inject({ url: asset.downloadPath, cookies: seller.cookies })).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/media/assets', cookies: seller.cookies })).statusCode).toBe(
      403,
    );
    expect((await upload(seller.cookies, pngOf(10, 10), 'image/png')).statusCode).toBe(403);
  });

  it('takes an MP4, and refuses what is neither picture nor video whatever it claims to be', async () => {
    const { cookies } = await sessionFor('marketing');
    const video = await upload(cookies, mp4(), 'video/mp4');
    expect(video.json<{ asset: MediaAsset }>().asset).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      aspect: 'other',
    });
    const script = await upload(cookies, Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(script.statusCode).toBe(400);
    expect(script.json()).toMatchObject({ error: 'invalid_media' });
  });

  it('filters by kind, origin, ad shape, tag and words of the prompt', async () => {
    const { cookies, employeeId } = await sessionFor('marketing');
    const generated = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'kairogen',
      bytes: pngOf(1080, 1920),
      prompt: 'Storefront at golden hour, advertising photography',
      model: 'fake-image-1',
      credits: 4,
      tags: ['franquia'],
    });
    if (!generated.ok) throw new Error('expected stored');

    const list = async (query: string) =>
      (await app.inject({ url: `/media/assets?${query}`, cookies }))
        .json<{ assets: MediaAsset[] }>()
        .assets.map((asset) => asset.id);

    expect(await list('origin=kairogen')).toEqual([generated.id]);
    expect(await list('aspect=9:16')).toEqual([generated.id]);
    expect(await list('tag=franquia')).toEqual([generated.id]);
    expect(await list('q=golden%20hour')).toEqual([generated.id]);
    expect(await list('kind=video')).not.toContain(generated.id);
    expect((await app.inject({ url: '/media/assets?kind=audio', cookies })).statusCode).toBe(400);

    const filed = await app.inject({
      method: 'PATCH',
      url: `/media/assets/${generated.id}`,
      cookies,
      payload: { client: 'Wings', folder: 'Campanha RJ', tags: ['RJ', 'rj', 'Reels'] },
    });
    expect(filed.json<{ asset: MediaAsset }>().asset).toMatchObject({
      client: 'Wings',
      folder: 'Campanha RJ',
      tags: ['rj', 'reels'],
      prompt: 'Storefront at golden hour, advertising photography',
      credits: 4,
    });
  });

  it('serves nothing from outside the volume, nor a file that is no longer the one stored', async () => {
    const { cookies, employeeId } = await sessionFor('marketing');
    const stored = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: pngOf(1200, 1200),
    });
    if (!stored.ok) throw new Error('expected stored');

    await db
      .update(mediaAssets)
      .set({ storageKey: '../../etc/passwd' })
      .where(eq(mediaAssets.id, stored.id));
    expect((await app.inject({ url: `/media/assets/${stored.id}/file`, cookies })).statusCode).toBe(
      404,
    );

    const other = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: pngOf(1300, 1300),
    });
    if (!other.ok) throw new Error('expected stored');
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, other.id));
    await writeFile(join(mediaDir, row?.storageKey ?? ''), Buffer.from('tampered'));
    expect((await app.inject({ url: `/media/assets/${other.id}/file`, cookies })).statusCode).toBe(
      404,
    );
  });

  it('falls back to a folder inside the video volume, and answers 503 with no volume at all', async () => {
    expect(mediaDirOf({ MEDIA_DIR: '/data/media', CREATIVE_VIDEO_DIR: '/data/videos' })).toBe(
      '/data/media',
    );
    expect(mediaDirOf({ MEDIA_DIR: undefined, CREATIVE_VIDEO_DIR: '/data/videos' })).toBe(
      '/data/videos/media',
    );
    expect(mediaDirOf({ MEDIA_DIR: undefined, CREATIVE_VIDEO_DIR: undefined })).toBeNull();

    const bare = await buildApp({ env: env(), db });
    try {
      const { cookies } = await sessionFor('marketing', bare);
      const refused = await bare.inject({
        method: 'POST',
        url: '/media/assets',
        cookies,
        headers: { 'content-type': 'image/png' },
        payload: pngOf(1080, 1080),
      });
      expect(refused.statusCode).toBe(503);
      const list = await bare.inject({ url: '/media/assets', cookies });
      expect(list.json()).toMatchObject({ storageAvailable: false });
    } finally {
      await bare.close();
    }
  });

  it('names the ad shape of a picture within a small tolerance', () => {
    expect(mediaAspectOf(1080, 1080)).toBe('1:1');
    expect(mediaAspectOf(1080, 1350)).toBe('4:5');
    expect(mediaAspectOf(1080, 1920)).toBe('9:16');
    expect(mediaAspectOf(1920, 1080)).toBe('16:9');
    expect(mediaAspectOf(1000, 700)).toBe('other');
    expect(mediaAspectOf(null, null)).toBe('other');
  });
});
