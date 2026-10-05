import { Suspense, lazy, useRef, type ComponentType, type ReactNode } from 'react';
import { hasWebGL, useSeenOnce } from './scene-support.js';

/**
 * Loads a 3D scene only when it appears on screen, and only where WebGL
 * exists; everywhere else the 2D `fallback` is what the person sees. The
 * scene's module (and with it three.js) is a separate chunk behind `load`,
 * so a page that never shows it never downloads it.
 */
export function lazyScene<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  return lazy(load);
}

interface Lazy3DProps<P extends object> {
  scene: ComponentType<P>;
  sceneProps: P;
  fallback: ReactNode;
  className?: string;
}

export function Lazy3D<P extends object>({
  scene: Scene,
  sceneProps,
  fallback,
  className,
}: Lazy3DProps<P>) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(ref);
  const webgl = seen ? hasWebGL() : true;
  return (
    <div ref={ref} className={className}>
      {seen && webgl ? (
        <Suspense fallback={fallback}>
          <Scene {...sceneProps} />
        </Suspense>
      ) : (
        fallback
      )}
    </div>
  );
}
