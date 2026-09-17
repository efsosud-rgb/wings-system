import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAds, adCreatives, adMetricsDaily } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { openPeriod } from './budget-guard.js';
import {
  campaignPerformance,
  conversionsFrom,
  ensureAdAccount,
  ingestMetrics,
  staleMetricAccounts,
  syncAds,
} from './metrics.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
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
  const id = await ensureAdAccount(db, {
    platform: 'meta',
    externalId: `act_${randomBytes(4).toString('hex')}`,
    name: 'Wings Matriz',
  });
  await openPeriod(db, {
    adAccountId: id,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  return id;
}

describe('what counts as a conversion', () => {
  it('recognises real lead actions', () => {
    expect(conversionsFrom({ lead: 4 })).toBe(4);
    expect(conversionsFrom({ 'offsite_conversion.fb_pixel_lead': 7 })).toBe(7);
  });

  it('never infers leads from engagement, which is what this account reports', () => {
    // Exactly the shape found on the real account in the Stage 6.0 spike.
    const actions = {
      post_engagement: 751,
      page_engagement: 751,
      video_view: 715,
      link_click: 27,
    };
    expect(conversionsFrom(actions)).toBe(0);
  });
});

describe('syncing ads and creatives', () => {
  it('mirrors ads with their creative detail', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 3000 }],
      adSets: [{ id: 'as1', campaignId: 'c1', name: 'Conjunto' }],
      ads: [{ id: 'ad1', campaignId: 'c1', adSetId: 'as1', name: 'Anúncio 1' }],
    });
    await reconcileAccount(db, client, id, NOW);

    const result = await syncAds(db, client, id, NOW);
    expect(result).toMatchObject({ ads: 1, creatives: 1, disapproved: 0 });

    const stored = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, id) });
    expect(stored[0]?.name).toBe('Anúncio 1');
    expect(stored[0]?.campaignId).toBeTruthy();
    expect(stored[0]?.adSetId).toBeTruthy();

    const creatives = await db.query.adCreatives.findMany({
      where: eq(adCreatives.adAccountId, id),
    });
    expect(creatives[0]?.thumbnailUrl).toBeTruthy();
  });

  it('keeps the real rejection reason for a disapproved ad', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 3000 }],
      adSets: [{ id: 'as1', campaignId: 'c1', name: 'Conjunto' }],
      ads: [
        {
          id: 'ad-bad',
          campaignId: 'c1',
          adSetId: 'as1',
          name: 'Anúncio reprovado',
          effectiveStatus: 'DISAPPROVED',
          // The shape the live account returns: the reason is in review
          // feedback, and issues_info is empty.
          reviewFeedback: { global: { 'Práticas de negócios inaceitáveis': 'Viola os padrões.' } },
          issuesInfo: null,
        },
      ],
    });
    await reconcileAccount(db, client, id, NOW);

    const result = await syncAds(db, client, id, NOW);
    expect(result.disapproved).toBe(1);

    const stored = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, id) });
    expect(stored[0]?.effectiveStatus).toBe('DISAPPROVED');
    expect(JSON.stringify(stored[0]?.reviewFeedback)).toContain('inaceitáveis');
  });

  it('is idempotent', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'C', status: 'ACTIVE', dailyBudgetCents: 1000 }],
      adSets: [{ id: 'as1', campaignId: 'c1', name: 'AS' }],
      ads: [{ id: 'ad1', campaignId: 'c1', adSetId: 'as1', name: 'A' }],
    });
    await reconcileAccount(db, client, id, NOW);
    await syncAds(db, client, id, NOW);
    await syncAds(db, client, id, NOW);

    const stored = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, id) });
    expect(stored).toHaveLength(1);
  });
});

describe('ingesting daily metrics', () => {
  it('treats an account with no delivery as normal, not as a failure', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Parada', status: 'PAUSED', dailyBudgetCents: 3000 }],
    });
    await reconcileAccount(db, client, id, NOW);

    // This is the real account's current state: nothing delivering.
    const result = await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);
    expect(result).toMatchObject({ rows: 0, spendCents: 0, conversions: 0 });
  });

  it('stores ratios as integers, never floats', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 5000 }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);

    await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);
    const rows = await db.query.adMetricsDaily.findMany({
      where: eq(adMetricsDaily.adAccountId, id),
    });

    expect(rows).toHaveLength(1);
    expect(Number.isInteger(rows[0]?.ctrMilli)).toBe(true);
    expect(Number.isInteger(rows[0]?.frequencyMilli)).toBe(true);
    expect(Number.isInteger(rows[0]?.spendCents)).toBe(true);
    // The raw action types are kept so the lead type can be chosen later.
    expect(rows[0]?.actions).toHaveProperty('link_click');
  });

  it('updates a day when the platform revises it, instead of duplicating', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 2000 }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);
    await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);

    // The same day is reported again with a higher figure.
    client.simulateDay('2026-09-16');
    client.settleReporting();
    await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);

    const rows = await db.query.adMetricsDaily.findMany({
      where: eq(adMetricsDaily.adAccountId, id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spendCents).toBe(4000);
  });

  it('never touches the money-truth table', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Ativa', status: 'ACTIVE', dailyBudgetCents: 2000 }],
    });
    client.simulateDay('2026-09-16');
    client.settleReporting();

    const before = await db.query.adSpendSnapshots.findMany();
    await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);
    const after = await db.query.adSpendSnapshots.findMany();

    // Analytics ingestion writes metrics only; spend snapshots belong to the
    // guardrail and are written by reconciliation.
    expect(after.length).toBe(before.length);
  });
});

describe('cockpit roll-up', () => {
  it('leaves cost per lead empty when there are no leads', async () => {
    const id = await account();
    const client = new FakeMetaClient({
      campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 5000 }],
    });
    client.simulateDay('2026-09-15');
    client.simulateDay('2026-09-16');
    client.settleReporting();
    await reconcileAccount(db, client, id, NOW);
    await ingestMetrics(db, client, id, 'campaign', '2026-09-01', NOW);

    const performance = await campaignPerformance(db, id, '2026-09-01');
    expect(performance).toHaveLength(1);
    expect(performance[0]?.spendCents).toBeGreaterThan(0);
    expect(performance[0]?.clicks).toBeGreaterThan(0);
    // The account reports clicks but no leads: CPL must stay null rather than
    // quietly becoming a cost per click.
    expect(performance[0]?.conversions).toBe(0);
    expect(performance[0]?.costPerLeadCents).toBeNull();
  });

  it('computes cost per lead once real conversions exist', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'campaign',
      entityExternalId: 'c-leads',
      day: '2026-09-16',
      spendCents: 12_000,
      impressions: 1000,
      clicks: 40,
      conversions: 4,
      actions: { lead: 4 },
    });

    const performance = await campaignPerformance(db, id, '2026-09-01');
    const row = performance.find((p) => p.campaignExternalId === 'c-leads');
    expect(row?.costPerLeadCents).toBe(3000); // R$120,00 / 4 = R$30,00
  });
});

describe('freshness', () => {
  it('reports an account whose metrics have gone stale', async () => {
    const id = await account();
    const stale = await staleMetricAccounts(db, 180, NOW);
    // No metrics at all counts as stale, which is what should alert.
    expect(stale.some((entry) => entry.accountId === id)).toBe(true);
  });
});
