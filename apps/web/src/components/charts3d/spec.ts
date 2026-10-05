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
  series: { name: string; values: number[]; neutral?: boolean }[];
  /** Categories drawn in neutral whatever the series ("Sem dono"). */
  neutralCategories?: string[];
  format: ValueFormat;
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
}

/** A funnel by stage: the same bars, in the stages' order, never regrouped. */
export interface FunnelSpec {
  kind: 'funnel';
  stages: { label: string; value: number }[];
  format: ValueFormat;
  totalLabel?: string;
  /** What a bar's share is of (a cohort funnel: the first stage); the sum of the bars when absent. */
  shareBase?: number;
}

/** A donut: only for 3 to 6 slices with none above 80% (see `shareSpec`). */
export interface DonutSpec {
  kind: 'donut';
  segments: { label: string; value: number; neutral?: boolean }[];
  format: ValueFormat;
  centerLabel?: string;
}

export type ChartSpec = ColumnsSpec | RankedSpec | FunnelSpec | DonutSpec;

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
