import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearReloadLock,
  isStaleChunkError,
  listenForStaleBuild,
  reloadOnceForNewBuild,
} from './stale-build.js';
import { goneChunk, viteImport } from './vite-preload.testing.js';

describe('stale build', () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('recognises the browsers’ messages for a chunk that is gone', () => {
    for (const text of [
      'Failed to fetch dynamically imported module: https://x.test/assets/Studio-abc.js',
      'Importing a module script failed.',
      'error loading dynamically imported module',
      'Unable to preload CSS for /assets/a.css',
    ]) {
      expect(isStaleChunkError(new Error(text))).toBe(true);
    }
    expect(isStaleChunkError(new Error('Network down'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });

  it('reloads once, then refuses until the app has loaded fine', () => {
    expect(reloadOnceForNewBuild()).toBe(true);
    expect(reloadOnceForNewBuild()).toBe(false);
    expect(reloadOnceForNewBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    clearReloadLock();
    expect(reloadOnceForNewBuild()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('vite:preloadError listener', () => {
  const reload = vi.fn();
  let stop: () => void;
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stop = listenForStaleBuild();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('swallows the error only while it reloads; the second time the import rejects', async () => {
    // First failure: reload, and the helper resolves undefined (the page is going away).
    await expect(viteImport(goneChunk)).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
    // The reload brought the same broken build back: the original error reaches the caller.
    await expect(viteImport(goneChunk)).rejects.toThrow(/Failed to fetch dynamically imported/);
    await expect(viteImport(goneChunk)).rejects.toThrow(/Failed to fetch dynamically imported/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not touch an import that works', async () => {
    await expect(viteImport(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(reload).not.toHaveBeenCalled();
  });
});
