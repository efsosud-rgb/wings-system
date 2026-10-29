import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReloadLock, isStaleChunkError, reloadOnceForNewBuild } from './stale-build.js';

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
