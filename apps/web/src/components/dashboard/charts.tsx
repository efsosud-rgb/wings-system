import type { DailyAmount } from '@wings/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatDayShort } from './format.js';

/**
 * The dashboard's charts, drawn as SVG with no library behind them.
 *
 * Marks are thin, the grid is a hairline, and every chart is a supplement to
 * a table that carries the same numbers: nothing here is the only way to read
 * a value. Colour follows the entity (a platform, a source of spend) and is
 * passed in as a CSS variable name, so a strip keeps its hue on every tab.
 */

/**
 * The rendered width of a figure, in pixels, so the SVG is drawn at scale
 * rather than stretched: stretching would distort the tick text and the
 * rounded ends of every column.
 */
function useWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(160, element.clientWidth));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Ticks at clean numbers: 0, and a rounded maximum. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const leading = max / magnitude;
  const nice = leading <= 1 ? 1 : leading <= 2 ? 2 : leading <= 5 ? 5 : 10;
  return nice * magnitude;
}

interface ColumnsProps {
  points: DailyAmount[];
  /** CSS colour, usually `var(--viz-meta)`. */
  color: string;
  format: (amount: number) => string;
  /** Height of the plot in px; the axis band is added below it. */
  height?: number;
  /** A horizontal reference, such as the average, drawn as a hairline. */
  reference?: { amount: number; label: string } | null;
  /** How a point's key reads on the axis; days by default, hours elsewhere. */
  label?: (key: string) => string;
  ariaLabel: string;
}

/**
 * One column per day. Columns are capped at 24px, rounded at the data end and
 * square at the baseline, with a two-pixel gap of surface between them.
 */
export function DailyColumns({
  points,
  color,
  format,
  height = 96,
  reference = null,
  label = formatDayShort,
  ariaLabel,
}: ColumnsProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const [ref, width] = useWidth();
  const axis = 18;
  const padTop = 6;
  const max = niceMax(Math.max(...points.map((point) => point.amount), reference?.amount ?? 0));
  const slot = width / Math.max(points.length, 1);
  const bar = Math.min(24, Math.max(2, slot - 2));
  const y = (amount: number) => padTop + (height - padTop) * (1 - amount / max);
  const hovered = hover === null ? null : points[hover];
  const labelEvery = points.length > 16 ? 7 : points.length > 8 ? 2 : 1;

  return (
    <figure className="viz" aria-label={ariaLabel} ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height + axis}`}
        width={width}
        height={height + axis}
        className="viz-svg"
        role="img"
        aria-labelledby={`${id}-title`}
        onMouseLeave={() => setHover(null)}
      >
        <title id={`${id}-title`}>{ariaLabel}</title>
        <line x1={0} x2={width} y1={height} y2={height} className="viz-baseline" />
        {reference && reference.amount > 0 && (
          <line
            x1={0}
            x2={width}
            y1={y(reference.amount)}
            y2={y(reference.amount)}
            className="viz-reference"
          />
        )}
        {points.map((point, index) => {
          const x = index * slot + (slot - bar) / 2;
          const top = y(point.amount);
          const h = Math.max(0, height - top);
          return (
            <g key={point.day}>
              {/* The hit area is the whole slot, not the sliver of a small bar. */}
              <rect
                x={index * slot}
                y={0}
                width={slot}
                height={height + axis}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${label(point.day)}: ${format(point.amount)}`}
              />
              {h > 0 && (
                <path
                  d={`M${x},${height} v${-(h - Math.min(4, h))} q0,-${Math.min(4, h)} 4,-${Math.min(4, h)} h${bar - 8} q4,0 4,${Math.min(4, h)} v${h - Math.min(4, h)} z`}
                  fill={color}
                  opacity={hover === null || hover === index ? 1 : 0.45}
                />
              )}
              {index % labelEvery === 0 && (
                <text x={index * slot + slot / 2} y={height + 13} className="viz-tick">
                  {label(point.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && (
        <figcaption className="viz-tooltip" aria-live="polite">
          <span>{label(hovered.day)}</span>
          <strong>{format(hovered.amount)}</strong>
        </figcaption>
      )}
      {reference && reference.amount > 0 && !hovered && (
        <figcaption className="viz-tooltip viz-tooltip-quiet">
          <span>{reference.label}</span>
          <strong>{format(reference.amount)}</strong>
        </figcaption>
      )}
    </figure>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: DailyAmount[];
}

/**
 * Two or three lines on one day axis, each two pixels wide with a faint wash
 * beneath, a legend, and a crosshair that reads every series at once.
 */
export function DailyLines({
  series,
  format,
  height = 160,
  ariaLabel,
}: {
  series: LineSeries[];
  format: (amount: number) => string;
  height?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const [ref, width] = useWidth();
  const axis = 18;
  const padTop = 8;
  const days = series[0]?.points.map((point) => point.day) ?? [];
  const max = niceMax(
    Math.max(...series.flatMap((line) => line.points.map((point) => point.amount)), 0),
  );
  const step = days.length > 1 ? width / (days.length - 1) : width;
  const x = (index: number) => (days.length > 1 ? index * step : width / 2);
  const y = (amount: number) => padTop + (height - padTop) * (1 - amount / max);
  const labelEvery = days.length > 16 ? 7 : days.length > 8 ? 2 : 1;

  return (
    <figure className="viz" aria-label={ariaLabel} ref={ref}>
      <div className="viz-legend">
        {series.map((line) => (
          <span key={line.key}>
            <i style={{ background: line.color }} aria-hidden="true" />
            {line.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height + axis}`}
        width={width}
        height={height + axis}
        className="viz-svg"
        role="img"
        aria-labelledby={`${id}-title`}
        onMouseLeave={() => setHover(null)}
      >
        <title id={`${id}-title`}>{ariaLabel}</title>
        <line x1={0} x2={width} y1={height} y2={height} className="viz-baseline" />
        <line x1={0} x2={width} y1={y(max / 2)} y2={y(max / 2)} className="viz-grid" />
        {series.map((line) => {
          const path = line.points
            .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.amount)}`)
            .join(' ');
          return (
            <g key={line.key}>
              <path
                d={`${path} L${x(line.points.length - 1)},${height} L0,${height} z`}
                fill={line.color}
                opacity={0.1}
              />
              <path
                d={path}
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="viz-crosshair" />
        )}
        {hover !== null &&
          series.map((line) => {
            const point = line.points[hover];
            return point ? (
              <circle
                key={line.key}
                cx={x(hover)}
                cy={y(point.amount)}
                r={4}
                fill={line.color}
                className="viz-marker"
              />
            ) : null;
          })}
        {days.map((day, index) => (
          <g key={day}>
            <rect
              x={x(index) - step / 2}
              y={0}
              width={step}
              height={height + axis}
              fill="transparent"
              tabIndex={0}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              aria-label={`${formatDayShort(day)}: ${series
                .map((line) => `${line.label} ${format(line.points[index]?.amount ?? 0)}`)
                .join(', ')}`}
            />
            {index % labelEvery === 0 && (
              <text x={x(index)} y={height + 13} className="viz-tick">
                {formatDayShort(day)}
              </text>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && days[hover] && (
        <figcaption className="viz-tooltip" aria-live="polite">
          <span>{formatDayShort(days[hover] ?? '')}</span>
          {series.map((line) => (
            <strong key={line.key}>
              <i style={{ background: line.color }} aria-hidden="true" />
              {format(line.points[hover]?.amount ?? 0)}
            </strong>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * A ranked list with a thin bar per row. Bars share one scale, the largest
 * filling the track; the numbers beside them carry the exact values.
 */
export function BarList({
  rows,
  color,
  emptyText,
}: {
  rows: { key: string; label: ReactNode; amount: number; detail: ReactNode }[];
  color: string;
  emptyText: string;
}) {
  if (rows.length === 0) return <p className="muted">{emptyText}</p>;
  const max = Math.max(...rows.map((row) => row.amount), 1);
  return (
    <ul className="barlist">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="barlist-label">{row.label}</span>
          <span className="barlist-track" aria-hidden="true">
            <span
              className="barlist-fill"
              style={{ width: `${(row.amount / max) * 100}%`, background: color }}
            />
          </span>
          <span className="barlist-detail">{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Spend against the month: a track for the ceiling, the spent part in the
 * source's colour, the forecast as a hairline marker past it.
 */
export function MonthMeter({
  spent,
  forecast,
  ceiling,
  color,
  label,
}: {
  spent: number;
  forecast: number | null;
  ceiling: number | null;
  color: string;
  label: string;
}) {
  const scale = Math.max(ceiling ?? 0, forecast ?? 0, spent, 1);
  const spentShare = Math.min(100, (spent / scale) * 100);
  const forecastShare = forecast === null ? null : Math.min(100, (forecast / scale) * 100);
  const ceilingShare = ceiling === null ? null : Math.min(100, (ceiling / scale) * 100);
  const over = ceiling !== null && forecast !== null && forecast > ceiling;
  return (
    <div className={`meter${over ? ' meter-over' : ''}`} role="img" aria-label={label}>
      <span className="meter-fill" style={{ width: `${spentShare}%`, background: color }} />
      {forecastShare !== null && (
        <span className="meter-forecast" style={{ left: `${forecastShare}%` }} />
      )}
      {ceilingShare !== null && ceilingShare < 100 && (
        <span className="meter-ceiling" style={{ left: `${ceilingShare}%` }} />
      )}
    </div>
  );
}
