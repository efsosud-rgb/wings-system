import { describe, expect, it } from 'vitest';
import { afterFirstPaint } from './after-paint.js';

type Callback = (list: { getEntriesByName: (name: string) => unknown[] }) => void;

/** A window with just what `afterFirstPaint` touches; `paint()` plays the browser's first paint. */
function fakeWindow(options: { paintTiming?: boolean; idle?: boolean } = {}) {
  const { paintTiming = true, idle = true } = options;
  const timers: { delay: number; fn: () => void }[] = [];
  const idleCallbacks: (() => void)[] = [];
  let callback: Callback | null = null;
  let disconnected = false;
  class FakeObserver {
    static supportedEntryTypes = paintTiming ? ['paint'] : [];
    constructor(cb: Callback) {
      callback = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const w = {
    PerformanceObserver: FakeObserver,
    setTimeout: (fn: () => void, delay: number) => void timers.push({ delay, fn }),
    ...(idle ? { requestIdleCallback: (fn: () => void) => void idleCallbacks.push(fn) } : {}),
  } as unknown as Window & typeof globalThis;
  return {
    w,
    timers,
    idleCallbacks,
    disconnected: () => disconnected,
    paint: (name = 'first-contentful-paint') =>
      callback?.({ getEntriesByName: (n) => (n === name ? [{}] : []) }),
  };
}

describe('afterFirstPaint', () => {
  it('waits for the first paint, then for an idle moment', () => {
    const win = fakeWindow();
    let runs = 0;
    afterFirstPaint(() => (runs += 1), win.w);
    expect(runs).toBe(0);
    win.paint();
    expect(runs).toBe(0);
    expect(win.disconnected()).toBe(true);
    win.idleCallbacks[0]?.();
    expect(runs).toBe(1);
  });

  it('ignores a paint entry that is not the first contentful paint', () => {
    const win = fakeWindow();
    afterFirstPaint(() => {}, win.w);
    win.paint('first-paint');
    expect(win.idleCallbacks).toHaveLength(0);
  });

  it('runs once even when the idle moment and the fallback timer both fire', () => {
    const win = fakeWindow();
    let runs = 0;
    afterFirstPaint(() => (runs += 1), win.w);
    win.paint();
    win.idleCallbacks[0]?.();
    win.timers.forEach((timer) => timer.fn());
    expect(runs).toBe(1);
  });

  it('runs by itself when no paint ever comes (a hidden tab)', () => {
    const win = fakeWindow();
    let runs = 0;
    afterFirstPaint(() => (runs += 1), win.w);
    expect(win.timers).toHaveLength(1);
    win.timers[0]?.fn();
    expect(runs).toBe(1);
  });

  it('uses a timer when the browser has no requestIdleCallback', () => {
    const win = fakeWindow({ idle: false });
    let runs = 0;
    afterFirstPaint(() => (runs += 1), win.w);
    win.paint();
    win.timers.at(-1)?.fn();
    expect(runs).toBe(1);
  });

  it('does not wait for a paint the browser cannot report', () => {
    const win = fakeWindow({ paintTiming: false });
    let runs = 0;
    afterFirstPaint(() => (runs += 1), win.w);
    expect(runs).toBe(0);
    win.idleCallbacks[0]?.();
    expect(runs).toBe(1);
  });
});
