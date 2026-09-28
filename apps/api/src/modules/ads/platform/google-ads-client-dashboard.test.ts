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

  it('makes video unavailable, with a warning, when the API does not know a field', async () => {
    // What staging answered on the first real run: v22 refused
    // metrics.video_views on campaign. The money rows still come back.
    const api = fakeGoogleApi({
      campaigns: [{ id: '100', name: 'Pesquisa', status: 'ENABLED', amountMicros: '5000000' }],
      metrics: [day({ videoViews: 200, quartiles: [0.5, 0.3, 0.2, 0.1] })],
      unrecognizedFields: ['metrics.video_views'],
    });
    const google = new GoogleAdsPlatformClient(api.reader, NOW);
    const rows = await google.getInsights('campaign', '2026-09-15', '2026-09-15');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spendCents).toBe(250);
    expect(rows[0]?.video).toEqual({ plays: 0, thruplays: 0, p25: 0, p50: 0, p75: 0, p100: 0 });
    const warnings = google.drainWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('metrics.video_views');
    expect(google.drainWarnings()).toEqual([]);

    // Learned once: the next read does not ask for video again.
    const before = api.calls.length;
    await google.getInsights('campaign', '2026-09-15', '2026-09-15');
    const queries = api.calls.slice(before).map((call) => String(call.body.query ?? ''));
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('video');
  });

  it('still fails on an error that is not an unknown field', async () => {
    const api = fakeGoogleApi({
      campaigns: [{ id: '100', name: 'Pesquisa', status: 'ENABLED', amountMicros: '5000000' }],
      metrics: [day()],
      unrecognizedFields: [],
    });
    const google = new GoogleAdsPlatformClient(api.reader, NOW);
    api.reader.search = () => Promise.reject(new Error('google: search failed (500): backend'));
    await expect(google.getInsights('campaign', '2026-09-15', '2026-09-15')).rejects.toThrow('500');
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

describe('search ads and their schedule (28/09)', () => {
  function account() {
    const api = fakeGoogleApi({
      campaigns: [
        {
          id: '100',
          name: 'SEARCH | Set26',
          status: 'ENABLED',
          amountMicros: '100000000',
          startDate: '2026-09-28',
          endDate: '2037-12-30',
        },
        {
          id: '200',
          name: 'Antiga',
          status: 'PAUSED',
          amountMicros: '5000000',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
        },
      ],
      existingAds: [
        {
          id: '55~9001',
          adGroupId: '55',
          campaignId: '100',
          status: 'ENABLED',
          finalUrls: ['https://wingscompany.com.br/formatar/franquia'],
          headlines: [
            'Formate sua franquia',
            'Fale com a Wings',
            'Modelo completo',
            'Quarto título',
          ],
          descriptions: ['Estruturamos a sua rede do zero.', 'Outra descrição.'],
        },
        {
          id: '55~9002',
          adGroupId: '55',
          campaignId: '100',
          status: 'ENABLED',
          approvalStatus: 'DISAPPROVED',
          finalUrls: [],
          headlines: ['Reprovado'],
          descriptions: [],
        },
      ],
      adMetrics: [
        {
          adId: '9001',
          date: '2026-09-15',
          costMicros: '3200000',
          impressions: 80,
          clicks: 6,
          conversions: 1,
        },
        { adId: '9001', date: '2026-08-01', costMicros: '9900000', impressions: 1, clicks: 1 },
      ],
    });
    return new GoogleAdsPlatformClient(api.reader, NOW);
  }

  it('lists responsive search ads with their headlines as a text creative, under their campaign', async () => {
    const ads = await account().listAds();
    expect(ads).toHaveLength(2);
    expect(ads[0]).toMatchObject({
      id: '9001',
      campaignId: '100',
      status: 'ACTIVE',
      effectiveStatus: 'APPROVED',
      creative: {
        title: 'Formate sua franquia | Fale com a Wings | Modelo completo',
        body: 'Estruturamos a sua rede do zero.',
        format: 'text',
        thumbnailUrl: null,
      },
    });
    expect(ads[1]?.effectiveStatus).toBe('DISAPPROVED');
  });

  it('reports each ad per day, inside the window only', async () => {
    const rows = await account().getInsights('ad', '2026-09-10', '2026-09-16');
    expect(rows).toEqual([
      expect.objectContaining({
        level: 'ad',
        entityId: '9001',
        date: '2026-09-15',
        spendCents: 320,
        impressions: 80,
        clicks: 6,
        actions: { lead: 1 },
      }),
    ]);
    expect(await account().getInsights('ad_set', '2026-09-10', '2026-09-16')).toEqual([]);
  });

  it("reads the campaign's start and end, and Google's far-future end as no end", async () => {
    const campaigns = await account().listCampaigns();
    expect(campaigns.find((campaign) => campaign.id === '100')).toMatchObject({
      startDate: '2026-09-28',
      endDate: null,
    });
    expect(campaigns.find((campaign) => campaign.id === '200')).toMatchObject({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    });
  });
});
