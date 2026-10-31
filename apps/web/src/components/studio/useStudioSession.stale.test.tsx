import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForStaleBuild } from '../stale-build.js';
import { goneChunk, viteImport } from '../vite-preload.testing.js';

/**
 * Reproduces the 25/09 report the way the production bundle delivers it: after a deploy the tab
 * still holds the old build, the editor core's chunk is gone, and `import('@wings/studio')` goes
 * through Vite's preload helper — which resolves `undefined` once the global listener handled the
 * `vite:preloadError`, and rejects with the original error when it did not.
 */
const load = vi.hoisted(() => ({ studio: vi.fn() }));
vi.mock('./loadStudioCore.js', () => ({ loadStudioCore: load.studio }));
vi.mock('harfbuzzjs/hb.wasm?url', () => ({ default: '/assets/hb.wasm' }));
vi.mock('@resvg/resvg-wasm/index_bg.wasm?url', () => ({ default: '/assets/resvg.wasm' }));
const { useStudioSession } = await import('./useStudioSession.js');
const { STALE_BUILD_NOTICE } = await import('../stale-build.js');

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe('the editor when its chunk is from a previous build', () => {
  const reload = vi.fn();
  let stop: () => void;
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    load.studio.mockImplementation(() => viteImport(goneChunk));
    stop = listenForStaleBuild();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('first time: reloads once, and the module that came back undefined is not a TypeError', async () => {
    const { result } = renderHook(() => useStudioSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.failure).toBe(STALE_BUILD_NOTICE);
    expect(result.current.failure).not.toMatch(/undefined|dynamically imported/i);
  });

  it('after the reload the problem persists: plain notice, no second reload', async () => {
    // The lock the first reload left behind.
    sessionStorage.setItem('wings:reloaded-for-new-build', '1');
    const { result } = renderHook(() => useStudioSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.failure).toBe(STALE_BUILD_NOTICE);
    expect(result.current.failure).not.toMatch(/undefined|dynamically imported/i);
  });
});
