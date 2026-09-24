import {
  ROADMAP_STATUS_COMPLETION,
  ROADMAP_WEIGHT_POINTS,
  type RoadmapComputed,
  type RoadmapDeliverableStatus,
  type RoadmapForecast,
  type RoadmapVelocity,
  type RoadmapWeight,
} from '@wings/shared';

/**
 * Pure math over the roadmap's numbers. No DB, no clock of its own (`now` is
 * always passed in) — everything here is reproducible from plain data, which
 * is what makes it unit-testable in isolation and what makes the LLM
 * phrasing step safe: it only ever turns these already-computed numbers into
 * sentences, never invents one.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface ScoringDeliverable {
  weight: RoadmapWeight;
  status: RoadmapDeliverableStatus;
}

export interface ScoringModule {
  moduleId: string;
  key: string;
  label: string;
  deliverables: ScoringDeliverable[];
}

/**
 * A module's %: `pronto` weight counts fully, `em_andamento` counts 50%,
 * `pendente` counts 0%, divided by the module's total weight. `percent` is
 * null (not 0) when the module has no deliverables yet — an empty module
 * has no rate, not a zero rate.
 */
export function modulePercentOf(deliverables: readonly ScoringDeliverable[]): {
  weightTotal: number;
  percent: number | null;
} {
  const weightTotal = deliverables.reduce((sum, d) => sum + ROADMAP_WEIGHT_POINTS[d.weight], 0);
  if (weightTotal === 0) return { weightTotal: 0, percent: null };
  const earned = deliverables.reduce(
    (sum, d) => sum + ROADMAP_WEIGHT_POINTS[d.weight] * ROADMAP_STATUS_COMPLETION[d.status],
    0,
  );
  return { weightTotal, percent: round1((100 * earned) / weightTotal) };
}

/** Weighted average of every module's % by its own weight total. Null with no weight anywhere. */
export function weightedTotalPercentOf(
  modules: readonly { weightTotal: number; percent: number | null }[],
): number | null {
  const totalWeight = modules.reduce((sum, module) => sum + module.weightTotal, 0);
  if (totalWeight === 0) return null;
  const earned = modules.reduce(
    (sum, module) => sum + module.weightTotal * (module.percent ?? 0),
    0,
  );
  return round1(earned / totalWeight);
}

export interface CompletionEvent {
  /** When the deliverable was marked `pronto` (its `completed_at`). */
  completedAt: Date;
  weightPoints: number;
}

/**
 * Weight completed per week, over the last 4 weeks and since the first
 * recorded completion. `last4WeeksPerWeek` is a real 0 (not null) when there
 * is history but nothing finished recently — that is a fact worth reporting
 * ("nada concluído nas últimas 4 semanas"), not a missing value.
 * `sinceStartPerWeek` is null only when less than a day has elapsed since the
 * first completion, where a rate would be a divide-by-near-zero artefact.
 */
export function velocityOf(events: readonly CompletionEvent[], now: Date): RoadmapVelocity {
  if (events.length === 0) return { last4WeeksPerWeek: null, sinceStartPerWeek: null };

  const fourWeeksAgoMs = now.getTime() - 4 * WEEK_MS;
  const recentWeight = events
    .filter((event) => {
      const t = event.completedAt.getTime();
      return t >= fourWeeksAgoMs && t <= now.getTime();
    })
    .reduce((sum, event) => sum + event.weightPoints, 0);
  const last4WeeksPerWeek = round2(recentWeight / 4);

  const earliestMs = Math.min(...events.map((event) => event.completedAt.getTime()));
  const elapsedWeeks = (now.getTime() - earliestMs) / WEEK_MS;
  const totalWeight = events.reduce((sum, event) => sum + event.weightPoints, 0);
  // Less than a day elapsed: too little time to estimate a weekly rate.
  const sinceStartPerWeek = elapsedWeeks >= 1 / 7 ? round2(totalWeight / elapsedWeeks) : null;

  return { last4WeeksPerWeek, sinceStartPerWeek };
}

/**
 * Forecast = remaining weight ÷ velocity, over the two windows `velocityOf`
 * produces. With only two observed weekly paces, "optimistic" takes the
 * faster of the two, "pessimistic" the slower, and "provável" their average —
 * a defensible reading of "optimistic/probable/pessimistic" that needs no
 * more history than the roadmap already keeps. A pace of 0 forecasts
 * "indeterminado" (null) for that bound instead of an infinite wait.
 */
export function forecastOf(
  remainingWeight: number,
  velocity: RoadmapVelocity,
): RoadmapForecast | null {
  const paces = [velocity.last4WeeksPerWeek, velocity.sinceStartPerWeek].filter(
    (value): value is number => value !== null,
  );
  if (paces.length === 0) return null;

  if (remainingWeight <= 0) return { optimisticWeeks: 0, provavelWeeks: 0, pessimisticWeeks: 0 };

  const fastest = Math.max(...paces);
  const slowest = Math.min(...paces);
  const average = paces.reduce((sum, pace) => sum + pace, 0) / paces.length;
  // Every pace is zero (or negative, which never happens): no forecast is
  // knowable, so every bound is "indeterminado" rather than a divide-by-zero.
  if (fastest <= 0) return { optimisticWeeks: null, provavelWeeks: null, pessimisticWeeks: null };

  const weeksAt = (pace: number) => (pace > 0 ? round1(remainingWeight / pace) : null);
  return {
    optimisticWeeks: weeksAt(fastest),
    provavelWeeks: weeksAt(average),
    pessimisticWeeks: weeksAt(slowest),
  };
}

/** "Escopo aumentou X% na semana": this week's total weight vs. last week's snapshot. */
export function scopeChangePercentOf(
  currentTotalWeight: number,
  lastWeekTotalWeight: number | null,
): number | null {
  if (lastWeekTotalWeight === null || lastWeekTotalWeight === 0) return null;
  return round1(((currentTotalWeight - lastWeekTotalWeight) / lastWeekTotalWeight) * 100);
}

export interface ComputeRoadmapInput {
  reportDate: string;
  modules: readonly ScoringModule[];
  completionEvents: readonly CompletionEvent[];
  lastWeekTotalWeight: number | null;
  now: Date;
}

/** Assembles every number the report needs from already-fetched, plain data. */
export function computeRoadmap(input: ComputeRoadmapInput): RoadmapComputed {
  const modules = input.modules.map((module) => {
    const { weightTotal, percent } = modulePercentOf(module.deliverables);
    return { moduleId: module.moduleId, key: module.key, label: module.label, weightTotal, percent };
  });
  const weightedTotalPercent = weightedTotalPercentOf(modules);
  const velocity = velocityOf(input.completionEvents, input.now);

  const totalWeight = modules.reduce((sum, module) => sum + module.weightTotal, 0);
  const earnedWeight = modules.reduce(
    (sum, module) => sum + module.weightTotal * ((module.percent ?? 0) / 100),
    0,
  );
  const forecast = forecastOf(totalWeight - earnedWeight, velocity);
  const scopeChangePercent = scopeChangePercentOf(totalWeight, input.lastWeekTotalWeight);

  return {
    reportDate: input.reportDate,
    modules,
    weightedTotalPercent,
    velocity,
    forecast,
    scopeChangePercent,
  };
}
