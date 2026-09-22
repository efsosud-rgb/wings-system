import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron, previousCronRun } from './cron.js';

const SP = 'America/Sao_Paulo';

describe('nextCronRun', () => {
  it('finds the next top of the hour', () => {
    const next = nextCronRun('0 * * * *', new Date('2026-09-22T14:20:00.000Z'), SP);
    expect(next?.toISOString()).toBe('2026-09-22T15:00:00.000Z');
  });

  it("reads the hour on São Paulo's clock, not UTC", () => {
    // 07:00 in São Paulo is 10:00 UTC all year since 2019.
    const next = nextCronRun('0 7 * * 1', new Date('2026-09-22T14:20:00.000Z'), SP);
    expect(next?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
  });

  it('handles steps, ranges and lists', () => {
    expect(
      nextCronRun('*/15 * * * *', new Date('2026-09-22T14:20:00.000Z'), SP)?.toISOString(),
    ).toBe('2026-09-22T14:30:00.000Z');
    // 08:00 to 18:00 SP is 11:00 to 21:00 UTC; at 22:00 UTC the next slot is tomorrow 11:00.
    expect(
      nextCronRun('0 8-18 * * *', new Date('2026-09-22T22:00:00.000Z'), SP)?.toISOString(),
    ).toBe('2026-09-23T11:00:00.000Z');
    expect(
      nextCronRun('0 6,12 * * *', new Date('2026-09-22T10:00:00.000Z'), SP)?.toISOString(),
    ).toBe('2026-09-22T15:00:00.000Z');
  });

  it('is strictly after the instant given', () => {
    const at = new Date('2026-09-22T15:00:00.000Z');
    expect(nextCronRun('0 * * * *', at, SP)?.toISOString()).toBe('2026-09-22T16:00:00.000Z');
    expect(previousCronRun('0 * * * *', at, SP)?.toISOString()).toBe('2026-09-22T15:00:00.000Z');
  });

  it('refuses what it cannot read', () => {
    expect(parseCron('0 * * *')).toBeNull();
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('0 25 * * *')).toBeNull();
    expect(nextCronRun('a b c d e', new Date(), SP)).toBeNull();
  });
});
