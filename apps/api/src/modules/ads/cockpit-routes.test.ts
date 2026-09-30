import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type CockpitSnapshot } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAlerts,
  adCampaigns,
  adMetricsDaily,
  budgetPeriods,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { runAlerts } from './alerts.js';
import { getPeriodState, openPeriod } from './budget-guard.js';
import { ensureAdAccount, syncAds } from './metrics.js';
import { fakeMetaApi } from './platform/fake-meta-api.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const PERIOD = '2026-09-01';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let accountId: string;

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
    }),
    db,
    now: () => NOW,
  });

  accountId = await ensureAdAccount(db, {
    platform: 'meta',
    externalId: `act_${randomBytes(4).toString('hex')}`,
    name: 'Wings Matriz',
  });
  await openPeriod(db, {
    adAccountId: accountId,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });

  const client = new FakeMetaClient({
    campaigns: [
      { id: 'c-live', name: 'LEAD | FORMS', status: 'ACTIVE', dailyBudgetCents: 3000 },
      { id: 'c-idle', name: 'Institucional parada', status: 'PAUSED', dailyBudgetCents: 2000 },
    ],
    adSets: [{ id: 'as1', campaignId: 'c-live', name: 'Conjunto' }],
    ads: [
      {
        id: 'ad-bad',
        campaignId: 'c-live',
        adSetId: 'as1',
        name: 'Anúncio reprovado',
        effectiveStatus: 'DISAPPROVED',
        reviewFeedback: { global: { 'Práticas de negócios inaceitáveis': 'Viola os padrões.' } },
      },
    ],
  });
  await reconcileAccount(db, client, accountId, NOW);
  await syncAds(db, client, accountId, NOW);
  await db.insert(adMetricsDaily).values({
    adAccountId: accountId,
    level: 'campaign',
    entityExternalId: 'c-live',
    day: '2026-09-15',
    spendCents: 4_500,
    impressions: 2000,
    clicks: 40,
    conversions: 0,
    actions: { link_click: 40 },
    fetchedAt: NOW,
  });
  await runAlerts(db, accountId, { now: NOW });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao' | 'diretoria') {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'vendedor_expansao' ? 'comercial' : role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employee, cookies: { [SESSION_COOKIE]: token } };
}

async function cockpit(cookies: Record<string, string>): Promise<CockpitSnapshot> {
  const response = await app.inject({ method: 'GET', url: '/ads/cockpit', cookies });
  expect(response.statusCode).toBe(200);
  return (response.json() as { cockpit: CockpitSnapshot }).cockpit;
}

describe('who may open the cockpit', () => {
  it('lets Marketing in', async () => {
    const { cookies } = await sessionFor('marketing');
    const response = await app.inject({ method: 'GET', url: '/ads/cockpit', cookies });
    expect(response.statusCode).toBe(200);
  });

  it('keeps a salesperson out', async () => {
    const { cookies } = await sessionFor('vendedor_expansao');
    const response = await app.inject({ method: 'GET', url: '/ads/cockpit', cookies });
    expect(response.statusCode).toBe(403);
  });

  it('refuses an anonymous request', async () => {
    const response = await app.inject({ method: 'GET', url: '/ads/cockpit' });
    expect(response.statusCode).toBe(401);
  });
});

describe('what the cockpit shows', () => {
  it('lists every campaign, including those that never delivered', async () => {
    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);

    const names = snapshot.campaigns.map((campaign) => campaign.name);
    expect(names).toContain('LEAD | FORMS');
    // A paused campaign with no metrics still belongs on screen.
    expect(names).toContain('Institucional parada');

    const idle = snapshot.campaigns.find((c) => c.name === 'Institucional parada');
    expect(idle?.spendCents).toBe(0);
    expect(idle?.costPerLeadCents).toBeNull();
  });

  it('leaves cost per lead empty rather than passing off a cost per click', async () => {
    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);

    const live = snapshot.campaigns.find((c) => c.name === 'LEAD | FORMS');
    expect(live?.spendCents).toBe(4_500);
    expect(live?.clicks).toBe(40);
    expect(live?.conversions).toBe(0);
    expect(live?.costPerLeadCents).toBeNull();
  });

  it('reports the month against the cap', async () => {
    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);

    expect(snapshot.pacing?.capCents).toBe(400_000);
    expect(snapshot.pacing?.usableCents).toBe(280_000);
    expect(snapshot.pacing?.periodMonth).toBe(PERIOD);
    expect(snapshot.pacing?.killSwitchEngaged).toBe(false);
  });

  it('surfaces the rejected ad with its real reason, badged on its campaign', async () => {
    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);

    const alert = snapshot.alerts.find((item) => item.kind === 'ad_rejected');
    expect(alert?.severity).toBe('critical');
    expect(JSON.stringify(alert?.detail)).toContain('inaceitáveis');

    // The alert is on an ad; the badge belongs to the campaign above it.
    const live = snapshot.campaigns.find((c) => c.name === 'LEAD | FORMS');
    expect(live?.alertCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.counts.disapprovedAds).toBe(1);
  });
});

describe('acknowledging an alert', () => {
  it('records the person and refuses a second time', async () => {
    const { cookies, employee } = await sessionFor('admin_master');
    const [alert] = await db.query.adAlerts.findMany({
      where: eq(adAlerts.adAccountId, accountId),
    });
    if (!alert) throw new Error('no alert stored');

    const first = await app.inject({
      method: 'POST',
      url: `/ads/alerts/${alert.id}/acknowledge`,
      cookies,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/ads/alerts/${alert.id}/acknowledge`,
      cookies,
    });
    expect(second.statusCode).toBe(409);

    const stored = await db.query.adAlerts.findFirst({ where: eq(adAlerts.id, alert.id) });
    expect(stored?.acknowledgedBy).toBe(employee.id);
    // Acknowledging is not resolving: the ad is still rejected.
    expect(stored?.resolvedAt).toBeNull();
  });
});

describe('multi-account: the platform param and the Wings total', () => {
  let googleAccountId: string;

  beforeAll(async () => {
    googleAccountId = await ensureAdAccount(db, {
      platform: 'google',
      externalId: '4268586278',
      name: 'Wings Company — Google Ads',
    });
    await openPeriod(db, {
      adAccountId: googleAccountId,
      periodMonth: PERIOD,
      capCents: 250_000,
      usablePercent: 70,
    });
  });

  it('resolves the same account by default and by ?platform=meta', async () => {
    const { cookies } = await sessionFor('marketing');
    const byDefault = await cockpit(cookies);
    const response = await app.inject({
      method: 'GET',
      url: '/ads/cockpit?platform=meta',
      cookies,
    });
    expect(response.statusCode).toBe(200);
    const byPlatform = (response.json() as { cockpit: CockpitSnapshot }).cockpit;
    expect(byPlatform.account.id).toBe(byDefault.account.id);
    expect(byPlatform.account.platform).toBe('meta');
  });

  it('resolves the Google account with ?platform=google', async () => {
    const { cookies } = await sessionFor('marketing');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/cockpit?platform=google',
      cookies,
    });
    expect(response.statusCode).toBe(200);
    const snapshot = (response.json() as { cockpit: CockpitSnapshot }).cockpit;
    expect(snapshot.account.id).toBe(googleAccountId);
    expect(snapshot.account.platform).toBe('google');
  });

  it('404s — never a fake zeroed response — when the requested platform has no account', async () => {
    // Archived is history: briefly archive the only Google account, then
    // restore it, rather than standing up a whole second database.
    await db
      .update(adAccounts)
      .set({ archivedAt: NOW, archivedReason: 'teste' })
      .where(eq(adAccounts.id, googleAccountId));

    const { cookies } = await sessionFor('marketing');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/cockpit?platform=google',
      cookies,
    });
    expect(response.statusCode).toBe(404);

    await db
      .update(adAccounts)
      .set({ archivedAt: null, archivedReason: null })
      .where(eq(adAccounts.id, googleAccountId));
  });

  it('sums the Wings total across every account with an open period this month', async () => {
    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);
    // Meta: cap 400.000, usable 280.000, committed R$40/day x 15 days x 1.25
    // from the LEAD | FORMS campaign seeded at module setup. Google: cap
    // 250.000, usable 175.000, never reconciled so nothing committed yet.
    expect(snapshot.wingsTotal).toEqual({
      capCents: 400_000 + 250_000,
      usableCents: 280_000 + 175_000,
      committedCents: 3000 * 15 * 1.25,
      spentCents: 0,
    });
  });

  it('skips an account with no open period this month, without nulling the total', async () => {
    await ensureAdAccount(db, {
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Sem período aberto',
    });

    const { cookies } = await sessionFor('marketing');
    const snapshot = await cockpit(cookies);
    // Unchanged from the previous test: the bare account adds nothing.
    expect(snapshot.wingsTotal?.capCents).toBe(400_000 + 250_000);
  });
});

describe('admin-only budget cap editing', () => {
  it('refuses a role without ads.budget_caps.manage, even one that can approve budget changes', async () => {
    const { cookies } = await sessionFor('diretoria');
    const response = await app.inject({
      method: 'POST',
      url: `/ads/accounts/${accountId}/budget-cap`,
      cookies,
      payload: { capCents: 500_000, usablePercent: 70, reason: 'teste de permissão' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses the listing route to the same non-admin role', async () => {
    const { cookies } = await sessionFor('diretoria');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/accounts/budget-caps',
      cookies,
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets an Admin Master open a new cap, using the same write the CLI has always used', async () => {
    const { cookies } = await sessionFor('admin_master');
    const response = await app.inject({
      method: 'POST',
      url: `/ads/accounts/${accountId}/budget-cap`,
      cookies,
      payload: { capCents: 500_000, usablePercent: 80, reason: 'Reajuste combinado com o Eric' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      account: {
        capCents: number | null;
        usableCents: number | null;
        usablePercent: number | null;
      };
    };
    expect(body.account.capCents).toBe(500_000);
    expect(body.account.usableCents).toBe(400_000);
    expect(body.account.usablePercent).toBe(80);

    const state = await getPeriodState(db, accountId, PERIOD);
    expect(state?.capCents).toBe(500_000);
  });

  it('lists every account with its current cap for the admin screen', async () => {
    const { cookies } = await sessionFor('admin_master');
    const response = await app.inject({
      method: 'GET',
      url: '/ads/accounts/budget-caps',
      cookies,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accounts: { accountId: string; capCents: number | null }[];
    };
    const row = body.accounts.find((a) => a.accountId === accountId);
    expect(row?.capCents).toBe(500_000);
  });
});

describe('manual reconciliation ("Atualizar agora")', () => {
  let manualAccountId: string;
  let manualExternalId: string;
  let reconcileApp: FastifyInstance;

  beforeAll(async () => {
    manualExternalId = `act_${randomBytes(4).readUInt32BE(0)}`;
    manualAccountId = await ensureAdAccount(db, {
      platform: 'meta',
      externalId: manualExternalId,
      name: 'Conta para reconciliação manual',
    });
    await openPeriod(db, {
      adAccountId: manualAccountId,
      periodMonth: PERIOD,
      capCents: 100_000,
      usablePercent: 70,
    });
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Campanha', status: 'ACTIVE', dailyBudgetCents: 1000 }],
    });
    await reconcileAccount(db, client, manualAccountId, NOW);

    // A second app, with read credentials for this one account, so the route
    // can really call `createPlatformClient` and reconcile against a scripted
    // Meta — the shared `app` above has none, on purpose (see routes.test.ts).
    const meta = fakeMetaApi({ accountId: manualExternalId });
    meta.state.campaigns.push({
      id: 'c2',
      name: 'Campanha nova',
      status: 'ACTIVE',
      daily_budget: '2000',
    });
    reconcileApp = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: randomBytes(48).toString('base64'),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: 'https://staging.wingssystem.online',
        META_WRITE_TOKEN: 'token',
      }),
      db,
      now: () => NOW,
      platformFetch: meta.impl,
    });
  });

  afterAll(async () => {
    await reconcileApp?.close();
  });

  it('refuses a role without ads.reconcile.manual', async () => {
    const { cookies } = await sessionFor('marketing');
    const response = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${manualAccountId}/reconcile-now`,
      cookies,
    });
    expect(response.statusCode).toBe(403);
  });

  it('404s for an unknown account', async () => {
    const { cookies } = await sessionFor('admin_master');
    const response = await reconcileApp.inject({
      method: 'POST',
      url: '/ads/accounts/00000000-0000-0000-0000-000000000000/reconcile-now',
      cookies,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a repeated click inside the cooldown, for Admin Master and for Diretoria alike', async () => {
    // The setup's own reconcileAccount just set lastReconciledAt to NOW.
    const admin = await sessionFor('admin_master');
    const first = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${manualAccountId}/reconcile-now`,
      cookies: admin.cookies,
    });
    expect(first.statusCode).toBe(429);
    expect(first.json()).toMatchObject({ error: 'reconcile_cooldown' });

    const diretoria = await sessionFor('diretoria');
    const second = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${manualAccountId}/reconcile-now`,
      cookies: diretoria.cookies,
    });
    expect(second.statusCode).toBe(429);
  });

  it('really reconciles against the platform once the cooldown has passed, and records the freshness', async () => {
    // Backdate past the 30s cooldown without waiting for it in the test.
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date(NOW.getTime() - 31_000) })
      .where(eq(budgetPeriods.adAccountId, manualAccountId));

    const { cookies } = await sessionFor('admin_master');
    const response = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${manualAccountId}/reconcile-now`,
      cookies,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: true; lastReconciledAt: string | null };
    expect(body.ok).toBe(true);
    expect(body.lastReconciledAt).toBe(NOW.toISOString());

    const state = await getPeriodState(db, manualAccountId, PERIOD);
    expect(state?.lastReconciledAt?.toISOString()).toBe(NOW.toISOString());
    // The scripted Meta answered two campaigns, not the one the setup seeded:
    // a real reconcileAccount ran, not a stub answer.
    const campaigns = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, manualAccountId),
    });
    expect(campaigns.map((c) => c.externalId).sort()).toEqual(['c1', 'c2']);
  });

  it('lets Diretoria trigger it too, once the cooldown has passed again', async () => {
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date(NOW.getTime() - 31_000) })
      .where(eq(budgetPeriods.adAccountId, manualAccountId));

    const { cookies } = await sessionFor('diretoria');
    const response = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${manualAccountId}/reconcile-now`,
      cookies,
    });
    expect(response.statusCode).toBe(200);
  });

  it('answers 503 for an account whose platform has no read credentials', async () => {
    const orphanId = await ensureAdAccount(db, {
      platform: 'google',
      externalId: '1234567890',
      name: 'Conta sem credenciais no ambiente de teste',
    });
    await openPeriod(db, {
      adAccountId: orphanId,
      periodMonth: PERIOD,
      capCents: 100_000,
      usablePercent: 70,
    });

    const { cookies } = await sessionFor('admin_master');
    const response = await reconcileApp.inject({
      method: 'POST',
      url: `/ads/accounts/${orphanId}/reconcile-now`,
      cookies,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'no_credentials' });
  });
});

describe("the platform's own figures on the builder (bloco 11)", () => {
  let figuresAccountId: string;
  let meta: ReturnType<typeof fakeMetaApi>;
  let figuresApp: FastifyInstance;
  let clock = NOW;

  beforeAll(async () => {
    const externalId = `act_${randomBytes(4).readUInt32BE(0)}`;
    figuresAccountId = await ensureAdAccount(db, {
      platform: 'meta',
      externalId,
      name: 'Conta com limite de gastos',
    });
    await openPeriod(db, {
      adAccountId: figuresAccountId,
      periodMonth: PERIOD,
      capCents: 400_000,
      usablePercent: 70,
    });
    // What act_694058302567457 answered on 2026-09-30.
    meta = fakeMetaApi({
      accountId: externalId,
      spendCapCents: '250000',
      amountSpentCents: '152084',
      balanceCents: '6008',
    });
    figuresApp = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: randomBytes(48).toString('base64'),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: 'https://staging.wingssystem.online',
        META_WRITE_TOKEN: 'token',
      }),
      db,
      now: () => clock,
      platformFetch: meta.impl,
    });
  });

  afterAll(async () => {
    await figuresApp?.close();
  });

  async function reading(cookies: Record<string, string>) {
    const response = await figuresApp.inject({
      method: 'GET',
      url: `/ads/cockpit?accountId=${figuresAccountId}`,
      cookies,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { cockpit: CockpitSnapshot }).cockpit.pacing?.platformReading;
  }

  const refresh = (cookies: Record<string, string>) =>
    figuresApp.inject({
      method: 'POST',
      url: `/ads/accounts/${figuresAccountId}/platform-refresh`,
      cookies,
    });

  it('reads the account when the builder opens, for anyone who may see it', async () => {
    const { cookies } = await sessionFor('marketing');
    expect((await reading(cookies))?.status).toBe('never');

    const response = await refresh(cookies);
    expect(response.json()).toEqual({ refreshed: true });

    const figures = await reading(cookies);
    expect(figures).toMatchObject({
      status: 'ok',
      readAtIso: NOW.toISOString(),
      spendCapCents: 250_000,
      amountSpentCents: 152_084,
      spendCapRemainingCents: 97_916,
      amountDueCents: 6_008,
      // The scripted Meta answers no funding_source_details at all.
      fundingKind: null,
      spendCapReset: null,
      spendCapResetsOn: null,
    });
  });

  it('skips the platform call when the account was read in the last two minutes', async () => {
    const { cookies } = await sessionFor('marketing');
    const before = meta.calls.length;
    clock = new Date(NOW.getTime() + 60_000);
    const response = await refresh(cookies);
    expect(response.json()).toEqual({ refreshed: false, reason: 'recent' });
    expect(meta.calls.length).toBe(before);
    clock = NOW;
  });

  it('records the monthly reset as the account rule, only for who manages caps', async () => {
    const marketing = await sessionFor('marketing');
    const refused = await figuresApp.inject({
      method: 'PUT',
      url: `/ads/accounts/${figuresAccountId}/spend-cap-reset`,
      payload: { reset: 'monthly' },
      cookies: marketing.cookies,
    });
    expect(refused.statusCode).toBe(403);

    const admin = await sessionFor('admin_master');
    const response = await figuresApp.inject({
      method: 'PUT',
      url: `/ads/accounts/${figuresAccountId}/spend-cap-reset`,
      payload: { reset: 'monthly' },
      cookies: admin.cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(await reading(admin.cookies)).toMatchObject({
      spendCapReset: 'monthly',
      spendCapResetsOn: '2026-10-01',
    });
  });

  it('shows no figure, and why, once a read fails — never the old one', async () => {
    const { cookies } = await sessionFor('marketing');
    meta.state.accountError = { code: 190, message: 'Error validating access token' };
    clock = new Date(NOW.getTime() + 3 * 60_000);
    const response = await refresh(cookies);
    expect(response.json()).toEqual({ refreshed: false, reason: 'failed' });

    const figures = await reading(cookies);
    expect(figures?.status).toBe('failed');
    expect(figures?.reason).toMatch(/a última leitura falhou: .*190/);
    expect(figures?.attemptedAtIso).toBe(clock.toISOString());
    expect(figures?.readAtIso).toBe(NOW.toISOString());
    expect(figures?.spendCapRemainingCents).toBeNull();
    expect(figures?.amountDueCents).toBeNull();

    // The next good read clears it.
    meta.state.accountError = undefined;
    clock = new Date(NOW.getTime() + 6 * 60_000);
    await refresh(cookies);
    expect((await reading(cookies))?.status).toBe('ok');
    clock = NOW;
  });

  it('calls a read older than three missed cycles stale', async () => {
    const { cookies } = await sessionFor('marketing');
    clock = new Date(NOW.getTime() + 6 * 60_000 + 46 * 60_000);
    const figures = await reading(cookies);
    expect(figures?.status).toBe('stale');
    expect(figures?.spendCapRemainingCents).toBeNull();
    clock = NOW;
  });

  it('records a failed scheduled reconciliation the same way', async () => {
    const failing = new FakeMetaClient({ campaigns: [] });
    failing.listCampaigns = () => Promise.reject(new Error('Graph 500'));
    await expect(reconcileAccount(db, failing, figuresAccountId, NOW)).rejects.toThrow();
    const [period] = await db
      .select()
      .from(budgetPeriods)
      .where(eq(budgetPeriods.adAccountId, figuresAccountId));
    expect(period?.platformReadError).toBe('Error: Graph 500');
  });
});
