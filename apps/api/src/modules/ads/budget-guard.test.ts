import { randomBytes, randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, adCampaigns, adGuardrailEvents } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  applyReportedSpend,
  campaignExposure,
  engageKillSwitch,
  exposureOf,
  getPeriodState,
  openPeriod,
  releaseReservation,
  remainingDays,
  reserveChange,
} from './budget-guard.js';

/**
 * The guardrail is the most safety-critical code in the system: a bug here
 * spends real money that nobody authorised. These tests attack it from every
 * angle available, including going around the application entirely.
 */

const CAPS = {
  meta: 400_000, // R$4.000,00
  google: 400_000,
  tiktok: 200_000, // R$2.000,00
} as const;

const USABLE_PERCENT = 70;

let harness: TestDatabase;
let db: Database;

/** Mid-month, so exposure maths has a predictable number of days left. */
const NOW = new Date('2026-09-16T12:00:00.000Z');
const PERIOD = '2026-09-01';

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

async function makeAccount(platform: 'meta' | 'google' | 'tiktok'): Promise<string> {
  const [account] = await db
    .insert(adAccounts)
    .values({
      platform,
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: `${platform} — Wings Matriz`,
    })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed to create ad account');

  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: CAPS[platform],
    usablePercent: USABLE_PERCENT,
  });
  return account.id;
}

async function makeCampaign(
  accountId: string,
  dailyBudgetCents = 0,
  status: 'ACTIVE' | 'PAUSED' = 'ACTIVE',
) {
  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: accountId,
      externalId: `c_${randomBytes(4).toString('hex')}`,
      name: 'Campanha',
      status,
      dailyBudgetCents,
    })
    .returning({ id: adCampaigns.id });
  if (!campaign) throw new Error('failed to create campaign');
  return campaign.id;
}

describe('exposure maths', () => {
  it('counts the remaining days of the month, including today', () => {
    expect(remainingDays(new Date('2026-09-16T12:00:00Z'))).toBe(15);
    expect(remainingDays(new Date('2026-09-30T12:00:00Z'))).toBe(1);
    expect(remainingDays(new Date('2026-02-01T12:00:00Z'))).toBe(28);
  });

  it('includes overdelivery: a budget is not the same as its spend', () => {
    // R$50/day for 10 days is R$500 of budget but R$625 of exposure.
    expect(exposureOf(5000, 10)).toBe(62_500);
  });
});

describe('per-platform independence', () => {
  it('exhausting Meta leaves Google and TikTok untouched', async () => {
    const meta = await makeAccount('meta');
    const google = await makeAccount('google');
    const metaCampaign = await makeCampaign(meta);
    const googleCampaign = await makeCampaign(google);

    // Fill Meta's usable budget (R$2.800) completely.
    const daysLeft = remainingDays(NOW);
    const perDay = Math.floor(280_000 / (daysLeft * 1.25));
    const filled = await reserveChange(db, {
      adAccountId: meta,
      campaignId: metaCampaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });
    expect(filled.ok).toBe(true);

    // Meta now refuses more...
    const refused = await reserveChange(db, {
      adAccountId: meta,
      campaignId: metaCampaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay * 2,
      now: NOW,
    });
    expect(refused.ok).toBe(false);

    // ...while Google's pool is entirely unaffected: nothing of Meta's was
    // committed against it.
    expect((await getPeriodState(db, google, PERIOD))?.committedCents).toBe(0);

    // A budget change on the Google campaign is judged against Google's own
    // pool, which Meta's exhaustion never touched.
    const googleChange = await reserveChange(db, {
      adAccountId: google,
      campaignId: googleCampaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });
    expect(googleChange.ok).toBe(true);
  });

  it('gives each account its own cap and usable split', async () => {
    const tiktok = await makeAccount('tiktok');
    const state = await getPeriodState(db, tiktok, PERIOD);
    expect(state?.capCents).toBe(200_000);
    expect(state?.usableCents).toBe(140_000); // 70% of R$2.000
  });
});

describe('the usable/reserve split', () => {
  it('refuses to plan into the 30% reserve', async () => {
    const meta = await makeAccount('meta');
    const campaign = await makeCampaign(meta);
    const daysLeft = remainingDays(NOW);

    // Ask for exposure just beyond the usable R$2.800 but below the R$4.000 cap.
    const perDay = Math.ceil(290_000 / (daysLeft * 1.25));
    const result = await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('usable_would_be_exceeded');
  });
});

describe('the database is the authority', () => {
  it('refuses a direct SQL update that would breach the cap', async () => {
    const meta = await makeAccount('meta');
    const state = await getPeriodState(db, meta, PERIOD);

    // Bypass every line of application code.
    const error = await db
      .execute(
        sql`update ad_budget_periods set committed_cents = ${CAPS.meta + 1} where id = ${state?.id}`,
      )
      .then(() => null)
      .catch((e: unknown) => e);

    const message = [
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    expect(message).toMatch(/ad_budget_periods_(within_cap|committed_within_usable)_ck/);
  });

  it('refuses a negative commitment', async () => {
    const meta = await makeAccount('meta');
    const state = await getPeriodState(db, meta, PERIOD);
    const error = await db
      .execute(sql`update ad_budget_periods set committed_cents = -1 where id = ${state?.id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    // Drizzle wraps driver errors; the constraint name is on the cause.
    const message = [
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    expect(message).toMatch(/non_negative_ck/);
  });

  it('still allows recording real overspend, because reality must be writable', async () => {
    const meta = await makeAccount('meta');
    const state = await getPeriodState(db, meta, PERIOD);
    if (!state) throw new Error('no period');

    // The platform overdelivered past the cap. The system must be able to
    // write that down — refusing would leave it blind.
    const result = await applyReportedSpend(db, {
      periodId: state.id,
      spentCents: CAPS.meta + 50_000,
      now: NOW,
    });

    expect(result.killSwitchEngaged).toBe(true);
    const after = await getPeriodState(db, meta, PERIOD);
    expect(after?.spentCents).toBe(CAPS.meta + 50_000);
    expect(after?.committedCents).toBe(0);

    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, meta) });
    expect(account?.killSwitchEngaged).toBe(true);
  });
});

describe('kill switch', () => {
  it('blocks every change while engaged', async () => {
    const meta = await makeAccount('meta');
    const campaign = await makeCampaign(meta);
    await engageKillSwitch(db, meta, 'teste');

    const result = await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1000,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('kill_switch_engaged');
  });
});

describe('reservations', () => {
  it('holds exposure so two pending changes cannot both fit', async () => {
    const meta = await makeAccount('meta');
    const a = await makeCampaign(meta);
    const b = await makeCampaign(meta);
    const daysLeft = remainingDays(NOW);
    const perDay = Math.floor(200_000 / (daysLeft * 1.25));

    const first = await reserveChange(db, {
      adAccountId: meta,
      campaignId: a,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });
    const second = await reserveChange(db, {
      adAccountId: meta,
      campaignId: b,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });

    expect(first.ok).toBe(true);
    // Both would fit individually; together they exceed the usable portion.
    expect(second.ok).toBe(false);
  });

  it('frees the exposure again when a change is rejected', async () => {
    const meta = await makeAccount('meta');
    const campaign = await makeCampaign(meta);
    const daysLeft = remainingDays(NOW);
    const perDay = Math.floor(200_000 / (daysLeft * 1.25));

    const reserved = await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: perDay,
      now: NOW,
    });
    if (!reserved.ok) throw new Error('expected reservation');

    const before = await getPeriodState(db, meta, PERIOD);
    await releaseReservation(db, reserved.value.changeRequestId, 'rejected');
    const after = await getPeriodState(db, meta, PERIOD);

    expect(before?.committedCents).toBeGreaterThan(0);
    expect(after?.committedCents).toBe(0);
  });

  it('records a refusal as a guardrail event, never silently', async () => {
    const meta = await makeAccount('meta');
    const campaign = await makeCampaign(meta);

    await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: CAPS.meta * 2,
      now: NOW,
    });

    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, meta),
    });
    expect(
      events.some((e) => e.kind === 'implausible_amount' || e.kind === 'cap_would_be_exceeded'),
    ).toBe(true);
  });

  it('rejects an implausible amount before anything else', async () => {
    const meta = await makeAccount('meta');
    const campaign = await makeCampaign(meta);

    // A 100x unit error: R$5.000,00 typed as if it were cents.
    const result = await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 50_000_00,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('implausible_amount');
  });
});

describe('concurrency', () => {
  it('serialises parallel reservations so the cap still holds', async () => {
    const meta = await makeAccount('meta');
    const campaigns = await Promise.all([
      makeCampaign(meta),
      makeCampaign(meta),
      makeCampaign(meta),
      makeCampaign(meta),
    ]);
    const daysLeft = remainingDays(NOW);
    // Each request alone is fine; all four together would exceed the usable part.
    const perDay = Math.floor(100_000 / (daysLeft * 1.25));

    const results = await Promise.all(
      campaigns.map((campaignId) =>
        reserveChange(db, {
          adAccountId: meta,
          campaignId,
          kind: 'set_daily_budget',
          toDailyBudgetCents: perDay,
          now: NOW,
        }),
      ),
    );

    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(4);

    const state = await getPeriodState(db, meta, PERIOD);
    expect(state?.committedCents).toBeLessThanOrEqual(state?.usableCents ?? 0);
  });
});

describe('invariants under random change sequences', () => {
  it('never breaches cap or usable, whatever order changes arrive in', async () => {
    const meta = await makeAccount('meta');
    const campaigns = await Promise.all([
      makeCampaign(meta),
      makeCampaign(meta),
      makeCampaign(meta),
    ]);

    for (let step = 0; step < 60; step++) {
      const campaignId = campaigns[randomInt(0, campaigns.length)] as string;
      const roll = randomInt(0, 10);

      if (roll < 6) {
        await reserveChange(db, {
          adAccountId: meta,
          campaignId,
          kind: 'set_daily_budget',
          toDailyBudgetCents: randomInt(100, 40_000),
          now: NOW,
        });
      } else if (roll < 8) {
        await reserveChange(db, {
          adAccountId: meta,
          campaignId,
          kind: 'pause_campaign',
          now: NOW,
        });
      } else {
        const pending = await db.query.adChangeRequests.findMany({ limit: 5 });
        const target = pending.find((r) => r.reservationActive);
        if (target) await releaseReservation(db, target.id, 'rejected');
      }

      // The invariant must hold after EVERY step, not just at the end.
      const state = await getPeriodState(db, meta, PERIOD);
      if (!state) throw new Error('period vanished');
      expect(state.committedCents).toBeGreaterThanOrEqual(0);
      expect(state.committedCents).toBeLessThanOrEqual(state.usableCents);
      expect(state.committedCents + state.spentCents).toBeLessThanOrEqual(state.capCents);
    }
  });
});

describe('month boundaries', () => {
  it('treats each month as its own budget', async () => {
    const meta = await makeAccount('meta');
    await openPeriod(db, {
      adAccountId: meta,
      periodMonth: '2026-10-01',
      capCents: CAPS.meta,
      usablePercent: USABLE_PERCENT,
    });

    const september = await getPeriodState(db, meta, PERIOD);
    const october = await getPeriodState(db, meta, '2026-10-01');
    expect(september?.id).not.toBe(october?.id);
    expect(october?.committedCents).toBe(0);
  });

  it('shrinks exposure as the month runs out', () => {
    // The same daily budget costs less exposure near month end.
    expect(exposureOf(5000, 15)).toBeGreaterThan(exposureOf(5000, 2));
  });
});

beforeEach(async () => {
  // Each test builds its own accounts; nothing is shared between them.
});

describe('exposure follows the budget level', () => {
  it('uses the campaign budget for CBO', () => {
    expect(
      campaignExposure(
        { campaignStatus: 'ACTIVE', campaignDailyBudgetCents: 4000, adSets: [] },
        10,
      ),
    ).toBe(exposureOf(4000, 10));
  });

  it('sums active ad sets for ABO', () => {
    expect(
      campaignExposure(
        {
          campaignStatus: 'ACTIVE',
          campaignDailyBudgetCents: 0,
          adSets: [
            { status: 'ACTIVE', dailyBudgetCents: 2000 },
            { status: 'ACTIVE', dailyBudgetCents: 1500 },
            { status: 'PAUSED', dailyBudgetCents: 9999 },
          ],
        },
        10,
      ),
    ).toBe(exposureOf(3500, 10));
  });

  it('returns zero for a paused campaign however many ad sets are active', () => {
    expect(
      campaignExposure(
        {
          campaignStatus: 'PAUSED',
          campaignDailyBudgetCents: 0,
          adSets: [{ status: 'ACTIVE', dailyBudgetCents: 5000 }],
        },
        10,
      ),
    ).toBe(0);
  });

  it('counts a lifetime budget in full, the worst case', () => {
    expect(
      campaignExposure(
        {
          campaignStatus: 'ACTIVE',
          campaignDailyBudgetCents: 0,
          adSets: [{ status: 'ACTIVE', dailyBudgetCents: 0, lifetimeBudgetCents: 25_000 }],
        },
        10,
      ),
    ).toBe(25_000);
  });
});

describe('ABO campaigns refuse campaign-level budget changes', () => {
  it('explains that the budget lives in the ad sets', async () => {
    const meta = await makeAccount('meta');
    const [campaign] = await db
      .insert(adCampaigns)
      .values({
        adAccountId: meta,
        externalId: `abo_${randomBytes(3).toString('hex')}`,
        name: 'ABO',
        status: 'ACTIVE',
        dailyBudgetCents: 0,
        budgetLevel: 'ad_set',
      })
      .returning({ id: adCampaigns.id });

    const result = await reserveChange(db, {
      adAccountId: meta,
      campaignId: campaign?.id ?? '',
      kind: 'set_daily_budget',
      toDailyBudgetCents: 2000,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_not_at_campaign_level');
  });
});

describe('a pause on a campaign the period never counted', () => {
  it('is accepted, with the commitment floored at zero', async () => {
    const accountId = await makeAccount('meta');
    // Mirrored from the platform but never reconciled into the commitment.
    const campaignId = await makeCampaign(accountId, 5000);

    const result = await reserveChange(db, {
      adAccountId: accountId,
      campaignId,
      kind: 'pause_campaign',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exposureDeltaCents).toBeLessThan(0);
    expect(result.value.period.committedCents).toBe(0);
  });
});
