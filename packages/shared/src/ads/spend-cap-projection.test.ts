import { describe, expect, it } from 'vitest';
import { firstOfNextMonth, projectSpendCapPause } from './cockpit.js';

describe('projectSpendCapPause', () => {
  const base = { spendCapCents: 250_000, reset: 'monthly' as const };

  it('stops at the end of the month when the limit resets on the 1st', () => {
    // 30/09: R$ 979,16 left, R$ 120/day until 05/10 — the 1st brings R$ 2.500 back.
    const result = projectSpendCapPause({
      ...base,
      today: '2026-09-30',
      remainingCents: 97_916,
      streams: [{ dailyBudgetCents: 12_000, startDate: null, endDate: '2026-10-05' }],
    });
    expect(result.pauseDate).toBeNull();
    expect(result.horizonEnd).toBe('2026-10-05');
  });

  it('finds the day the remainder runs out inside the month', () => {
    const result = projectSpendCapPause({
      ...base,
      today: '2026-09-20',
      remainingCents: 50_000,
      streams: [
        { dailyBudgetCents: 12_000, startDate: null, endDate: null },
        { dailyBudgetCents: 8_000, startDate: '2026-09-22', endDate: '2026-09-30' },
      ],
    });
    // 20: 120, 21: 240, 22: 440, 23: 640 > 500.
    expect(result.pauseDate).toBe('2026-09-23');
    expect(result.allowedCents).toBe(50_000);
  });

  it('judges a later month against the full limit after the reset', () => {
    const result = projectSpendCapPause({
      ...base,
      today: '2026-09-30',
      remainingCents: 100_000,
      streams: [{ dailyBudgetCents: 20_000, startDate: '2026-10-01', endDate: '2026-10-31' }],
    });
    // 2.500 / 200 per day = 12.5 days: the 13th day of October breaks it.
    expect(result.pauseDate).toBe('2026-10-13');
    expect(result.allowedCents).toBe(250_000);
  });

  it('never resets when nobody said the limit resets', () => {
    const result = projectSpendCapPause({
      ...base,
      reset: null,
      today: '2026-09-30',
      remainingCents: 97_916,
      streams: [{ dailyBudgetCents: 12_000, startDate: null, endDate: '2026-10-10' }],
    });
    // 979,16 / 120 = 8.2 days: 30/09 … 07/10 is 8 days (960), 08/10 breaks it.
    expect(result.pauseDate).toBe('2026-10-08');
  });

  it('ignores budgets already ended and has no pause with nothing running', () => {
    const result = projectSpendCapPause({
      ...base,
      today: '2026-09-30',
      remainingCents: 0,
      streams: [{ dailyBudgetCents: 12_000, startDate: null, endDate: '2026-09-29' }],
    });
    expect(result.pauseDate).toBeNull();
  });

  it('knows the first of next month across the year', () => {
    expect(firstOfNextMonth('2026-12-15')).toBe('2027-01-01');
  });
});
