import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  type DashboardAudience,
  type DashboardCampaigns,
  type DashboardCreatives,
  type DashboardOverview,
  type DashboardPlatforms,
} from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import type { Database } from '../../../db/client.js';
import {
  agentConversations,
  agentMessages,
  integrationConnections,
  mediaCreditLedger,
} from '../../../db/schema/index.js';
import { loadEnv } from '../../../env.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../../test/factories.js';
import { runAlerts } from '../alerts.js';
import { ingestBreakdown, recordAccountDay } from '../breakdowns.js';
import { openPeriod } from '../budget-guard.js';
import { ensureAdAccount, ingestMetrics, syncAds } from '../metrics.js';
import { fakeGoogleApi } from '../platform/fake-google-api.js';
import { FakeMetaClient } from '../platform/fake-meta-client.js';
import { GoogleAdsPlatformClient } from '../platform/google-ads-client.js';
import { reconcileAccount } from '../reconcile.js';

/**
 * The dashboard read end to end: a Meta account and a Google account mirrored
 * through the fakes, the media ledger and the agent's messages seeded, and the
 * five endpoints read as a person would. No platform is ever called.
 */

const NOW = new Date('2026-09-16T12:00:00.000Z'); // 09:00 in São Paulo, day 16 of 30
const PERIOD = '2026-09-01';
const META_DAYS = ['2026-09-04', '2026-09-05', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15'];

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let metaAccountId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
      OPENROUTER_API_KEY: 'not-a-real-key',
      KAIROGEN_MONTHLY_CREDITS: '1000',
    }),
    db,
    now: () => NOW,
  });

  // --- Meta: a video ad and an image ad under one campaign ------------------
  const metaExternalId = `act_${randomBytes(4).toString('hex')}`;
  metaAccountId = await ensureAdAccount(db, {
    platform: 'meta',
    externalId: metaExternalId,
    name: 'Fly High',
  });
  await openPeriod(db, {
    adAccountId: metaAccountId,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  const meta = new FakeMetaClient({
    accountId: metaExternalId,
    spendCapCents: 250_000,
    campaigns: [
      { id: 'c-leads', name: 'LEAD | FORMS', status: 'ACTIVE', dailyBudgetCents: 10_000 },
      { id: 'c-idle', name: 'Institucional parada', status: 'PAUSED', dailyBudgetCents: 2000 },
    ],
    adSets: [{ id: 'as1', campaignId: 'c-leads', name: 'Conjunto SP' }],
    ads: [
      { id: 'ad-video', campaignId: 'c-leads', adSetId: 'as1', name: 'Reels 15s', format: 'video' },
      { id: 'ad-image', campaignId: 'c-leads', adSetId: 'as1', name: 'Estático', format: 'image' },
      {
        id: 'ad-bad',
        campaignId: 'c-leads',
        adSetId: 'as1',
        name: 'Reprovado',
        effectiveStatus: 'DISAPPROVED',
        reviewFeedback: { global: { 'Práticas de negócios inaceitáveis': 'Viola os padrões.' } },
      },
    ],
  });
  for (const day of META_DAYS) meta.simulateDay(day);
  await reconcileAccount(db, meta, metaAccountId, NOW);
  await syncAds(db, meta, metaAccountId, NOW);
  for (const level of ['campaign', 'ad_set', 'ad'] as const) {
    await ingestMetrics(db, meta, metaAccountId, level, PERIOD, NOW);
  }
  for (const kind of ['placement', 'age_gender', 'region', 'hour'] as const) {
    await ingestBreakdown(db, meta, metaAccountId, kind, PERIOD, NOW);
  }
  await recordAccountDay(db, meta, metaAccountId, NOW);
  await runAlerts(db, metaAccountId, { now: NOW });

  // --- Google: one Search campaign, prepaid ---------------------------------
  const api = fakeGoogleApi({
    campaigns: [{ id: '100', name: 'Pesquisa | Franquia', status: 'ENABLED', amountMicros: '5000000' }],
    accountBudget: { limitMicros: '13100000000', servedMicros: '12600000000' },
    metrics: [
      { campaignId: '100', date: '2026-09-14', costMicros: '2500000', impressions: 500, clicks: 10, conversions: 1 },
      { campaignId: '100', date: '2026-09-15', costMicros: '2500000', impressions: 500, clicks: 10, conversions: 1 },
      { campaignId: '100', date: '2026-09-15', costMicros: '2500000', impressions: 500, clicks: 10, adNetworkType: 'YOUTUBE' },
    ],
  });
  const google = new GoogleAdsPlatformClient(api.reader, () => NOW);
  const googleAccountId = await ensureAdAccount(db, {
    platform: 'google',
    externalId: api.reader.customerId,
    name: 'Wings Google',
  });
  await openPeriod(db, {
    adAccountId: googleAccountId,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  await reconcileAccount(db, google, googleAccountId, NOW);
  await ingestMetrics(db, google, googleAccountId, 'campaign', PERIOD, NOW);
  await ingestBreakdown(db, google, googleAccountId, 'placement', PERIOD, NOW);
  await recordAccountDay(db, google, googleAccountId, NOW);

  // --- Kairogen, the agent and the other media providers --------------------
  const employee = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  await db.insert(integrationConnections).values({ provider: 'kairogen', state: 'connected' });
  await db.insert(mediaCreditLedger).values([
    {
      employeeId: employee.id,
      event: 'started',
      operation: 'generate_image',
      provider: 'kairogen',
      creditsEstimated: 10,
      creditsDelta: 10,
      createdAt: new Date('2026-09-14T14:00:00.000Z'),
    },
    {
      employeeId: employee.id,
      event: 'balance_changed',
      operation: 'get_credits',
      provider: 'kairogen',
      creditsEstimated: 0,
      creditsDelta: 0,
      balanceReported: 990,
      createdAt: new Date('2026-09-14T14:00:01.000Z'),
    },
    {
      employeeId: employee.id,
      event: 'started',
      operation: 'generate_image',
      provider: 'higgsfield',
      creditsEstimated: 0,
      brlCentsEstimated: 250,
      brlCentsDelta: 250,
      createdAt: new Date('2026-09-15T14:00:00.000Z'),
    },
  ]);
  const [conversation] = await db
    .insert(agentConversations)
    .values({ employeeId: employee.id, title: 'Como está a campanha' })
    .returning({ id: agentConversations.id });
  await db.insert(agentMessages).values({
    conversationId: conversation!.id,
    employeeId: employee.id,
    role: 'assistant',
    content: 'Resposta',
    costMicroUsd: 500_000, // half a dollar
    createdAt: new Date('2026-09-15T15:00:00.000Z'),
  });
}, 90_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: 'marketing' | 'vendedor_expansao') {
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
  return { [SESSION_COOKIE]: token };
}

async function read<T>(path: string, key: string): Promise<T> {
  const cookies = await sessionFor('marketing');
  const response = await app.inject({ method: 'GET', url: path, cookies });
  expect(response.statusCode).toBe(200);
  return (response.json() as Record<string, T>)[key] as T;
}

describe('who may open the dashboard', () => {
  it('keeps a salesperson out and refuses an anonymous request', async () => {
    const cookies = await sessionFor('vendedor_expansao');
    for (const path of [
      '/ads/dashboard/overview',
      '/ads/dashboard/platforms',
      '/ads/dashboard/campaigns',
      '/ads/dashboard/creatives',
      '/ads/dashboard/audience',
    ]) {
      expect((await app.inject({ method: 'GET', url: path, cookies })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    }
  });

  it('accepts only the windows the screen offers', async () => {
    const cookies = await sessionFor('marketing');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/dashboard/platforms?days=5',
      cookies,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the overview', () => {
  it('has one strip per source, in a fixed order', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    expect(overview.strips.map((strip) => strip.source)).toEqual([
      'meta',
      'google',
      'kairogen',
      'ai',
      'media',
    ]);
  });

  it('reads Meta from the reconciled period and the account row', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    const meta = overview.strips.find((strip) => strip.source === 'meta');
    if (!meta) throw new Error('no meta strip');
    // Six days at R$ 100,00, reported as spend.
    expect(meta.spent).toBe(60_000);
    expect(meta.ceiling).toBe(400_000);
    expect(meta.balance).toBe(250_000 - 60_000);
    expect(meta.balanceSource).toBe('meta.spend_cap');
    expect(meta.activeDailyBudget).toBe(10_000);
    expect(meta.forecast).toBeGreaterThan(meta.spent);
    expect(meta.killSwitchEngaged).toBe(false);
    expect(meta.daily.map((point) => point.day)).toContain('2026-09-15');
    expect(meta.daily.find((point) => point.day === '2026-09-15')?.amount).toBe(10_000);
    expect(meta.daily.find((point) => point.day === '2026-09-10')?.amount).toBe(0);
  });

  it('reads Google as a prepaid balance', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    const google = overview.strips.find((strip) => strip.source === 'google');
    expect(google?.configured).toBe(true);
    expect(google?.balance).toBe(50_000);
    expect(google?.balanceSource).toBe('google.prepaid_balance');
  });

  it('counts Kairogen in credits, the agent and the providers in reais', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    const by = Object.fromEntries(overview.strips.map((strip) => [strip.source, strip]));
    expect(by.kairogen).toMatchObject({
      unit: 'credits',
      configured: true,
      spent: 10,
      balance: 990,
      ceiling: 1000,
      available: 990,
    });
    // Half a dollar at the default R$ 5,50.
    expect(by.ai).toMatchObject({ unit: 'brl', configured: true, spent: 275, ceiling: null });
    expect(by.media).toMatchObject({ unit: 'brl', spent: 250, ceiling: 30_000, available: 29_750 });
  });

  it('carries the counts a person acts on', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    expect(overview.counts.disapprovedAds).toBe(1);
    expect(overview.counts.openAlerts).toBeGreaterThanOrEqual(1);
    expect(overview.counts.criticalAlerts).toBeGreaterThanOrEqual(1);
    expect(overview.counts.pendingApprovals).toBe(0);
    expect(overview.totalDays).toBe(30);
  });
});

describe('per platform', () => {
  it('compares the window with the one before it, per platform', async () => {
    const platforms = await read<DashboardPlatforms>('/ads/dashboard/platforms?days=7', 'platforms');
    expect(platforms.since).toBe('2026-09-10');
    expect(platforms.until).toBe('2026-09-16');
    expect(platforms.previousSince).toBe('2026-09-03');

    const meta = platforms.platforms.find((p) => p.platform === 'meta');
    expect(meta?.current.spendCents).toBe(40_000); // 12th to 15th
    expect(meta?.previous.spendCents).toBe(20_000); // 4th and 5th
    expect(meta?.current.videoPlays).toBeGreaterThan(0);
    expect(meta?.daily).toHaveLength(7);

    const google = platforms.platforms.find((p) => p.platform === 'google');
    expect(google?.current.spendCents).toBe(500);
    expect(google?.current.conversions).toBe(2);
    expect(google?.previous.spendCents).toBe(0);
    expect(platforms.metricsFetchedAt).toBe(NOW.toISOString());
  });
});

describe('campaigns down to the ad', () => {
  it('nests ad sets and ads under each campaign, with every campaign present', async () => {
    const result = await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns');
    const names = result.campaigns.map((campaign) => campaign.name);
    expect(names).toContain('LEAD | FORMS');
    expect(names).toContain('Institucional parada');
    expect(names).toContain('Pesquisa | Franquia');

    const leads = result.campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(leads?.platform).toBe('meta');
    expect(leads?.totals.spendCents).toBe(60_000);
    expect(leads?.alertCount).toBeGreaterThanOrEqual(1);
    expect(leads?.adSets).toHaveLength(1);
    const ads = leads?.adSets[0]?.ads ?? [];
    // The simulator files every creative as an image unless told otherwise.
    expect(ads.map((ad) => ad.format).sort()).toEqual(['image', 'image', 'video']);
    // The simulator splits each day three ways and rounds; the tree still adds up.
    const adSpend = ads.reduce((total, ad) => total + ad.totals.spendCents, 0);
    expect(Math.abs(adSpend - 60_000)).toBeLessThan(ads.length * META_DAYS.length);

    const google = result.campaigns.find((campaign) => campaign.name === 'Pesquisa | Franquia');
    expect(google?.platform).toBe('google');
    expect(google?.adSets).toEqual([]);
    expect(google?.totals.conversions).toBe(2);
  });
});

describe('creatives', () => {
  it('ranks formats and lists the ads that delivered, with a fatigue signal each', async () => {
    // Fourteen days: the 4th and 5th fall in the first half, the 12th to 15th in the second.
    const result = await read<DashboardCreatives>('/ads/dashboard/creatives?days=14', 'creatives');
    expect(result.formats.map((format) => format.format).sort()).toEqual(['image', 'video']);
    expect(result.formats.find((format) => format.format === 'image')?.ads).toBe(2);
    const video = result.creatives.find((creative) => creative.format === 'video');
    expect(video?.name).toBe('Reels 15s');
    expect(video?.campaignName).toBe('LEAD | FORMS');
    expect(video?.totals.videoPlays).toBeGreaterThan(0);
    // The simulator delivers evenly, so nothing is worn out.
    expect(video?.fatigue.wornOut).toBe(false);
    expect(video?.fatigue.firstHalfCtrMilli).not.toBeNull();
  });
});

describe('audience and region', () => {
  it('sums the breakdowns of both platforms over the window', async () => {
    const result = await read<DashboardAudience>('/ads/dashboard/audience?days=7', 'audience');
    expect(result.platforms.sort()).toEqual(['google', 'meta']);
    const placements = result.rows.filter((row) => row.kind === 'placement');
    expect(placements.map((row) => `${row.key}/${row.subKey}`)).toEqual(
      expect.arrayContaining(['instagram/reels', 'facebook/feed', 'youtube/']),
    );
    const reels = placements.find((row) => row.subKey === 'reels');
    // Four days in the window at 35% of R$ 100,00.
    expect(reels?.totals.spendCents).toBe(14_000);
    expect(result.rows.some((row) => row.kind === 'hour' && row.key === '20')).toBe(true);
    expect(result.rows.some((row) => row.kind === 'region' && row.key === 'São Paulo')).toBe(true);
  });
});
