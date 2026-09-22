import { describe, expect, it } from 'vitest';
import { dueWeekKey, isoWeekOf, nextScheduledAt } from './scheduler.js';

/** When Monday's run is due, decided on fixed instants, in São Paulo time (UTC−3). */
describe('the weekly schedule', () => {
  it('is due from 07:00 on Monday, São Paulo, until the end of that Monday', () => {
    expect(dueWeekKey(new Date('2026-09-21T09:59:00.000Z'))).toBeNull(); // Monday 06:59
    expect(dueWeekKey(new Date('2026-09-21T10:00:00.000Z'))).toBe('2026-W39'); // Monday 07:00
    expect(dueWeekKey(new Date('2026-09-21T23:30:00.000Z'))).toBe('2026-W39'); // Monday 20:30
    expect(dueWeekKey(new Date('2026-09-22T03:00:00.000Z'))).toBeNull(); // Tuesday 00:00 in São Paulo
    expect(dueWeekKey(new Date('2026-09-20T12:00:00.000Z'))).toBeNull(); // Sunday
  });

  it('names ISO weeks the way the unique index expects', () => {
    expect(isoWeekOf('2026-09-21')).toBe('2026-W39');
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53');
  });

  it('says when the next run is', () => {
    expect(nextScheduledAt(new Date('2026-09-22T12:00:00.000Z')).toISOString()).toBe(
      '2026-09-28T10:00:00.000Z',
    );
    expect(nextScheduledAt(new Date('2026-09-21T09:00:00.000Z')).toISOString()).toBe(
      '2026-09-21T10:00:00.000Z',
    );
    expect(nextScheduledAt(new Date('2026-09-21T10:00:00.000Z')).toISOString()).toBe(
      '2026-09-28T10:00:00.000Z',
    );
    expect(nextScheduledAt(new Date('2026-09-20T12:00:00.000Z')).toISOString()).toBe(
      '2026-09-21T10:00:00.000Z',
    );
  });
});
