/**
 * What the production bundle really does around every `import()`: Vite wraps it in a preload
 * helper that, when the chunk fails, dispatches a cancelable `vite:preloadError` on `window` and
 * rethrows the original error unless a listener called `preventDefault()` — in which case the
 * promise resolves `undefined`. Mirrors `preload()` in vite's build-import-analysis plugin
 * (handlePreloadError). Vitest has no such helper, so a test that only rejects the import covers
 * a path the browser never takes.
 */
export function viteImport<T>(load: () => Promise<T>): Promise<T | undefined> {
  return load().catch((error: unknown) => {
    const event = new Event('vite:preloadError', { cancelable: true });
    (event as Event & { payload?: unknown }).payload = error;
    window.dispatchEvent(event);
    if (!event.defaultPrevented) throw error;
    return undefined;
  });
}

/** The chunk of a previous build: the file is gone (404), as Chrome reports it. */
export const goneChunk = () =>
  Promise.reject(
    new TypeError('Failed to fetch dynamically imported module: https://x.test/assets/old-abc.js'),
  );
