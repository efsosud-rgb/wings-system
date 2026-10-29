/**
 * Runs `fn` once, after the page has painted its first content and the browser has a free
 * moment. What is not needed for that first frame (the 3D scene, the robot check) starts here,
 * so it does not compete with the content for the network or the main thread.
 */

/** Longest wait for an idle moment once the first paint is in. */
const IDLE_TIMEOUT_MS = 2000;
/** A paint signal that never comes (a hidden tab) must not leave `fn` waiting for good. */
const NO_PAINT_FALLBACK_MS = 4000;

export function afterFirstPaint(fn: () => void, w: Window & typeof globalThis = window): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const idle = () => {
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
      w.setTimeout(run, 0);
    }
  };
  // browsers without paint timing have no first paint to wait for: the idle moment alone
  if (!w.PerformanceObserver?.supportedEntryTypes?.includes('paint')) return idle();
  w.setTimeout(run, NO_PAINT_FALLBACK_MS);
  try {
    const observer = new w.PerformanceObserver((list) => {
      if (!list.getEntriesByName('first-contentful-paint').length) return;
      observer.disconnect();
      idle();
    });
    observer.observe({ type: 'paint', buffered: true });
  } catch {
    // the fallback timer above still runs it
  }
}
