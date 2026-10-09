import { describe, expect, it } from 'vitest';
import {
  addTotals,
  deltaPercent,
  effectiveCampaignEnd,
  EMPTY_TOTALS,
  fatigueOf,
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
