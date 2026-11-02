import { randomBytes } from 'node:crypto';
import { campaignDraftSchema, type CampaignDraft } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  adSpendSnapshots,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  commitmentCents,
  openPeriod,
  reserveCampaignCreation,
  reserveChange,
} from './budget-guard.js';
import { expireStaleChanges } from './expiry.js';
import { simulateChange } from './simulate.js';
import { at, CAP, guardFixtures, NOW, USABLE, type World } from './write-time-guard-fixtures.js';

/**
 * Travas de verba, part 2 (Eric, 29/10/2026): the request, the approval, the
 * execution and reconciliation read one number, the commitment = exposure on
 * the platform (as mirrored) + the increases holding a live reservation.
 * Reductions count only once executed. The edges are here; the races in
 * commitment-races.test.ts. Clock and world: write-time-guard-fixtures.ts
 * (21 days left, R$ 10/dia = 26_250, usable 210_000).
 */
let harness: TestDatabase;
let db: Database;
let approverId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  approverId = (await createEmployee(db, { role: 'admin_master', sector: 'diretoria' })).id;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const {
  world,
  requested,
  decide,
  approved,
  execute,
  changeRow,
  twoIncreasesAcrossAReconciliation,
} = guardFixtures(() => ({ db, approverId }));

async function accountOf(w: World) {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, w.accountId) });
  if (!account) throw new Error('account not found');
  return account;
}

/** The platform's own spending limit drops to `capCents`, and the next reconciliation reads it. */
async function platformCapDropsTo(w: World, capCents: number, now: Date) {
  await w.client.setAccountSpendCap(capCents);
  await w.reconcile(now);
}

describe('one number', () => {
  it('is the platform exposure plus the increases still waiting; a reduction counts once it runs', async () => {
    const w = await world({ a: 1000, b: 1000, c: 1000 }); // 78_750
    await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 }); // +26_250, pending
    await approved(w, 'b', 3000); // +52_500, approved
    const pause = await requested(w, 'c', { kind: 'pause_campaign' }); // −26_250: not yet
    expect(await w.committed()).toBe(157_500);

    // A reconciliation works out the same figure: it no longer wipes the two increases.
    await w.reconcile(at(0.25));
    expect(await w.committed()).toBe(157_500);
    expect(await commitmentCents(db, await accountOf(w), await w.periodId(), NOW)).toBe(157_500);

    // The pause runs: c leaves the mirror, and only then the commitment.
    expect(await decide(pause.approvalId, 'approved')).toMatchObject({ ok: true });
    expect(await execute(w, pause.changeId, at(1))).toMatchObject({ outcome: 'applied' });
    expect(await w.committed()).toBe(131_250);
  });

  it('a request fits exactly at the ceiling, and one cent of exposure more is refused', async () => {
    const w = await world({ a: 1000, b: 1000, c: 1000 }); // 78_750
    await approved(w, 'a', 4000); // +78_750 → 157_500
    await w.reconcile(at(0.25));
    await requested(w, 'b', { kind: 'set_daily_budget', to: 3000 }, at(0.5)); // +52_500 → 210_000
    expect(await w.committed()).toBe(USABLE);

    const oneMore = await reserveChange(db, {
      adAccountId: w.accountId,
      campaignId: await w.campaign('c'),
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1001, // +26 (1001 × 26.25 rounds to 26_276)
      now: at(0.5),
    });
    expect(oneMore).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    // Asking to spend less is never refused, even with the month full.
    const pause = await reserveChange(db, {
      adAccountId: w.accountId,
      campaignId: await w.campaign('c'),
      kind: 'pause_campaign',
      now: at(0.5),
    });
    expect(pause.ok).toBe(true);
    expect(await w.committed()).toBe(USABLE);
  });

  it('a new campaign is judged on top of the increases still waiting', async () => {
    const w = await world({ a: 1000 }); // 26_250
    await approved(w, 'a', 7000); // +157_500 → 183_750
    await w.reconcile(at(0.25)); // part 1 era: back to 26_250

    // R$ 20/dia judged as if running: 2000 × 21 × 1.25 = 52_500 > 210_000 − 183_750.
    const created = await reserveCampaignCreation(db, {
      adAccountId: w.accountId,
      draft: draftOf({ dailyBudgetCents: 2000 }),
      now: at(0.5),
    });
    expect(created).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });

  it('every request is judged on what runs now, not on the last figure stored', async () => {
    const w = await world({ a: 1000, b: 1000 }); // 52_500 stored
    // A synced reading put A at R$ 70/dia (raised in Ads Manager); the
    // reconciliation has not stored the figure yet: 157_500 + 26_250 = 183_750.
    await db
      .update(adCampaigns)
      .set({ dailyBudgetCents: 6000 })
      .where(eq(adCampaigns.id, await w.campaign('a')));
    expect(await w.committed()).toBe(52_500);

    const raise = await reserveChange(db, {
      adAccountId: w.accountId,
      campaignId: await w.campaign('b'),
      kind: 'set_daily_budget',
      toDailyBudgetCents: 3000, // +52_500
      now: at(0.5),
    });
    const created = await reserveCampaignCreation(db, {
      adAccountId: w.accountId,
      draft: draftOf({ dailyBudgetCents: 2000 }), // judged 52_500
      now: at(0.5),
    });

    expect(raise).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    expect(created).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });

  it('a request of a month that is over does not count in the new one, and keeps its own figure', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 }); // 52_500
    const novemberId = await w.periodId();
    const december = new Date('2026-12-01T15:00:00Z');
    await openPeriod(db, {
      adAccountId: w.accountId,
      periodMonth: '2026-12-01',
      capCents: CAP,
      usablePercent: 70,
    });
    const decemberRow = await db.query.budgetPeriods.findFirst({
      where: and(
        eq(budgetPeriods.adAccountId, w.accountId),
        eq(budgetPeriods.periodMonth, '2026-12-01'),
      ),
    });
    if (!decemberRow) throw new Error('december not opened');

    // December: the campaign at 31 days × 1.25, without November's request.
    expect(await commitmentCents(db, await accountOf(w), decemberRow.id, december)).toBe(38_750);

    await expireStaleChanges(db, { now: december });
    expect(await changeRow(ids.changeId)).toMatchObject({ status: 'expired' });
    // November is over: its row is not worked out again with December's days.
    const november = await db.query.budgetPeriods.findFirst({
      where: eq(budgetPeriods.id, novemberId),
    });
    expect(november?.committedCents).toBe(52_500);
  });

  it('a change of unknown outcome keeps counting, even after a reconciliation', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const a = await approved(w, 'a', 4000);
    w.client.injectFailure({ kind: 'timeout_after_apply' });

    expect(await execute(w, a.changeId, at(1))).toMatchObject({ outcome: 'unknown' });
    await w.reconcile(at(1.25));

    // The mirror now shows A applied and A still counts: twice, on purpose,
    // until a person resolves it (the account is frozen meanwhile).
    expect(await changeRow(a.changeId)).toMatchObject({ status: 'unknown' });
    expect(await commitmentCents(db, await accountOf(w), await w.periodId(), at(1.25))).toBe(
      131_250 + 78_750,
    );
  });
});

describe('the approval reads the same number', () => {
  it('leaves an increase pending when the month shrank since the request', async () => {
    const w = await world({ a: 1000 }); // 26_250
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 4000 }); // 105_000
    await platformCapDropsTo(w, 100_000, at(0.25));

    const refused = await decide(ids.approvalId, 'approved', at(0.5));

    expect(refused).toMatchObject({ ok: false, reason: 'platform_limit_would_be_exceeded' });
    expect(await changeRow(ids.changeId)).toMatchObject({
      status: 'pending_approval',
      reservationActive: true,
    });
    const approval = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, ids.approvalId),
    });
    expect(approval?.status).toBe('pending');

    // Room again (the limit raised), and the same approval goes through.
    await platformCapDropsTo(w, 300_000, at(0.75));
    expect(await decide(ids.approvalId, 'approved', at(1))).toMatchObject({ ok: true });
  });

  it('a reduction is asked for and approved whatever the month holds', async () => {
    const w = await world({ a: 1000, b: 1000 }); // 52_500
    await requested(w, 'a', { kind: 'set_daily_budget', to: 4000 }); // 131_250
    // The platform allows 100_000: the campaigns running fit, the waiting increase does not.
    await platformCapDropsTo(w, 100_000, at(0.25));

    const pause = await requested(w, 'b', { kind: 'pause_campaign' }, at(0.5));
    expect(await decide(pause.approvalId, 'approved', at(0.5))).toMatchObject({ ok: true });
  });
});

describe('the execution reads the same number', () => {
  it('an increase does not go out over another one still reserved, once the month shrank', async () => {
    // A and B together fill the month exactly (210_000); then the platform allows 200_000.
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(4000);
    await platformCapDropsTo(w, 200_000, at(0.75));
    const account = await accountOf(w);
    expect(account.killSwitchEngaged).toBe(false); // the platform's own exposure still fits

    expect(await execute(w, a.changeId, at(1))).toMatchObject({
      outcome: 'refused',
      reason: 'cap_no_longer_allows',
    });
    expect(w.budgetWrites()).toEqual([]);

    // An approved change has no "give up" button: it expires a day after its
    // approval. A (approved at NOW) goes first; then B fits, and goes out.
    await w.reconcile(at(24.2));
    const expired = (await expireStaleChanges(db, { now: at(24.25) })).expired;
    expect(
      expired
        .filter((entry) => entry.adAccountId === w.accountId)
        .map((entry) => entry.changeRequestId),
    ).toEqual([a.changeId]);
    expect(await execute(w, b.changeId, at(24.25))).toMatchObject({ outcome: 'applied' });
    expect(w.budgetWrites()).toEqual(['b']);
  });
});

describe('reconciliation', () => {
  it('freezes on the platform’s own exposure, never on reservations the month no longer holds', async () => {
    const { w } = await twoIncreasesAcrossAReconciliation(4000); // 210_000 with both waiting
    await platformCapDropsTo(w, 100_000, at(0.75)); // the mirror (52_500) still fits

    expect((await accountOf(w)).killSwitchEngaged).toBe(false);
    // Stored at the room the row allows; every decision works the full figure out again.
    expect(await w.committed()).toBe(USABLE);

    await platformCapDropsTo(w, 50_000, at(1)); // now the running campaigns themselves do not fit
    expect((await accountOf(w)).killSwitchEngaged).toBe(true);
  });

  it('spend never freezes on an increase still waiting, only on what is running', async () => {
    const w = await world({ a: 1000, b: 1000 }); // 52_500
    await spendReported(w, '2026-11-05', 100_000);
    await w.reconcile(at(0.1)); // room 200_000
    const a = await requested(w, 'a', { kind: 'set_daily_budget', to: 6000 }, at(0.2)); // +131_250
    await w.reconcile(at(0.3));
    expect(await w.committed()).toBe(183_750);

    // Spend shrinks the room to 180_000: A no longer fits, the mirror does.
    await spendReported(w, '2026-11-09', 20_000);
    await w.reconcile(at(0.4));
    expect((await accountOf(w)).killSwitchEngaged).toBe(false);
    // The column is cut at that room; the approval screen still shows the month
    // without A from the full figure (the mirror), not from the cut column.
    expect(await w.committed()).toBe(180_000);
    const simulation = await simulateChange(db, a.changeId, { now: at(0.4) });
    expect(simulation?.period.committedWithoutRequestCents).toBe(52_500);
    // A is refused where it is judged, and asking to spend less still works.
    expect(await decide(a.approvalId, 'approved', at(0.5))).toMatchObject({
      ok: false,
      reason: 'cap_would_be_exceeded',
    });
    expect(await changeRow(a.changeId)).toMatchObject({ status: 'pending_approval' });
    const pause = await reserveChange(db, {
      adAccountId: w.accountId,
      campaignId: await w.campaign('b'),
      kind: 'pause_campaign',
      now: at(0.5),
    });
    expect(pause.ok).toBe(true);

    // Spend that leaves no room for the running campaigns does freeze.
    await spendReported(w, '2026-11-10', 140_000); // room 40_000 < 52_500
    await w.reconcile(at(0.6));
    expect((await accountOf(w)).killSwitchEngaged).toBe(true);
  });
});

/** Spend the platform reported for one day, the way reconciliation stores it. */
async function spendReported(w: World, spendDate: string, spendCents: number) {
  await db
    .insert(adSpendSnapshots)
    .values({ adAccountId: w.accountId, spendDate, spendCents, asOf: NOW });
}

function draftOf(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  const today = '2026-11-10';
  return campaignDraftSchema.parse({
    platform: 'meta',
    name: `Compromisso ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      {
        creativeId: '11111111-1111-4111-8111-111111111111',
        headline: 'Leve a Wings',
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
      },
    ],
    startDate: today,
    endDate: '2026-11-30',
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456' },
    startPaused: true,
    ...overrides,
  });
}
