import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  type DashboardAudience,
  type DashboardCampaigns,
  type DashboardCockpit,
  type DashboardCreatives,
  type DashboardOverview,
  type DashboardPlatforms,
  type DashboardFunnel,
  type DashboardSettings,
  type DashboardSite,
} from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import type { Database } from '../../../db/client.js';
import { eq } from 'drizzle-orm';
import {
  rdCrmDeals,
  ga4TrafficDaily,
  adCampaignDrafts,
  adCampaigns,
  agentConversations,
  agentMessages,
  ingestRuns,
  integrationConnections,
  mediaCreditLedger,
} from '../../../db/schema/index.js';
import { loadEnv } from '../../../env.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../../test/factories.js';
import { runAlerts } from '../alerts.js';
import { ingestBreakdown, recordAccountDay } from '../breakdowns.js';
import { engageKillSwitch, openPeriod, releaseKillSwitch } from '../budget-guard.js';
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
const META_DAYS = [
  '2026-09-04',
  '2026-09-05',
  '2026-09-12',
  '2026-09-13',
  '2026-09-14',
  '2026-09-15',
];

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
      ADS_INGEST_CRON: '0 * * * *',
      GA4_PROPERTY_ID: '123456789',
      GOOGLE_ADS_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_ADS_CLIENT_SECRET: 'not-a-real-secret',
      GA4_REFRESH_TOKEN: 'not-a-real-token',
      RD_CRM_API_TOKEN: 'not-a-real-token',
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
  for (const kind of ['placement', 'age_gender', 'region', 'hour', 'device'] as const) {
    await ingestBreakdown(db, meta, metaAccountId, kind, PERIOD, NOW);
  }
  await recordAccountDay(db, meta, metaAccountId, NOW);
  await runAlerts(db, metaAccountId, { now: NOW });

  // --- Google: one Search campaign, prepaid ---------------------------------
  const api = fakeGoogleApi({
    campaigns: [
      { id: '100', name: 'Pesquisa | Franquia', status: 'ENABLED', amountMicros: '5000000' },
    ],
    accountBudget: { limitMicros: '13100000000', servedMicros: '12600000000' },
    metrics: [
      {
        campaignId: '100',
        date: '2026-09-14',
        costMicros: '2500000',
        impressions: 500,
        clicks: 10,
        conversions: 1,
      },
      {
        campaignId: '100',
        date: '2026-09-15',
        costMicros: '2500000',
        impressions: 500,
        clicks: 10,
        conversions: 1,
      },
      {
        campaignId: '100',
        date: '2026-09-15',
        costMicros: '2500000',
        impressions: 500,
        clicks: 10,
        adNetworkType: 'YOUTUBE',
      },
      {
        campaignId: '100',
        date: '2026-09-15',
        costMicros: '2000000',
        impressions: 400,
        clicks: 8,
        device: 'MOBILE',
      },
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
  await ingestBreakdown(db, google, googleAccountId, 'device', PERIOD, NOW);
  await recordAccountDay(db, google, googleAccountId, NOW);

  // The ingest job's own record: the last run failed on the Google region split.
  await db.insert(ingestRuns).values({
    trigger: 'scheduled',
    status: 'failed',
    since: PERIOD,
    startedAt: new Date('2026-09-16T11:00:00.000Z'),
    finishedAt: new Date('2026-09-16T11:02:00.000Z'),
    accounts: [
      { platform: 'meta', externalId: metaExternalId, status: 'ok' },
      {
        platform: 'google',
        externalId: api.reader.customerId,
        status: 'failed',
        step: 'breakdown:region',
        error: 'GoogleAdsError: bad field',
      },
    ],
    site: { status: 'ok', posts: 3 },
    error: '1 conta(s) falharam',
  });

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
    expect(meta.killSwitch).toBeNull();
    expect(meta.daily.map((point) => point.day)).toContain('2026-09-15');
    expect(meta.daily.find((point) => point.day === '2026-09-15')?.amount).toBe(10_000);
    expect(meta.daily.find((point) => point.day === '2026-09-10')?.amount).toBe(0);
  });

  it('forecasts the month from the budgets in force, each campaign stopping at its end date', async () => {
    const mirrored = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, metaAccountId),
    });
    const saved = mirrored.map((campaign) => ({ ...campaign }));
    try {
      // One campaign at R$ 240,00 a day, ending on the 18th; everything else paused.
      await db
        .update(adCampaigns)
        .set({ status: 'PAUSED' })
        .where(eq(adCampaigns.adAccountId, metaAccountId));
      await db
        .update(adCampaigns)
        .set({
          status: 'ACTIVE',
          budgetLevel: 'campaign',
          dailyBudgetCents: 24_000,
          endDate: '2026-09-18',
        })
        .where(eq(adCampaigns.id, mirrored[0]!.id));
      const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
      const meta = overview.strips.find((strip) => strip.source === 'meta');
      // Day 16, nothing spent yet today: the rest of today, then the 17th and the 18th.
      expect(meta?.forecast).toBe(60_000 + 24_000 * 3);
      expect(meta?.forecastRule).toContain('R$ 240,00/dia');
      expect(meta?.forecastRule).toContain('data de fim');
      // Kairogen and AI keep the straight line, with no rule.
      expect(overview.strips.find((strip) => strip.source === 'ai')?.forecastRule).toBeNull();
    } finally {
      for (const campaign of saved) {
        await db
          .update(adCampaigns)
          .set({
            status: campaign.status,
            budgetLevel: campaign.budgetLevel,
            dailyBudgetCents: campaign.dailyBudgetCents,
            endDate: campaign.endDate,
          })
          .where(eq(adCampaigns.id, campaign.id));
      }
    }
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

  it('says when the ingest job last ran, what failed and when the next one is due', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    expect(overview.ingestion.lastRunAt).toBe('2026-09-16T11:00:00.000Z');
    expect(overview.ingestion.lastRunStatus).toBe('failed');
    expect(overview.ingestion.lastRunFailures).toEqual([
      { platform: 'google', step: 'breakdown:region' },
    ]);
    expect(overview.ingestion.schedule).toBe('0 * * * *');
    // NOW is 12:00 UTC; the hourly slot at 12:00 is within the grace period, and 11:00 ran.
    expect(overview.ingestion.nextRunAt).toBe('2026-09-16T13:00:00.000Z');
    expect(overview.ingestion.overdue).toBe(false);
  });

  it('answers the four health questions per account, with numbers and what to do', async () => {
    const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
    const keys = overview.health.map((item) => `${item.platform}:${item.key}`);
    expect(keys).toEqual([
      'meta:conversions_measuring',
      'meta:creative_fatigue',
      'meta:spend_pacing',
      'meta:active_without_results',
      'google:conversions_measuring',
      'google:creative_fatigue',
      'google:spend_pacing',
      'google:active_without_results',
    ]);
    const metaConversions = overview.health.find(
      (item) => item.platform === 'meta' && item.key === 'conversions_measuring',
    );
    // The fake pixel fires, so the account measures even without a lead in three days.
    expect(metaConversions?.state).toBe('ok');
    expect(metaConversions?.detail).toContain('Pixel Wings: ativo');
    expect(metaConversions?.detail).toContain('0 lead(s)');
    const googleConversions = overview.health.find(
      (item) => item.platform === 'google' && item.key === 'conversions_measuring',
    );
    expect(googleConversions?.state).toBe('ok');
    expect(googleConversions?.detail).toContain('2 lead(s)');
    // Nothing is judged without a state, a detail and an action rule.
    for (const item of overview.health) {
      expect(['ok', 'attention', 'problem', 'unknown']).toContain(item.state);
      expect(item.detail.length).toBeGreaterThan(10);
      if (item.state === 'ok') expect(item.action).toBe('');
    }
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
    const platforms = await read<DashboardPlatforms>(
      '/ads/dashboard/platforms?days=7',
      'platforms',
    );
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

describe('campaigns the system created', () => {
  it('carry the account id, the flag and the period of the draft that created them; the rest do not', async () => {
    const leads = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.externalId, 'c-leads'),
    });
    if (!leads) throw new Error('expected the leads campaign');
    await db.insert(adCampaignDrafts).values({
      adAccountId: metaAccountId,
      name: 'LEAD | FORMS',
      objective: 'lead',
      dailyBudgetCents: 24_000,
      startDate: '2026-09-28',
      endDate: '2026-10-02',
      payload: {},
      campaignId: leads.id,
    });
    const result = await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns');
    const created = result.campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(created).toMatchObject({
      systemCreated: true,
      startDate: '2026-09-28',
      endDate: '2026-10-02',
    });
    expect(created?.accountExternalId).toMatch(/^act_/);
    const byHand = result.campaigns.find((campaign) => campaign.name === 'Institucional parada');
    expect(byHand).toMatchObject({ systemCreated: false, startDate: null, endDate: null });
  });
});

describe('after the click: site and funnel', () => {
  it('shows the site by source and campaign, and follows each campaign and platform down to the sale', async () => {
    await db.insert(ga4TrafficDaily).values([
      // Matched to the Meta campaign by its own name, whatever the case.
      {
        propertyId: '123456789',
        day: '2026-09-15',
        source: 'facebook',
        medium: 'cpc',
        campaign: 'lead | forms',
        sessions: 40,
        engagedSessions: 30,
        engagementSeconds: 1200,
        pageViews: 80,
        keyEvents: 2,
      },
      {
        propertyId: '123456789',
        day: '2026-09-15',
        source: '(direct)',
        medium: '(none)',
        campaign: '(não definido)',
        sessions: 10,
        engagedSessions: 5,
        engagementSeconds: 100,
        pageViews: 12,
        keyEvents: 0,
      },
      // Outside the 7-day window.
      {
        propertyId: '123456789',
        day: '2026-09-01',
        source: 'facebook',
        medium: 'cpc',
        campaign: 'lead | forms',
        sessions: 999,
        engagedSessions: 0,
        engagementSeconds: 0,
        pageViews: 0,
        keyEvents: 0,
      },
    ]);
    const at = (day: string) => new Date(`${day}T12:00:00-03:00`);
    await db.insert(rdCrmDeals).values([
      {
        rdId: 'r1',
        pipeline: 'Formatação',
        stage: 'Proposta enviada',
        stageOrder: 4,
        reachedMeeting: true,
        win: null,
        createdAt: at('2026-09-14'),
        platform: 'meta',
        sourceLabel: 'Busca Paga | Facebook Ads',
      },
      {
        rdId: 'r2',
        pipeline: 'Formatação',
        stage: 'Sem contato',
        stageOrder: 1,
        reachedMeeting: false,
        win: null,
        createdAt: at('2026-09-15'),
        platform: 'meta',
      },
      {
        rdId: 'r3',
        pipeline: 'Vendidos',
        stage: 'Vendido',
        stageOrder: 1,
        reachedMeeting: true,
        win: true,
        createdAt: at('2026-09-12'),
        platform: 'google',
      },
      {
        rdId: 'r4',
        pipeline: 'Expansão',
        stage: 'Sem contato',
        stageOrder: 1,
        reachedMeeting: false,
        win: null,
        createdAt: at('2026-09-13'),
        platform: null,
      },
    ]);

    const site = await read<DashboardSite>('/ads/dashboard/site?days=7', 'site');
    expect(site.configured).toBe(true);
    expect(site.totals.sessions).toBe(50);
    expect(site.rows[0]).toMatchObject({
      source: 'facebook',
      campaign: 'lead | forms',
      sessions: 40,
    });

    const funnel = await read<DashboardFunnel>('/ads/dashboard/funnel?days=7', 'funnel');
    const leads = funnel.campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(leads).toMatchObject({ sessions: 40, matchedSiteCampaigns: ['lead | forms'] });
    expect(leads?.impressions).toBeGreaterThan(0);
    const meta = funnel.platforms.find((platform) => platform.platform === 'meta');
    expect(meta).toMatchObject({ sessions: 40, crmLeads: 2, meetings: 1, sales: 0 });
    expect(funnel.platforms.find((platform) => platform.platform === 'google')).toMatchObject({
      crmLeads: 1,
      meetings: 1,
      sales: 1,
    });
    expect(funnel.crmUnattributed).toBe(1);
    expect(funnel.crmConfigured).toBe(true);
  });
});

describe('verdicts and targets', () => {
  it('says "sem meta" for a leads campaign until a person confirms a target, then judges by it', async () => {
    await db
      .update(adCampaigns)
      .set({ objective: 'OUTCOME_LEADS' })
      .where(eq(adCampaigns.externalId, 'c-leads'));
    const before = await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns');
    const untargeted = before.campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(untargeted?.verdict.verdict).toBe('no_target');
    expect(untargeted?.verdict.primary).toBe('cpl');
    expect(untargeted?.verdict.reasons.find((reason) => reason.signal === 'cpl')?.text).toContain(
      'Sem meta',
    );
    // Google's Search campaign spent R$ 7,50: too little to judge.
    expect(
      before.campaigns.find((campaign) => campaign.name === 'Pesquisa | Franquia')?.verdict.verdict,
    ).toBe('insufficient');

    const settings = await read<DashboardSettings>('/ads/dashboard/settings', 'settings');
    expect(settings.targets.map((target) => target.objectiveKind)).toEqual(['leads', 'traffic']);
    expect(settings.targets[0]?.targetCents).toBeNull();
    // Two leads in the history are not enough for the system to propose a figure.
    expect(settings.targets[0]?.proposedCents).toBeNull();

    const cookies = await sessionFor('marketing');
    const put = await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/cpl-target',
      cookies,
      payload: { objectiveKind: 'leads', targetCents: 5000 },
    });
    expect(put.statusCode).toBe(200);
    const confirmed = (put.json() as { settings: DashboardSettings }).settings.targets[0];
    expect(confirmed).toMatchObject({ objectiveKind: 'leads', targetCents: 5000 });
    expect(confirmed?.confirmedAt).not.toBeNull();
    expect(confirmed?.confirmedByName).toBeTruthy();

    const after = await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns');
    const judged = after.campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    // R$ 600,00 spent and no lead against a R$ 50,00 target: negative, and the reason says so.
    expect(judged?.verdict.verdict).toBe('negative');
    const cpl = judged?.verdict.reasons.find((reason) => reason.signal === 'cpl');
    expect(cpl?.state).toBe('bad');
    // formatBrl joins "R$" and the figure with a non-breaking space.
    expect(cpl?.text).toMatch(/Nenhum lead com R\$\s600,00/);
    expect(cpl?.text).toMatch(/meta de R\$\s50,00/);
    expect(judged?.verdict.reasons.map((reason) => reason.signal)).toEqual([
      'cpl',
      'ctr',
      'trend',
      'frequency',
      'pacing',
    ]);
  });

  it("an account's own CPL target wins over the company's, and clearing it brings the company's back", async () => {
    // Runs after the test above confirmed the company-wide R$ 50,00.
    const cookies = await sessionFor('marketing');
    const settings = await read<DashboardSettings>('/ads/dashboard/settings', 'settings');
    const meta = settings.accountTargets.find((target) => target.adAccountId === metaAccountId);
    // The Meta suggestion fills the box; nothing is judged against it yet.
    expect(meta).toMatchObject({ platform: 'meta', targetCents: null, suggestedCents: 8590 });
    expect(
      settings.accountTargets.find((target) => target.platform === 'google')?.suggestedCents,
    ).toBeNull();

    const put = await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/account-cpl-target',
      cookies,
      payload: { adAccountId: metaAccountId, targetCents: 8590 },
    });
    expect(put.statusCode).toBe(200);
    const leads = (
      await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns')
    ).campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(leads?.targetCplCents).toBe(8590);
    expect(leads?.verdict.reasons.find((reason) => reason.signal === 'cpl')?.text).toMatch(
      /meta de R\$\s85,90/,
    );

    await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/account-cpl-target',
      cookies,
      payload: { adAccountId: metaAccountId, targetCents: null },
    });
    const back = (
      await read<DashboardCampaigns>('/ads/dashboard/campaigns?days=30', 'campaigns')
    ).campaigns.find((campaign) => campaign.name === 'LEAD | FORMS');
    expect(back?.targetCplCents).toBe(5000);

    const unknown = await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/account-cpl-target',
      cookies,
      payload: { adAccountId: '99999999-9999-4999-8999-999999999999', targetCents: 8590 },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a target from somebody who cannot request changes, and a bad one', async () => {
    const cookies = await sessionFor('vendedor_expansao');
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/cpl-target',
      cookies,
      payload: { objectiveKind: 'leads', targetCents: 5000 },
    });
    expect(forbidden.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/ads/dashboard/settings/cpl-target',
      cookies: await sessionFor('marketing'),
      payload: { objectiveKind: 'awareness', targetCents: 5000 },
    });
    expect(invalid.statusCode).toBe(400);
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

  it('splits by device on both platforms and maps weekday × hour from the hourly rows', async () => {
    const result = await read<DashboardAudience>('/ads/dashboard/audience?days=7', 'audience');
    const devices = result.rows.filter((row) => row.kind === 'device');
    expect(devices.map((row) => row.key).sort()).toEqual(['desktop', 'mobile', 'mobile_app']);
    // Four Meta days in the window at 70% of R$ 100,00.
    expect(devices.find((row) => row.key === 'mobile_app')?.totals.spendCents).toBe(28_000);
    expect(devices.find((row) => row.key === 'mobile')?.totals.spendCents).toBe(200);

    // 2026-09-12 is a Saturday and the 14th a Monday; the fake delivers at 09, 14 and 20.
    const saturday = result.heatmap.filter((cell) => cell.weekday === 6);
    expect(saturday.map((cell) => cell.hour)).toEqual(['09', '14', '20']);
    expect(saturday.find((cell) => cell.hour === '20')?.spendCents).toBe(4000);
    expect(result.heatmap.every((cell) => cell.impressions > 0)).toBe(true);
    expect(result.heatmap.some((cell) => cell.weekday === 1)).toBe(true);
  });
});

describe('the kill switch on the strip', () => {
  it('carries the rule, the reason and when it tripped', async () => {
    await engageKillSwitch(
      db,
      metaAccountId,
      'Orçamentos na plataforma excedem o limite planejado do mês',
    );
    try {
      const overview = await read<DashboardOverview>('/ads/dashboard/overview', 'overview');
      const meta = overview.strips.find((strip) => strip.source === 'meta');
      expect(meta?.killSwitchEngaged).toBe(true);
      expect(meta?.killSwitch?.rule).toBe('budgets_exceed_plan');
      expect(meta?.killSwitch?.reason).toContain('excedem o limite');
      expect(meta?.killSwitch?.engagedAt).toBeTruthy();
      expect(meta?.killSwitch?.accountExternalId).toMatch(/^act_/);
    } finally {
      await releaseKillSwitch(db, metaAccountId, 'teste');
    }
  });
});

describe('the cockpit', () => {
  it('refuses a campaign filter it does not know', async () => {
    const cookies = await sessionFor('marketing');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/dashboard/cockpit?days=7&campanhas=pausadas',
      cookies,
    });
    expect(response.statusCode).toBe(400);
  });

  it('sums only the campaigns delivering now, and lists ads that are on but not serving', async () => {
    const before = await read<DashboardCockpit>('/ads/dashboard/cockpit?days=7', 'cockpit');
    expect(before.activeCampaigns.map((campaign) => campaign.name).sort()).toEqual([
      'LEAD | FORMS',
      'Pesquisa | Franquia',
    ]);
    expect(before.adWarnings).toEqual([
      expect.objectContaining({
        adName: 'Reprovado',
        issue: 'DISAPPROVED',
        campaignName: 'LEAD | FORMS',
      }),
    ]);
    expect(before.creatives.map((creative) => creative.name)).not.toContain('Reprovado');
    expect(before.current.spendCents).toBeGreaterThan(0);
    // What the visual cards read: the budget in force, the split and "today".
    const google = before.activeCampaigns.find((campaign) => campaign.platform === 'google');
    expect(google?.dailyBudgetCents).toBe(500);
    expect(before.spendByPlatform.meta + before.spendByPlatform.google).toBe(
      before.current.spendCents,
    );
    expect(before.today).toBe('2026-09-16');
    // A target confirmed by an earlier test in this file reaches the gauge.
    expect(before.cplTargetCents).toBe(5000);

    // Google stops serving (the end date came, say): its spend leaves every figure.
    await db
      .update(adCampaigns)
      .set({ deliveryStatus: 'ENDED' })
      .where(eq(adCampaigns.externalId, '100'));
    try {
      const after = await read<DashboardCockpit>('/ads/dashboard/cockpit?days=7', 'cockpit');
      expect(after.activeCampaigns.map((campaign) => campaign.name)).toEqual(['LEAD | FORMS']);
      expect(after.current.spendCents).toBeLessThan(before.current.spendCents);
      expect(after.creatives.every((creative) => creative.platform === 'meta')).toBe(true);

      // "Todas": the ended campaign delivered in the window, so it is back in
      // every figure, marked as not delivering; Performance ativa does not move.
      const all = await read<DashboardCockpit>(
        '/ads/dashboard/cockpit?days=7&campanhas=todas',
        'cockpit',
      );
      expect(all.campaignScope).toBe('todas');
      expect(
        all.activeCampaigns.find((campaign) => campaign.platform === 'google')?.delivering,
      ).toBe(false);
      expect(all.current.spendCents).toBe(before.current.spendCents);
      expect(all.activePerformance).toEqual(after.activePerformance);
    } finally {
      await db
        .update(adCampaigns)
        .set({ deliveryStatus: 'SERVING' })
        .where(eq(adCampaigns.externalId, '100'));
    }
  });

  it('narrows every block to the campaigns picked, keeps the picker whole, and says why a figure is "—"', async () => {
    const all = await read<DashboardCockpit>('/ads/dashboard/cockpit?days=7', 'cockpit');
    expect(all.selection).toBeNull();
    expect(all.campaignOptions.map((option) => option.name).sort()).toEqual([
      'LEAD | FORMS',
      'Pesquisa | Franquia',
    ]);
    const meta = all.campaignOptions.find((option) => option.platform === 'meta')!;
    const google = all.campaignOptions.find((option) => option.platform === 'google')!;

    const onlyMeta = await read<DashboardCockpit>(
      `/ads/dashboard/cockpit?days=7&campanha=${meta.id}`,
      'cockpit',
    );
    // The picker still offers both; the figures are the picked one's alone.
    expect(onlyMeta.campaignOptions).toEqual(all.campaignOptions);
    expect(onlyMeta.activeCampaigns.map((campaign) => campaign.id)).toEqual([meta.id]);
    expect(onlyMeta.current.spendCents).toBe(onlyMeta.spendByPlatform.meta);
    expect(onlyMeta.spendByPlatform.google).toBe(0);
    expect(onlyMeta.current.spendCents).toBeLessThan(all.current.spendCents);
    expect(onlyMeta.daily.reduce((sum, day) => sum + day.spendCents, 0)).toBe(
      onlyMeta.current.spendCents,
    );
    expect(onlyMeta.creatives.every((creative) => creative.platform === 'meta')).toBe(true);
    // RD cannot split these by campaign: "—" and the reason, never the site-wide number.
    expect(onlyMeta.current.sessions).toBeNull();
    expect(onlyMeta.current.meetings).toBeNull();
    expect(onlyMeta.selection).toMatchObject({ ids: [meta.id], unknown: 0 });
    expect(onlyMeta.selection?.why.sessions).toContain('campanha');
    expect(onlyMeta.selection?.why.meetings).toContain('reuniões');

    // Two picked equal the unpicked view; an unknown id is ignored and counted.
    const both = await read<DashboardCockpit>(
      `/ads/dashboard/cockpit?days=7&campanha=${meta.id},${google.id},11111111-1111-4111-8111-111111111111`,
      'cockpit',
    );
    expect(both.current.spendCents).toBe(all.current.spendCents);
    expect(both.selection).toMatchObject({ unknown: 1 });
  });

  it('refuses a campaign list that is not ids', async () => {
    const cookies = await sessionFor('marketing');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/dashboard/cockpit?days=7&campanha=abc',
      cookies,
    });
    expect(response.statusCode).toBe(400);
  });
});
