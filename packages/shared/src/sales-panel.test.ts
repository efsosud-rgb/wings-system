import { describe, expect, it } from 'vitest';
import { cityKey, salesDashboardQuerySchema, salesRanges } from './sales-panel.js';

// 15/10/2026 at noon in São Paulo.
const NOW = new Date('2026-10-15T15:00:00Z');

describe('salesRanges', () => {
  it('compares the month to date with the same days of the month before and of last year', () => {
    expect(salesRanges('month', NOW)).toEqual({
      current: { from: '2026-10-01', to: '2026-10-15' },
      previous: { from: '2026-09-01', to: '2026-09-15' },
      previousYear: { from: '2025-10-01', to: '2025-10-15' },
    });
    // Late in the evening of the 31st in São Paulo is still the 31st.
    expect(salesRanges('month', new Date('2026-04-01T02:00:00Z')).current).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
    });
    // A longer month never spills past the end of the shorter one.
    expect(salesRanges('month', new Date('2026-03-31T15:00:00Z')).previous).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('rolls 7, 30 and 90 days back from today, against the same length just before', () => {
    expect(salesRanges('7d', NOW)).toMatchObject({
      current: { from: '2026-10-09', to: '2026-10-15' },
      previous: { from: '2026-10-02', to: '2026-10-08' },
    });
    expect(salesRanges('90d', NOW).current.from).toBe('2026-07-18');
  });

  it('starts quarters and years at their first day', () => {
    expect(salesRanges('quarter', NOW)).toMatchObject({
      current: { from: '2026-10-01', to: '2026-10-15' },
      previous: { from: '2026-07-01', to: '2026-07-15' },
    });
    expect(salesRanges('year', NOW)).toMatchObject({
      current: { from: '2026-01-01', to: '2026-10-15' },
      previous: { from: '2025-01-01', to: '2025-10-15' },
    });
  });

  it('takes a custom range as given', () => {
    expect(salesRanges('custom', NOW, { from: '2026-08-01', to: '2026-08-10' })).toMatchObject({
      current: { from: '2026-08-01', to: '2026-08-10' },
      previous: { from: '2026-07-22', to: '2026-07-31' },
    });
  });
});

describe('salesDashboardQuerySchema', () => {
  it('defaults to every funnel this month and refuses a custom range without both ends', () => {
    expect(salesDashboardQuerySchema.parse({})).toMatchObject({
      pipeline: 'todos',
      period: 'month',
    });
    expect(
      salesDashboardQuerySchema.safeParse({ period: 'custom', from: '2026-10-01' }).success,
    ).toBe(false);
    expect(
      salesDashboardQuerySchema.safeParse({
        period: 'custom',
        from: '2026-10-09',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
  });
});

describe('cityKey', () => {
  it('folds case, accents and spaces', () => {
    expect(cityKey('  São   Paulo ')).toBe(cityKey('sao paulo'));
  });
});
