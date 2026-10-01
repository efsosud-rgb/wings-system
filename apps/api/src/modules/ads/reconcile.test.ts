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
import {
  enforceReconciliationFreshness,
  reconcileAccount,
  reconciliationFreshness,
  syncCampaigns,
} from './reconcile.js';

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

describe('the month turned with no budget period (Eric, 01/10)', () => {
  it('still records the reading, touches no period and leaves spending blocked', async () => {
    const [row] = await db
      .insert(adAccounts)
      .values({ platform: 'meta', externalId: 'act_turned', name: 'Sem período' })
      .returning({ id: adAccounts.id });
    const id = row!.id;
    const client = new FakeMetaClient({
      spendCapCents: CAP,
      campaigns: [{ id: 'c-oct', name: 'Outubro', status: 'ACTIVE', dailyBudgetCents: 4000 }],
    });
    client.simulateDay('2026-10-01');
    client.settleReporting();
    const october = new Date('2026-10-01T15:00:00.000Z');

    const result = await reconcileAccount(db, client, id, october);

    expect(result).toMatchObject({
      periodMissing: true,
      campaignsSynced: 1,
      spendRowsRecorded: 1,
      spentCents: 4000,
      committedCents: 0,
      killSwitchEngaged: false,
    });
    expect(
      await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, id) }),
    ).toHaveLength(1);
    // No period was invented, and the write path still sees no reconciliation.
    expect(
      await db.query.budgetPeriods.findMany({ where: eq(budgetPeriods.adAccountId, id) }),
    ).toHaveLength(0);
    expect(await reconciliationFreshness(db, id, { now: october })).toMatchObject({
      fresh: false,
      reason: 'never_reconciled',
    });
    // Nor does the dead-man switch freeze an account that has no period to judge.
    expect(await enforceReconciliationFreshness(db, { now: october })).not.toContainEqual(
      expect.objectContaining({ accountId: id }),
    );

    // Once someone opens the month, the next reconciliation fills it from the same facts.
    await openPeriod(db, {
      adAccountId: id,
      periodMonth: '2026-10-01',
      capCents: CAP,
      usablePercent: USABLE_PERCENT,
    });
    const opened = await reconcileAccount(db, client, id, october);
    expect(opened.periodMissing).toBe(false);
    expect((await getPeriodState(db, id, '2026-10-01'))?.spentCents).toBe(4000);
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

describe('the platform limit reconciliation records', () => {
  it('uses the prepaid balance as remaining headroom, not spend_cap minus amount_spent', async () => {
    const id = await account();
    // The balance deliberately disagrees with a naive spend_cap - amount_spent:
    // spend_cap says 4.000,00 left, but the account actually has 500,00 loaded.
    const client = new FakeMetaClient({
      spendCapCents: 400_000,
      prepaidBalanceCents: 50_000,
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 1000 }],
    });

    await reconcileAccount(db, client, id, NOW);

    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.platformRemainingCents).toBe(50_000);
    expect(state?.platformLimitSource).toBe('meta.prepaid_balance');
  });

  it('keeps the existing spend_cap behaviour for a non-prepaid (card) account', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      spendCapCents: 250_000,
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 1000 }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();

    await reconcileAccount(db, client, id, NOW);

    const state = await getPeriodState(db, id, PERIOD);
    // spend_cap (250.000) minus the R$10,00 delivered.
    expect(state?.platformRemainingCents).toBe(250_000 - 1000);
    expect(state?.platformLimitSource).toBe('meta.spend_cap');
  });

  it('persists the platform warning as a human-readable note', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      permissionDenied: { funding: true },
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 1000 }],
    });

    await reconcileAccount(db, client, id, NOW);

    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.platformLimitNote).toMatch(/funding_source_details/);
    expect(state?.platformLimitSyncedAt).not.toBeNull();
  });

  it('leaves the note null when the platform answered without complaint', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      spendCapCents: 100_000,
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 1000 }],
    });

    await reconcileAccount(db, client, id, NOW);

    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.platformLimitNote).toBeNull();
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

  it('leaves an archived account alone — it never reconciles, by design', async () => {
    const id = await account();
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date(NOW.getTime() - 5 * 3600_000) })
      .where(eq(budgetPeriods.adAccountId, id));
    await db
      .update(adAccounts)
      .set({ archivedAt: NOW, archivedReason: 'conta errada' })
      .where(eq(adAccounts.id, id));

    const stale = await enforceReconciliationFreshness(db, { maxAgeMinutes: 120, now: NOW });

    expect(stale.some((entry) => entry.accountId === id)).toBe(false);
    const row = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) });
    expect(row?.killSwitchEngaged).toBe(false);
  });

  it('reports a period that was opened but never reconciled as unknown, not fresh', async () => {
    const id = await account();
    expect(await reconciliationFreshness(db, id, { now: NOW })).toMatchObject({
      fresh: false,
      reason: 'never_reconciled',
    });

    const client = new FakeMetaClient({ campaigns: [] });
    await reconcileAccount(db, client, id, NOW);
    expect(await reconciliationFreshness(db, id, { now: NOW })).toMatchObject({ fresh: true });
    expect(
      await reconciliationFreshness(db, id, { now: new Date(NOW.getTime() + 121 * 60_000) }),
    ).toMatchObject({ fresh: false, reason: 'stale', ageMinutes: 121 });
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
