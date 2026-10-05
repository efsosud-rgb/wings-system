import { describe, expect, it } from 'vitest';
import { cityKey, salesDashboardQuerySchema, salesRanges, salesTrendOf } from './sales-panel.js';

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

describe('salesTrendOf', () => {
  const won = (entries: [string, number][]) => new Map(entries);

  it('accumulates by day, stops at today and reads the comparison by position', () => {
    const ranges = salesRanges('month', new Date('2026-10-04T15:00:00Z'));
    // A 31-day month to date, 4 days in: 01/10 to 04/10 against 01/09 to 04/09.
    const trend = salesTrendOf(ranges, '2026-10-03', {
      current: won([
        ['2026-10-01', 100],
        ['2026-10-03', 50],
      ]),
      previous: won([['2026-09-02', 70]]),
      previousYear: won([]),
    });
    expect(trend.bucket).toBe('day');
    expect(trend.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(trend.current).toEqual([100, 100, 150, null]);
    expect(trend.previous).toEqual([0, 70, 70, 70]);
    expect(trend.previousYear).toEqual([0, 0, 0, 0]);
    expect(trend.goalCents).toBeNull();
  });

  it('goes by week past 92 days, and a shorter comparison ends in null', () => {
    const trend = salesTrendOf(
      {
        current: { from: '2026-01-01', to: '2026-04-30' },
        previous: { from: '2025-12-01', to: '2025-12-10' },
        previousYear: { from: '2025-01-01', to: '2025-04-30' },
      },
      '2026-04-30',
      {
        current: won([
          ['2026-01-03', 10],
          ['2026-01-08', 5],
        ]),
        previous: won([['2025-12-09', 1]]),
        previousYear: won([]),
      },
    );
    expect(trend.bucket).toBe('week');
    expect(trend.days.slice(0, 2)).toEqual(['2026-01-01', '2026-01-08']);
    expect(trend.current.slice(0, 2)).toEqual([10, 15]);
    expect(trend.previous.slice(0, 3)).toEqual([0, 1, null]);
    expect(trend.days).toHaveLength(18);
  });
});
