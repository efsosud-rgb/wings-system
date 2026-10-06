/**
 * What a 3D chart draws, as plain data: no `three` here, so a page can
 * describe its charts without pulling the 3D engine into its own bundle.
 *
 * The look follows the reference module from Eric's canvas
 * (`docs/referencias/wings-charts3d.js`): honest shapes (bars from one base,
 * a donut only for 3–6 slices with none above 80%), one colour per series in
 * a fixed order, and "Sem dono", "Sem marca" and "Outras" in neutral so the
 * real data stands out. Words and numbers are HTML over the canvas.
 */

/** The validated categorical palette, in this order and never recycled. */
export const SERIES = [
  '#E95228',
  '#2A78D6',
  '#1BAF7A',
  '#4A3AA7',
  '#EDA100',
  '#E87BA4',
  '#008300',
] as const;
export const NEUTRAL = '#CBC4BA';

/** How a chart's numbers read: a count or reais (cents in, whole reais on the chart). */
export type ValueFormat = 'int' | 'brl';

/** Grouped columns: categories on the axis, one column per series (sellers). */
export interface ColumnsSpec {
  kind: 'columns';
  categories: string[];
  series: { name: string; values: number[]; neutral?: boolean; slot?: number }[];
  /** Categories drawn in neutral whatever the series ("Sem dono"). */
  neutralCategories?: string[];
  format: ValueFormat;
  /** A horizontal reference (the period's average), drawn as a hairline with its name. */
  reference?: { value: number; label: string } | null;
}

/** Bars from one base, ranked by value; more than `limit` folds into a neutral "Outras". */
export interface RankedSpec {
  kind: 'ranked';
  items: { label: string; value: number; neutral?: boolean }[];
  format: ValueFormat;
  /** What the share is of, in the tooltip ("do total", "das abertas"). */
  totalLabel?: string;
  /** Keep the given order (the funnel's stages) instead of ranking. */
  sort?: boolean;
  limit?: number;
  /** What a bar's share is of; the sum of the bars when absent. */
  shareBase?: number;
  /** The palette slot of every bar (an entity's colour); the first by default. */
  slot?: number;
  /** Lengths on a log scale, for steps thousands of times apart; the chart must say so. */
  log?: boolean;
}

/** A funnel by stage: the same bars, in the stages' order, never regrouped. */
export interface FunnelSpec {
  kind: 'funnel';
  stages: { label: string; value: number }[];
  format: ValueFormat;
  totalLabel?: string;
  /** What a bar's share is of (a cohort funnel: the first stage); the sum of the bars when absent. */
  shareBase?: number;
  slot?: number;
  log?: boolean;
}

/** A donut: only for 3 to 6 slices with none above 80% (see `shareSpec`). */
export interface DonutSpec {
  kind: 'donut';
  segments: { label: string; value: number; neutral?: boolean }[];
  format: ValueFormat;
  centerLabel?: string;
}

/**
 * Lines over an ordered axis (days, weeks): a trend. A missing value is
 * `null` and breaks the line there, never drawn as a zero. `area` fills
 * under that series; `dashed` marks a comparison (the previous period).
 */
export interface LineSpec {
  kind: 'line';
  categories: string[];
  series: {
    name: string;
    values: (number | null)[];
    /** The palette slot, so an entity keeps its colour on every tab (Meta, Google). */
    slot?: number;
    neutral?: boolean;
    dashed?: boolean;
    area?: boolean;
  }[];
  format: ValueFormat;
  /** A horizontal reference (the goal), dashed, with its name at the end. */
  reference?: { value: number; label: string } | null;
}

/**
 * Rows × columns (weekday × hour) in the orange ramp: five steps of the
 * largest value, a cell without anything in neutral grey.
 */
export interface HeatSpec {
  kind: 'heat';
  rows: string[];
  columns: string[];
  /** `values[row][column]`; zero means nothing there. */
  values: number[][];
  format: ValueFormat;
  /** How a column's name reads under the grid ("06h"); every third is shown. */
  columnEvery?: number;
}

export type ChartSpec = ColumnsSpec | RankedSpec | FunnelSpec | DonutSpec | LineSpec | HeatSpec;

/** The palette slot of "the period before" wherever a trend is compared (dashed). */
export const COMPARISON_SLOT = 3;

/** The brand's orange in five steps, lightest to darkest: the heat map's only ramp. */
export const HEAT_RAMP = ['#FBDCCF', '#F6B095', '#F0835C', '#E95228', '#A93A17'] as const;
/** A heat cell with nothing in it. */
export const HEAT_EMPTY = '#EEE9E2';

/** The step (1–5) of a value against the largest; 0 for nothing. */
export const heatStep = (value: number, max: number) =>
  value > 0 && max > 0 ? Math.min(5, Math.max(1, Math.ceil((value / max) * 5))) : 0;

const intFmt = new Intl.NumberFormat('pt-BR');
const brlFmt = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});
/** A value as the chart writes it: counts whole, cents as whole reais. */
export const formatValue = (format: ValueFormat, value: number) =>
  format === 'brl' ? brlFmt.format(Math.round(value / 100)) : intFmt.format(Math.round(value));

/** The heat map's key: each step's range of values, then "sem dado". */
export function heatLegend(spec: HeatSpec) {
  const max = Math.max(0, ...spec.values.flat());
  if (!(max > 0)) return [{ label: 'sem dado', color: HEAT_EMPTY }];
  const bands = HEAT_RAMP.map((color, i) => {
    const lo = (max * i) / 5;
    const hi = (max * (i + 1)) / 5;
    return {
      label: `${i === 0 ? 'até' : `${formatValue(spec.format, lo)} a`} ${formatValue(spec.format, hi)}`,
      color,
    };
  });
  return [...bands, { label: 'sem dado', color: HEAT_EMPTY }];
}

/** A series' colour: its slot in the palette (or its order), neutral when it says so. */
export const seriesColor = (series: { slot?: number; neutral?: boolean }, index: number) =>
  series.neutral ? NEUTRAL : SERIES[(series.slot ?? index) % SERIES.length]!;

/** At most this many bars; the rest become "Outras". */
export const RANKED_LIMIT = 6;

/**
 * Parts of a whole: a donut when it reads as one (3 to 6 slices, none above
 * 80%), ranked bars otherwise.
 */
export function shareSpec(
  items: { label: string; value: number; neutral?: boolean }[],
  format: ValueFormat,
  labels: { totalLabel?: string; centerLabel?: string } = {},
): DonutSpec | RankedSpec {
  const positive = items.filter((item) => item.value > 0);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  const top = Math.max(0, ...positive.map((item) => item.value));
  if (positive.length >= 3 && positive.length <= 6 && total > 0 && top / total <= 0.8) {
    return { kind: 'donut', segments: positive, format, centerLabel: labels.centerLabel };
  }
  return { kind: 'ranked', items, format, totalLabel: labels.totalLabel };
}

/** First name only, so sellers' names never crowd the axis. */
export const firstName = (name: string | null | undefined, fallback: string) =>
  name?.trim().split(/\s+/)[0] || fallback;
