import { useEffect, useRef, useState } from 'react';
import type { WingsLogo3DOptions } from './wings-logo3d.js';
import { WingsLogo } from './WingsLogo.js';
import { hasWebGL, useSeenOnce } from './scene-support.js';

interface WingsLogo3DProps extends Pick<WingsLogo3DOptions, 'company' | 'motion' | 'fit'> {
  /** `dark` on a dark background (the negative logo), `light` on a light one. */
  variant?: 'light' | 'dark';
  /** Height of the area in CSS pixels. */
  height: number;
  /** Width of the area in CSS pixels; the whole width of the parent when omitted. */
  width?: number;
  className?: string;
}

/**
 * The official logo in relief. The 2D logo is what shows until the 3D is
 * ready, and for good when there is no WebGL, the engine fails, or the module
 * cannot be fetched: nothing here ever leaves the place empty.
 *
 * The engine (wings-logo3d.js, three.js) is a separate chunk fetched the first
 * time this is on screen. It pauses by itself when the tab is hidden or the
 * logo is off screen and stays still under prefers-reduced-motion; its options
 * beyond the three above are the manual's look and are not exposed.
 */
export function WingsLogo3D({
  variant = 'light',
  height,
  width,
  company,
  motion,
  fit,
  className,
}: WingsLogo3DProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seen = useSeenOnce(boxRef);
  const [ready, setReady] = useState(false);
  const enabled = seen && hasWebGL();

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let engine: { dispose(): void } | null = null;
    void import('./wings-logo3d.js')
      .then(({ WingsLogo3D: Engine }) => {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        engine = new Engine(canvas, {
          variant,
          company,
          motion,
          fit,
          onFallback: () => setReady(false),
        });
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      disposed = true;
      engine?.dispose();
      setReady(false);
    };
  }, [enabled, variant, company, motion, fit]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ position: 'relative', height, width: width ?? '100%' }}
    >
      <div
        aria-hidden={ready}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: ready ? 0 : 1,
          transition: 'opacity 0.4s',
        }}
      >
        <WingsLogo
          variant={variant === 'dark' ? 'negativo' : 'principal'}
          height={Math.min(height * 0.7, 120)}
        />
      </div>
      {enabled ? (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Wings Company"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
      ) : null}
    </div>
  );
}
