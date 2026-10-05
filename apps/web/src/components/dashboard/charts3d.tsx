import type { SpendStrip } from '@wings/shared';
import { useRef, type ReactNode } from 'react';
import '../charts3d/charts3d.css';

/**
 * What the marketing tabs share around the 3D charts: the KPI card of the
 * sales panel, each source of spend's slot in the validated palette (so Meta
 * is the same blue on every tab), and the plain table every chart carries.
 */

/** Palette slots (see `SERIES`): Meta blue, Google green, Kairogen amber, IA pink, mídia violet. */
export const SOURCE_SLOT: Record<SpendStrip['source'], number> = {
  meta: 1,
  google: 2,
  media: 3,
  kairogen: 4,
  ai: 5,
};

/** A KPI card that leans a few degrees towards the pointer (none with reduced motion, in CSS). */
export function KpiCard({
  title,
  value,
  note,
  children,
}: {
  title: string;
  value: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lean = (event: React.PointerEvent) => {
    const element = ref.current;
    if (!element || event.pointerType === 'touch') return;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.setProperty('--tilt-y', `${(x * 8).toFixed(2)}deg`);
    element.style.setProperty('--tilt-x', `${(-y * 8).toFixed(2)}deg`);
  };
  const rest = () => {
    ref.current?.style.setProperty('--tilt-x', '0deg');
    ref.current?.style.setProperty('--tilt-y', '0deg');
  };
  return (
    <div
      ref={ref}
      className="card kpi3d sales-kpi"
      onPointerMove={lean}
      onPointerLeave={rest}
      aria-label={`${title}: ${value}${typeof note === 'string' && note ? ` (${note})` : ''}`}
    >
      <span className="muted">{title}</span>
      <strong>{value}</strong>
      {note && <span className="cell-sub">{note}</span>}
      {children}
    </div>
  );
}

/** The table under a chart: a header row and the same numbers, as text. */
export function ChartTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: { key: string; cells: ReactNode[]; neutral?: boolean }[];
}) {
  return (
    <table className="table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th key={cell} scope="col" className={index > 0 ? 'num' : undefined}>
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={row.neutral ? 'is-neutral' : undefined}>
            {row.cells.map((cell, index) =>
              index === 0 ? (
                <td key={index}>{cell}</td>
              ) : (
                <td key={index} className="num mono">
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
