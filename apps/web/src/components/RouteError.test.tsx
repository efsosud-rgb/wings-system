import { render, screen, waitFor } from '@testing-library/react';
import { Suspense, lazy } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteError } from './RouteError.js';

// A lazy screen whose file is gone after a deploy, like Marketing › Edição de Fotos e Vídeos.
const Gone = lazy(() =>
  Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Studio-old.js')),
);

describe('RouteError', () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reloads once for a lazy screen from a previous build', async () => {
    const router = createMemoryRouter([
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
    render(<RouterProvider router={router} />);
    await screen.findByText('Esta tela foi atualizada');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
