import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaigns,
  adGuardrailEvents,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { getPeriodState, openPeriod, remainingDays } from './budget-guard.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { enforceReconciliationFreshness, reconcileAccount, syncCampaigns } from './reconcile.js';

const CAP = 400_000; // Meta: R$4.000,00
const USABLE_PERCENT = 70;
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

async function account(): Promise<string> {
  const [row] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!row) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: row.id,
    periodMonth: PERIOD,
    capCents: CAP,
    usablePercent: USABLE_PERCENT,
  });
  return row.id;
}

describe('syncing campaigns from the platform', () => {
  it('mirrors campaigns and their budgets', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [
        { id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 5000 },
        { id: 'c2', name: 'Remarketing', status: 'PAUSED', dailyBudgetCents: 3000 },
      ],
    });

    const synced = await syncCampaigns(db, client, id, NOW);
    expect(synced.campaigns).toBe(2);

    const stored = await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, id) });
    expect(stored).toHaveLength(2);
    expect(stored.find((c) => c.externalId === 'c1')?.dailyBudgetCents).toBe(5000);
  });

  it('is idempotent — running twice changes nothing', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 5000 }],
    });

    await syncCampaigns(db, client, id, NOW);
    await syncCampaigns(db, client, id, NOW);
    const stored = await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, id) });
    expect(stored).toHaveLength(1);
  });
});

describe('reconciling spend', () => {
  it('records reported spend and re-derives the period totals', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      spendCapCents: CAP,
      campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 4000 }],
    });
    client.simulateDay('2026-09-15');
    client.simulateDay('2026-09-16');
    client.settleReporting();

    const result = await reconcileAccount(db, client, id, NOW);

    expect(result.spendRowsRecorded).toBe(2);
    expect(result.spentCents).toBe(8000); // two days at R$40,00
    // Commitment reflects what is actually running: R$40/day x 15 days x 1.25
    expect(result.committedCents).toBe(4000 * remainingDays(NOW) * 1.25);
    expect(result.killSwitchEngaged).toBe(false);
  });

  it('keeps the newest figure when the platform revises a day', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 2000 }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);

    // The same day is reported again, revised upward.
    client.simulateDay('2026-09-16');
    client.settleReporting();
    const second = await reconcileAccount(db, client, id, new Date('2026-09-16T18:00:00Z'));

    // Latest snapshot wins rather than being added to the previous one.
    expect(second.spentCents).toBe(4000);
  });

  it('engages the kill switch when reported spend reaches the cap', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: CAP }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();

    const result = await reconcileAccount(db, client, id, NOW);
    expect(result.killSwitchEngaged).toBe(true);

    const row = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) });
    expect(row?.killSwitchEngaged).toBe(true);
  });

  it('detects a budget changed directly in Ads Manager, outside the system', async () => {
    const id = await account();
    // Someone raised the budget by hand on the platform, far beyond the plan.
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 50_000 }],
    });

    const result = await reconcileAccount(db, client, id, NOW);

    expect(result.outOfBandChangeDetected).toBe(true);
    expect(result.killSwitchEngaged).toBe(true);
    // The commitment is clamped to what the cap allows; it never records a
    // number the guardrail forbids.
    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.committedCents).toBeLessThanOrEqual(state?.usableCents ?? 0);

    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, id),
    });
    expect(events.some((e) => e.kind === 'usable_would_be_exceeded')).toBe(true);
  });

  it('does not lose spend that the platform has not reported yet', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      reportingLagMinutes: 60,
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 3000 }],
    });
    client.simulateDay('2026-09-16');

    // Reported spend is still zero even though money has been spent.
    const first = await reconcileAccount(db, client, id, NOW);
    expect(first.spentCents).toBe(0);
    expect(client.actualTotalSpendCents()).toBe(3000);

    client.settleReporting();
    const second = await reconcileAccount(db, client, id, NOW);
    expect(second.spentCents).toBe(3000);
  });
});

describe('dead-man switch', () => {
  it('stops spending when reconciliation goes stale', async () => {
    const id = await account();
    // Pin the last successful reconciliation well in the past, so the test
    // does not depend on when it happens to run.
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date(NOW.getTime() - 5 * 3600_000) })
      .where(eq(budgetPeriods.adAccountId, id));

    const stale = await enforceReconciliationFreshness(db, { maxAgeMinutes: 120, now: NOW });

    expect(stale.some((entry) => entry.accountId === id)).toBe(true);
    const row = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) });
    expect(row?.killSwitchEngaged).toBe(true);
    expect(row?.killSwitchReason).toMatch(/Reconciliação parada/);
  });

  it('leaves a freshly reconciled account alone', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 1000 }],
    });
    await reconcileAccount(db, client, id, NOW);

    const stale = await enforceReconciliationFreshness(db, {
      maxAgeMinutes: 120,
      now: new Date(NOW.getTime() + 30 * 60_000),
    });
    expect(stale.some((entry) => entry.accountId === id)).toBe(false);
  });
});

describe('ABO campaigns: the budget lives in the ad sets', () => {
  it('counts ad-set budgets as exposure when the campaign has none', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'abo1', name: 'ABO Institucional', status: 'ACTIVE' }],
      adSets: [
        { id: 'as1', campaignId: 'abo1', name: 'Interesses Franquia', dailyBudgetCents: 2000 },
        { id: 'as2', campaignId: 'abo1', name: 'Alto Padrão', dailyBudgetCents: 1500 },
      ],
    });

    const result = await reconcileAccount(db, client, id, NOW);

    expect(result.adSetsSynced).toBe(2);
    // R$35,00/day across two ad sets, not the R$0 the old model reported.
    expect(result.committedCents).toBe(3500 * remainingDays(NOW) * 1.25);
  });

  it('records where each campaign keeps its budget', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [
        { id: 'cbo1', name: 'CBO', status: 'ACTIVE', dailyBudgetCents: 4000 },
        { id: 'abo1', name: 'ABO', status: 'ACTIVE' },
        { id: 'none1', name: 'Sem orçamento', status: 'PAUSED' },
      ],
      adSets: [{ id: 'as1', campaignId: 'abo1', name: 'Conjunto', dailyBudgetCents: 1000 }],
    });

    await reconcileAccount(db, client, id, NOW);
    const stored = await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, id) });
    const level = (external: string) =>
      stored.find((campaign) => campaign.externalId === external)?.budgetLevel;

    expect(level('cbo1')).toBe('campaign');
    expect(level('abo1')).toBe('ad_set');
    expect(level('none1')).toBe('none');
  });

  it('ignores ad sets under a paused campaign, which cannot deliver', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'abo1', name: 'ABO pausada', status: 'PAUSED' }],
      adSets: [
        // Exactly the shape found on the real account: ACTIVE ad sets beneath
        // a PAUSED campaign, which spend nothing.
        { id: 'as1', campaignId: 'abo1', name: 'Ativo', status: 'ACTIVE', dailyBudgetCents: 2000 },
      ],
    });

    const result = await reconcileAccount(db, client, id, NOW);
    expect(result.adSetsSynced).toBe(1);
    expect(result.committedCents).toBe(0);
  });

  it('prefers the campaign budget when the campaign owns it', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'cbo1', name: 'CBO', status: 'ACTIVE', dailyBudgetCents: 3000 }],
      adSets: [{ id: 'as1', campaignId: 'cbo1', name: 'Conjunto', dailyBudgetCents: 9999 }],
    });

    const result = await reconcileAccount(db, client, id, NOW);
    // The CBO budget governs; ad-set figures must not be added on top.
    expect(result.committedCents).toBe(3000 * remainingDays(NOW) * 1.25);
  });

  it('detects an ad-set budget raised outside the system', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'abo1', name: 'ABO', status: 'ACTIVE' }],
      adSets: [{ id: 'as1', campaignId: 'abo1', name: 'Conjunto', dailyBudgetCents: 60_000 }],
    });

    const result = await reconcileAccount(db, client, id, NOW);
    expect(result.outOfBandChangeDetected).toBe(true);
    expect(result.killSwitchEngaged).toBe(true);
  });
});
