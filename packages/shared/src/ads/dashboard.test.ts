import { describe, expect, it } from 'vitest';
import {
  addTotals,
  campaignDelivering,
  campaignEnded,
  deltaPercent,
  earliestEnd,
  effectiveCampaignEnd,
  EMPTY_TOTALS,
  fatigueOf,
  last24hDays,
  placementsLabel,
  ratiosOf,
} from './dashboard.js';

describe('ratios over a window', () => {
  it('leaves every ratio empty when nothing was delivered', () => {
    const ratios = ratiosOf(EMPTY_TOTALS);
    expect(Object.values(ratios).every((value) => value === null)).toBe(true);
  });

  it('never turns clicks into a cost per lead', () => {
    const ratios = ratiosOf({
      ...EMPTY_TOTALS,
      spendCents: 10_000,
      impressions: 5000,
      clicks: 100,
    });
    expect(ratios.ctrMilli).toBe(2000);
    expect(ratios.cpcCents).toBe(100);
    expect(ratios.cpmCents).toBe(2000);
    expect(ratios.costPerLeadCents).toBeNull();
  });

  it('computes the video funnel from plays, not impressions', () => {
    const ratios = ratiosOf({
      ...EMPTY_TOTALS,
      impressions: 1000,
      videoPlays: 400,
      videoThruplays: 100,
      videoP100: 40,
    });
    expect(ratios.hookRateMilli).toBe(40_000);
    expect(ratios.holdRateMilli).toBe(25_000);
    expect(ratios.completionRateMilli).toBe(10_000);
  });

  it('adds partial rows without inventing fields', () => {
    const total = addTotals(EMPTY_TOTALS, { spendCents: 5, clicks: 2 });
    expect(total.spendCents).toBe(5);
    expect(total.clicks).toBe(2);
    expect(total.videoP100).toBe(0);
  });
});

describe('change against the previous window', () => {
  it('is a rate only when there was something before', () => {
    expect(deltaPercent(150, 100)).toBe(50);
    expect(deltaPercent(50, 100)).toBe(-50);
    expect(deltaPercent(100, 0)).toBeNull();
    expect(deltaPercent(100, null)).toBeNull();
    expect(deltaPercent(null, 100)).toBeNull();
  });
});

describe('creative fatigue', () => {
  it('flags a CTR that fell by a fifth at a frequency above 2', () => {
    expect(fatigueOf(2000, 1500, 2300).wornOut).toBe(true);
  });

  it('does not flag a drop at low frequency, nor a small drop', () => {
    expect(fatigueOf(2000, 1500, 1200).wornOut).toBe(false);
    expect(fatigueOf(2000, 1800, 2300).wornOut).toBe(false);
  });

  it('cannot judge an ad that did not deliver in both halves', () => {
    expect(fatigueOf(null, 1500, 2300).wornOut).toBe(false);
    expect(fatigueOf(2000, null, 2300).wornOut).toBe(false);
  });
});

describe('a campaign that ran its course', () => {
  it('ends when Google says ENDED, or when its last day is before today', () => {
    expect(campaignEnded({ deliveryStatus: 'ENDED', endDate: null }, '2026-10-22')).toBe(true);
    expect(campaignEnded({ deliveryStatus: 'ACTIVE', endDate: '2026-10-09' }, '2026-10-22')).toBe(
      true,
    );
    // The last day itself still delivers.
    expect(campaignEnded({ deliveryStatus: 'SERVING', endDate: '2026-10-22' }, '2026-10-22')).toBe(
      false,
    );
    expect(campaignEnded({ deliveryStatus: null, endDate: null }, '2026-10-22')).toBe(false);
  });
});

describe('where a campaign ends when its schedule lives on the ad sets', () => {
  it('keeps the campaign own end date', () => {
    expect(effectiveCampaignEnd('2026-10-05', [{ status: 'ACTIVE', endDate: '2026-10-13' }])).toBe(
      '2026-10-05',
    );
  });

  it('ends with the latest end among the ad sets that are on, when every one has an end', () => {
    expect(
      effectiveCampaignEnd(null, [
        { status: 'ACTIVE', endDate: '2026-10-13' },
        { status: 'ACTIVE', endDate: '2026-10-11' },
        { status: 'PAUSED', endDate: null },
      ]),
    ).toBe('2026-10-13');
  });

  it('ends with the ad sets when they stop before the campaign does, and not before them when they stop after', () => {
    expect(effectiveCampaignEnd('2026-10-20', [{ status: 'ACTIVE', endDate: '2026-10-10' }])).toBe(
      '2026-10-10',
    );
    expect(effectiveCampaignEnd('2026-10-10', [{ status: 'ACTIVE', endDate: '2026-10-20' }])).toBe(
      '2026-10-10',
    );
    // The campaign has an end and one ad set that is on has none: the campaign's end stands.
    expect(
      effectiveCampaignEnd('2026-10-20', [
        { status: 'ACTIVE', endDate: '2026-10-10' },
        { status: 'ACTIVE', endDate: null },
      ]),
    ).toBe('2026-10-20');
    expect(earliestEnd(null, '2026-10-05')).toBe('2026-10-05');
    expect(earliestEnd('2026-10-05', null)).toBe('2026-10-05');
    expect(earliestEnd(null, null)).toBeNull();
  });

  it('stays open while one ad set that is on has no end, or none is on', () => {
    expect(
      effectiveCampaignEnd(null, [
        { status: 'ACTIVE', endDate: '2026-10-13' },
        { status: 'ACTIVE', endDate: null },
      ]),
    ).toBeNull();
    expect(effectiveCampaignEnd(null, [{ status: 'PAUSED', endDate: '2026-10-13' }])).toBeNull();
    expect(effectiveCampaignEnd(null, [])).toBeNull();
  });

  it('names the platforms an ad set delivers on, and nothing for automatic placements', () => {
    expect(placementsLabel({ platforms: ['instagram'], positions: ['instagram:stream'] })).toBe(
      'Instagram',
    );
    expect(placementsLabel({ platforms: ['instagram', 'facebook'], positions: [] })).toBe(
      'Instagram, Facebook',
    );
    expect(placementsLabel(null)).toBeNull();
    expect(placementsLabel({ platforms: [], positions: [] })).toBeNull();
  });
});

describe('the one rule for "em veiculação"', () => {
  const TODAY = '2026-10-29';
  const meta = {
    platform: 'meta' as const,
    status: 'ACTIVE',
    deliveryStatus: 'ACTIVE' as string | null,
    endDate: null as string | null,
    spentLast24h: false,
  };

  it('counts the last 24 hours as today and the day before', () => {
    expect(last24hDays('2026-10-29')).toEqual({ since: '2026-10-28', until: '2026-10-29' });
    expect(last24hDays('2026-11-01')).toEqual({ since: '2026-10-31', until: '2026-11-01' });
    expect(last24hDays('2027-01-01')).toEqual({ since: '2026-12-31', until: '2027-01-01' });
  });

  it('lets spend in the last 24 hours win over a paused status and a past end date', () => {
    const spending = { ...meta, spentLast24h: true };
    expect(
      campaignDelivering({ ...spending, status: 'PAUSED', deliveryStatus: 'PAUSED' }, TODAY),
    ).toBe(true);
    expect(campaignDelivering({ ...spending, endDate: '2026-10-20' }, TODAY)).toBe(true);
    const google = { ...spending, platform: 'google' as const };
    expect(
      campaignDelivering({ ...google, status: 'PAUSED', deliveryStatus: 'ENDED' }, TODAY),
    ).toBe(true);
  });

  it('keeps the status as the rule when nothing was spent', () => {
    expect(campaignDelivering(meta, TODAY)).toBe(true);
    expect(campaignDelivering({ ...meta, deliveryStatus: null }, TODAY)).toBe(true);
    expect(campaignDelivering({ ...meta, status: 'PAUSED', deliveryStatus: 'PAUSED' }, TODAY)).toBe(
      false,
    );
    expect(campaignDelivering({ ...meta, deliveryStatus: 'CAMPAIGN_PAUSED' }, TODAY)).toBe(false);
    expect(campaignDelivering({ ...meta, endDate: '2026-10-28' }, TODAY)).toBe(false);
    expect(campaignDelivering({ ...meta, endDate: TODAY }, TODAY)).toBe(true);
    const google = { ...meta, platform: 'google' as const };
    expect(campaignDelivering({ ...google, deliveryStatus: 'SERVING' }, TODAY)).toBe(true);
    expect(campaignDelivering({ ...google, deliveryStatus: 'ENDED' }, TODAY)).toBe(false);
    expect(campaignDelivering({ ...google, status: 'PAUSED', deliveryStatus: null }, TODAY)).toBe(
      false,
    );
  });
});
