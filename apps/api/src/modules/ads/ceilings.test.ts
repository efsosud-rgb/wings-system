import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, adAlerts, adCampaigns, adMetricsDaily } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { DEFAULT_ALERT_CONFIG, detectAlerts, runAlerts } from './alerts.js';
import { applyPlatformLimit, getPeriodState, openPeriod, reserveChange } from './budget-guard.js';
import { activeAdAccounts, archiveAdAccount, ensureAdAccount, ingestMetrics } from './metrics.js';
import { effectiveHeadroomCents, limitFrom } from './platform/limits.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { MetaReadOnlyClient } from './platform/meta-client.js';
import { reconcileAccount } from './reconcile.js';

/**
 * Wave 1: the ceiling the system respects must be the real one.
 *
 * Our monthly cap is a policy; the platform's limit is a fact. Where they
 * disagree the smaller wins — an internal cap above what Meta or Google
 * actually permits is a number with nothing behind it.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');
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

async function account(capCents = 400_000): Promise<string> {
  const id = await ensureAdAccount(db, {
    platform: 'meta',
    externalId: `act_${randomBytes(4).toString('hex')}`,
    name: 'Wings Fly High',
  });
  await openPeriod(db, {
    adAccountId: id,
    periodMonth: PERIOD,
    capCents,
    usablePercent: 70,
  });
  return id;
}

async function campaign(accountId: string, dailyBudgetCents = 0): Promise<string> {
  const [row] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: accountId,
      externalId: `c_${randomBytes(4).toString('hex')}`,
      name: 'Institucional',
      status: 'ACTIVE',
      dailyBudgetCents,
      budgetLevel: 'campaign',
      lastSyncedAt: NOW,
    })
    .returning({ id: adCampaigns.id });
  if (!row) throw new Error('failed');
  return row.id;
}

describe('which ceiling wins', () => {
  it('takes the platform limit when it is lower than ours', () => {
    // Internal headroom R$2.800, platform allows R$1.864,35.
    expect(effectiveHeadroomCents(280_000, 186_435)).toBe(186_435);
  });

  it('takes our own when the platform is more generous', () => {
    expect(effectiveHeadroomCents(280_000, 900_000)).toBe(280_000);
  });

  it('treats "no platform limit" as no limit, never as zero', () => {
    // An account with no cap must not be frozen by a missing number.
    expect(effectiveHeadroomCents(280_000, null)).toBe(280_000);
  });

  it('never returns a negative headroom', () => {
    expect(effectiveHeadroomCents(-5000, null)).toBe(0);
    expect(effectiveHeadroomCents(280_000, -1)).toBe(0);
  });

  it('computes remaining from a limit and what was spent against it', () => {
    // Meta's real figures for the Fly High account.
    const limit = limitFrom(250_000, 63_690, 'meta.spend_cap');
    expect(limit.remainingCents).toBe(186_310);
    expect(limit.source).toBe('meta.spend_cap');
  });
});

describe('recording what the platform allows', () => {
  it('shrinks what may be planned, without touching what is committed', async () => {
    const id = await account();
    const before = await getPeriodState(db, id, PERIOD);
    expect(before?.availableCents).toBe(280_000); // usable slice, no platform data yet

    await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(250_000, 63_690, 'meta.spend_cap'),
      now: NOW,
    });

    const after = await getPeriodState(db, id, PERIOD);
    expect(after?.platformRemainingCents).toBe(186_310);
    expect(after?.platformLimitSource).toBe('meta.spend_cap');
    // The platform is now the binding ceiling: R$1.863,10 rather than R$2.800.
    expect(after?.availableCents).toBe(186_310);
    expect(after?.committedCents).toBe(before?.committedCents);
  });

  it('leaves a guardrail event when the platform is the binding limit', async () => {
    const id = await account();
    await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(52_076, 0, 'google.account_budget'),
      now: NOW,
    });

    const events = await db.query.adGuardrailEvents.findMany();
    const mine = events.filter((event) => event.adAccountId === id);
    expect(mine.some((event) => event.kind === 'cap_change')).toBe(true);
  });

  it('records a limit that is already below what is committed, rather than refusing', async () => {
    const id = await account();
    const campaignId = await campaign(id);
    const reserved = await reserveChange(db, {
      adAccountId: id,
      campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 2000,
      now: NOW,
    });
    if (!reserved.ok) throw new Error(reserved.reason);

    // The prepaid balance collapses to R$20,76 — below the live commitment.
    const result = await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(2076, 0, 'google.account_budget'),
      now: NOW,
    });

    expect(result?.committedExceedsPlatform).toBe(true);
    // Knowing is the point; existing reservations are not silently voided.
    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.committedCents).toBe(reserved.value.period.committedCents);
    expect(state?.availableCents).toBe(0);
  });
});

describe('the guard refuses against the real ceiling', () => {
  it('blocks a change the platform would not allow, naming the platform', async () => {
    const id = await account();
    const campaignId = await campaign(id);
    await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(2076, 0, 'google.account_budget'), // R$20,76 left
      now: NOW,
    });

    const result = await reserveChange(db, {
      adAccountId: id,
      campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 3000, // R$30/day — far beyond the balance
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('platform_limit_would_be_exceeded');
    // The message must say it was the platform, not our own cap: the operator
    // needs to know topping up is the fix, not raising the internal limit.
    expect(result.message).toContain('plataforma');
  });

  it('still allows a change that fits inside the platform headroom', async () => {
    const id = await account();
    const campaignId = await campaign(id);
    await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(250_000, 0, 'meta.spend_cap'),
      now: NOW,
    });

    const result = await reserveChange(db, {
      adAccountId: id,
      campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1000,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('is unaffected when the platform reports no limit at all', async () => {
    const id = await account();
    const campaignId = await campaign(id);
    await applyPlatformLimit(db, {
      adAccountId: id,
      periodMonth: PERIOD,
      limit: limitFrom(null, 0, 'meta.spend_cap:unset'),
      now: NOW,
    });

    const result = await reserveChange(db, {
      adAccountId: id,
      campaignId,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 1000,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('reconciliation reads the ceiling from the platform', () => {
  it('stores what the account itself reports', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      spendCapCents: 250_000,
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 1000 }],
    });

    const result = await reconcileAccount(db, client, id, NOW);

    expect(result.platformRemainingCents).not.toBeNull();
    const state = await getPeriodState(db, id, PERIOD);
    expect(state?.platformLimitSource).toBe('meta.spend_cap');
    expect(state?.platformRemainingCents).toBe(result.platformRemainingCents);
  });
});

describe('the day’s budget is captured with the metrics', () => {
  it('records the budget in force, so a later change cannot rewrite history', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 3000 }],
    });
    const today = NOW.toISOString().slice(0, 10);
    client.simulateDay(today);
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);

    await ingestMetrics(db, client, id, 'campaign', PERIOD, NOW);
    const [row] = await db.query.adMetricsDaily.findMany({
      where: eq(adMetricsDaily.adAccountId, id),
    });
    expect(row?.dailyBudgetCents).toBe(3000);

    // The budget is raised, and the day is ingested again.
    await db
      .update(adCampaigns)
      .set({ dailyBudgetCents: 9000 })
      .where(eq(adCampaigns.adAccountId, id));
    await ingestMetrics(db, client, id, 'campaign', PERIOD, NOW);

    const [updated] = await db.query.adMetricsDaily.findMany({
      where: eq(adMetricsDaily.adAccountId, id),
    });
    // Same day, so the correction is allowed to land.
    expect(updated?.dailyBudgetCents).toBe(9000);
  });

  it('leaves a closed day alone when a later run reports it again', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 3000 }],
    });
    client.simulateDay('2026-09-10'); // a day in the past
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);

    await ingestMetrics(db, client, id, 'campaign', PERIOD, NOW);
    const [row] = await db.query.adMetricsDaily.findMany({
      where: eq(adMetricsDaily.adAccountId, id),
    });
    // We cannot know what the budget was on a past day, so we claim nothing
    // rather than stamping today's number onto it.
    expect(row?.dailyBudgetCents).toBeNull();
  });
});

describe('archiving an account', () => {
  it('hides it from ingestion without deleting anything', async () => {
    const id = await account();
    const external = (await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) }))
      ?.externalId;
    if (!external) throw new Error('no account');
    await campaign(id);

    const before = await activeAdAccounts(db, 'meta');
    expect(before.some((a) => a.id === id)).toBe(true);

    const result = await archiveAdAccount(db, external, 'conta errada: nunca veiculou nada', NOW);
    expect(result?.accountId).toBe(id);

    const after = await activeAdAccounts(db, 'meta');
    expect(after.some((a) => a.id === id)).toBe(false);

    // Nothing was destroyed: the account and its campaigns are still there.
    const stored = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) });
    expect(stored?.archivedAt).not.toBeNull();
    expect(stored?.archivedReason).toContain('nunca veiculou');
    const campaigns = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, id),
    });
    expect(campaigns.length).toBeGreaterThan(0);
  });

  it('resolves open alerts with the reason recorded on them', async () => {
    const id = await account();
    await db.insert(adAlerts).values({
      adAccountId: id,
      kind: 'budget_pacing',
      severity: 'warning',
      entityExternalId: 'acct',
      title: 'Ritmo abaixo do previsto',
      detail: {},
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    const external = (await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) }))
      ?.externalId;

    const result = await archiveAdAccount(db, external ?? '', 'substituída pela Fly High', NOW);
    expect(result?.alertsResolved).toBe(1);

    const [alert] = await db.query.adAlerts.findMany({ where: eq(adAlerts.adAccountId, id) });
    expect(alert?.resolvedAt).not.toBeNull();
    expect(JSON.stringify(alert?.detail)).toContain('substituída pela Fly High');
  });

  it('stops producing new alerts once archived', async () => {
    const id = await account();
    const external = (await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) }))
      ?.externalId;
    await archiveAdAccount(db, external ?? '', 'arquivada', NOW);

    const found = await detectAlerts(db, id, DEFAULT_ALERT_CONFIG, NOW);
    expect(found).toHaveLength(0);

    const run = await runAlerts(db, id, { now: NOW });
    expect(run.opened).toBe(0);
  });

  it('reports nothing for an account that does not exist', async () => {
    expect(await archiveAdAccount(db, 'act_does_not_exist', 'x', NOW)).toBeNull();
  });
});

describe('a client may only write its own account', () => {
  /**
   * The incident this prevents: the ingest loop built one client from the
   * environment and reused it for every account row, so the live account's 84
   * campaigns, 202 ad sets and R$636,93 of spend were filed under an account
   * that had never run anything.
   *
   * Exercised with a real client (isLive) and an injected fetch, because the
   * check deliberately applies only to live clients.
   */
  function liveClientFor(externalId: string) {
    return new MetaReadOnlyClient({
      accessToken: 'test-token',
      adAccountId: externalId,
      // Never called: the guard refuses before any request goes out.
      fetchImpl: (() => Promise.reject(new Error('network reached'))) as typeof fetch,
    });
  }

  it('refuses to mirror one account into another’s row', async () => {
    const accountA = await account();
    const client = liveClientFor('act_999999999');

    await expect(reconcileAccount(db, client, accountA, NOW)).rejects.toThrow(
      /refusing to file one account/,
    );

    // Nothing leaked into the account's row, and no call was even attempted.
    const campaigns = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, accountA),
    });
    expect(campaigns).toHaveLength(0);
  });

  it('refuses on the metrics path too, not only reconciliation', async () => {
    const id = await account();
    const client = liveClientFor('act_888888888');

    await expect(ingestMetrics(db, client, id, 'campaign', PERIOD, NOW)).rejects.toThrow(
      /refusing to file one account/,
    );
  });

  it('names both accounts, so the mistake is obvious in a log', async () => {
    const id = await account();
    const external = (await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, id) }))
      ?.externalId;
    const client = liveClientFor('act_777777777');

    await expect(reconcileAccount(db, client, id, NOW)).rejects.toThrow(
      new RegExp(`act_777777777.*${external}`),
    );
  });
});
