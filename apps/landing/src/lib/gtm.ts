/**
 * Google Tag Manager, the standard snippet for the container the runtime
 * config names (LANDING_GTM_ID); no id, no tag. The dataLayer exists either
 * way, so the page's events (`whatsapp_click`, `lead_submit`) never break.
 * `deferGtm` is the page's way in; the embedded form still calls `installGtm` at once.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export const GTM_SCRIPT = 'https://www.googletagmanager.com/gtm.js';

export function initDataLayer(w: Window = window): unknown[] {
  w.dataLayer = w.dataLayer || [];
  return w.dataLayer;
}

export function installGtm(
  id: string | null,
  w: Window = window,
  d: Document = document,
): HTMLScriptElement | null {
  const dataLayer = initDataLayer(w);
  if (!id) return null;
  dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  const script = d.createElement('script');
  script.async = true;
  script.src = `${GTM_SCRIPT}?id=${encodeURIComponent(id)}`;
  const first = d.getElementsByTagName('script')[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else d.head.appendChild(script);
  return script;
}

/** Without a first touch, GTM loads this long after the page's `load`. */
export const GTM_IDLE_LOAD_MS = 4000;
/** The longest a conversion event waits for GTM to finish loading before it goes to the dataLayer anyway. */
export const GTM_READY_WAIT_MS = 1500;
/** The visitor's first touch; `scroll` does not bubble, so all of them are listened for on the window. */
const FIRST_TOUCH = ['pointerdown', 'touchstart', 'scroll', 'keydown'] as const;

export interface DeferredGtm {
  /** Loads GTM now; it loads once, whoever asks first. */
  load(): void;
  /**
   * Puts a conversion event on the dataLayer with GTM already loaded: at once when it is, else it
   * loads GTM now and waits for it, `maxMs` at most. Never awaited: nothing else depends on it.
   */
  pushWhenLoaded(event: Record<string, unknown>, maxMs?: number): void;
}

/**
 * GTM loads on the first touch (`FIRST_TOUCH`, or `load()` for the rest, such as a form field's
 * focus) or `GTM_IDLE_LOAD_MS` after the page's `load`, whichever comes first, so the tags do not
 * compete with the first paint. Until then the dataLayer exists and queues what the page pushes,
 * and GTM replays it in order when it loads: `gtm.js` is pushed at load time, before any event
 * that follows the touch.
 */
export function deferGtm(
  id: string | null,
  w: Window & typeof globalThis = window,
  d: Document = document,
): DeferredGtm {
  initDataLayer(w);
  // no id, no tag: nothing to wait for
  if (!id) return { load() {}, pushWhenLoaded: (event) => pushEvent(event, w) };

  let started = false;
  let loaded = false;
  const waiting: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const settle = () => {
    loaded = true;
    waiting.splice(0).forEach((go) => go());
  };
  const load = () => {
    if (started) return;
    started = true;
    cleanups.splice(0).forEach((undo) => undo());
    const script = installGtm(id, w, d);
    // a script that fails to load still releases the events: they stay queued for GTM
    script?.addEventListener('load', settle);
    script?.addEventListener('error', settle);
  };

  for (const type of FIRST_TOUCH) {
    w.addEventListener(type, load, { capture: true, passive: true });
    cleanups.push(() => w.removeEventListener(type, load, { capture: true }));
  }
  const startTimer = () => {
    const timer = w.setTimeout(load, GTM_IDLE_LOAD_MS);
    cleanups.push(() => w.clearTimeout(timer));
  };
  if (d.readyState === 'complete') startTimer();
  else {
    w.addEventListener('load', startTimer, { once: true });
    cleanups.push(() => w.removeEventListener('load', startTimer));
  }

  return {
    load,
    pushWhenLoaded(event, maxMs = GTM_READY_WAIT_MS) {
      if (loaded) return pushEvent(event, w);
      load();
      const timer = w.setTimeout(() => go(), maxMs);
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        w.clearTimeout(timer);
        pushEvent(event, w);
      };
      waiting.push(go);
    },
  };
}

export function pushEvent(event: Record<string, unknown>, w: Window = window): void {
  initDataLayer(w).push(event);
}
