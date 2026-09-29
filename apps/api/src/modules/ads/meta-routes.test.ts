import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_VIDEO_BYTES,
  SESSION_COOKIE,
  VIDEO_UPLOAD_PART_BYTES,
  campaignDraftSchema,
  type MetaIdentities,
  type VideoUpload,
  type VideoUploadSession,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adExecutions,
  adVideoUploadSessions,
  adVideoUploads,
  auditLog,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { recordStep } from './ad-tree.js';
import { gateChange } from './approvals.js';
import { openPeriod, reserveCampaignCreation } from './budget-guard.js';
import { fakeMetaApi } from './platform/fake-meta-api.js';

/**
 * The routes the builder needs around a Meta campaign: which Pages exist, video
 * uploads, and Meta's own preview once the ads are there. Meta is scripted.
 */

const ACCOUNT = 'act_694058302567457';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
  new Date(),
);

let harness: TestDatabase;
let db: Database;
let videoDir: string;
let app: FastifyInstance;
let bare: FastifyInstance;
let accountDbId: string;
const meta = fakeMetaApi({ accountId: ACCOUNT });

const baseEnv = () => ({
  NODE_ENV: 'test',
  DATABASE_URL: harness.url,
  SESSION_SECRET: randomBytes(48).toString('base64'),
  CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
  CPF_INDEX_KEY: TEST_INDEX_KEY,
  APP_BASE_URL: 'https://staging.wingssystem.online',
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  videoDir = await mkdtemp(join(tmpdir(), 'wings-route-videos-'));

  app = await buildApp({
    env: loadEnv({
      ...baseEnv(),
      META_WRITE_TOKEN: 'token',
      META_WRITE_ACCOUNT_ID: ACCOUNT,
      CREATIVE_VIDEO_DIR: videoDir,
    }),
    db,
    platformFetch: meta.impl,
  });
  // The same API with no Meta token and no video volume.
  bare = await buildApp({ env: loadEnv(baseEnv()), db, platformFetch: meta.impl });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: ACCOUNT, name: 'Fly High' })
    .returning({ id: adAccounts.id });
  accountDbId = account?.id as string;
  await openPeriod(db, {
    adAccountId: accountDbId,
    periodMonth: `${TODAY.slice(0, 7)}-01`,
    capCents: 250_000,
    usablePercent: 70,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await harness?.drop();
  await rm(videoDir, { recursive: true, force: true });
});

async function cookiesFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao', on = app) {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'vendedor_expansao' ? 'comercial' : role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const login = await on.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

/** Twelve bytes are enough to look like an MP4: a box size, then `ftyp`. */
const mp4Of = (size: number) =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(size - 12, 1)]);

describe('GET /ads/meta/identities', () => {
  it('lists what Meta lists, with no default until one is saved', async () => {
    const response = await app.inject({
      url: '/ads/meta/identities',
      cookies: await cookiesFor('marketing'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ identities: MetaIdentities }>().identities).toEqual({
      pages: [
        {
          id: '104567890123456',
          name: 'Wings Company',
          instagramAccounts: [{ id: '17841400000000000', username: 'wingscompany' }],
        },
      ],
      default: null,
    });
    expect(meta.writes()).toHaveLength(0);
  });

  it('says so when this environment has no Meta credentials, instead of an empty list', async () => {
    const response = await bare.inject({
      url: '/ads/meta/identities',
      cookies: await cookiesFor('marketing', bare),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('meta_not_configured');
  });

  it('is closed to someone who may not ask for campaigns', async () => {
    const response = await app.inject({
      url: '/ads/meta/identities',
      cookies: await cookiesFor('vendedor_expansao'),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('PUT /ads/meta/identities/default', () => {
  it('saves Wings’ choice, audits it, and hands it back next time', async () => {
    const cookies = await cookiesFor('marketing');
    const saved = await app.inject({
      method: 'PUT',
      url: '/ads/meta/identities/default',
      cookies,
      payload: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
    });
    expect(saved.statusCode).toBe(200);

    const again = await app.inject({ url: '/ads/meta/identities', cookies });
    expect(again.json<{ identities: MetaIdentities }>().identities.default).toEqual({
      pageId: '104567890123456',
      instagramActorId: '17841400000000000',
    });
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ads.meta_identity_default_saved'));
    expect(entries).toHaveLength(1);
  });

  it('refuses a Page or an Instagram account Meta does not list', async () => {
    const cookies = await cookiesFor('marketing');
    for (const payload of [
      { pageId: '999999999999', instagramActorId: null },
      { pageId: '104567890123456', instagramActorId: '11111111111' },
      { pageId: 'minha-pagina', instagramActorId: null },
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/ads/meta/identities/default',
        cookies,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('videos', () => {
  it('stores a video on the volume under a name of our own, and serves it back in ranges', async () => {
    const cookies = await cookiesFor('marketing');
    const bytes = mp4Of(4_096);
    const upload = await app.inject({
      method: 'POST',
      url: '/ads/videos',
      cookies,
      headers: { 'content-type': 'video/mp4' },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const { video } = upload.json<{ video: { id: string; byteSize: number; mimeType: string } }>();
    expect(video).toMatchObject({ byteSize: 4_096, mimeType: 'video/mp4' });

    const files = await readdir(videoDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.mp4$/);

    const whole = await app.inject({ url: `/ads/videos/${video.id}`, cookies });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(bytes)).toBe(true);

    const part = await app.inject({
      url: `/ads/videos/${video.id}`,
      cookies,
      headers: { range: 'bytes=10-19' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/4096');
    expect(part.rawPayload.equals(bytes.subarray(10, 20))).toBe(true);
  });

  it('refuses bytes that are not a video, whatever the header says, and keeps nothing', async () => {
    const before = (await readdir(videoDir)).length;
    const response = await app.inject({
      method: 'POST',
      url: '/ads/videos',
      cookies: await cookiesFor('marketing'),
      headers: { 'content-type': 'video/mp4' },
      payload: Buffer.from('<html>definitely not a video</html>'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('invalid_video');
    expect(await readdir(videoDir)).toHaveLength(before);
  });

  it('answers 503 without a video volume, never a fake success', async () => {
    const response = await bare.inject({
      method: 'POST',
      url: '/ads/videos',
      cookies: await cookiesFor('marketing', bare),
      headers: { 'content-type': 'video/mp4' },
      payload: mp4Of(64),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('video_storage_not_configured');
  });

  it('is closed to someone who may not ask for campaigns', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/videos',
      cookies: await cookiesFor('vendedor_expansao'),
      headers: { 'content-type': 'video/mp4' },
      payload: mp4Of(64),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('videos in parts', () => {
  const PART = VIDEO_UPLOAD_PART_BYTES;

  async function opened(cookies: Record<string, string>, byteSize: number, on = app) {
    const response = await on.inject({
      method: 'POST',
      url: '/ads/videos/uploads',
      cookies,
      payload: { mimeType: 'video/mp4', byteSize },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ upload: VideoUploadSession }>().upload;
  }

  async function sendPart(
    cookies: Record<string, string>,
    id: string,
    n: number,
    bytes: Buffer,
    on = app,
  ) {
    return on.inject({
      method: 'PUT',
      url: `/ads/videos/uploads/${id}/parts/${n}`,
      cookies,
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
  }

  it('takes a video in ordered parts, keeps it under our own name and serves it back', async () => {
    const cookies = await cookiesFor('marketing');
    const tail = 1_000;
    const whole = mp4Of(2 * PART + tail);
    const upload = await opened(cookies, whole.length);
    expect(upload).toMatchObject({ partSize: PART, parts: 3, receivedBytes: 0, nextPart: 1 });

    const before = (await readdir(videoDir)).filter((name) => !name.endsWith('.part')).length;
    for (let n = 1; n <= 3; n += 1) {
      const response = await sendPart(
        cookies,
        upload.id,
        n,
        whole.subarray((n - 1) * PART, Math.min(n * PART, whole.length)),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json<{ upload: VideoUploadSession }>().upload).toMatchObject({
        nextPart: n + 1,
        receivedBytes: Math.min(n * PART, whole.length),
      });
    }

    const status = await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies });
    expect(status.json<{ upload: VideoUploadSession }>().upload.receivedBytes).toBe(whole.length);

    const complete = await app.inject({
      method: 'POST',
      url: `/ads/videos/uploads/${upload.id}/complete`,
      cookies,
    });
    expect(complete.statusCode).toBe(201);
    const { video } = complete.json<{ video: VideoUpload }>();
    expect(video).toMatchObject({ byteSize: whole.length, mimeType: 'video/mp4' });

    const files = (await readdir(videoDir)).filter((name) => !name.endsWith('.part'));
    expect(files).toHaveLength(before + 1);

    const served = await app.inject({ url: `/ads/videos/${video.id}`, cookies });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(whole)).toBe(true);
    expect(createHash('sha256').update(whole).digest('hex')).toBe(
      (await db.query.adVideoUploads.findFirst({ where: eq(adVideoUploads.id, video.id) }))?.sha256,
    );

    // The session is gone with the upload.
    expect(
      (await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies })).statusCode,
    ).toBe(404);
  }, 60_000);

  it('refuses a part out of order and says which one it expects', async () => {
    const cookies = await cookiesFor('marketing');
    const upload = await opened(cookies, 2 * PART + 10);
    const response = await sendPart(cookies, upload.id, 2, Buffer.alloc(PART, 1));
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string; expected: number }>()).toMatchObject({
      error: 'part_out_of_order',
      expected: 1,
    });
  });

  it('answers a repeated part without writing it twice', async () => {
    const cookies = await cookiesFor('marketing');
    const whole = mp4Of(PART + 10);
    const upload = await opened(cookies, whole.length);
    expect((await sendPart(cookies, upload.id, 1, whole.subarray(0, PART))).statusCode).toBe(200);
    const again = await sendPart(cookies, upload.id, 1, Buffer.alloc(PART, 9));
    expect(again.statusCode).toBe(200);
    expect(again.json<{ upload: VideoUploadSession }>().upload).toMatchObject({
      nextPart: 2,
      receivedBytes: PART,
    });
    expect((await sendPart(cookies, upload.id, 2, whole.subarray(PART))).statusCode).toBe(200);
    const complete = await app.inject({
      method: 'POST',
      url: `/ads/videos/uploads/${upload.id}/complete`,
      cookies,
    });
    expect(complete.statusCode).toBe(201);
    const served = await app.inject({
      url: `/ads/videos/${complete.json<{ video: VideoUpload }>().video.id}`,
      cookies,
    });
    expect(served.rawPayload.equals(whole)).toBe(true);
  }, 60_000);

  it('refuses a part of the wrong size and keeps nothing of it', async () => {
    const cookies = await cookiesFor('marketing');
    const upload = await opened(cookies, PART + 10);
    const short = await sendPart(cookies, upload.id, 1, Buffer.alloc(PART - 1, 1));
    expect(short.statusCode).toBe(400);
    expect(short.json<{ error: string }>().error).toBe('part_size_mismatch');
    const last = await sendPart(cookies, upload.id, 1, Buffer.alloc(PART, 1));
    expect(last.statusCode).toBe(200);
    // The last part must be exactly what is left.
    const wrongTail = await sendPart(cookies, upload.id, 2, Buffer.alloc(11, 1));
    expect(wrongTail.statusCode).toBe(400);
    expect(
      (await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies })).json<{
        upload: VideoUploadSession;
      }>().upload,
    ).toMatchObject({ nextPart: 2, receivedBytes: PART });
  }, 60_000);

  it('will not complete before every part is in', async () => {
    const cookies = await cookiesFor('marketing');
    const upload = await opened(cookies, PART + 10);
    const response = await app.inject({
      method: 'POST',
      url: `/ads/videos/uploads/${upload.id}/complete`,
      cookies,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('upload_incomplete');
  });

  it('refuses bytes that are not a video at the end, and keeps nothing', async () => {
    const cookies = await cookiesFor('marketing');
    const junk = Buffer.from('<html>definitely not a video</html>');
    const upload = await opened(cookies, junk.length);
    expect((await sendPart(cookies, upload.id, 1, junk)).statusCode).toBe(200);
    const partial = `${
      (
        await db.query.adVideoUploadSessions.findFirst({
          where: eq(adVideoUploadSessions.id, upload.id),
        })
      )?.storageKey
    }.part`;
    expect((await readdir(videoDir)).includes(partial)).toBe(true);
    const complete = await app.inject({
      method: 'POST',
      url: `/ads/videos/uploads/${upload.id}/complete`,
      cookies,
    });
    expect(complete.statusCode).toBe(400);
    expect(complete.json<{ error: string }>().error).toBe('invalid_video');
    expect((await readdir(videoDir)).includes(partial)).toBe(false);
    expect(
      (await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies })).statusCode,
    ).toBe(404);
  });

  it('refuses a video over 4 GB before a byte goes up, and a bad type', async () => {
    const cookies = await cookiesFor('marketing');
    const big = await app.inject({
      method: 'POST',
      url: '/ads/videos/uploads',
      cookies,
      payload: { mimeType: 'video/mp4', byteSize: MAX_VIDEO_BYTES + 1 },
    });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({
      method: 'POST',
      url: '/ads/videos/uploads',
      cookies,
      payload: { mimeType: 'image/png', byteSize: 10 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers 503 without a video volume, never a fake success', async () => {
    const response = await bare.inject({
      method: 'POST',
      url: '/ads/videos/uploads',
      cookies: await cookiesFor('marketing', bare),
      payload: { mimeType: 'video/mp4', byteSize: 64 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('video_storage_not_configured');
  });

  it('is closed to someone who may not ask for campaigns', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/videos/uploads',
      cookies: await cookiesFor('vendedor_expansao'),
      payload: { mimeType: 'video/mp4', byteSize: 64 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("is blind to another employee's session", async () => {
    const owner = await cookiesFor('marketing');
    const other = await cookiesFor('marketing');
    const upload = await opened(owner, 64);
    expect(
      (await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies: other })).statusCode,
    ).toBe(404);
    expect((await sendPart(other, upload.id, 1, mp4Of(64))).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/ads/videos/uploads/${upload.id}`,
          cookies: other,
        })
      ).statusCode,
    ).toBe(404);
    // The owner can still throw it away.
    const gone = await app.inject({
      method: 'DELETE',
      url: `/ads/videos/uploads/${upload.id}`,
      cookies: owner,
    });
    expect(gone.statusCode).toBe(204);
    expect(
      (await app.inject({ url: `/ads/videos/uploads/${upload.id}`, cookies: owner })).statusCode,
    ).toBe(404);
  });

  it('purges sessions nobody finished in a day, files included', async () => {
    const cookies = await cookiesFor('marketing');
    const stale = await opened(cookies, 64);
    const [row] = await db
      .update(adVideoUploadSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(adVideoUploadSessions.id, stale.id))
      .returning({ storageKey: adVideoUploadSessions.storageKey });
    expect((await readdir(videoDir)).includes(`${row?.storageKey}.part`)).toBe(true);

    await opened(cookies, 64);
    expect((await app.inject({ url: `/ads/videos/uploads/${stale.id}`, cookies })).statusCode).toBe(
      404,
    );
    expect((await readdir(videoDir)).includes(`${row?.storageKey}.part`)).toBe(false);
  });
});

describe('GET /ads/approvals/:id/previews', () => {
  /** A real request in front of the gate, then an execution with these ads on record. */
  async function approvalWithAds(adIds: string[]) {
    const draft = campaignDraftSchema.parse({
      platform: 'meta',
      name: `Prévia ${randomBytes(3).toString('hex')}`,
      objective: 'lead',
      idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
      reach: { states: ['SP'], cities: [] },
      formatKey: 'feed_square',
      destinationUrl: 'https://wingscompany.com.br/franquia',
      variations: [1, 2].map((n) => ({
        creativeId: `${n}1111111-1111-4111-8111-111111111111`,
        headline: `Variação ${n}`,
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
      })),
      ageMin: 25,
      ageMax: 65,
      placements: { mode: 'automatic' },
      identity: { pageId: '104567890123456' },
      startDate: TODAY,
      endDate: TODAY,
      dailyBudgetCents: 600,
      utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: '' },
      startPaused: true,
    });
    const reserved = await reserveCampaignCreation(db, { adAccountId: accountDbId, draft });
    if (!reserved.ok) throw new Error(reserved.message);
    const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
    if (!gate.approvalId) throw new Error('expected an approval');

    const [execution] = await db
      .insert(adExecutions)
      .values({
        changeRequestId: reserved.value.changeRequestId,
        idempotencyKey: randomBytes(8).toString('hex'),
        requestHash: 'x',
        outcome: 'applied',
      })
      .returning({ id: adExecutions.id });
    for (const [index, externalId] of adIds.entries()) {
      await recordStep(db, execution?.id as string, {
        seq: index + 1,
        kind: 'ad',
        label: `Anúncio v${index + 1}`,
        status: 'created',
        externalId,
        message: null,
      });
    }
    return gate.approvalId;
  }

  it('says the ads do not exist yet, before the execution', async () => {
    const id = await approvalWithAds([]);
    const response = await app.inject({
      url: `/ads/approvals/${id}/previews?placement=instagram_stories`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('not_created_yet');
  });

  it('hands back Meta’s own preview for each ad, for the placement asked', async () => {
    const id = await approvalWithAds(['120210000000777', '120210000000778']);
    const response = await app.inject({
      url: `/ads/approvals/${id}/previews?placement=instagram_stories`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      previews: [
        {
          adName: 'Anúncio v1',
          iframeSrc: 'https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=INSTAGRAM_STORY',
        },
        {
          adName: 'Anúncio v2',
          iframeSrc: 'https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=INSTAGRAM_STORY',
        },
      ],
    });
  });

  it('refuses a placement it does not know', async () => {
    const id = await approvalWithAds(['120210000000779']);
    const response = await app.inject({
      url: `/ads/approvals/${id}/previews?placement=tiktok_feed`,
      cookies: await cookiesFor('admin_master'),
    });
    expect(response.statusCode).toBe(400);
  });
});
