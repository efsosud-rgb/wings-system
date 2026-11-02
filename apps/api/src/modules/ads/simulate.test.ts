import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, adApprovalRequests, adCampaigns, adSets } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { gateChange } from './approvals.js';
import { nextPendingInGroup, pendingGroups } from './batches.js';
import { openPeriod, remainingDays, reserveChange } from './budget-guard.js';
import { simulateChange } from './simulate.js';

/**
 * The simulator is decision support for a person about to move real money, so
 * these tests care most about two things: that its arithmetic is the guard's
 * own, and that it tells the truth about *when* exposure is reserved.
 */

// Mid-month, so there are days left to expose but the month is well under way.
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

interface Scene {
  accountId: string;
  campaignId: string;
  changeRequestId: string;
  approvalId: string;
}

async function scene(
  options: {
    campaignDailyBudgetCents?: number;
    toDailyBudgetCents?: number;
    kind?: 'set_daily_budget' | 'pause_campaign' | 'resume_campaign';
    budgetLevel?: 'campaign' | 'ad_set';
    capCents?: number;
    campaignName?: string;
  } = {},
): Promise<Scene> {
  const [account] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');

  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: options.capCents ?? 400_000,
    usablePercent: 70,
  });

  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: account.id,
      externalId: `c_${randomBytes(4).toString('hex')}`,
      name: options.campaignName ?? 'Institucional',
      status: 'ACTIVE',
      // A pause scene starts from a running budget: since part 2 of the
      // budget locks the mirror alone holds its exposure (docs/ads/travas.md).
      dailyBudgetCents:
        options.kind === 'pause_campaign'
          ? (options.campaignDailyBudgetCents ?? 3000)
          : (options.campaignDailyBudgetCents ?? 0),
      budgetLevel: options.budgetLevel ?? 'campaign',
      lastSyncedAt: NOW,
    })
    .returning({ id: adCampaigns.id });
  if (!campaign) throw new Error('failed');

  const reserved = await reserveChange(db, {
    adAccountId: account.id,
    campaignId: campaign.id,
    kind: options.kind ?? 'set_daily_budget',
    toDailyBudgetCents: options.toDailyBudgetCents ?? 2000,
    now: NOW,
  });
  if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);

  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId, now: NOW });

  return {
    accountId: account.id,
    campaignId: campaign.id,
    changeRequestId: reserved.value.changeRequestId,
    approvalId: gate.approvalId ?? '',
  };
}

describe('what the simulator projects', () => {
  it('uses the guard’s own exposure maths, overdelivery included', async () => {
    const { changeRequestId } = await scene({ toDailyBudgetCents: 2000 });
    const daysLeft = remainingDays(NOW, 'America/Sao_Paulo');

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    if (!simulation) throw new Error('no simulation');

    // R$20,00/dia × dias restantes × 1,25 de sobreentrega.
    expect(simulation.requested.campaignExposureCents).toBe(Math.round(2000 * daysLeft * 1.25));
    expect(simulation.overdeliveryFactorMilli).toBe(1250);
    expect(simulation.daysLeftInPeriod).toBe(daysLeft);
  });

  it('separates committed with the request from committed without it', async () => {
    const { changeRequestId } = await scene({ toDailyBudgetCents: 2000 });

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    if (!simulation) throw new Error('no simulation');

    // The reservation is held from the moment the change is requested, so the
    // difference between the two totals is exactly this request's exposure.
    expect(
      simulation.period.committedWithRequestCents - simulation.period.committedWithoutRequestCents,
    ).toBe(simulation.requested.campaignExposureCents);
    expect(simulation.period.committedWithoutRequestCents).toBe(0);
    expect(simulation.current.committedCents).toBe(0);
    expect(simulation.requested.committedCents).toBe(simulation.period.committedWithRequestCents);
  });

  it('reports the share of the usable slice and of the hard cap', async () => {
    const { changeRequestId } = await scene({ toDailyBudgetCents: 2000 });

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    if (!simulation) throw new Error('no simulation');

    const expectedUsableShare = Math.round(
      (simulation.requested.committedCents / simulation.period.usableCents) * 100,
    );
    expect(simulation.requested.usedOfUsablePercent).toBe(expectedUsableShare);
    // Nothing has been spent yet, so cap usage is commitment over the cap.
    expect(simulation.requested.usedOfCapPercent).toBe(
      Math.round((simulation.requested.committedCents / simulation.period.capCents) * 100),
    );
    expect(simulation.requested.withinUsable).toBe(true);
    expect(simulation.requested.withinCap).toBe(true);
  });

  it('says how many days the budget could run on what is left', async () => {
    const { changeRequestId } = await scene({ toDailyBudgetCents: 2000 });

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    if (!simulation) throw new Error('no simulation');

    expect(simulation.requested.runwayDays).toBe(
      Math.floor(simulation.requested.availableCents / (2000 * 1.25)),
    );
    // A current state of zero budget has no runway to speak of.
    expect(simulation.current.runwayDays).toBeNull();
  });
});

describe('trying an alternative value', () => {
  it('projects a smaller budget without touching the request', async () => {
    const { changeRequestId } = await scene({ toDailyBudgetCents: 4000 });

    const simulation = await simulateChange(db, changeRequestId, {
      alternativeDailyBudgetCents: 1000,
      now: NOW,
    });
    if (!simulation) throw new Error('no simulation');

    expect(simulation.simulated?.dailyBudgetCents).toBe(1000);
    expect(simulation.simulated?.campaignExposureCents).toBeLessThan(
      simulation.requested.campaignExposureCents,
    );

    // Exploration must not edit anything: the request still asks for R$40,00.
    const stored = await db.query.adChangeRequests.findFirst({
      where: (table, { eq: is }) => is(table.id, changeRequestId),
    });
    expect(stored?.toValueCents).toBe(4000);
    expect(stored?.status).toBe('pending_approval');
  });

  it('flags a value that would break the usable slice', async () => {
    // A tiny cap makes the breach unambiguous.
    const { changeRequestId } = await scene({ toDailyBudgetCents: 500, capCents: 20_000 });

    const simulation = await simulateChange(db, changeRequestId, {
      alternativeDailyBudgetCents: 50_000,
      now: NOW,
    });
    if (!simulation) throw new Error('no simulation');

    expect(simulation.simulated?.withinUsable).toBe(false);
    expect(simulation.simulated?.withinCap).toBe(false);
    expect(simulation.simulated?.availableCents).toBe(0);
  });

  it('offers no alternatives for a pause, because a pause has no number', async () => {
    const { changeRequestId } = await scene({
      campaignDailyBudgetCents: 3000,
      kind: 'pause_campaign',
    });

    const simulation = await simulateChange(db, changeRequestId, {
      alternativeDailyBudgetCents: 1000,
      now: NOW,
    });
    if (!simulation) throw new Error('no simulation');

    expect(simulation.simulationAvailable).toBe(false);
    expect(simulation.simulated).toBeNull();
    // Pausing releases exposure rather than adding it.
    expect(simulation.requested.campaignExposureCents).toBe(0);
    // Waiting, it frees nothing: "without" is the month as it runs, and
    // "with" the month once the pause has run.
    const running = Math.round(3000 * remainingDays(NOW, 'America/Sao_Paulo') * 1.25);
    expect(simulation.period.committedWithoutRequestCents).toBe(running);
    expect(simulation.period.committedWithRequestCents).toBe(0);
    expect(simulation.requested.committedCents).toBeLessThanOrEqual(
      simulation.current.committedCents,
    );
  });
});

describe('drift between the request and the platform', () => {
  it('warns when the mirrored budget no longer matches what was requested from', async () => {
    const { changeRequestId, campaignId } = await scene({
      campaignDailyBudgetCents: 2000,
      toDailyBudgetCents: 3000,
    });

    // Someone changed the budget in Ads Manager after the request was made.
    await db
      .update(adCampaigns)
      .set({ dailyBudgetCents: 2500 })
      .where(eq(adCampaigns.id, campaignId));

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    expect(simulation?.drift).toEqual({
      field: 'daily_budget',
      expectedCents: 2000,
      mirroredCents: 2500,
    });
  });

  it('stays quiet when the platform still matches', async () => {
    const { changeRequestId } = await scene({
      campaignDailyBudgetCents: 2000,
      toDailyBudgetCents: 3000,
    });

    const simulation = await simulateChange(db, changeRequestId, { now: NOW });
    expect(simulation?.drift).toBeNull();
  });
});

describe('the grouped view', () => {
  it('gathers several waiting requests on one campaign', async () => {
    const first = await scene({ toDailyBudgetCents: 1000, campaignName: 'Agrupada' });
    // A second request on the same campaign, while the first still waits.
    const second = await reserveChange(db, {
      adAccountId: first.accountId,
      campaignId: first.campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1500,
      now: NOW,
    });
    if (!second.ok) throw new Error(`reservation refused: ${second.reason}`);
    await gateChange(db, { changeRequestId: second.value.changeRequestId, now: NOW });

    const groups = await pendingGroups(db);
    const group = groups.find((entry) => entry.campaignId === first.campaignId);

    expect(group?.items).toHaveLength(2);
    expect(group?.totalExposureDeltaCents).toBe(
      (group?.items ?? []).reduce((sum, item) => sum + item.exposureDeltaCents, 0),
    );
    // Reservations are already inside the period's committed total.
    expect(group?.committedCents).toBe(group?.totalExposureDeltaCents);
    expect(group?.shareOfUsablePercent).toBeGreaterThan(0);
  });

  it('points at the next decision without deciding it', async () => {
    const first = await scene({ toDailyBudgetCents: 1000, campaignName: 'Sequência' });
    const second = await reserveChange(db, {
      adAccountId: first.accountId,
      campaignId: first.campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1200,
      now: NOW,
    });
    if (!second.ok) throw new Error('reservation refused');
    const gate = await gateChange(db, {
      changeRequestId: second.value.changeRequestId,
      now: NOW,
    });

    const next = await nextPendingInGroup(db, first.approvalId);
    expect(next?.approvalId).toBe(gate.approvalId);
    expect(next?.remaining).toBe(1);

    // Nothing was decided by looking.
    const stored = await db.query.adApprovalRequests.findMany({
      where: (table, { inArray }) => inArray(table.id, [first.approvalId, gate.approvalId ?? '']),
    });
    expect(stored.every((row) => row.status === 'pending')).toBe(true);
  });

  it('returns nothing to move on to when a request stands alone', async () => {
    const alone = await scene({ toDailyBudgetCents: 1000, campaignName: 'Sozinha' });
    expect(await nextPendingInGroup(db, alone.approvalId)).toBeNull();
  });

  it('puts escalated groups first', async () => {
    const plain = await scene({ toDailyBudgetCents: 1000, campaignName: 'Comum' });
    const urgent = await scene({ toDailyBudgetCents: 1000, campaignName: 'Escalada' });
    await db
      .update(adApprovalRequests)
      .set({ status: 'escalated', escalatedAt: NOW })
      .where(eq(adApprovalRequests.id, urgent.approvalId));

    const groups = await pendingGroups(db);
    const escalatedIndex = groups.findIndex((g) => g.campaignId === urgent.campaignId);
    const plainIndex = groups.findIndex((g) => g.campaignId === plain.campaignId);

    expect(escalatedIndex).toBeLessThan(plainIndex);
    expect(groups[escalatedIndex]?.anyEscalated).toBe(true);
  });

  it('ignores ad sets that belong to another campaign entirely', async () => {
    const first = await scene({ toDailyBudgetCents: 1000, campaignName: 'Isolada A' });
    const other = await scene({ toDailyBudgetCents: 1000, campaignName: 'Isolada B' });
    await db.insert(adSets).values({
      campaignId: other.campaignId,
      externalId: `as_${randomBytes(4).toString('hex')}`,
      name: 'Conjunto alheio',
      status: 'ACTIVE',
      dailyBudgetCents: 9999,
    });

    const groups = await pendingGroups(db);
    const group = groups.find((entry) => entry.campaignId === first.campaignId);
    expect(group?.items).toHaveLength(1);
  });
});
