import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type DashboardOverview } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import type { Database } from '../../../db/client.js';
import { ingestRuns } from '../../../db/schema/index.js';
import { loadEnv } from '../../../env.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../../test/factories.js';
import { recordAccountDay } from '../breakdowns.js';
import { openPeriod } from '../budget-guard.js';
import { ensureAdAccount } from '../metrics.js';
import { FakeMetaClient } from '../platform/fake-meta-client.js';
import { reconcileAccount } from '../reconcile.js';

/**
 * What the overview says before the ingestion has anything to show: on
 * staging the Google strip read "não configurado" with the credentials set,
 * because no account row had been seeded. The strip must tell those two
 * situations apart, and the header must say when the scheduled ingestion
 * failed to run.
 */

const NOW = new Date('2026-09-22T14:20:00.000Z'); // 11:20 in São Paulo, a Tuesday
const META_ACCOUNT = 'act_123456789012345';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

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
      META_WRITE_TOKEN: 'not-a-real-token',
      META_WRITE_ACCOUNT_ID: META_ACCOUNT,
      GOOGLE_ADS_CLIENT_ID: 'client-id',
      GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
      GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
      GOOGLE_ADS_CUSTOMER_ID: '4268586278',
      ADS_INGEST_CRON: '0 * * * *',
    }),
    db,
    now: () => NOW,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function overview(): Promise<DashboardOverview> {
  const employee = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  const response = await app.inject({
    method: 'GET',
    url: '/ads/dashboard/overview',
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { overview: DashboardOverview }).overview;
}

describe('before the first ingestion', () => {
  it('tells credentials apart from a seeded account, and names the command', async () => {
    const result = await overview();
    const google = result.strips.find((strip) => strip.source === 'google');
    expect(google?.configured).toBe(true);
    expect(google?.setupNote).toContain('ainda não foi semeada');
    expect(google?.setupNote).toContain('--platform google --account 4268586278');
    expect(google?.spent).toBe(0);
    expect(google?.forecast).toBeNull();
    const meta = result.strips.find((strip) => strip.source === 'meta');
    expect(meta?.configured).toBe(true);
    expect(meta?.setupNote).toContain(`--platform meta --account ${META_ACCOUNT}`);
    expect(result.strips.find((strip) => strip.source === 'kairogen')?.setupNote).toBeNull();
    expect(result.health).toEqual([]);
  });

  it('says the scheduled ingestion is overdue when no run was ever recorded', async () => {
    const result = await overview();
    expect(result.ingestion.lastRunAt).toBeNull();
    expect(result.ingestion.lastRunStatus).toBeNull();
    expect(result.ingestion.schedule).toBe('0 * * * *');
    expect(result.ingestion.nextRunAt).toBe('2026-09-22T15:00:00.000Z');
    // The 14:00 slot is 20 minutes gone with nothing recorded.
    expect(result.ingestion.overdue).toBe(true);
  });
});

describe('after seeding and one run', () => {
  it('moves the note to "first ingestion pending", then drops it once the day is recorded', async () => {
    const accountId = await ensureAdAccount(db, {
      platform: 'meta',
      externalId: META_ACCOUNT,
      name: 'Fly High',
    });
    await openPeriod(db, {
      adAccountId: accountId,
      periodMonth: '2026-09-01',
      capCents: 400_000,
      usablePercent: 70,
    });
    const seeded = await overview();
    const meta = seeded.strips.find((strip) => strip.source === 'meta');
    expect(meta?.setupNote).toBe(
      'Conta semeada; a primeira ingestão ainda não gravou o dia da conta.',
    );

    const client = new FakeMetaClient({
      accountId: META_ACCOUNT,
      spendCapCents: 250_000,
      campaigns: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', dailyBudgetCents: 10_000 }],
      conversionSources: [{ id: 'px', name: 'Pixel Wings', status: 'inactive', lastEventAt: null }],
    });
    for (const day of ['2026-09-20', '2026-09-21']) client.simulateDay(day);
    await reconcileAccount(db, client, accountId, NOW);
    await recordAccountDay(db, client, accountId, NOW);
    await db.insert(ingestRuns).values({
      trigger: 'scheduled',
      status: 'ok',
      since: '2026-09-15',
      startedAt: new Date('2026-09-22T14:00:10.000Z'),
      finishedAt: new Date('2026-09-22T14:01:00.000Z'),
      accounts: [{ platform: 'meta', externalId: META_ACCOUNT, status: 'ok' }],
    });

    const result = await overview();
    expect(result.strips.find((strip) => strip.source === 'meta')?.setupNote).toBeNull();
    expect(result.ingestion).toMatchObject({
      lastRunAt: '2026-09-22T14:00:10.000Z',
      lastRunStatus: 'ok',
      lastRunFailures: [],
      overdue: false,
    });
    // An inactive pixel with no lead is a problem, whatever the spend.
    const conversions = result.health.find((item) => item.key === 'conversions_measuring');
    expect(conversions?.state).toBe('problem');
    expect(conversions?.detail).toContain('Pixel Wings: inativo');
    expect(conversions?.action).toContain('Gerenciador de Eventos');
  });
});
