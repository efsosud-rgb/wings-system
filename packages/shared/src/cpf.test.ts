import { describe, expect, it } from 'vitest';
import { formatCpf, isValidCpf, maskCpf, normalizeCpf } from './cpf.js';

describe('cpf', () => {
  it('accepts valid numbers with and without formatting', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('rejects wrong check digits, repeated digits and wrong lengths', () => {
    expect(isValidCpf('529.982.247-26')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('')).toBe(false);
  });

  it('normalizes and formats', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
  });

  it('masks the first three and last two digits', () => {
    expect(maskCpf('52998224725')).toBe('***.982.247-**');
    expect(maskCpf('bad')).toBe('***.***.***-**');
  });
});
