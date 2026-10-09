import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_METHOD_LABEL,
  hasTestWord,
  isOutOfAccountReason,
  isTestDeal,
  UNATTRIBUTED_REASONS,
} from './campaign-leads.js';

describe('hasTestWord', () => {
  it('finds the word teste/testes alone or stuck to digits and punctuation', () => {
    for (const text of [
      'teste',
      'Teste',
      'Teste 2',
      'teste1',
      'TESTES',
      'joao.teste@example.com',
      'teste_x',
      'teste@example.com',
      'Negócio de teste',
      'Pré-Teste',
    ]) {
      expect(hasTestWord(text), text).toBe(true);
    }
  });

  it('ignores accents and case', () => {
    expect(hasTestWord('TÉSTE')).toBe(true);
    expect(hasTestWord('Tèste')).toBe(true);
    expect(hasTestWord('Tésté')).toBe(true);
  });

  it('does not take words that only start that way', () => {
    for (const text of ['testemunho', 'Testeira', 'contestes', 'Maria Silva', 'atestado']) {
      expect(hasTestWord(text), text).toBe(false);
    }
  });

  it('is false for empty values', () => {
    expect(hasTestWord(null)).toBe(false);
    expect(hasTestWord(undefined)).toBe(false);
    expect(hasTestWord('')).toBe(false);
  });
});

describe('isTestDeal (unchanged, feeds the dashboard)', () => {
  it('reads the deal name and the lost reason only', () => {
    expect(isTestDeal('Teste X', null)).toBe(true);
    expect(isTestDeal('Negócio', 'teste')).toBe(true);
    expect(isTestDeal('Negócio', null)).toBe(false);
    expect(isTestDeal('Teste2', null)).toBe(false);
  });
});

describe('the deals kept out of the account', () => {
  it('takes only the ones who arrived before 28/09 out of every figure', () => {
    expect(isOutOfAccountReason('arrived_before_cutoff')).toBe(true);
    for (const reason of Object.keys(UNATTRIBUTED_REASONS).filter(
      (key) => key !== 'arrived_before_cutoff',
    )) {
      expect(isOutOfAccountReason(reason), reason).toBe(false);
    }
    expect(isOutOfAccountReason(null)).toBe(false);
    expect(isOutOfAccountReason(undefined)).toBe(false);
  });

  it('words every reason and every attribution method for the screen', () => {
    expect(UNATTRIBUTED_REASONS.arrived_before_cutoff).toMatch(/Chegou antes de 28\/09/);
    expect(UNATTRIBUTED_REASONS.utm_other_campaign).toMatch(/data de entrada/);
    expect(Object.keys(ATTRIBUTION_METHOD_LABEL).sort()).toEqual(['lead_ads', 'rd_origin', 'utm']);
  });
});
