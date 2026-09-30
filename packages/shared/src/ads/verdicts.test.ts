import { describe, expect, it } from 'vitest';
import { objectiveKindOf, verdictOf, type VerdictInput } from './verdicts.js';

/**
 * The verdict is read before somebody moves money, so each rule is checked
 * on its own: a leads campaign without a confirmed target is "Sem meta"
 * whatever the numbers, too little delivery is "Poucos dados", and the
 * primary figure decides before the secondary ones pile up.
 */

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    objectiveKind: 'leads',
    spendCents: 50_000,
    impressions: 20_000,
    conversions: 10,
    cplCents: 5000,
    ctrMilli: 1500,
    frequencyMilli: 1500,
    targetCplCents: 6000,
    accountMedianCtrMilli: 1200,
    trend: {
      currentCplCents: 4800,
      previousCplCents: 6000,
      currentCtrMilli: 1500,
      previousCtrMilli: 1450,
    },
    pacing: { last7SpendCents: 21_000, dailyBudgetCents: 3000 },
    ...overrides,
  };
}

describe('objectiveKindOf', () => {
  it('reads Meta objectives and treats a Google campaign without one as leads', () => {
    expect(objectiveKindOf('OUTCOME_LEADS', 'meta')).toBe('leads');
    expect(objectiveKindOf('OUTCOME_TRAFFIC', 'meta')).toBe('traffic');
    expect(objectiveKindOf('OUTCOME_AWARENESS', 'meta')).toBe('awareness');
    expect(objectiveKindOf(null, 'meta')).toBe('unknown');
    expect(objectiveKindOf(null, 'google')).toBe('leads');
  });
});

describe('verdictOf', () => {
  it('is positive when every signal is good, with the numbers in each reason', () => {
    const result = verdictOf(input());
    expect(result.verdict).toBe('positive');
    expect(result.primary).toBe('cpl');
    expect(result.reasons.map((reason) => reason.state)).toEqual([
      'good',
      'good',
      'good',
      'good',
      'good',
    ]);
    expect(result.reasons[0]?.text).toMatch(/R\$\s50,00 contra a meta de R\$\s60,00 \(-17%\)/);
  });

  it('says "sem meta" for a leads campaign with no confirmed target, whatever the numbers', () => {
    const result = verdictOf(input({ targetCplCents: null }));
    expect(result.verdict).toBe('no_target');
    expect(result.reasons[0]?.state).toBe('unknown');
    expect(result.reasons[0]?.text).toContain('Configurações do Dashboard');
  });

  it('does not judge a campaign that barely delivered', () => {
    expect(verdictOf(input({ spendCents: 500 })).verdict).toBe('insufficient');
    expect(verdictOf(input({ impressions: 100 })).verdict).toBe('insufficient');
  });

  it('is negative as soon as the primary figure is bad', () => {
    const result = verdictOf(input({ cplCents: 8000 }));
    expect(result.verdict).toBe('negative');
    expect(result.reasons[0]?.text).toContain('+33%');
  });

  it('is negative with no lead once the spend passes twice the target', () => {
    const result = verdictOf(input({ conversions: 0, cplCents: null, spendCents: 13_000 }));
    expect(result.verdict).toBe('negative');
    expect(result.reasons[0]?.text).toContain('Nenhum lead');
  });

  it('is attention on a primary within tolerance or on one bad secondary signal', () => {
    expect(verdictOf(input({ cplCents: 6500 })).verdict).toBe('attention');
    expect(verdictOf(input({ frequencyMilli: 3200 })).verdict).toBe('attention');
    expect(
      verdictOf(input({ pacing: { last7SpendCents: 2000, dailyBudgetCents: 3000 } })).verdict,
    ).toBe('attention');
  });

  it('turns negative when two secondary signals are bad', () => {
    const result = verdictOf(
      input({
        frequencyMilli: 3200,
        trend: {
          currentCplCents: 7000,
          previousCplCents: 5000,
          currentCtrMilli: 1500,
          previousCtrMilli: 1450,
        },
      }),
    );
    expect(result.verdict).toBe('negative');
  });

  it('judges a traffic campaign by CTR and never by CPL', () => {
    const result = verdictOf(
      input({
        objectiveKind: 'traffic',
        targetCplCents: null,
        conversions: 0,
        cplCents: null,
        ctrMilli: 900,
      }),
    );
    expect(result.primary).toBe('ctr');
    expect(result.verdict).toBe('negative');
    expect(result.reasons[0]?.state).toBe('unknown');
    expect(result.reasons[1]?.state).toBe('bad');
  });

  it('marks pacing unknown when the budget lives in the ad sets', () => {
    const result = verdictOf(
      input({ pacing: { last7SpendCents: 21_000, dailyBudgetCents: null } }),
    );
    expect(result.reasons[4]?.state).toBe('unknown');
    expect(result.verdict).toBe('positive');
  });
});
