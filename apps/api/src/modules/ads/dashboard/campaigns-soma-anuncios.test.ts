import { randomBytes } from 'node:crypto';
import type { DashboardCampaigns } from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../db/client.js';
import { adAds, adMetricsDaily } from '../../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { openPeriod } from '../budget-guard.js';
import { ensureAdAccount, ingestMetrics, syncAds } from '../metrics.js';
import { FakeMetaClient } from '../platform/fake-meta-client.js';
import { reconcileAccount } from '../reconcile.js';
import { campaigns } from './queries.js';

/**
 * The campaigns tab when Meta answers a campaign or an ad set with spend,
 * impressions, clicks and reach at 0 while the ads under it carry them (seen on
 * 20/10 for a new Instagram-only campaign). The simulator fills every level
 * right; each test then zeroes the rows the way the platform did.
 */

const NOW = new Date('2026-09-16T12:00:00.000Z');
const PERIOD = '2026-09-01';
const DAYS = ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15'];
const BUDGET = { dailyBudgetCents: 10_000 };

let harness: TestDatabase;
let db: Database;
let tree: DashboardCampaigns;

async function zeroRows(level: 'campaign' | 'ad_set' | 'ad', externalIds: string[]) {
  await db
    .update(adMetricsDaily)
    .set({ spendCents: 0, impressions: 0, clicks: 0, reach: 0 })
    .where(
      and(eq(adMetricsDaily.level, level), inArray(adMetricsDaily.entityExternalId, externalIds)),
    );
}

/** What the table holds for these entities at one level, summed over the window. */
async function stored(level: 'campaign' | 'ad_set' | 'ad', externalIds: string[]) {
  const [row] = await db
    .select({
      spendCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
      impressions: sql<string>`coalesce(sum(${adMetricsDaily.impressions}), 0)`,
      clicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}), 0)`,
      videoPlays: sql<string>`coalesce(sum(${adMetricsDaily.videoPlays}), 0)`,
    })
    .from(adMetricsDaily)
    .where(
      and(eq(adMetricsDaily.level, level), inArray(adMetricsDaily.entityExternalId, externalIds)),
    );
  return {
    spendCents: Number(row?.spendCents),
    impressions: Number(row?.impressions),
    clicks: Number(row?.clicks),
    videoPlays: Number(row?.videoPlays),
  };
}

function campaignOf(externalId: string) {
  const found = tree.campaigns.find((campaign) => campaign.externalId === externalId);
  if (!found) throw new Error(`campaign ${externalId} missing`);
  return found;
}

function adSetOf(campaignExternalId: string, externalId: string) {
  const found = campaignOf(campaignExternalId).adSets.find((set) => set.externalId === externalId);
  if (!found) throw new Error(`ad set ${externalId} missing`);
  return found;
}

const pickTotals = (t: {
  spendCents: number;
  impressions: number;
  clicks: number;
  videoPlays: number;
}) => ({
  spendCents: t.spendCents,
  impressions: t.impressions,
  clicks: t.clicks,
  videoPlays: t.videoPlays,
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;

  const externalId = `act_${randomBytes(4).toString('hex')}`;
  const accountId = await ensureAdAccount(db, { platform: 'meta', externalId, name: 'Fly High' });
  await openPeriod(db, {
    adAccountId: accountId,
    periodMonth: PERIOD,
    capCents: 1_000_000,
    usablePercent: 70,
  });
  const meta = new FakeMetaClient({
    accountId: externalId,
    spendCapCents: 2_000_000,
    campaigns: [
      { id: 'c-ok', name: 'Linha da campanha certa', status: 'ACTIVE', ...BUDGET },
      { id: 'c-zero', name: 'Campanha zerada', status: 'ACTIVE', ...BUDGET },
      { id: 'c-mix', name: 'Conjunto zerado', status: 'ACTIVE', ...BUDGET },
      { id: 'c-dead', name: 'Zerada de verdade', status: 'ACTIVE', ...BUDGET },
    ],
    adSets: [
      { id: 'as-ok', campaignId: 'c-ok', name: 'Conjunto certo' },
      { id: 'as-za', campaignId: 'c-zero', name: 'Conjunto A' },
      { id: 'as-zb', campaignId: 'c-zero', name: 'Conjunto B' },
      { id: 'as-mix', campaignId: 'c-mix', name: 'Conjunto zerado' },
      { id: 'as-dead', campaignId: 'c-dead', name: 'Conjunto parado' },
    ],
    ads: [
      { id: 'ad-ok1', campaignId: 'c-ok', adSetId: 'as-ok', name: 'Ok 1' },
      { id: 'ad-ok2', campaignId: 'c-ok', adSetId: 'as-ok', name: 'Ok 2' },
      { id: 'ad-za1', campaignId: 'c-zero', adSetId: 'as-za', name: 'A 1', format: 'video' },
      { id: 'ad-za2', campaignId: 'c-zero', adSetId: 'as-za', name: 'A 2' },
      { id: 'ad-zb1', campaignId: 'c-zero', adSetId: 'as-zb', name: 'B 1' },
      { id: 'ad-zb2', campaignId: 'c-zero', adSetId: 'as-zb', name: 'B 2 (sem conjunto)' },
      { id: 'ad-mix1', campaignId: 'c-mix', adSetId: 'as-mix', name: 'Mix 1' },
      { id: 'ad-mix2', campaignId: 'c-mix', adSetId: 'as-mix', name: 'Mix 2' },
      { id: 'ad-dead1', campaignId: 'c-dead', adSetId: 'as-dead', name: 'Parado 1' },
    ],
  });
  for (const day of DAYS) meta.simulateDay(day);
  await reconcileAccount(db, meta, accountId, NOW);
  await syncAds(db, meta, accountId, NOW);
  for (const level of ['campaign', 'ad_set', 'ad'] as const) {
    await ingestMetrics(db, meta, accountId, level, PERIOD, NOW);
  }

  // An ad the mirror holds without an ad set: it hangs straight under its campaign.
  await db.update(adAds).set({ adSetId: null }).where(eq(adAds.externalId, 'ad-zb2'));

  // What Meta answered for the new campaign: the campaign and its ad sets at 0.
  await zeroRows('campaign', ['c-zero', 'c-dead']);
  await zeroRows('ad_set', ['as-za', 'as-zb', 'as-mix', 'as-dead']);
  // And a campaign that really delivered nothing: the ads read 0 as well.
  await zeroRows('ad', ['ad-dead1']);

  tree = await campaigns(db, 30, NOW);
}, 90_000);

afterAll(async () => {
  await harness?.drop();
});

describe('the campaigns tab when the campaign line reads zero', () => {
  it('T1: shows the sum of its ad sets and loose ads, not R$ 0', async () => {
    const adsSum = await stored('ad', ['ad-za1', 'ad-za2', 'ad-zb1', 'ad-zb2']);
    expect(adsSum.spendCents).toBeGreaterThan(0);

    const zero = campaignOf('c-zero');
    expect(pickTotals(zero.totals)).toEqual(adsSum);
    expect(zero.orphanAds.map((ad) => ad.externalId)).toEqual(['ad-zb2']);
    // The same figure from the screen's own parts: ad sets plus the loose ad.
    const parts = [...zero.adSets, ...zero.orphanAds].reduce((total, node) => {
      return total + node.totals.spendCents;
    }, 0);
    expect(zero.totals.spendCents).toBe(parts);
  });

  it('T2: leaves a line that has its own spend as it is, summing nothing twice', async () => {
    const own = await stored('campaign', ['c-ok']);
    const ownAdSet = await stored('ad_set', ['as-ok']);
    expect(own.spendCents).toBeGreaterThan(0);

    // Exactly the rows of its own level: a sum on top of them would show up here.
    expect(pickTotals(campaignOf('c-ok').totals)).toEqual(own);
    expect(pickTotals(adSetOf('c-ok', 'as-ok').totals)).toEqual(ownAdSet);

    // A campaign with its own spend keeps it even when the ad set under it reads zero.
    const mix = await stored('campaign', ['c-mix']);
    expect(mix.spendCents).toBeGreaterThan(0);
    expect(pickTotals(campaignOf('c-mix').totals)).toEqual(mix);
  });

  it('T3: shows the sum of its ads for an ad set that reads zero', async () => {
    const setA = await stored('ad', ['ad-za1', 'ad-za2']);
    const setB = await stored('ad', ['ad-zb1']);
    const mix = await stored('ad', ['ad-mix1', 'ad-mix2']);

    expect(pickTotals(adSetOf('c-zero', 'as-za').totals)).toEqual(setA);
    // The loose ad is not in the set any more, so it is not in the set's total.
    expect(pickTotals(adSetOf('c-zero', 'as-zb').totals)).toEqual(setB);
    expect(pickTotals(adSetOf('c-mix', 'as-mix').totals)).toEqual(mix);
    expect(adSetOf('c-zero', 'as-za').totals.videoPlays).toBeGreaterThan(0);
  });

  it('T4: keeps a true zero a zero when no ad has spend either', async () => {
    const dead = campaignOf('c-dead');
    expect(dead.totals.spendCents).toBe(0);
    expect(dead.totals.impressions).toBe(0);
    expect(adSetOf('c-dead', 'as-dead').totals.spendCents).toBe(0);
  });
});
