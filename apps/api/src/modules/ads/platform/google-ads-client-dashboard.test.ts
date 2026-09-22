import { describe, expect, it } from 'vitest';
import { fakeGoogleApi, type FakeGoogleMetricsRow } from './fake-google-api.js';
import { GoogleAdsPlatformClient } from './google-ads-client.js';

/**
 * What the dashboard added to the Google reader: video figures on the daily
 * rows, the prepaid balance, and the four breakdowns as GAQL reports. Every
 * answer is scripted; nothing reaches Google.
 */

const NOW = () => new Date('2026-09-16T15:00:00.000Z');

const day = (extra: Partial<FakeGoogleMetricsRow> = {}): FakeGoogleMetricsRow => ({
  campaignId: '100',
  date: '2026-09-15',
  costMicros: '2500000',
  impressions: 500,
  clicks: 10,
  conversions: 1,
  ...extra,
});

function reader(metrics: FakeGoogleMetricsRow[]) {
  const api = fakeGoogleApi({
    campaigns: [{ id: '100', name: 'Pesquisa', status: 'ENABLED', amountMicros: '5000000' }],
    accountBudget: { limitMicros: '13100000000', servedMicros: '12600000000' },
    metrics,
  });
  return { api, google: new GoogleAdsPlatformClient(api.reader, NOW) };
}

describe('the account as a prepaid balance', () => {
  it('reports what is left as the balance', async () => {
    const { google } = reader([]);
    const account = await google.getAccount();
    expect(account.spendCapCents).toBe(1_310_000);
    expect(account.amountSpentCents).toBe(1_260_000);
    expect(account.prepaidBalanceCents).toBe(50_000);
    expect(account.fundingKind).toBe('prepaid');
  });
});

describe('video on the daily rows', () => {
  it('turns quartile rates into counts of views', async () => {
    const { google } = reader([day({ videoViews: 200, quartiles: [0.5, 0.3, 0.2, 0.1] })]);
    const [row] = await google.getInsights('campaign', '2026-09-15', '2026-09-15');
    expect(row?.video).toEqual({ plays: 200, thruplays: 20, p25: 100, p50: 60, p75: 40, p100: 20 });
  });
});

describe('the breakdowns as reports', () => {
  it('placement is the network the ad served on', async () => {
    const { google, api } = reader([day({ adNetworkType: 'YOUTUBE' }), day()]);
    const rows = await google.getBreakdowns('placement', '2026-09-15', '2026-09-15');
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'placement', key: 'youtube', subKey: '', spendCents: 250 }),
    ]);
    expect(api.searchCalls('campaign').at(-1)?.body.query).toContain('segments.ad_network_type');
  });

  it('hour keeps two digits', async () => {
    const { google } = reader([day({ hour: 9 })]);
    const [row] = await google.getBreakdowns('hour', '2026-09-15', '2026-09-15');
    expect(row?.key).toBe('09');
  });

  it('age and gender arrive as two sets of rows, each with "all" on the other side', async () => {
    const { google } = reader([
      day({ ageRange: 'AGE_RANGE_25_34' }),
      day({ gender: 'FEMALE' }),
      day({ gender: 'UNDETERMINED' }),
    ]);
    const rows = await google.getBreakdowns('age_gender', '2026-09-15', '2026-09-15');
    expect(rows.map((row) => [row.key, row.subKey])).toEqual([
      ['25-34', 'all'],
      ['all', 'female'],
      ['all', 'unknown'],
    ]);
  });

  it('region is named through one more read of the geo constants', async () => {
    const { google, api } = reader([
      day({ geoTargetRegion: 'geoTargetConstants/20106' }),
      day({ geoTargetRegion: 'geoTargetConstants/20101' }),
    ]);
    const rows = await google.getBreakdowns('region', '2026-09-15', '2026-09-15');
    expect(rows.map((row) => row.key)).toEqual(['São Paulo', 'Paraná']);
    expect(api.searchCalls('geo_target_constant')).toHaveLength(1);
  });

  it('leads are the conversions, as everywhere on this account', async () => {
    const { google } = reader([day({ hour: 9, conversions: 3 })]);
    const [row] = await google.getBreakdowns('hour', '2026-09-15', '2026-09-15');
    expect(row?.actions).toEqual({ lead: 3 });
  });
});
