import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { DriveFilePicker } = await import('./DriveFilePicker.js');
const { SaveToDriveDialog } = await import('./SaveToDriveDialog.js');
const { ApiError } = await import('../../api/client.js');

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

function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('the Drive file picker', () => {
  const picker = () =>
    wrap(
      <DriveFilePicker
        label="Escolher do Drive"
        accept={['video']}
        initialFolderId={null}
        onPick={() => undefined}
        onClose={() => undefined}
      />,
    );

  it('says "—" and why instead of "Pasta vazia" when the listing failed', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/drive/tree')
        return { folders: [FOLDER], maxFileBytes: 1, storageAvailable: true };
      throw new ApiError(500, {});
    });
    picker();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar os arquivos desta pasta: o servidor teve um problema/,
    );
    expect(screen.queryByText('Pasta vazia.')).toBeNull();
  });

  it('says the folders could not be loaded when the tree failed', async () => {
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    picker();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar as pastas do Drive: sem conexão com o servidor/,
    );
    expect(screen.queryByText('Pasta vazia.')).toBeNull();
  });

  it('says "Pasta vazia." for a folder that answered with no files', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/drive/tree'
        ? { folders: [FOLDER], maxFileBytes: 1, storageAvailable: true }
        : { folder: FOLDER, files: [] },
    );
    picker();
    expect(await screen.findByText('Pasta vazia.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the save-to-Drive dialog', () => {
  it('says why the folders are missing instead of leaving an empty tree', async () => {
    get.mockRejectedValue(new ApiError(403, {}));
    wrap(
      <SaveToDriveDialog
        label="Salvar no Drive"
        defaultName="projeto"
        defaultFolderId={null}
        replace={null}
        actions={[]}
        onClose={() => undefined}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar as pastas do Drive: você não tem permissão/,
    );
  });
});
