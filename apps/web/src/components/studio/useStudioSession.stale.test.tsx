import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reproduces the 25/09 report: after a deploy, the tab still holds the old build and the
 * editor core's chunk no longer exists, so `import('@wings/studio')` rejects.
 */
// Vitest wraps an error thrown by the factory itself, so the browser's message comes from the
// first call the hook makes on the module, which lands in the same catch as a rejected import().
vi.mock('@wings/studio', () => ({
  configureStudio: () => {
    throw new Error(
      'Failed to fetch dynamically imported module: https://x.test/assets/studio-old.js',
    );
  },
}));
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
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reloads once and says so in plain words, not with the browser’s message', async () => {
    const { result, rerender } = renderHook(() => useStudioSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.failure).toBe(STALE_BUILD_NOTICE);
    expect(result.current.failure).not.toMatch(/dynamically imported/i);

    // The reload brought the same broken build back: no second reload, no loop.
    rerender();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
