import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioSession } from '../../session.js';

/**
 * Logos: a search that failed must not read "the logo is not in the Drive yet"
 * (which also offers to upload it again, duplicating it).
 */

const get = vi.fn();
vi.mock('../../../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../../../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { ElementsPanel } = await import('./ElementsPanel.js');
const { ApiError } = await import('../../../../api/client.js');

const session = { status: 'ready', busy: null, clientId: 'c-1' } as unknown as StudioSession;
function script(failing: (path: string) => unknown) {
  get.mockImplementation(async (path: string) => {
    const error = failing(path);
    if (error) throw error;
    if (path === '/drive/tree') return { folders: [], maxFileBytes: 1, storageAvailable: true };
    if (path.startsWith('/drive/search')) return { files: [] };
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ElementsPanel session={session} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('Elementos: logos', () => {
  it('does not say the Wings logo is missing when the search failed', async () => {
    script((path) => path.includes('wings-logo') && new ApiError(500, {}));
    renderPanel();
    expect(
      await screen.findByText(
        /Não foi possível carregar o logo da Wings: o servidor teve um problema/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/O logo ainda não está no Drive/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar o logo para o Drive' })).toBeNull();
  });

  it('does not say the client has no logo when the search failed', async () => {
    script((path) => path.includes('clientId') && new TypeError('Failed to fetch'));
    renderPanel();
    expect(
      await screen.findByText(/Não foi possível carregar os logos do cliente: sem conexão/),
    ).toBeTruthy();
    expect(screen.queryByText(/Nenhum arquivo com “logo” no nome/)).toBeNull();
  });

  it('still says so when the searches answered and found nothing', async () => {
    script(() => null);
    renderPanel();
    expect(await screen.findByText(/O logo ainda não está no Drive/)).toBeTruthy();
    expect(await screen.findByText(/Nenhum arquivo com “logo” no nome/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
