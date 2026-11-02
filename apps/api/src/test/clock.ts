import { vi } from 'vitest';

/**
 * Stops the clock at the end of the minute of `from` (hh:mm:59.900) and returns that instant.
 * A test that checks a time the code rounds to the minute or the day computes the expected
 * value from this instant, never from a second `new Date()` or from a row's `created_at` (the
 * database clock, at the start of the transaction): those are other moments, and a minute
 * turning between them fails the test (CI of PR #67, 30/10/2026). The end of the minute is the
 * worst case, so every run is the one that used to fail. Only `Date` is faked: the database
 * driver's and Fastify's timers keep running. Undo with `vi.useRealTimers()`.
 */
export function freezeClockAtMinuteEnd(from = new Date()): Date {
  const at = new Date(from.getTime());
  at.setUTCSeconds(59, 900);
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  return at;
}
