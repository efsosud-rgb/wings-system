import { describe, expect, it } from 'vitest';
import { effectiveHeadroomCents, limitFrom, prepaidLimitFrom } from './limits.js';

describe('limitFrom', () => {
  it('is the limit minus what was spent, floored at zero', () => {
    expect(limitFrom(250_000, 63_690, 'meta.spend_cap')).toEqual({
      limitCents: 250_000,
      spentCents: 63_690,
      remainingCents: 186_310,
      source: 'meta.spend_cap',
    });
  });

  it('never goes negative when spend has outrun the cap', () => {
    expect(limitFrom(10_000, 15_000, 'meta.spend_cap').remainingCents).toBe(0);
  });

  it('is null — uncapped — when the platform sets no limit', () => {
    expect(limitFrom(null, 5_000, 'meta.spend_cap').remainingCents).toBeNull();
  });
});

describe('prepaidLimitFrom', () => {
  it('uses the balance itself as the remaining headroom, not limit minus spent', () => {
    // A balance that does NOT agree with a naive spend_cap - amount_spent:
    // the cap was raised mid-month, so the two figures diverge on purpose.
    const result = prepaidLimitFrom(20_76, 32_500, 'google.account_budget');
    expect(result.remainingCents).toBe(20_76);
    expect(result.spentCents).toBe(32_500);
    expect(result.source).toBe('google.account_budget');
  });

  it('reconstructs a limitCents for logging, from balance plus spent', () => {
    expect(prepaidLimitFrom(1_000, 4_000, 'meta.prepaid_balance').limitCents).toBe(5_000);
  });

  it('is null — uncapped — when the platform reports no balance at all', () => {
    const result = prepaidLimitFrom(null, 1_000, 'meta.prepaid_balance');
    expect(result.remainingCents).toBeNull();
    expect(result.limitCents).toBeNull();
  });

  it('passes a zero balance through as zero, not as uncapped', () => {
    expect(prepaidLimitFrom(0, 1_000, 'meta.prepaid_balance').remainingCents).toBe(0);
  });
});

describe('effectiveHeadroomCents', () => {
  it('takes the smaller of the two headrooms', () => {
    expect(effectiveHeadroomCents(100_000, 40_000)).toBe(40_000);
    expect(effectiveHeadroomCents(20_000, 40_000)).toBe(20_000);
  });

  it('is the internal headroom alone when the platform sets no limit', () => {
    expect(effectiveHeadroomCents(75_000, null)).toBe(75_000);
  });

  it('never goes negative', () => {
    expect(effectiveHeadroomCents(-5_000, 10_000)).toBe(0);
  });
});
