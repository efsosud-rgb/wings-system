import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, campaignDraftSchema, type MetaIdentities } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { adAccounts, adExecutions, auditLog } from '../../db/schema/index.js';
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
