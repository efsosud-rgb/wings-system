import { randomBytes } from 'node:crypto';
import { META_URL_TAGS } from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, adAlerts, adCampaigns, adMetricsDaily } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  acknowledgeAlert,
  DEFAULT_ALERT_CONFIG,
  detectAlerts,
  rejectionReasons,
  runAlerts,
  type AlertNotification,
  type AlertNotifier,
  type AlertRuleConfig,
} from './alerts.js';
import { applyReportedSpend, getPeriodState, openPeriod } from './budget-guard.js';
import { ensureAdAccount, syncAds } from './metrics.js';
import { FakeMetaClient, type FakeAdSeed } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

/** Mid-September: roughly half the month gone, so pacing is judgeable. */
const NOW = new Date('2026-09-16T00:00:00.000Z');
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
    name: 'Wings Matriz',
  });
  await openPeriod(db, {
    adAccountId: id,
    periodMonth: PERIOD,
    capCents,
    usablePercent: 70,
  });
  return id;
}

/** Config with every rule off except the one under test. */
function only(overrides: Partial<AlertRuleConfig>): AlertRuleConfig {
  return {
    adRejected: { enabled: false },
    budgetPacing: { ...DEFAULT_ALERT_CONFIG.budgetPacing, enabled: false },
    creativeFatigue: { ...DEFAULT_ALERT_CONFIG.creativeFatigue, enabled: false },
    qualityBelowAverage: { ...DEFAULT_ALERT_CONFIG.qualityBelowAverage, enabled: false },
    conversionSilence: { ...DEFAULT_ALERT_CONFIG.conversionSilence, enabled: false },
    metaAdWithoutUtms: { enabled: false },
    googleCampaignOwnSuffix: { enabled: false },
    ...overrides,
  };
}

function recordingNotifier(options: { fail?: boolean } = {}) {
  const sent: AlertNotification[] = [];
  const notifier: AlertNotifier = {
    send: (notification) => {
      sent.push(notification);
      if (options.fail) return Promise.reject(new Error('instance disconnected'));
      return Promise.resolve();
    },
  };
  return { notifier, sent };
}

async function seedAdsWith(id: string, ads: FakeAdSeed[]) {
  const client = new FakeMetaClient({
    campaigns: [{ id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 3000 }],
    adSets: [{ id: 'as1', campaignId: 'c1', name: 'Conjunto' }],
    ads,
  });
  await reconcileAccount(db, client, id, NOW);
  await syncAds(db, client, id, NOW);
}

/** Puts reported spend on the period, the way reconciliation would. */
async function setSpend(id: string, spentCents: number) {
  const state = await getPeriodState(db, id, PERIOD);
  if (!state) throw new Error('no period open');
  await applyReportedSpend(db, { periodId: state.id, spentCents, now: NOW });
}

describe('reading a rejection reason', () => {
  it('pulls the real reason out of review feedback', () => {
    // The exact shape the live account returns.
    expect(
      rejectionReasons({ global: { 'Práticas de negócios inaceitáveis': 'Viola os padrões.' } }),
    ).toEqual(['Práticas de negócios inaceitáveis']);
  });

  it('survives an empty or absent feedback object', () => {
    expect(rejectionReasons(null)).toEqual([]);
    expect(rejectionReasons({})).toEqual([]);
  });
});

describe('rejected ads', () => {
  it('opens a critical alert carrying the platform reason', async () => {
    const id = await account();
    await seedAdsWith(id, [
      {
        id: 'ad-bad',
        campaignId: 'c1',
        adSetId: 'as1',
        name: 'Anúncio reprovado',
        effectiveStatus: 'DISAPPROVED',
        reviewFeedback: { global: { 'Práticas de negócios inaceitáveis': 'Viola os padrões.' } },
      },
      { id: 'ad-ok', campaignId: 'c1', adSetId: 'as1', name: 'Anúncio normal' },
    ]);

    const found = await detectAlerts(db, id, only({ adRejected: { enabled: true } }), NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('critical');
    expect(found[0]?.entityExternalId).toBe('ad-bad');
    expect(found[0]?.detail.reasons).toEqual(['Práticas de negócios inaceitáveis']);
  });
});

describe('storing what was found', () => {
  it('refreshes an ongoing alert instead of piling up duplicates', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'DISAPPROVED' },
    ]);
    const config = only({ adRejected: { enabled: true } });

    const first = await runAlerts(db, id, { config, now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await runAlerts(db, id, { config, now: later });

    expect(first.opened).toBe(1);
    expect(second.opened).toBe(0);
    expect(second.refreshed).toBe(1);

    const rows = await db.query.adAlerts.findMany({ where: eq(adAlerts.adAccountId, id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSeenAt.toISOString()).toBe(later.toISOString());
    expect(rows[0]?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
  });

  it('resolves an alert once the condition stops holding', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'DISAPPROVED' },
    ]);
    const config = only({ adRejected: { enabled: true } });
    await runAlerts(db, id, { config, now: NOW });

    // The ad is fixed and approved on the next sync.
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'ACTIVE' },
    ]);
    const result = await runAlerts(db, id, { config, now: NOW });

    expect(result.resolved).toBe(1);
    const open = await db.query.adAlerts.findMany({
      where: and(eq(adAlerts.adAccountId, id), isNull(adAlerts.resolvedAt)),
    });
    expect(open).toHaveLength(0);
  });
});

describe('who gets woken up', () => {
  it('notifies once for a critical alert, not on every run', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'DISAPPROVED' },
    ]);
    const config = only({ adRejected: { enabled: true } });
    const { notifier, sent } = recordingNotifier();

    await runAlerts(db, id, { config, notifier, now: NOW });
    await runAlerts(db, id, { config, notifier, now: NOW });

    expect(sent).toHaveLength(1);
  });

  it('keeps warnings in the cockpit and off the phones', async () => {
    const id = await account();
    await setSpend(id, 250_000); // far ahead of the even-spend line
    const config = only({ budgetPacing: { ...DEFAULT_ALERT_CONFIG.budgetPacing, enabled: true } });
    const { notifier, sent } = recordingNotifier();

    const result = await runAlerts(db, id, { config, notifier, now: NOW });

    expect(result.opened).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('records a delivery failure and retries it on the next run', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'DISAPPROVED' },
    ]);
    const config = only({ adRejected: { enabled: true } });

    const failing = recordingNotifier({ fail: true });
    const first = await runAlerts(db, id, { config, notifier: failing.notifier, now: NOW });
    expect(first.notificationErrors).toBe(1);

    const stored = await db.query.adAlerts.findMany({ where: eq(adAlerts.adAccountId, id) });
    // The alert survives the failure, and says so.
    expect(stored[0]?.notifiedAt).toBeNull();
    expect(stored[0]?.notificationError).toContain('disconnected');

    const working = recordingNotifier();
    const second = await runAlerts(db, id, { config, notifier: working.notifier, now: NOW });
    expect(second.notified).toBe(1);
    expect(working.sent).toHaveLength(1);
  });
});

describe('budget pacing', () => {
  const config = only({ budgetPacing: { ...DEFAULT_ALERT_CONFIG.budgetPacing, enabled: true } });

  it('flags spending well ahead of the month', async () => {
    const id = await account();
    // Usable is R$2.800; half the month gone means ~R$1.400 expected.
    await setSpend(id, 250_000);

    const found = await detectAlerts(db, id, config, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('budget_pacing');
    expect(found[0]?.severity).toBe('warning');
    expect(Number(found[0]?.detail.deviationPercent)).toBeGreaterThan(20);
  });

  it('stays quiet inside the tolerance band', async () => {
    const id = await account();
    // 15 of 30 days gone: half of R$2.800 is R$1.400.
    await setSpend(id, 140_000);

    expect(await detectAlerts(db, id, config, NOW)).toHaveLength(0);
  });

  it('says nothing in the first days, when pace means nothing yet', async () => {
    const id = await account();
    const secondOfMonth = new Date('2026-09-02T00:00:00.000Z');
    expect(await detectAlerts(db, id, config, secondOfMonth)).toHaveLength(0);
  });

  it('does not call an idle account "behind" when nothing is committed', async () => {
    const id = await account();
    // Nothing spent, nothing committed: the account simply is not running.
    expect(await detectAlerts(db, id, config, NOW)).toHaveLength(0);
  });
});

describe('creative fatigue', () => {
  const config = only({
    creativeFatigue: { ...DEFAULT_ALERT_CONFIG.creativeFatigue, enabled: true },
  });

  it('flags an ad shown to the same people over and over', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values([
      {
        adAccountId: id,
        level: 'ad',
        entityExternalId: 'ad-tired',
        day: '2026-09-14',
        spendCents: 4000,
        impressions: 6000,
        reach: 1000,
        frequencyMilli: 1800,
      },
      {
        adAccountId: id,
        level: 'ad',
        entityExternalId: 'ad-tired',
        day: '2026-09-15',
        spendCents: 4000,
        impressions: 4000,
        reach: 900,
        frequencyMilli: 1900,
      },
    ]);

    const found = await detectAlerts(db, id, config, NOW);
    expect(found).toHaveLength(1);
    // 10.000 impressions over a peak reach of 1.000 ≈ frequency 10.
    expect(Number(found[0]?.detail.frequencyMilli)).toBeGreaterThanOrEqual(3000);
  });

  it('leaves a healthy frequency alone', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'ad',
      entityExternalId: 'ad-fresh',
      day: '2026-09-15',
      spendCents: 4000,
      impressions: 1200,
      reach: 1000,
      frequencyMilli: 1200,
    });

    expect(await detectAlerts(db, id, config, NOW)).toHaveLength(0);
  });
});

describe('quality ranking', () => {
  const config = only({
    qualityBelowAverage: { ...DEFAULT_ALERT_CONFIG.qualityBelowAverage, enabled: true },
  });

  it('stays dormant while Meta reports UNKNOWN, which is this account today', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'ad',
      entityExternalId: 'ad-1',
      day: '2026-09-15',
      spendCents: 3000,
      impressions: 500,
      qualityRanking: 'UNKNOWN',
    });

    expect(await detectAlerts(db, id, config, NOW)).toHaveLength(0);
  });

  it('wakes up on its own once a real ranking arrives', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'ad',
      entityExternalId: 'ad-2',
      day: '2026-09-15',
      spendCents: 3000,
      impressions: 90_000,
      qualityRanking: 'BELOW_AVERAGE_20',
    });

    const found = await detectAlerts(db, id, config, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('quality_below_average');
    expect(found[0]?.detail.qualityRanking).toBe('BELOW_AVERAGE_20');
  });
});

describe('conversion silence', () => {
  async function accountSpendingWithoutLeads(): Promise<string> {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'campaign',
      entityExternalId: 'c-silent',
      day: '2026-09-16',
      spendCents: 9_000, // R$90, above the R$50 threshold
      impressions: 4000,
      clicks: 60,
      conversions: 0,
      actions: { link_click: 60 },
    });
    return id;
  }

  it('is switched off by default, because this account has never recorded a lead', async () => {
    const id = await accountSpendingWithoutLeads();
    expect(DEFAULT_ALERT_CONFIG.conversionSilence.enabled).toBe(false);

    const found = await detectAlerts(db, id, DEFAULT_ALERT_CONFIG, NOW);
    expect(found.some((alert) => alert.kind === 'conversion_silence')).toBe(false);
  });

  it('fires as critical once switched on', async () => {
    const id = await accountSpendingWithoutLeads();
    const config = only({
      conversionSilence: { ...DEFAULT_ALERT_CONFIG.conversionSilence, enabled: true },
    });

    const found = await detectAlerts(db, id, config, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('critical');
    expect(found[0]?.title).toContain('90,00');
  });

  it('ignores spend below the threshold', async () => {
    const id = await account();
    await db.insert(adMetricsDaily).values({
      adAccountId: id,
      level: 'campaign',
      entityExternalId: 'c-quiet',
      day: '2026-09-16',
      spendCents: 1_200,
      impressions: 300,
      conversions: 0,
    });
    const config = only({
      conversionSilence: { ...DEFAULT_ALERT_CONFIG.conversionSilence, enabled: true },
    });

    expect(await detectAlerts(db, id, config, NOW)).toHaveLength(0);
  });
});

describe("the platforms' UTM standard", () => {
  it('flags an active Meta ad without the standard url_tags, on the panel only', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-std', campaignId: 'c1', adSetId: 'as1', name: 'Padrão', urlTags: META_URL_TAGS },
      // Same parameters, another order: still the standard.
      {
        id: 'ad-reordered',
        campaignId: 'c1',
        adSetId: 'as1',
        name: 'Ordem trocada',
        urlTags: META_URL_TAGS.split('&').reverse().join('&'),
      },
      { id: 'ad-none', campaignId: 'c1', adSetId: 'as1', name: 'Sem UTM', urlTags: '' },
      {
        id: 'ad-old',
        campaignId: 'c1',
        adSetId: 'as1',
        name: 'Antigo',
        urlTags: 'utm_source=facebook&utm_medium=cpc',
      },
      {
        id: 'ad-paused',
        campaignId: 'c1',
        adSetId: 'as1',
        name: 'Pausado',
        status: 'PAUSED',
        effectiveStatus: 'PAUSED',
        urlTags: '',
      },
      // Never read: waits for the next ingest instead of crying wolf.
      { id: 'ad-unread', campaignId: 'c1', adSetId: 'as1', name: 'Não lido' },
    ]);
    const config = only({ metaAdWithoutUtms: { enabled: true } });

    const found = await detectAlerts(db, id, config, NOW);
    expect(found.map((alert) => alert.entityExternalId).sort()).toEqual(['ad-none', 'ad-old']);
    expect(found[0]).toMatchObject({ kind: 'meta_ad_without_utms', severity: 'warning' });

    const { notifier, sent } = recordingNotifier();
    const first = await runAlerts(db, id, { config, notifier, now: NOW });
    const second = await runAlerts(db, id, { config, notifier, now: NOW });
    // Deduplicated like every alert, and never sent to WhatsApp.
    expect([first.opened, second.opened, second.refreshed]).toEqual([2, 0, 2]);
    expect(sent).toHaveLength(0);
  });

  it("flags a Google campaign whose own suffix differs from the account's", async () => {
    const id = await ensureAdAccount(db, {
      platform: 'google',
      externalId: randomBytes(4).toString('hex'),
      name: 'Google Wings',
    });
    const accountSuffix =
      'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}';
    const campaign = (externalId: string, finalUrlSuffix: string | null) => ({
      adAccountId: id,
      externalId,
      name: `Campanha ${externalId}`,
      status: 'ACTIVE' as const,
      finalUrlSuffix,
    });
    await db
      .insert(adCampaigns)
      .values([
        campaign('1001', ''),
        campaign('1002', accountSuffix),
        campaign('1003', 'utm_source=outro'),
        campaign('1004', null),
      ]);
    const config = only({ googleCampaignOwnSuffix: { enabled: true } });

    // The account's suffix not read yet: nothing to compare with.
    expect(await detectAlerts(db, id, config, NOW)).toEqual([]);

    await db.update(adAccounts).set({ finalUrlSuffix: accountSuffix }).where(eq(adAccounts.id, id));
    const found = await detectAlerts(db, id, config, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'google_campaign_own_suffix',
      severity: 'warning',
      entityLevel: 'campaign',
      entityExternalId: '1003',
    });

    const { notifier, sent } = recordingNotifier();
    await runAlerts(db, id, { config, notifier, now: NOW });
    expect(sent).toHaveLength(0);
  });
});

describe('acknowledging', () => {
  it('records who saw it, without resolving it', async () => {
    const id = await account();
    await seedAdsWith(id, [
      { id: 'ad-bad', campaignId: 'c1', adSetId: 'as1', name: 'X', effectiveStatus: 'DISAPPROVED' },
    ]);
    await runAlerts(db, id, { config: only({ adRejected: { enabled: true } }), now: NOW });
    const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    const [alert] = await db.query.adAlerts.findMany({ where: eq(adAlerts.adAccountId, id) });
    if (!alert) throw new Error('no alert stored');

    expect(await acknowledgeAlert(db, alert.id, employee.id, NOW)).toBe(true);
    // Acknowledging twice is not an error the second time — it is a no-op.
    expect(await acknowledgeAlert(db, alert.id, employee.id, NOW)).toBe(false);

    const stored = await db.query.adAlerts.findFirst({ where: eq(adAlerts.id, alert.id) });
    expect(stored?.acknowledgedBy).toBe(employee.id);
    expect(stored?.resolvedAt).toBeNull();
  });
});
