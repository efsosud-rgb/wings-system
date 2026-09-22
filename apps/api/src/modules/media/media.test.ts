import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, WINGS_CLIENT_ID, mediaAspectOf, type MediaAsset } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { clients, driveFiles, driveFolders, mediaAssets } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { migrateMediaToDrive } from '../../scripts/migrate-media-to-drive.js';
import { createLocalStorage } from '../../lib/storage/local.js';
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
      driveFileId: expect.any(String),
    });

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    // The bytes are a Drive file: in Formatação/Marketing/Mídia, under a key of the server's.
    expect(row?.storageKey).toMatch(/^drive\/\d{4}-\d{2}\/[0-9a-f-]{36}$/);
    const [month] = await readdir(join(mediaDir, 'drive'));
    expect(await readdir(join(mediaDir, 'drive', month ?? ''))).toHaveLength(1);
    const [inDrive] = await db
      .select({ file: driveFiles, path: driveFolders.path })
      .from(driveFiles)
      .innerJoin(driveFolders, eq(driveFolders.id, driveFiles.folderId))
      .where(eq(driveFiles.id, row?.driveFileId ?? ''));
    expect(inDrive).toMatchObject({
      path: '/Formatação/Marketing/Mídia',
      file: { mimeType: 'image/png', byteSize: bytes.length, storageKey: row?.storageKey },
    });
    expect(inDrive?.file.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(created.payload).not.toContain(row?.storageKey ?? 'x');

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

    // Everything starts as Wings Company's; the library can be narrowed to one client.
    const [aurora] = await db
      .insert(clients)
      .values({ name: 'Padaria Aurora', slug: 'padaria-aurora' })
      .returning();
    if (!aurora) throw new Error('expected a client');
    expect(await list(`clientId=${WINGS_CLIENT_ID}`)).toContain(generated.id);
    expect(await list(`clientId=${aurora.id}`)).toEqual([]);
    expect(await list('q=aurora')).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/media/assets/${generated.id}`,
          cookies,
          payload: { clientId: '99999999-9999-4999-8999-999999999999' },
        })
      ).statusCode,
    ).toBe(400);

    const filed = await app.inject({
      method: 'PATCH',
      url: `/media/assets/${generated.id}`,
      cookies,
      payload: { clientId: aurora.id, folder: 'Campanha RJ', tags: ['RJ', 'rj', 'Reels'] },
    });
    expect(filed.json<{ asset: MediaAsset }>().asset).toMatchObject({
      clientId: aurora.id,
      client: 'Padaria Aurora',
      folder: 'Campanha RJ',
      tags: ['rj', 'reels'],
      prompt: 'Storefront at golden hour, advertising photography',
      credits: 4,
    });
    expect(await list(`clientId=${aurora.id}`)).toEqual([generated.id]);
    // The search finds a client by name too.
    expect(await list('q=aurora')).toEqual([generated.id]);
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

describe('the library inside the Drive', () => {
  it('files a client’s media in that client’s "Mídia", and follows the asset when it is refiled', async () => {
    const { cookies, employeeId } = await sessionFor('marketing');
    const made = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies,
      payload: { name: 'Cliente Do Drive' },
    });
    const clientId = made.json<{ client: { id: string } }>().client.id;
    const pathOf = async (assetId: string) => {
      const [row] = await db
        .select({ path: driveFolders.path })
        .from(mediaAssets)
        .innerJoin(driveFiles, eq(driveFiles.id, mediaAssets.driveFileId))
        .innerJoin(driveFolders, eq(driveFolders.id, driveFiles.folderId))
        .where(eq(mediaAssets.id, assetId));
      return row?.path;
    };

    const forClient = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'kairogen',
      bytes: pngOf(1080, 1080),
      model: 'seedream-v4',
      clientId,
    });
    if (!forClient.ok) throw new Error('expected stored');
    expect(await pathOf(forClient.id)).toBe(
      '/Formatação/Marketing/Clientes/Cliente Do Drive/Mídia',
    );

    const forWings = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: pngOf(1080, 1080),
    });
    if (!forWings.ok) throw new Error('expected stored');
    expect(await pathOf(forWings.id)).toBe('/Formatação/Marketing/Mídia');
    await app.inject({
      method: 'PATCH',
      url: `/media/assets/${forWings.id}`,
      cookies,
      payload: { clientId },
    });
    expect(await pathOf(forWings.id)).toBe('/Formatação/Marketing/Clientes/Cliente Do Drive/Mídia');
  });

  it('leaves the library when its file goes to the Drive’s trash, and comes back when restored', async () => {
    const { cookies, employeeId } = await sessionFor('marketing');
    const stored = await storeMedia(db, mediaDir, {
      ownerId: employeeId,
      origin: 'upload',
      bytes: pngOf(640, 640),
    });
    if (!stored.ok) throw new Error('expected stored');
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, stored.id));
    const listed = async () =>
      (await app.inject({ url: '/media/assets', cookies }))
        .json<{ assets: MediaAsset[] }>()
        .assets.some((item) => item.id === stored.id);
    expect(await listed()).toBe(true);
    await app.inject({ method: 'POST', url: `/drive/files/${asset?.driveFileId}/trash`, cookies });
    expect(await listed()).toBe(false);
    await app.inject({
      method: 'POST',
      url: `/drive/files/${asset?.driveFileId}/restore`,
      cookies,
    });
    expect(await listed()).toBe(true);
  });

  it('with R2, sends the browser to a five-minute pre-signed address instead of streaming', async () => {
    const r2 = await buildApp({
      env: env({
        MEDIA_DIR: mediaDir,
        R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
        R2_BUCKET: 'wings-staging',
        R2_ACCESS_KEY_ID: 'AKID',
        R2_SECRET_ACCESS_KEY: 'r2-secret-never-shown',
      }),
      db,
      storageFetch: async () => new Response(null, { status: 200 }),
    });
    try {
      const { cookies } = await sessionFor('marketing', r2);
      const { asset } = (
        await r2.inject({
          method: 'POST',
          url: '/media/assets',
          cookies,
          headers: { 'content-type': 'image/png' },
          payload: pngOf(1080, 1080),
        })
      ).json<{ asset: MediaAsset }>();
      const file = await r2.inject({ url: asset.downloadPath, cookies });
      expect(file.statusCode).toBe(302);
      const to = new URL(String(file.headers.location));
      expect(to.origin).toBe('https://acct.r2.cloudflarestorage.com');
      expect(to.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(String(file.headers.location)).not.toContain('r2-secret-never-shown');
      // And still nothing without a login.
      expect((await r2.inject({ url: asset.downloadPath })).statusCode).toBe(401);
    } finally {
      await r2.close();
    }
  });
});

describe('moving the old library from the volume into the Drive', () => {
  it('links and copies each asset once, however many times it runs, and carries files to a new storage', async () => {
    const { employeeId } = await sessionFor('marketing');
    // An asset as the library used to keep it: a file on the volume and no Drive file.
    const bytes = pngOf(900, 900);
    await mkdir(join(mediaDir, '2026-08'), { recursive: true });
    await writeFile(join(mediaDir, '2026-08', 'legacy.png'), bytes);
    const [legacy] = await db
      .insert(mediaAssets)
      .values({
        ownerId: employeeId,
        origin: 'kairogen',
        kind: 'image',
        mimeType: 'image/png',
        byteSize: bytes.length,
        sha256: 'a'.repeat(64),
        width: 900,
        height: 900,
        storageKey: '2026-08/legacy.png',
        model: 'gpt-image-1-5',
      })
      .returning();
    const [lost] = await db
      .insert(mediaAssets)
      .values({
        ownerId: employeeId,
        origin: 'upload',
        kind: 'image',
        mimeType: 'image/png',
        byteSize: 10,
        sha256: 'b'.repeat(64),
        storageKey: '2026-08/not-there.png',
      })
      .returning();

    const local = createLocalStorage({
      dir: mediaDir,
      publicApiBase: '',
      linkKey: Buffer.alloc(32),
    });
    const first = await migrateMediaToDrive(db, local, mediaDir);
    expect(first.linked).toBe(1);
    // A file that is not on the volume is reported by the asset's id, and left alone.
    expect(first.missing).toContain(lost?.id);
    expect(first.missing).not.toContain(legacy?.id);
    const [after] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, legacy?.id ?? ''));
    expect(after?.storageKey).toBe(`drive/media/${legacy?.id}`);
    expect(after?.driveFileId).toBeTruthy();
    expect((await local.get(after?.storageKey ?? ''))?.equals(bytes)).toBe(true);
    // The old file is still on the volume: the script deletes nothing.
    expect(await readdir(join(mediaDir, '2026-08'))).toContain('legacy.png');

    const second = await migrateMediaToDrive(db, local, mediaDir);
    expect(second).toMatchObject({ linked: 0, copied: 0 });
    expect(second.missing).toEqual(first.missing);
    expect(
      await db
        .select()
        .from(driveFiles)
        .where(eq(driveFiles.storageKey, `drive/media/${legacy?.id}`)),
    ).toHaveLength(1);

    // The environment gets a bucket: what was on the volume is carried over, once.
    const bucket = new Map<string, Buffer>();
    const r2 = {
      ...local,
      head: async (key: string) =>
        bucket.has(key) ? { size: bucket.get(key)?.length ?? 0, etag: null } : null,
      put: async (key: string, data: Buffer) => void bucket.set(key, data),
    };
    const carried = await migrateMediaToDrive(db, r2, mediaDir);
    expect(carried.copied).toBeGreaterThan(0);
    expect(bucket.get(`drive/media/${legacy?.id}`)?.equals(bytes)).toBe(true);
    expect((await migrateMediaToDrive(db, r2, mediaDir)).copied).toBe(0);
  });
});
