import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccountDaily, adMetricsBreakdownDaily } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { ingestBreakdown, recordAccountDay } from './breakdowns.js';
import { openPeriod } from './budget-guard.js';
import { runIngestionCycle } from './ingest-cycle.js';
import { ensureAdAccount } from './metrics.js';
import { FAKE_BREAKDOWN_SHARES, FakeMetaClient } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const PERIOD = '2026-09-01';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

async function account(): Promise<{ id: string; externalId: string }> {
  const externalId = `act_${randomBytes(4).toString('hex')}`;
  const id = await ensureAdAccount(db, { platform: 'meta', externalId, name: 'Fly High' });
  await openPeriod(db, {
    adAccountId: id,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  return { id, externalId };
}

describe('ingesting a breakdown', () => {
  it('files each slice of each day under its campaign, and re-running rewrites rather than duplicates', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({
      accountId: externalId,
      campaigns: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', dailyBudgetCents: 10_000 }],
    });
    client.simulateDay('2026-09-14');
    client.simulateDay('2026-09-15');
    await reconcileAccount(db, client, id, NOW);

    const first = await ingestBreakdown(db, client, id, 'placement', '2026-09-14', NOW);
    expect(first.rows).toBe(2 * FAKE_BREAKDOWN_SHARES.placement.length);

    const stored = await db.query.adMetricsBreakdownDaily.findMany({
      where: and(
        eq(adMetricsBreakdownDaily.adAccountId, id),
        eq(adMetricsBreakdownDaily.kind, 'placement'),
      ),
    });
    expect(stored).toHaveLength(first.rows);
    // The campaign is linked by id, not only by the platform's string.
    expect(stored.every((row) => row.campaignId !== null)).toBe(true);
    const reels = stored.find((row) => row.day === '2026-09-14' && row.subKey === 'reels');
    expect(reels?.spendCents).toBe(3500);

    await ingestBreakdown(db, client, id, 'placement', '2026-09-14', NOW);
    const again = await db.query.adMetricsBreakdownDaily.findMany({
      where: and(
        eq(adMetricsBreakdownDaily.adAccountId, id),
        eq(adMetricsBreakdownDaily.kind, 'placement'),
      ),
    });
    expect(again).toHaveLength(first.rows);
  });

  it('leaves reach at zero where the platform gives none', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({
      accountId: externalId,
      campaigns: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', dailyBudgetCents: 10_000 }],
    });
    client.simulateDay('2026-09-15');
    await reconcileAccount(db, client, id, NOW);
    await ingestBreakdown(db, client, id, 'hour', '2026-09-15', NOW);

    const rows = await db.query.adMetricsBreakdownDaily.findMany({
      where: and(
        eq(adMetricsBreakdownDaily.adAccountId, id),
        eq(adMetricsBreakdownDaily.kind, 'hour'),
      ),
    });
    expect(rows.map((row) => row.key).sort()).toEqual(['09', '14', '20']);
    expect(rows.every((row) => row.reach === 0)).toBe(true);
  });
});

describe("the account's day", () => {
  it('records the budget in force: CBO campaigns plus the ad sets of active ABO campaigns', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({
      accountId: externalId,
      spendCapCents: 250_000,
      campaigns: [
        { id: 'cbo', name: 'CBO ativa', status: 'ACTIVE', dailyBudgetCents: 3000 },
        { id: 'cbo-off', name: 'CBO pausada', status: 'PAUSED', dailyBudgetCents: 9000 },
        { id: 'abo', name: 'ABO ativa', status: 'ACTIVE' },
        { id: 'abo-off', name: 'ABO pausada', status: 'PAUSED' },
      ],
      adSets: [
        { id: 'as-on', campaignId: 'abo', name: 'Conjunto ligado', dailyBudgetCents: 1000 },
        {
          id: 'as-off',
          campaignId: 'abo',
          name: 'Conjunto pausado',
          status: 'PAUSED',
          dailyBudgetCents: 2000,
        },
        // Its campaign is paused, so this ad set delivers nothing.
        { id: 'as-starved', campaignId: 'abo-off', name: 'Faminto', dailyBudgetCents: 5000 },
      ],
    });
    await reconcileAccount(db, client, id, NOW);

    const result = await recordAccountDay(db, client, id, NOW);
    expect(result.day).toBe('2026-09-16');
    expect(result.activeDailyBudgetCents).toBe(4000);
    expect(result.platformRemainingCents).toBe(250_000);
    expect(result.prepaidBalanceCents).toBeNull();

    const [row] = await db.query.adAccountDaily.findMany({
      where: eq(adAccountDaily.adAccountId, id),
    });
    expect(row?.spendCapCents).toBe(250_000);
    expect(row?.fundingKind).toBe('credit_card');
  });

  it('files a São Paulo evening under the local day and rewrites it on the next run', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({ accountId: externalId, prepaidBalanceCents: 80_000 });
    await reconcileAccount(db, client, id, NOW);

    // 01:00 UTC on the 17th is 22:00 on the 16th in São Paulo.
    await recordAccountDay(db, client, id, new Date('2026-09-17T01:00:00.000Z'));
    await recordAccountDay(db, client, id, new Date('2026-09-17T02:00:00.000Z'));

    const rows = await db.query.adAccountDaily.findMany({
      where: eq(adAccountDaily.adAccountId, id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.day).toBe('2026-09-16');
    expect(rows[0]?.prepaidBalanceCents).toBe(80_000);
    expect(rows[0]?.fundingKind).toBe('prepaid');
  });
});

describe('inside the ingestion cycle', () => {
  it('runs the breakdowns and the account day after the metrics, and reports them', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({
      accountId: externalId,
      campaigns: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', dailyBudgetCents: 2000 }],
    });
    client.simulateDay('2026-09-15');

    const cycle = await runIngestionCycle(db, [{ id, platform: 'meta', externalId }], {
      clientFor: () => client,
      since: '2026-09-10',
      now: NOW,
    });
    const [result] = cycle.accounts;
    if (result?.status !== 'ok') throw new Error(`cycle ${result?.status ?? 'missing'}`);
    expect(result.breakdowns.placement.rows).toBeGreaterThan(0);
    expect(result.breakdowns.hour.rows).toBeGreaterThan(0);
    expect(result.accountDay.day).toBe('2026-09-16');
    expect(result.accountDay.activeDailyBudgetCents).toBe(2000);
  });
});

describe('device and conversion sources', () => {
  it('files the device split like any other, keyed by the platform name', async () => {
    const { id, externalId } = await account();
    const client = new FakeMetaClient({
      accountId: externalId,
      campaigns: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', dailyBudgetCents: 10_000 }],
    });
    client.simulateDay('2026-09-15');
    await reconcileAccount(db, client, id, NOW);
    const result = await ingestBreakdown(db, client, id, 'device', '2026-09-15', NOW);
    expect(result.rows).toBe(FAKE_BREAKDOWN_SHARES.device.length);

    const rows = await db.query.adMetricsBreakdownDaily.findMany({
      where: and(
        eq(adMetricsBreakdownDaily.adAccountId, id),
        eq(adMetricsBreakdownDaily.kind, 'device'),
      ),
    });
    expect(rows.map((row) => row.key).sort()).toEqual(['desktop', 'mobile_app']);
    expect(rows.find((row) => row.key === 'mobile_app')?.spendCents).toBe(7000);
  });

  it('writes what the platform says about its conversion sources, and null when the read fails', async () => {
    const { id, externalId } = await account();
    const measuring = new FakeMetaClient({
      accountId: externalId,
      conversionSources: [{ id: 'px', name: 'Pixel', status: 'inactive', lastEventAt: null }],
    });
    await reconcileAccount(db, measuring, id, NOW);
    await recordAccountDay(db, measuring, id, NOW);
    const [row] = await db.select().from(adAccountDaily).where(eq(adAccountDaily.adAccountId, id));
    expect(row?.conversionSources).toEqual([
      { id: 'px', name: 'Pixel', status: 'inactive', lastEventAt: null },
    ]);

    const broken = new FakeMetaClient({
      accountId: externalId,
      conversionSources: () => {
        throw new Error('pixel unreadable');
      },
    });
    // The day is still recorded: the read is a courtesy, not a step that can fail the cycle.
    await expect(recordAccountDay(db, broken, id, NOW)).resolves.toMatchObject({
      day: '2026-09-16',
    });
    const [again] = await db
      .select()
      .from(adAccountDaily)
      .where(eq(adAccountDaily.adAccountId, id));
    expect(again?.conversionSources).toBeNull();
  });
});
