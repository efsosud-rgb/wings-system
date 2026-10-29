import { describe, expect, it } from 'vitest';
import { dayLabel, listTimeOf } from './whatsapp-time.js';

/** Dates as WhatsApp Desktop writes them, against a fixed "now" in the browser's own days. */

const now = new Date(2026, 9, 21, 15, 0); // Wednesday, 21/10/2026, 15:00
const at = (day: number, hour = 10, minute = 5) =>
  new Date(2026, 9, day, hour, minute).toISOString();

describe('dayLabel', () => {
  it('says today, yesterday, the weekday within the week, then the date', () => {
    expect(dayLabel(at(21, 0, 1), now)).toBe('Hoje');
    expect(dayLabel(at(20, 23, 59), now)).toBe('Ontem');
    expect(dayLabel(at(19), now)).toBe('Segunda-feira');
    expect(dayLabel(at(15), now)).toBe('Quinta-feira');
    expect(dayLabel(at(14), now)).toBe('14/10/2026');
  });

  it('takes a clock a little ahead of ours for today', () => {
    expect(dayLabel(at(21, 15, 2), now)).toBe('Hoje');
  });
});

describe('listTimeOf', () => {
  it('shows the clock for today and the day otherwise', () => {
    expect(listTimeOf(at(21, 9, 7), now)).toBe('09:07');
    expect(listTimeOf(at(20), now)).toBe('Ontem');
    expect(listTimeOf(at(1), now)).toBe('01/10/2026');
  });
});
