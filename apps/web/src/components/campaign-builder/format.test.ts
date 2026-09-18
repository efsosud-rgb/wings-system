import { describe, expect, it } from 'vitest';
import { parseBrlToCents } from './format.js';

describe('parseBrlToCents', () => {
  it('reads money the way a person types it', () => {
    expect(parseBrlToCents('20')).toBe(2_000);
    expect(parseBrlToCents('20,5')).toBe(2_050);
    expect(parseBrlToCents('R$ 20,00')).toBe(2_000);
    expect(parseBrlToCents('1.250,00')).toBe(125_000);
    expect(parseBrlToCents('1.250')).toBe(125_000);
  });

  it('takes a dot as the decimal mark a phone keypad offers — never as ×100', () => {
    // This used to read as R$ 2.000,00: a hundredfold daily budget.
    expect(parseBrlToCents('20.00')).toBe(2_000);
    expect(parseBrlToCents('20.5')).toBe(2_050);
  });

  it('answers NaN for anything that is not plainly money', () => {
    for (const text of ['', 'vinte', '20 reais', '20,000', '1.25.0', '-20', '20,0,0']) {
      expect(parseBrlToCents(text)).toBeNaN();
    }
  });
});
