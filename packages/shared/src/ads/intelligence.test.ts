import { describe, expect, it } from 'vitest';
import {
  adCopyPackageSchema,
  auditPriority,
  auditRunRequestSchema,
  inventedNumbers,
  variationProblems,
} from './intelligence.js';

describe('auditPriority', () => {
  it('ranks a cheap, sure, costly problem first and never scores a pass', () => {
    const top = auditPriority({
      status: 'fail',
      impact: 'high',
      confidence: 'high',
      effort: 'low',
    });
    const hard = auditPriority({
      status: 'fail',
      impact: 'high',
      confidence: 'high',
      effort: 'high',
    });
    const warn = auditPriority({
      status: 'warn',
      impact: 'high',
      confidence: 'high',
      effort: 'low',
    });
    expect(top).toBe(18);
    expect(top).toBeGreaterThan(warn);
    expect(warn).toBeGreaterThan(hard);
    expect(
      auditPriority({ status: 'pass', impact: 'high', confidence: 'high', effort: 'low' }),
    ).toBe(0);
  });
});

describe('auditRunRequestSchema', () => {
  it('takes only the dashboard windows', () => {
    expect(auditRunRequestSchema.parse({})).toEqual({ scope: 'all', days: 14 });
    expect(auditRunRequestSchema.safeParse({ days: 5 }).success).toBe(false);
  });
});

describe('numbers the person never typed', () => {
  it('finds prices, percentages and counts that are not in the briefing', () => {
    expect(inventedNumbers('Mais de 300 marcas, 98% de satisfação', 'Mais de 300 marcas')).toEqual([
      '98',
    ]);
    expect(inventedNumbers('A partir de R$ 1.500,00', 'Taxa a partir de R$ 1500,00')).toEqual([]);
    expect(inventedNumbers('Fale com a Wings.', '')).toEqual([]);
  });
});

describe('variationProblems', () => {
  const base = {
    headline: 'Sua marca em outras cidades',
    primaryText: 'Formatação de franquias com método.',
    callToAction: 'LEARN_MORE' as const,
    angle: 'benefício',
  };

  it('asks Meta for a text and a call to action, and Google for a short title and a description', () => {
    expect(variationProblems(base, 'meta', '')).toEqual([]);
    expect(variationProblems({ ...base, callToAction: undefined }, 'meta', '')).toHaveLength(1);
    const google = variationProblems(
      { ...base, headline: 'Sua marca em outras cidades do país' },
      'google_search',
      '',
    );
    expect(google).toContain('Falta a descrição.');
    expect(google.some((problem) => problem.includes('30 caracteres'))).toBe(true);
  });

  it('refuses a number that did not come from the briefing', () => {
    const problems = variationProblems(
      { ...base, primaryText: 'Fature R$ 50 mil por mês.' },
      'meta',
      'Formatação de franquias',
    );
    expect(problems.join(' ')).toContain('50');
  });

  it('the package refuses a promise of gain in any text', () => {
    const parsed = adCopyPackageSchema.safeParse({
      variations: [{ ...base, headline: 'Lucro garantido' }],
      creativeBrief: 'Pessoa em frente à loja.',
    });
    expect(parsed.success).toBe(false);
  });
});
