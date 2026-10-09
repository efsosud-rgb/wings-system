import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adCampaigns, adSets } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { ensureAdAccount } from './metrics.js';
import { activeBudgetsOf } from './platform-reading.js';

/**
 * What the cockpit projects against the platform's spending limit when the schedule lives on the
 * ad sets (Meta): a stream per ad set where the ad sets hold the budget, each until its own end,
 * and the campaign ending with its ad sets when the campaign holds it.
 */

let harness: TestDatabase;
let db: Database;
let accountId: string;

const TODAY = '2026-10-09';

async function campaign(
  externalId: string,
  fields: Partial<typeof adCampaigns.$inferInsert>,
  sets: Partial<typeof adSets.$inferInsert>[],
) {
  const [row] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: accountId,
      externalId,
      name: `Campanha ${externalId}`,
      status: 'ACTIVE',
      startDate: '2026-10-01',
      ...fields,
    })
    .returning();
  for (const [index, set] of sets.entries()) {
    await db.insert(adSets).values({
      campaignId: row!.id,
      externalId: `${externalId}-s${index}`,
      name: `Conjunto ${index}`,
      status: 'ACTIVE',
      ...set,
    } as typeof adSets.$inferInsert);
  }
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  accountId = await ensureAdAccount(db, { platform: 'meta', externalId: 'act_7', name: 'Meta' });
  // Budget on the ad sets: two that are on, with their own ends, and one paused.
  await campaign('abo', { budgetLevel: 'ad_set' }, [
    { dailyBudgetCents: 10_000, endDate: '2026-10-17' },
    { dailyBudgetCents: 5_000, endDate: '2026-10-18' },
    { dailyBudgetCents: 8_000, status: 'PAUSED', endDate: null },
  ]);
  // Budget on the campaign, no end of its own: it ends with its only ad set that is on.
  await campaign('cbo-sets', { budgetLevel: 'campaign', dailyBudgetCents: 20_000 }, [
    { endDate: '2026-10-12' },
    { status: 'PAUSED', endDate: null },
  ]);
  // The campaign ends on the 20th and its ad set on the 30th: the 20th stands.
  await campaign(
    'cbo-own',
    { budgetLevel: 'campaign', dailyBudgetCents: 7_000, endDate: '2026-10-20' },
    [{ endDate: '2026-10-30' }],
  );
  // The ad set ended yesterday: out of the projection.
  await campaign('ended', { budgetLevel: 'campaign', dailyBudgetCents: 9_000 }, [
    { endDate: '2026-10-08' },
  ]);
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('the budgets the cockpit projects', () => {
  it('counts a stream per ad set where the ad sets hold the budget, each until its own end', async () => {
    const budgets = await activeBudgetsOf(db, accountId, TODAY);
    const abo = budgets
      .filter((budget) => budget.campaignExternalId === 'abo')
      .map((budget) => [budget.dailyBudgetCents, budget.endDate]);
    expect(abo.sort()).toEqual([
      [10_000, '2026-10-17'],
      [5_000, '2026-10-18'],
    ]);
  });

  it('ends a campaign that holds the budget with its ad sets that are on, or with its own end if earlier', async () => {
    const budgets = await activeBudgetsOf(db, accountId, TODAY);
    const of = (id: string) => budgets.filter((budget) => budget.campaignExternalId === id);
    expect(of('cbo-sets')).toEqual([
      expect.objectContaining({ dailyBudgetCents: 20_000, endDate: '2026-10-12' }),
    ]);
    expect(of('cbo-own')).toEqual([
      expect.objectContaining({ dailyBudgetCents: 7_000, endDate: '2026-10-20' }),
    ]);
  });

  it('leaves out what has ended', async () => {
    const budgets = await activeBudgetsOf(db, accountId, TODAY);
    expect(budgets.some((budget) => budget.campaignExternalId === 'ended')).toBe(false);
  });
});
