import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type CockpitSnapshot } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { adAlerts, adMetricsDaily } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { runAlerts } from './alerts.js';
import { openPeriod } from './budget-guard.js';
import { ensureAdAccount, syncAds } from './metrics.js';
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

async function sessionFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao') {
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
