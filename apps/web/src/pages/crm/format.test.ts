import { describe, expect, it } from 'vitest';
import { parseMoney } from './format.js';

describe('parseMoney', () => {
  it('reads Brazilian and plain decimals', () => {
    expect(parseMoney('R$ 1.234,56')).toBe(123456);
    expect(parseMoney('1234,5')).toBe(123450);
    expect(parseMoney('1234.56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('1234')).toBe(123400);
  });

  it('takes a dot grouping thousands as thousands: 25.000 is R$ 25.000,00, not R$ 25,00', () => {
    expect(parseMoney('25.000')).toBe(2_500_000);
    expect(parseMoney('1.500')).toBe(150_000);
    expect(parseMoney('R$ 1.500.000')).toBe(150_000_000);
    expect(parseMoney('25.000,50')).toBe(2_500_050);
    expect(parseMoney('1.5')).toBe(150);
  });

  it('empty is null, nonsense and negatives are undefined', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('R$ ')).toBeNull();
    expect(parseMoney('abc')).toBeUndefined();
    expect(parseMoney('-10')).toBeUndefined();
  });
});
