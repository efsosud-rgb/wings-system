import { describe, expect, it } from 'vitest';
import {
  computeRoadmap,
  forecastOf,
  modulePercentOf,
  scopeChangePercentOf,
  velocityOf,
  weightedTotalPercentOf,
  type CompletionEvent,
} from './scoring.js';

describe('modulePercentOf', () => {
  it('is null with no deliverables (no rate, not a zero rate)', () => {
    expect(modulePercentOf([])).toEqual({ weightTotal: 0, percent: null });
  });

  it('counts pronto fully, em_andamento at half, pendente at zero', () => {
    // P(1) pronto + M(2) em_andamento + G(3) pendente = weight 6, earned 1 + 1 = 2
    const result = modulePercentOf([
      { weight: 'P', status: 'pronto' },
      { weight: 'M', status: 'em_andamento' },
      { weight: 'G', status: 'pendente' },
    ]);
    expect(result.weightTotal).toBe(6);
    expect(result.percent).toBeCloseTo((100 * 2) / 6, 1);
  });

  it('is 100 when every deliverable is pronto', () => {
    const result = modulePercentOf([
      { weight: 'G', status: 'pronto' },
      { weight: 'P', status: 'pronto' },
    ]);
    expect(result.percent).toBe(100);
  });
});

describe('weightedTotalPercentOf', () => {
  it('is null with no weight anywhere', () => {
    expect(weightedTotalPercentOf([])).toBeNull();
    expect(weightedTotalPercentOf([{ weightTotal: 0, percent: null }])).toBeNull();
  });

  it('weighs each module by its own total weight', () => {
    // module A: weight 4, 100%; module B: weight 2 (Sunday's is 6? no just 2), 0%
    const total = weightedTotalPercentOf([
      { weightTotal: 4, percent: 100 },
      { weightTotal: 2, percent: 0 },
    ]);
    // (4*100 + 2*0) / 6 = 66.67
    expect(total).toBeCloseTo(66.7, 1);
  });

  it('treats a module with no percent yet as contributing zero', () => {
    const total = weightedTotalPercentOf([
      { weightTotal: 4, percent: 50 },
      { weightTotal: 0, percent: null },
    ]);
    expect(total).toBe(50);
  });
});

describe('velocityOf', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('is null/null with no completion history at all', () => {
    expect(velocityOf([], now)).toEqual({ last4WeeksPerWeek: null, sinceStartPerWeek: null });
  });

  it('reports a real zero for the last 4 weeks when nothing finished recently, never null', () => {
    const events: CompletionEvent[] = [
      { completedAt: new Date('2026-01-01T00:00:00Z'), weightPoints: 10 },
    ];
    const velocity = velocityOf(events, now);
    expect(velocity.last4WeeksPerWeek).toBe(0);
    expect(velocity.sinceStartPerWeek).not.toBeNull();
  });

  it('averages weight completed in the last 4 weeks over 4 weeks', () => {
    const events: CompletionEvent[] = [
      { completedAt: new Date('2026-09-20T00:00:00Z'), weightPoints: 4 },
      { completedAt: new Date('2026-08-01T00:00:00Z'), weightPoints: 4 }, // outside the 4-week window
    ];
    const velocity = velocityOf(events, now);
    expect(velocity.last4WeeksPerWeek).toBe(1); // 4 / 4 weeks
  });

  it('never divides by zero when everything completed today (near-zero elapsed time)', () => {
    const events: CompletionEvent[] = [{ completedAt: now, weightPoints: 3 }];
    const velocity = velocityOf(events, now);
    expect(velocity.sinceStartPerWeek).toBeNull();
    expect(() => velocityOf(events, now)).not.toThrow();
  });
});

describe('forecastOf', () => {
  it('is null (indeterminado) with no velocity data', () => {
    expect(forecastOf(10, { last4WeeksPerWeek: null, sinceStartPerWeek: null })).toBeNull();
  });

  it('is every bound null when the observed pace is zero, never Infinity or a throw', () => {
    const forecast = forecastOf(10, { last4WeeksPerWeek: 0, sinceStartPerWeek: 0 });
    expect(forecast).toEqual({ optimisticWeeks: null, provavelWeeks: null, pessimisticWeeks: null });
    expect(() => forecastOf(10, { last4WeeksPerWeek: 0, sinceStartPerWeek: 0 })).not.toThrow();
  });

  it('is all zero when nothing remains', () => {
    expect(forecastOf(0, { last4WeeksPerWeek: 2, sinceStartPerWeek: 1 })).toEqual({
      optimisticWeeks: 0,
      provavelWeeks: 0,
      pessimisticWeeks: 0,
    });
  });

  it('optimistic uses the faster pace, pessimistic the slower, provável their average', () => {
    const forecast = forecastOf(10, { last4WeeksPerWeek: 5, sinceStartPerWeek: 1 });
    expect(forecast).toEqual({ optimisticWeeks: 2, provavelWeeks: 3.3, pessimisticWeeks: 10 });
  });

  it('leaves the pessimistic bound indeterminate when the slower pace is zero', () => {
    const forecast = forecastOf(10, { last4WeeksPerWeek: 0, sinceStartPerWeek: 2 });
    expect(forecast?.pessimisticWeeks).toBeNull();
    expect(forecast?.optimisticWeeks).toBe(5);
  });
});

describe('scopeChangePercentOf', () => {
  it('is null with no prior snapshot', () => {
    expect(scopeChangePercentOf(10, null)).toBeNull();
  });

  it('is null when last week had no weight (would divide by zero)', () => {
    expect(scopeChangePercentOf(10, 0)).toBeNull();
  });

  it('is the percentage change from last week to this week', () => {
    expect(scopeChangePercentOf(11, 10)).toBe(10);
    expect(scopeChangePercentOf(9, 10)).toBe(-10);
  });
});

describe('computeRoadmap', () => {
  it('assembles every number from plain data, reproducibly', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const computed = computeRoadmap({
      reportDate: '2026-09-24',
      modules: [
        {
          moduleId: 'm1',
          key: 'crm',
          label: 'CRM',
          deliverables: [
            { weight: 'G', status: 'pronto' },
            { weight: 'M', status: 'pendente' },
          ],
        },
      ],
      completionEvents: [{ completedAt: new Date('2026-09-01T00:00:00Z'), weightPoints: 3 }],
      lastWeekTotalWeight: 5,
      now,
    });
    expect(computed.reportDate).toBe('2026-09-24');
    expect(computed.modules).toHaveLength(1);
    expect(computed.modules[0]?.weightTotal).toBe(5);
    expect(computed.weightedTotalPercent).toBe(computed.modules[0]?.percent);
    expect(computed.scopeChangePercent).toBe(0);
    expect(computed.velocity.sinceStartPerWeek).not.toBeNull();
  });

  it('never throws on an entirely empty roadmap', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(() =>
      computeRoadmap({
        reportDate: '2026-09-24',
        modules: [],
        completionEvents: [],
        lastWeekTotalWeight: null,
        now,
      }),
    ).not.toThrow();
    const computed = computeRoadmap({
      reportDate: '2026-09-24',
      modules: [],
      completionEvents: [],
      lastWeekTotalWeight: null,
      now,
    });
    expect(computed.weightedTotalPercent).toBeNull();
    expect(computed.forecast).toBeNull();
  });
});
