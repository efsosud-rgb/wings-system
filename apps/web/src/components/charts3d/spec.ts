/**
 * What a 3D chart draws, as plain data: no `three` here, so a page can
 * describe its charts without pulling the 3D engine into its own bundle.
 *
 * Every number arrives already formatted (`text`), because the words and
 * numbers on a chart are HTML laid over the canvas, never pixels in it.
 */

/** The four inks of a chart: the brand orange for the main series, then graphite, warm grey and slate. */
export type Tone = 'brand' | 'graphite' | 'warm' | 'slate';

export const TONE_HEX: Record<Tone | 'track' | 'brandSoft', string> = {
  brand: '#E95228',
  /** The funnel's alternate step, a lighter warmth of the brand orange. */
  brandSoft: '#F07A52',
  graphite: '#3A3733',
  warm: '#A8A29A',
  slate: '#5B6B7F',
  track: '#E7E3DD',
};

/** Below this width a chart's names leave the scene for a list under it. */
export const COMPACT_WIDTH = 520;

/** Series after the first take these, in order; colour is never the only cue, a label always goes with it. */
export const SERIES_TONES: Tone[] = ['brand', 'graphite', 'warm', 'slate'];

export interface Category {
  key: string;
  label: string;
  /** Whether the label shows on the axis; the rest still show on hover and in the table. */
  axis?: boolean;
}

export interface BarSeries {
  key: string;
  label: string;
  tone: Tone;
  values: number[];
  texts: string[];
  /** Shorter text printed on the bar when `showValues`; the full `texts` go to the tooltip and table. */
  short?: string[];
}

/** Columns standing on the floor (`vertical`) or bars running right, one row each (`horizontal`). */
export interface BarsSpec {
  kind: 'bars';
  orientation: 'vertical' | 'horizontal';
  categories: Category[];
  series: BarSeries[];
  /** Print each bar's value beside it (few bars); otherwise it shows on hover. */
  showValues?: boolean;
}

export interface FunnelSpec {
  kind: 'funnel';
  steps: { key: string; label: string; value: number; text: string }[];
  /**
   * `log` when steps differ by orders of magnitude (impressions → leads), so
   * the last steps stay visible; the printed numbers are always the real ones.
   */
  scale?: 'linear' | 'log';
}

export interface DonutSpec {
  kind: 'donut';
  slices: { key: string; label: string; value: number; text: string; tone: Tone | 'track' }[];
  /** A ring meter: thinner, with the first slice as the progress. */
  gauge?: boolean;
}

export interface RibbonsSpec {
  kind: 'ribbons';
  days: Category[];
  series: { key: string; label: string; tone: Tone; values: (number | null)[]; texts: string[] }[];
}

export interface HeatSpec {
  kind: 'heat';
  rows: Category[];
  cols: Category[];
  /** Cells with nothing are omitted; their floor tile still shows. */
  cells: { row: number; col: number; value: number; text: string }[];
  tone: Tone;
}

export type ChartSpec = BarsSpec | FunnelSpec | DonutSpec | RibbonsSpec | HeatSpec;

/** An HTML label pinned to a point of the scene. */
export interface ChartLabel {
  key: string;
  text: string;
  /** `name` beside a piece, `value` on it, `axis` under it. */
  kind: 'name' | 'value' | 'axis';
  /** Which side of the point the text sits on. */
  align: 'center' | 'left' | 'right' | 'above';
}

/** Ease-out, for anything entering. */
export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The entrance of a series of pieces: 40 ms apart, the whole stagger capped so a long series stays short. */
export function staggerOf(count: number, stepMs = 40, capMs = 800): number {
  return count <= 1 ? 0 : Math.min(stepMs, capMs / (count - 1));
}

/** The opacity steps of the flat heat grid (five, from 0.18 to 1), reused as the blocks' colour mix. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 0.18 + Math.ceil((value / max) * 5) * 0.164;
}
