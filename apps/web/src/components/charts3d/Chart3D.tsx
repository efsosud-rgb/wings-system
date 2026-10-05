import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './charts3d.css';
import { COMPACT_WIDTH, TONE_HEX, type ChartLabel, type ChartSpec } from './spec.js';

type Swatch = keyof typeof TONE_HEX;

/**
 * A 3D chart: the scene on a canvas, every word and number in HTML over it,
 * a tooltip on hover (or with the arrow keys), and a table with the same
 * numbers one click away. `three` and the engine load on demand; without
 * WebGL, or while they load, the flat chart (`fallback`) stands in, so the
 * numbers are never hostage to the 3D.
 */

/**
 * The key of a chart whose colours carry meaning: every series of a multi-series
 * chart, and the donut slices too thin to carry their own label.
 */
function legendOf(
  spec: ChartSpec,
  compact: boolean,
): { key: string; label: string; tone: Swatch; below?: boolean }[] {
  // Narrow: the names that sat beside the scene become this list.
  if (compact && spec.kind === 'funnel')
    return spec.steps.map((step, i) => ({
      key: step.key,
      label: `${step.label} · ${step.text}`,
      tone: i % 2 === 0 ? 'brand' : 'brandSoft',
      below: true,
    }));
  if (compact && spec.kind === 'donut' && !spec.gauge)
    return spec.slices.map((slice) => ({
      key: slice.key,
      label: `${slice.label} · ${slice.text}`,
      tone: slice.tone,
      below: true,
    }));
  if ((spec.kind === 'bars' || spec.kind === 'ribbons') && spec.series.length > 1)
    return spec.series.map((series) => ({
      key: series.key,
      label: series.label,
      tone: series.tone,
    }));
  if (spec.kind === 'donut' && !spec.gauge) {
    const total = spec.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
    return spec.slices
      .filter((slice) => total > 0 && (slice.value / total) * Math.PI * 2 < 0.12)
      .map((slice) => ({
        key: slice.key,
        label: `${slice.label} · ${slice.text}`,
        tone: slice.tone,
      }));
  }
  return [];
}

type EngineModule = typeof import('./engine.js');
let loading: Promise<EngineModule | null> | null = null;

/** WebGL2 and a real browser; jsdom and old browsers get the flat chart. */
const canUse3d = () =>
  typeof window !== 'undefined' &&
  typeof WebGL2RenderingContext !== 'undefined' &&
  typeof requestAnimationFrame === 'function';

function loadEngine(): Promise<EngineModule | null> {
  loading ??= import('./engine.js').catch(() => null);
  return loading;
}

interface Props {
  spec: ChartSpec;
  /** Height of the scene in CSS pixels. */
  height: number;
  /** What the chart shows, for the canvas's accessible name. */
  ariaLabel: string;
  /** The flat chart, shown without WebGL; when absent the table itself stands in. */
  fallback?: ReactNode;
  /** A table with the same numbers. */
  table: ReactNode;
  /** Replay the entrance when this changes (another funnel, another period). */
  replayKey?: string;
  className?: string;
}

export function Chart3D({ spec, height, ariaLabel, fallback, table, replayKey, className }: Props) {
  const [mode, setMode] = useState<'loading' | '3d' | 'flat'>(() =>
    canUse3d() ? 'loading' : 'flat',
  );
  const [labels, setLabels] = useState<ChartLabel[]>([]);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [compact, setCompact] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const viewRef = useRef<import('./engine.js').ChartView | null>(null);
  const specRef = useRef(spec);
  const keyboardPiece = useRef(-1);
  const tipId = useId();
  specRef.current = spec;

  useEffect(() => {
    if (mode === 'flat') return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void loadEngine().then((module) => {
      if (cancelled) return;
      const engine = module?.acquireEngine() ?? null;
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!module || !engine || !canvas || !stage) {
        setMode('flat');
        return;
      }
      let view: import('./engine.js').ChartView;
      try {
        view = engine.add(canvas, stage, specRef.current, {
          onLabels: (next) => setLabels(next),
          onFrame: (positions) => {
            positions.forEach((position, i) => {
              const element = labelRefs.current[i];
              if (!element) return;
              element.style.visibility = position ? 'visible' : 'hidden';
              if (position) element.style.transform = `translate(${position.x}px, ${position.y}px)`;
            });
          },
          onHover: (hover) => setTip(hover),
        });
      } catch {
        module.releaseEngine();
        setMode('flat');
        return;
      }
      viewRef.current = view;
      setMode('3d');
      const resize = () => {
        view.resize(stage.clientWidth, stage.clientHeight);
        setCompact(stage.clientWidth < COMPACT_WIDTH);
      };
      resize();
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
      observer?.observe(stage);
      cleanup = () => {
        observer?.disconnect();
        engine.remove(view, stage);
        viewRef.current = null;
        module.releaseEngine();
      };
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // The view is made once; data changes go through the effect below.
  }, [mode === 'flat']);

  // Pages build their specs inline, so compare the data, not the object.
  const specKey = JSON.stringify(spec);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    view.spec = specRef.current;
    view.entering = true;
    view.startedAt = null;
    view.rebuild();
    view.engine.wake();
  }, [specKey, replayKey]);

  const local = (event: React.PointerEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const view = viewRef.current;
    if (!view) return;
    const at = local(event);
    if (view.drag && !view.engine.reduced) {
      const yaw = view.drag.yaw + (event.clientX - view.drag.x) * 0.004;
      view.yawTarget = Math.max(-0.5, Math.min(0.5, yaw));
      view.engine.wake();
      return;
    }
    view.setHover(view.pick(at.x, at.y), at);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const view = viewRef.current;
    if (!view || view.engine.reduced || event.pointerType === 'touch') return;
    view.drag = { x: event.clientX, yaw: view.yawTarget };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const endDrag = () => {
    const view = viewRef.current;
    if (!view || !view.drag) return;
    view.drag = null;
    view.yawTarget = 0;
    view.engine.wake();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const view = viewRef.current;
    const count = view?.built?.pieceCount ?? 0;
    if (!view || count === 0) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (event.key === 'Escape') {
      keyboardPiece.current = -1;
      view.setHover(null, null);
      return;
    }
    if (!step) return;
    event.preventDefault();
    keyboardPiece.current = (keyboardPiece.current + step + count) % count;
    view.setHover({ piece: keyboardPiece.current }, null);
  };

  const legend = legendOf(spec, compact);

  return (
    <figure className={`c3d${compact ? ' c3d-compact' : ''}${className ? ` ${className}` : ''}`}>
      {mode !== 'flat' && legend.length > 0 && !legend[0]!.below && (
        <ul className="c3d-legend">
          {legend.map((item) => (
            <li key={item.key}>
              <span
                className="c3d-swatch"
                style={{ background: TONE_HEX[item.tone] }}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {mode === 'flat' ? (
        (fallback ?? <div className="c3d-flat-table">{table}</div>)
      ) : (
        <div className="c3d-stage" ref={stageRef} style={{ height }}>
          <canvas
            ref={canvasRef}
            className="c3d-canvas"
            role="img"
            aria-label={`${ariaLabel}. Use as setas para ler cada valor; a tabela abaixo traz os mesmos números.`}
            aria-describedby={tip ? tipId : undefined}
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              endDrag();
              viewRef.current?.setHover(null, null);
            }}
            onPointerDown={onPointerDown}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            onBlur={() => {
              keyboardPiece.current = -1;
              viewRef.current?.setHover(null, null);
            }}
          />
          <div className="c3d-labels" aria-hidden="true">
            {labels.map((label, i) => (
              <span
                key={label.key}
                ref={(element) => {
                  labelRefs.current[i] = element;
                }}
                className={`c3d-label c3d-label-${label.kind} c3d-align-${label.align}`}
                style={{ visibility: 'hidden' }}
              >
                <span>{label.text}</span>
              </span>
            ))}
          </div>
          {tip && (
            <div
              id={tipId}
              role="tooltip"
              className="c3d-tip"
              style={{ transform: `translate(${tip.x}px, ${tip.y}px)` }}
            >
              {tip.text}
            </div>
          )}
          {mode === 'loading' && <div className="c3d-loading" aria-hidden="true" />}
        </div>
      )}
      {mode !== 'flat' && legend.length > 0 && legend[0]!.below && (
        <ul className="c3d-legend c3d-legend-below">
          {legend.map((item) => (
            <li key={item.key}>
              <span
                className="c3d-swatch"
                style={{ background: TONE_HEX[item.tone] }}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {(mode !== 'flat' || fallback) && (
        <details className="c3d-table">
          <summary>Ver como tabela</summary>
          {table}
        </details>
      )}
    </figure>
  );
}
