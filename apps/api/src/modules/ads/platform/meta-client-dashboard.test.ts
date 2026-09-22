import { describe, expect, it } from 'vitest';
import { MetaReadOnlyClient, VIDEO_FIELDS } from './meta-client.js';
import {
  creativeFormatOf,
  fundingKindOf,
  prepaidBalanceFromDisplay,
  sumActionValues,
} from './meta-parse.js';

/**
 * What the dashboard added to the Meta reader: video figures, the account's
 * funding, the creative's format and the four breakdowns. All against scripted
 * payloads through an injected fetch — no test can reach Meta.
 */

interface Recorded {
  path: string;
  query: Record<string, string>;
}

function client(handler: (call: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetchImpl = ((input: unknown) => {
    const url = new URL(String(input));
    const call = {
      path: url.pathname.replace(/^\/v[\d.]+\//, ''),
      query: Object.fromEntries(url.searchParams.entries()),
    };
    calls.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(handler(call)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return {
    calls,
    meta: new MetaReadOnlyClient({
      accessToken: 'test-token-not-real',
      adAccountId: 'act_123456789',
      fetchImpl,
    }),
  };
}

describe('video figures on an insights row', () => {
  it('reads 3-second plays from actions and the rest from the video fields', async () => {
    const { meta, calls } = client(() => ({
      data: [
        {
          ad_id: 'ad-1',
          date_start: '2026-09-15',
          spend: '12.50',
          impressions: '1000',
          clicks: '20',
          reach: '800',
          ctr: '2',
          frequency: '1.25',
          actions: [
            { action_type: 'link_click', value: '20' },
            { action_type: 'video_view', value: '300' },
          ],
          video_thruplay_watched_actions: [{ action_type: 'video_view', value: '120' }],
          video_p25_watched_actions: [{ action_type: 'video_view', value: '200' }],
          video_p50_watched_actions: [{ action_type: 'video_view', value: '150' }],
          video_p75_watched_actions: [{ action_type: 'video_view', value: '90' }],
          video_p100_watched_actions: [{ action_type: 'video_view', value: '45' }],
        },
      ],
    }));

    const [row] = await meta.getInsights('ad', '2026-09-15', '2026-09-15');
    expect(row?.video).toEqual({
      plays: 300,
      thruplays: 120,
      p25: 200,
      p50: 150,
      p75: 90,
      p100: 45,
    });
    // The fields ride on the same request: no extra call for video.
    expect(calls).toHaveLength(1);
    for (const field of VIDEO_FIELDS) expect(calls[0]?.query.fields).toContain(field);
  });

  it('is zero, not absent, on an image ad', async () => {
    const { meta } = client(() => ({
      data: [{ campaign_id: 'c1', date_start: '2026-09-15', spend: '1.00', impressions: '10' }],
    }));
    const [row] = await meta.getInsights('campaign', '2026-09-15', '2026-09-15');
    expect(row?.video).toEqual({ plays: 0, thruplays: 0, p25: 0, p50: 0, p75: 0, p100: 0 });
  });

  it('sums an action list and shrugs at anything else', () => {
    expect(sumActionValues([{ value: '3' }, { value: '4' }])).toBe(7);
    expect(sumActionValues(undefined)).toBe(0);
    expect(sumActionValues('12')).toBe(0);
  });
});

describe('the breakdowns', () => {
  it('asks for one split per call and keeps the platform names as keys', async () => {
    const { meta, calls } = client((call) =>
      call.query.breakdowns === 'publisher_platform,platform_position'
        ? {
            data: [
              {
                campaign_id: 'c1',
                date_start: '2026-09-15',
                publisher_platform: 'instagram',
                platform_position: 'instagram_reels',
                spend: '4.00',
                impressions: '400',
                clicks: '8',
                reach: '350',
                actions: [{ action_type: 'lead', value: '1' }],
              },
            ],
          }
        : { data: [] },
    );

    const rows = await meta.getBreakdowns('placement', '2026-09-15', '2026-09-15');
    expect(rows).toEqual([
      {
        kind: 'placement',
        campaignId: 'c1',
        date: '2026-09-15',
        key: 'instagram',
        subKey: 'instagram_reels',
        spendCents: 400,
        impressions: 400,
        clicks: 8,
        reach: 350,
        actions: { lead: 1 },
      },
    ]);
    expect(calls[0]?.query.level).toBe('campaign');
    expect(calls[0]?.query.fields).toContain('reach');
  });

  it('keeps only the hour of the hourly range, and never asks reach by hour', async () => {
    const { meta, calls } = client(() => ({
      data: [
        {
          campaign_id: 'c1',
          date_start: '2026-09-15',
          hourly_stats_aggregated_by_advertiser_time_zone: '14:00:00 - 14:59:59',
          spend: '1.50',
          impressions: '100',
          clicks: '2',
        },
      ],
    }));

    const [row] = await meta.getBreakdowns('hour', '2026-09-15', '2026-09-15');
    expect(row?.key).toBe('14');
    expect(row?.subKey).toBe('');
    expect(row?.reach).toBe(0);
    expect(calls[0]?.query.breakdowns).toBe('hourly_stats_aggregated_by_advertiser_time_zone');
    expect(calls[0]?.query.fields).not.toContain('reach');
  });

  it('splits age and gender into key and sub-key', async () => {
    const { meta } = client(() => ({
      data: [
        {
          campaign_id: 'c1',
          date_start: '2026-09-15',
          age: '25-34',
          gender: 'female',
          spend: '0.75',
          impressions: '50',
          clicks: '1',
          reach: '48',
        },
      ],
    }));
    const [row] = await meta.getBreakdowns('age_gender', '2026-09-15', '2026-09-15');
    expect(row?.key).toBe('25-34');
    expect(row?.subKey).toBe('female');
  });
});

describe('the account and its funding', () => {
  it('reads a prepaid balance out of the display string', async () => {
    const { meta, calls } = client(() => ({
      id: 'act_123456789',
      currency: 'BRL',
      spend_cap: '250000',
      amount_spent: '63690',
      funding_source_details: { type: 20, display_string: 'Saldo pré-pago: R$ 1.234,56' },
    }));
    const account = await meta.getAccount();
    expect(account.prepaidBalanceCents).toBe(123_456);
    expect(account.fundingKind).toBe('prepaid');
    expect(calls[0]?.query.fields).toContain('funding_source_details');
  });

  it('reports a card account with no balance', async () => {
    const { meta } = client(() => ({
      id: 'act_123456789',
      currency: 'BRL',
      funding_source_details: { type: 1, display_string: 'Visa *1234' },
    }));
    const account = await meta.getAccount();
    expect(account.prepaidBalanceCents).toBeNull();
    expect(account.fundingKind).toBe('credit_card');
  });

  it('parses balances written either way, and nothing that is not a balance', () => {
    expect(prepaidBalanceFromDisplay('Prepaid balance: $1,234.56')).toBe(123_456);
    expect(prepaidBalanceFromDisplay('Saldo: R$ 500')).toBe(50_000);
    expect(prepaidBalanceFromDisplay('Mastercard *9876')).toBeNull();
    expect(prepaidBalanceFromDisplay(undefined)).toBeNull();
    expect(fundingKindOf('banana')).toBe('unknown');
    expect(fundingKindOf(99)).toBe('meta:99');
  });
});

describe('what a creative is made of', () => {
  it('tells video, carousel and image apart, and admits when it cannot', () => {
    expect(creativeFormatOf({ object_type: 'VIDEO' })).toBe('video');
    expect(creativeFormatOf({ object_story_spec: { video_data: { video_id: '1' } } })).toBe('video');
    expect(
      creativeFormatOf({
        object_type: 'SHARE',
        object_story_spec: { link_data: { child_attachments: [{}, {}, {}] } },
      }),
    ).toBe('carousel');
    expect(
      creativeFormatOf({
        object_type: 'SHARE',
        object_story_spec: { link_data: { child_attachments: [{}], image_hash: 'abc' } },
      }),
    ).toBe('image');
    expect(creativeFormatOf({ object_type: 'PHOTO' })).toBe('image');
    expect(creativeFormatOf({ object_type: 'SHARE' })).toBe('unknown');
  });

  it('carries the format on every ad listed', async () => {
    const { meta } = client(() => ({
      data: [
        {
          id: 'ad-1',
          name: 'Reels',
          status: 'ACTIVE',
          campaign_id: 'c1',
          adset_id: 'as1',
          creative: { id: 'cr1', object_type: 'VIDEO' },
        },
      ],
    }));
    const [ad] = await meta.listAds();
    expect(ad?.creative?.format).toBe('video');
  });
});
