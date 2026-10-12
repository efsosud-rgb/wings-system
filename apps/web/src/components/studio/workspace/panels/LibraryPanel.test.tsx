import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioSession } from '../../session.js';

/**
 * The editor's library rail: a request that failed is "—" and the reason, never
 * "Nada na biblioteca" or "Pasta vazia" (the person would conclude there is
 * nothing to add and go and upload what is already there).
 */

const get = vi.fn();
vi.mock('../../../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../../../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));
vi.mock('../../../../api/clients.js', () => ({ useClients: () => ({ data: { clients: [] } }) }));

const { LibraryPanel } = await import('./LibraryPanel.js');
const { ApiError } = await import('../../../../api/client.js');

const session = { status: 'ready', busy: null, lastFolder: null } as unknown as StudioSession;
const FOLDER = {
  id: 'f-1',
  parentId: null,
  name: 'Marketing',
  path: '/Marketing',
  accessible: true,
  canWrite: true,
  department: 'marketing',
  clientId: null,
  origin: 'template',
  managed: true,
  slot: null,
};

/** The default script: answers everything with nothing, except what the test makes fail. */
function script(failing: (path: string) => unknown) {
  get.mockImplementation(async (path: string) => {
    const error = failing(path);
    if (error) throw error;
    if (path === '/drive/tree') {
      return { folders: [FOLDER], maxFileBytes: 1, storageAvailable: true };
    }
    if (path.startsWith('/drive/folders/')) return { folder: FOLDER, files: [] };
    if (path.startsWith('/drive/search')) return { files: [] };
    if (path.startsWith('/media/assets')) return { assets: [], storageAvailable: true };
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LibraryPanel session={session} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('the editor library: Biblioteca', () => {
  it('says "—" and why instead of "Nada na biblioteca com esses filtros"', async () => {
    script((path) => path.startsWith('/media/assets') && new ApiError(500, {}));
    renderPanel();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar a biblioteca: o servidor teve um problema \(erro 500\)/,
    );
    expect(screen.queryByText(/Nada na biblioteca/)).toBeNull();
  });

  it('keeps the empty text for a library that answered with nothing', async () => {
    script(() => null);
    renderPanel();
    expect(await screen.findByText(/Nada na biblioteca com esses filtros/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the editor library: Drive', () => {
  const openDrive = async () => fireEvent.click(await screen.findByRole('tab', { name: 'Drive' }));

  it('does not call a folder empty because its listing failed', async () => {
    script((path) => path.startsWith('/drive/folders/') && new TypeError('Failed to fetch'));
    renderPanel();
    await openDrive();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar os arquivos desta pasta: sem conexão com o servidor/,
    );
    expect(screen.queryByText(/Pasta vazia/)).toBeNull();
  });

  it('says the folders could not be loaded when the tree failed', async () => {
    script((path) => path === '/drive/tree' && new ApiError(403, {}));
    renderPanel();
    await openDrive();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar as pastas do Drive: você não tem permissão/,
    );
    expect(screen.queryByText(/Pasta vazia/)).toBeNull();
  });

  it('does not say "Nenhum arquivo com esse nome" for a search that failed', async () => {
    script((path) => path.startsWith('/drive/search') && new ApiError(500, {}));
    renderPanel();
    await openDrive();
    fireEvent.change(await screen.findByLabelText('Buscar no Drive'), {
      target: { value: 'logo' },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar a busca/,
    );
    expect(screen.queryByText(/Nenhum arquivo com esse nome/)).toBeNull();
  });

  it('keeps "Pasta vazia" for a folder that answered with nothing', async () => {
    script(() => null);
    renderPanel();
    await openDrive();
    expect(await screen.findByText(/Pasta vazia/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
