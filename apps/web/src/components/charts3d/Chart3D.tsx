import { useEffect, useRef, useState, type ReactNode } from 'react';
import './charts3d.css';
import { NEUTRAL, SERIES, heatLegend, seriesColor, type ChartSpec } from './spec.js';

/**
 * A 3D chart: the scene on a canvas, every word and number in HTML over it,
 * a dark tooltip on hover (or with the arrow keys), and a table with the
 * same numbers one click away. `three` and the engine load on demand;
 * without WebGL the table itself stands in, so the numbers never depend on
 * the 3D.
 */

type EngineModule = typeof import('./engine.js');
let loading: Promise<EngineModule | null> | null = null;

/** WebGL2 and a real browser; jsdom and old browsers get the table. */
const canUse3d = () =>
  typeof window !== 'undefined' &&
  typeof WebGL2RenderingContext !== 'undefined' &&
  typeof requestAnimationFrame === 'function' &&
  typeof ResizeObserver !== 'undefined';

function loadEngine(): Promise<EngineModule | null> {
  loading ??= import('./engine.js').catch(() => null);
  return loading;
}

/** The key of a chart whose colours carry meaning: grouped columns' series, the donut's slices. */
function legendOf(spec: ChartSpec) {
  if (spec.kind === 'columns' && spec.series.length > 1)
    return spec.series.map((series, i) => ({ label: series.name, color: seriesColor(series, i) }));
  if (spec.kind === 'line') {
    // Same colouring as the scene: neutral series take no palette colour.
    let next = 0;
    return spec.series.map((series) => {
      const color = series.neutral ? NEUTRAL : seriesColor({ slot: series.slot ?? next }, 0);
      if (!series.neutral && series.slot === undefined) next++;
      return { label: series.name, color, dashed: series.dashed };
    });
  }
  if (spec.kind === 'heat') return heatLegend(spec);
  if (spec.kind === 'donut') {
    // Same colouring as the scene: neutral slices take no palette colour.
    let next = 0;
    return spec.segments
      .filter((segment) => segment.value > 0)
      .map((segment) => ({
        label: segment.label,
        color: segment.neutral ? NEUTRAL : SERIES[next++ % SERIES.length]!,
      }));
  }
  return [];
}

interface Props {
  spec: ChartSpec;
  /** Height of the scene in CSS pixels. */
  height: number;
  /** What the chart shows, for the canvas's accessible name. */
  ariaLabel: string;
  /** A table with the same numbers. */
  table: ReactNode;
  className?: string;
}

export function Chart3D({ spec, height, ariaLabel, table, className }: Props) {
  const [mode, setMode] = useState<'loading' | '3d' | 'flat'>(() =>
    canUse3d() ? 'loading' : 'flat',
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<import('./engine.js').ChartEngine | null>(null);
  const sceneRef = useRef<import('./scenes.js').Scene3D | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  // Pages build their specs inline, so compare the data, not the object.
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    if (mode === 'flat') return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void loadEngine().then((module) => {
      if (cancelled) return;
      const engine = module?.acquireEngine() ?? null;
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      const layer = layerRef.current;
      const tip = tipRef.current;
      if (!module || !engine || !stage || !canvas || !layer || !tip) {
        setMode('flat');
        return;
      }
      try {
        sceneRef.current = engine.add({ stage, canvas, layer, tip }, specRef.current);
      } catch {
        module.releaseEngine();
        setMode('flat');
        return;
      }
      engineRef.current = engine;
      setMode('3d');
      const observer = new ResizeObserver(() => engine.resize(stage));
      observer.observe(stage);
      cleanup = () => {
        observer.disconnect();
        engine.remove(stage);
        engineRef.current = null;
        sceneRef.current = null;
        module.releaseEngine();
      };
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [mode === 'flat']);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || !canvasRef.current || !layerRef.current || !tipRef.current) return;
    sceneRef.current = engine.replace(
      { stage, canvas: canvasRef.current, layer: layerRef.current, tip: tipRef.current },
      specRef.current,
    );
  }, [specKey]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (event.key === 'Escape') return scene.focusPiece(0);
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    scene.focusPiece(step);
  };

  const legend = legendOf(spec);

  return (
    <figure className={`c3d${className ? ` ${className}` : ''}`}>
      {mode !== 'flat' && legend.length > 0 && (
        <ul className="c3d-legend">
          {legend.map((item) => (
            <li key={item.label}>
              <span
                className={`c3d-swatch${'dashed' in item && item.dashed ? ' c3d-swatch-dashed' : ''}`}
                style={{ background: item.color }}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {mode === 'flat' ? (
        <div className="c3d-flat-table">{table}</div>
      ) : (
        <div className="w3d c3d-stage" ref={stageRef} style={{ height }}>
          <canvas
            ref={canvasRef}
            className="w3d-canvas"
            role="img"
            aria-label={`${ariaLabel}. Use as setas para ler cada valor; a tabela abaixo traz os mesmos números.`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={() => sceneRef.current?.focusPiece(0)}
          />
          <div className="w3d-labels" ref={layerRef} aria-hidden="true" />
          <div className="w3d-tip" ref={tipRef} role="tooltip" hidden />
          {mode === 'loading' && <div className="c3d-loading" aria-hidden="true" />}
        </div>
      )}
      {mode !== 'flat' && (
        <details className="c3d-table">
          <summary>Ver como tabela</summary>
          {table}
        </details>
      )}
    </figure>
  );
}
