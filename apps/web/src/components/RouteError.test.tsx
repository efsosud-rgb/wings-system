import { render, screen, waitFor } from '@testing-library/react';
import { Suspense, lazy } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteError } from './RouteError.js';
import { listenForStaleBuild } from './stale-build.js';
import { goneChunk, viteImport } from './vite-preload.testing.js';

// A lazy screen whose file is gone after a deploy, like Marketing › Edição de Fotos e Vídeos,
// loaded through the preload helper the build wraps around every import().
function screenOfPreviousBuild() {
  const Gone = lazy(() => viteImport(goneChunk) as unknown as Promise<{ default: () => null }>);
  return createMemoryRouter([
    {
      path: '/',
      element: (
        <Suspense fallback="…">
          <Gone />
        </Suspense>
      ),
      errorElement: <RouteError />,
    },
  ]);
}

describe('RouteError', () => {
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

  it('reloads once for a lazy screen from a previous build', async () => {
    render(<RouterProvider router={screenOfPreviousBuild()} />);
    await screen.findByText('Esta tela foi atualizada');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('after the reload the screen still shows the notice, without a second reload', async () => {
    sessionStorage.setItem('wings:reloaded-for-new-build', '1');
    render(<RouterProvider router={screenOfPreviousBuild()} />);
    await screen.findByText('Esta tela foi atualizada');
    expect(reload).not.toHaveBeenCalled();
  });
});
