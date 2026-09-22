import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, forecastOf, monthOf, windowOf } from './window.js';

describe('the dashboard calendar', () => {
  it('counts today in São Paulo, not in UTC', () => {
    // 01:30 UTC on the 17th is still the evening of the 16th in São Paulo.
    const window = windowOf(7, new Date('2026-09-17T01:30:00.000Z'));
    expect(window.until).toBe('2026-09-16');
    expect(window.since).toBe('2026-09-10');
    expect(window.previousUntil).toBe('2026-09-09');
    expect(window.previousSince).toBe('2026-09-03');
  });

  it('splits a window into two halves of equal length', () => {
    const window = windowOf(14, new Date('2026-09-16T15:00:00.000Z'));
    expect(daysBetween(window.since, window.midpoint)).toHaveLength(7);
    expect(daysBetween(addDays(window.midpoint, 1), window.until)).toHaveLength(7);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('projects the month from the days gone, and refuses on day one', () => {
    const midMonth = monthOf(new Date('2026-09-16T15:00:00.000Z'));
    expect(midMonth.totalDays).toBe(30);
    expect(midMonth.elapsedDays).toBe(15.5);
    expect(forecastOf(15_500, midMonth)).toBe(30_000);

    const firstMorning = monthOf(new Date('2026-09-01T09:00:00.000Z'));
    expect(forecastOf(1_000, firstMorning)).toBeNull();
  });
});
