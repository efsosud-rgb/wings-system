import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, YOUTUBE_FORMATACAO_OUT26 } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaignDrafts,
  auditLog,
  driveFiles,
  driveFolders,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createLocalStorage } from '../../lib/storage/local.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  fakeJpeg,
  fakePng,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { openPeriod } from './budget-guard.js';
import { sha256Of } from './demand-gen.js';
import { fakeGoogleApi } from './platform/fake-google-api.js';

/**
 * Asking for a YouTube (Demand Gen) campaign over HTTP: the videos are
 * checked on YouTube, the logo in the Drive (as this person sees it), and the
 * builder reads the account's conversions and segments. Nothing here reaches
 * Google or YouTube: both are scripted.
 */

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
  new Date(),
);

/** YouTube's oEmbed as the test wants it: public, private, missing, or silent. */
const videoStatus = new Map<string, number | 'down' | 'html'>();
const youtubeCalls: string[] = [];
const youtubeFetch = ((url: unknown) => {
  const href = String(url);
  youtubeCalls.push(href);
  const id = /watch%3Fv%3D([A-Za-z0-9_-]{11})/.exec(href)?.[1] ?? '';
  const status = videoStatus.get(id) ?? 200;
  if (status === 'down') return Promise.reject(new TypeError('fetch failed'));
  // A consent page that answers 200 is not YouTube saying yes.
  if (status === 'html') {
    return Promise.resolve(new Response('<html>Antes de continuar</html>', { status: 200 }));
  }
  return Promise.resolve(
    new Response(status === 200 ? JSON.stringify({ title: `Vídeo ${id}` }) : 'Unauthorized', {
      status,
    }),
  );
}) as typeof fetch;

const google = fakeGoogleApi({
  conversionActions: [
    { id: '7804997444', name: 'RD form conversion', status: 'ENABLED', primaryForGoal: true },
  ],
  customAudiences: [{ id: '1019547251', name: 'Concorrentes' }],
});

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let mediaDir: string;
let storage: ReturnType<typeof createLocalStorage>;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  mediaDir = await mkdtemp(join(tmpdir(), 'wings-dg-routes-'));
  storage = createLocalStorage({
    dir: mediaDir,
    publicApiBase: 'http://localhost/api',
    linkKey: randomBytes(32),
  });
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
      GOOGLE_ADS_CLIENT_ID: 'client-id',
      GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
      GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
      GOOGLE_ADS_CUSTOMER_ID: '4268586278',
    }),
    db,
    platformFetch: google.fetch,
    youtubeFetch,
    storage,
  });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'google', externalId: '4268586278', name: 'Wings Company — Google Ads' })
    .returning({ id: adAccounts.id });
  await openPeriod(db, {
    adAccountId: account!.id,
    periodMonth: `${TODAY.slice(0, 7)}-01`,
    capCents: 400_000,
    usablePercent: 70,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(mediaDir, { recursive: true, force: true });
});

async function cookiesFor(role: 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { cookies: { [SESSION_COOKIE]: token }, employeeId: employee.id };
}

/** A logo in a Drive folder of the given department. */
async function driveLogo(options: { department?: string; bytes?: Buffer; mimeType?: string } = {}) {
  const owner = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const tag = randomBytes(3).toString('hex');
  const [folder] = await db
    .insert(driveFolders)
    .values({
      name: `Logos ${tag}`,
      path: `/Marketing/Logos ${tag}`,
      department: options.department ?? 'marketing',
    })
    .returning({ id: driveFolders.id });
  const bytes = options.bytes ?? fakePng(512, 512, 4096);
  const storageKey = `drive/2026-10/${randomBytes(8).toString('hex')}`;
  await storage.put(storageKey, bytes, options.mimeType ?? 'image/png');
  const [file] = await db
    .insert(driveFiles)
    .values({
      folderId: folder!.id,
      name: 'logo.png',
      mimeType: options.mimeType ?? 'image/png',
      byteSize: bytes.length,
      storageKey,
      ownerId: owner.id,
    })
    .returning({ id: driveFiles.id });
  return file!.id;
}

/** The Out26 template, as the builder fills it once the person picked the logo. */
function out26(logoFileId: string, youtube: Record<string, unknown> = {}) {
  const form = YOUTUBE_FORMATACAO_OUT26.draft(TODAY);
  return {
    ...form,
    name: `${form.name} ${randomBytes(3).toString('hex')}`,
    youtube: {
      ...form.youtube,
      logoFileId,
      conversionAction: { id: '7804997444', name: 'RD form conversion' },
      ...youtube,
    },
  };
}

const ask = (cookies: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url: '/ads/campaign-requests', cookies, payload });

describe('asking for a YouTube campaign', () => {
  it('turns the Out26 template into a request in the approval queue, with nothing sent to Google', async () => {
    const { cookies } = await cookiesFor('marketing');
    const logo = await driveLogo();
    const before = google.mutateCalls().length;

    const payload = out26(logo);
    // Whatever the browser says the logo's fingerprint is, the server writes its own.
    const response = await ask(cookies, {
      ...payload,
      youtube: { ...payload.youtube, logoSha256: 'f'.repeat(64) },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ approvalId: string | null }>().approvalId).toBeTruthy();
    // The draft is the approved payload: everything Google will receive.
    const stored = await db.query.adCampaignDrafts.findFirst({
      where: eq(adCampaignDrafts.name, payload.name),
    });
    expect(stored).toMatchObject({ dailyBudgetCents: 5000, startPaused: true });
    expect(stored?.payload).toMatchObject({
      platform: 'youtube',
      reach: { states: ['DF', 'GO', 'RJ', 'SC'] },
      youtube: {
        logoFileId: logo,
        logoSha256: sha256Of(fakePng(512, 512, 4096)),
        conversionAction: { id: '7804997444' },
        ageMin: 25,
      },
    });

    // The approver sees the logo itself, through a short link, audited by id.
    const approvalId = response.json<{ approvalId: string }>().approvalId;
    const shown = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}/youtube-logo`,
      cookies,
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ fileId: logo, unchanged: true });
    expect(shown.json<{ url: string }>().url).not.toContain('drive/2026-10');
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(auditLog.action, 'drive.file_previewed'), eq(auditLog.entityId, logo)),
    });
    expect(audit?.metadata).toMatchObject({ purpose: 'ads_approval_logo', approvalId });
    expect(google.mutateCalls().length).toBe(before);
    expect(youtubeCalls.some((url) => url.includes('34zzJBPHlYg'))).toBe(true);
  });

  it('refuses a private or missing video before anyone approves anything', async () => {
    const { cookies } = await cookiesFor('marketing');
    const logo = await driveLogo();
    videoStatus.set('PrivateVid0', 401);
    videoStatus.set('MissingVid0', 404);

    const priv = await ask(cookies, out26(logo, { videos: ['PrivateVid0'] }));
    expect(priv.statusCode).toBe(400);
    expect(priv.json()).toMatchObject({ error: 'video_unavailable', path: ['youtube', 'videos'] });
    expect(priv.json<{ message: string }>().message).toMatch(/privado/);

    const missing = await ask(cookies, out26(logo, { videos: ['MissingVid0'] }));
    expect(missing.json<{ message: string }>().message).toMatch(/não existe/);

    // YouTube silent, busy, or answering with a page that is not its own: no yes.
    videoStatus.set('SilentVid00', 'down');
    videoStatus.set('BusyVideo00', 429);
    videoStatus.set('ConsentPage', 'html');
    for (const id of ['SilentVid00', 'BusyVideo00', 'ConsentPage']) {
      const silent = await ask(cookies, out26(logo, { videos: [id] }));
      expect(silent.statusCode).toBe(503);
      expect(silent.json()).toMatchObject({ error: 'video_check_unavailable' });
    }
  });

  it('refuses a logo from a Drive folder the person cannot see, as if it did not exist', async () => {
    const { cookies } = await cookiesFor('marketing');
    const hidden = await driveLogo({ department: 'juridico' });

    const response = await ask(cookies, out26(hidden));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'logo_not_found',
      path: ['youtube', 'logoFileId'],
    });
  });

  it('refuses a logo Google would not take: not square, too small, not an image', async () => {
    const { cookies } = await cookiesFor('marketing');
    const wide = await ask(cookies, out26(await driveLogo({ bytes: fakePng(1125, 600, 4096) })));
    expect(wide.json<{ message: string }>().message).toMatch(/quadrada/);
    const small = await ask(cookies, out26(await driveLogo({ bytes: fakePng(100, 100, 1024) })));
    expect(small.json<{ message: string }>().message).toMatch(/128/);
    // Square within 1 %, but one side under 128 px.
    const short = await ask(cookies, out26(await driveLogo({ bytes: fakePng(128, 127, 1024) })));
    expect(short.json<{ message: string }>().message).toMatch(/128/);
    // Said to be a JPEG, but the bytes are a PNG.
    const lying = await ask(
      cookies,
      out26(await driveLogo({ bytes: fakePng(512, 512, 2048), mimeType: 'image/jpeg' })),
    );
    expect(lying.json()).toMatchObject({ error: 'logo_refused' });
    // A real JPEG passes.
    const jpeg = await ask(
      cookies,
      out26(await driveLogo({ bytes: fakeJpeg(400, 400, 4096), mimeType: 'image/jpeg' })),
    );
    expect(jpeg.statusCode).toBe(201);
  });

  it('is not for people without ads.request', async () => {
    const { cookies } = await cookiesFor('vendedor_expansao');
    const response = await ask(cookies, out26(await driveLogo()));
    expect(response.statusCode).toBe(403);
  });
});

describe('what the builder reads for YouTube', () => {
  it("lists the account's conversions and segments, reading only", async () => {
    const { cookies } = await cookiesFor('marketing');
    const writesBefore = google.writeCalls().length;
    const response = await app.inject({
      method: 'GET',
      url: '/ads/google/demand-gen-options',
      cookies,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conversionActions: [
        { id: '7804997444', name: 'RD form conversion', category: null, primary: true },
      ],
      audienceSegments: [{ kind: 'custom_audience', id: '1019547251', name: 'Concorrentes' }],
    });
    expect(google.writeCalls().length).toBe(writesBefore);
  });

  it('checks videos by link or id, one answer each', async () => {
    const { cookies } = await cookiesFor('marketing');
    videoStatus.set('PrivateVid1', 403);
    const response = await app.inject({
      method: 'POST',
      url: '/ads/youtube/videos/check',
      cookies,
      payload: { videos: ['https://youtu.be/34zzJBPHlYg', 'PrivateVid1'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      videos: [
        { videoId: '34zzJBPHlYg', status: 'ok', title: 'Vídeo 34zzJBPHlYg' },
        { videoId: 'PrivateVid1', status: 'private' },
      ],
    });
  });
});
