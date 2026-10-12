import type { DriveFile, DriveFolder, SessionUser } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Drive screen against a scripted API. The bytes of a file never go to the
 * API: a stand-in for XMLHttpRequest records where they went.
 */

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
    delete: (path: string) => del(path),
  },
}));
const session = { current: null as SessionUser | null };
vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));
vi.mock('../api/clients.js', () => ({
  useClients: () => ({
    data: {
      clients: [{ id: 'c-1', name: 'Padaria Aurora', slug: 'padaria-aurora', active: true }],
    },
  }),
}));

const { DrivePage, numberedName } = await import('./DrivePage.js');
const { DriveTemplatePage } = await import('./DriveTemplatePage.js');
const { ApiError } = await import('../api/client.js');

const folder = (id: string, path: string, extra: Partial<DriveFolder> = {}): DriveFolder => ({
  id,
  parentId: null,
  name: path.split('/').pop() ?? '',
  path,
  department: 'marketing',
  clientId: null,
  origin: 'template',
  accessible: true,
  canWrite: true,
  managed: true,
  slot: null,
  ...extra,
});
// Marketing's view: "Formatação" is only the way down to its own tree.
const FOLDERS: DriveFolder[] = [
  folder('f-root', '/Formatação', { accessible: false, canWrite: false, department: 'formatacao' }),
  folder('f-mkt', '/Formatação/Marketing', { parentId: 'f-root' }),
  folder('f-media', '/Formatação/Marketing/Mídia', { parentId: 'f-mkt' }),
  folder('f-camp', '/Formatação/Marketing/Campanha RJ', {
    parentId: 'f-mkt',
    origin: 'manual',
    managed: false,
    slot: null,
  }),
];
const fileOf = (extra: Partial<DriveFile> = {}): DriveFile => ({
  id: 'file-1',
  folderId: 'f-mkt',
  folderPath: '/Formatação/Marketing',
  name: 'Roteiro.pdf',
  mimeType: 'application/pdf',
  byteSize: 2_400_000,
  version: 1,
  ownerName: 'Marketing',
  clientId: null,
  clientName: null,
  tags: ['rj'],
  createdAt: '2026-09-21T12:00:00.000Z',
  updatedAt: '2026-09-21T12:00:00.000Z',
  trashedAt: null,
  purgeAt: null,
  canWrite: true,
  ...extra,
});

let files: DriveFile[] = [];
let trashed: DriveFile[] = [];
function script() {
  get.mockImplementation((path: string) => {
    if (path === '/drive/tree') {
      return Promise.resolve({ folders: FOLDERS, maxFileBytes: 5_000_000, storageAvailable: true });
    }
    if (path.startsWith('/drive/folders/')) {
      const id = path.split('/').pop();
      return Promise.resolve({
        folder: FOLDERS.find((item) => item.id === id),
        files: files.filter((file) => file.folderId === id),
      });
    }
    if (path.startsWith('/drive/search')) return Promise.resolve({ files });
    if (path === '/drive/trash') return Promise.resolve({ files: trashed });
    if (path.includes('/link')) {
      return Promise.resolve({ url: 'https://r2.example/signed', expiresAt: '' });
    }
    if (path === '/projects/c-1') {
      return Promise.resolve({
        project: {
          id: 'p-1',
          clientId: 'c-1',
          clientName: 'Padaria Aurora',
          clientNumber: 3,
          clientActive: true,
          status: 'parado',
          currentStage: '08',
          updatedAt: '2026-09-24T12:00:00.000Z',
          updatedByName: null,
          canManage: false,
          stages: [
            {
              slot: '08',
              name: '08 Marketing',
              department: 'marketing',
              progress: 'em_andamento',
              note: null,
              startedAt: null,
              completedAt: null,
              updatedAt: null,
              updatedByName: null,
              canEdit: true,
            },
          ],
        },
        history: [],
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

/** Where the browser sent bytes, and a handle to finish each send. */
const sent: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  finish: (status: number) => void;
  progress: (fraction: number) => void;
}[] = [];
class FakeXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  abort() {
    this.onabort?.();
  }
  send(body: unknown) {
    sent.push({
      method: this.method,
      url: this.url,
      headers: this.headers,
      body,
      progress: (fraction) =>
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: fraction,
          total: 1,
        } as ProgressEvent),
      finish: (status) => {
        this.status = status;
        this.onload?.();
      },
    });
  }
}

function renderAt(path = '/drive/arquivos') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/drive/arquivos" element={<DrivePage />} />
          <Route path="/administracao/drive" element={<DriveTemplatePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const userWith = (...permissions: string[]) =>
  ({
    id: 'emp-1',
    permissions: Object.fromEntries(permissions.map((key) => [key, 'all'])),
  }) as unknown as SessionUser;

beforeEach(() => {
  for (const mock of [get, post, patch, del]) mock.mockReset();
  sent.length = 0;
  files = [fileOf()];
  trashed = [];
  session.current = userWith('drive.read', 'drive.write');
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  localStorage.clear();
  script();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the tree and the folder', () => {
  it('opens in the first folder the person works in, and the folder above is only a way down', async () => {
    renderAt();
    const tree = await screen.findByRole('navigation', { name: 'Pastas' });
    const above = await within(tree).findByRole('button', { name: 'Formatação' });
    expect(above).toHaveProperty('disabled', true);
    expect(
      within(tree).getByRole('button', { name: 'Marketing' }).getAttribute('aria-current'),
    ).toBe('true');
    // Its subfolders and files are listed; the trail shows where it is.
    expect(await screen.findByRole('button', { name: 'Roteiro.pdf' })).toBeTruthy();
    const trail = screen.getByRole('navigation', { name: 'Caminho' });
    expect(trail.textContent).toBe('FormataçãoMarketing');
    expect(within(trail).queryByRole('button', { name: 'Formatação' })).toBeNull();

    const list = screen.getByRole('table');
    fireEvent.click(within(list).getByRole('button', { name: 'Mídia' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/drive/folders/f-media'));
    expect(await screen.findByText(/Pasta vazia\. Arraste arquivos para cá/)).toBeTruthy();
  });

  it('searches by name, client and tag through the server, and says where each file is', async () => {
    renderAt();
    const search = await screen.findByRole('search', { name: 'Busca no Drive' });
    fireEvent.change(within(search).getByLabelText('Busca'), { target: { value: 'roteiro' } });
    fireEvent.change(within(search).getByLabelText('Cliente'), { target: { value: 'c-1' } });
    fireEvent.change(within(search).getByLabelText('Tag'), { target: { value: 'rj' } });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/drive/search?q=roteiro&clientId=c-1&tag=rj'),
    );
    expect(
      await screen.findByText('1 arquivo encontrado nas pastas que você acessa.'),
    ).toBeTruthy();
    expect(screen.getByText('/Formatação/Marketing')).toBeTruthy();
  });

  it('switches to the grid and remembers it', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Grade' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(await screen.findByRole('button', { name: /Roteiro\.pdf/ })).toBeTruthy();
    expect(localStorage.getItem('wings.drive.view')).toBe('grid');
  });

  it('shows the project status and stage on a client folder, and nothing on the rest', async () => {
    session.current = userWith('drive.read', 'drive.write', 'projects.read');
    FOLDERS.push(
      folder('f-client', '/Clientes/03. Padaria Aurora/08 Marketing', {
        parentId: null,
        department: 'marketing',
        clientId: 'c-1',
        origin: 'client_child',
        slot: '08',
      }),
    );
    try {
      renderAt('/drive/arquivos?pasta=f-client');
      const summary = await screen.findByLabelText('Projeto do cliente');
      expect(within(summary).getByText('Parado')).toBeTruthy();
      expect(within(summary).getByText('Etapa atual: 08 Marketing')).toBeTruthy();
      expect(within(summary).getByText('Em andamento')).toBeTruthy();
      // Read only here: the chip is not a button.
      expect(within(summary).queryByRole('button')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Marketing' }));
      await waitFor(() => expect(screen.queryByLabelText('Projeto do cliente')).toBeNull());
    } finally {
      FOLDERS.pop();
    }
  });

  it('offers nothing that writes to somebody who may only read', async () => {
    const readOnly = FOLDERS.map((item) => ({ ...item, canWrite: false }));
    get.mockImplementation((path: string) =>
      path === '/drive/tree'
        ? Promise.resolve({ folders: readOnly, maxFileBytes: 1, storageAvailable: true })
        : Promise.resolve({ folder: readOnly[1], files: [fileOf({ canWrite: false })] }),
    );
    renderAt();
    await screen.findByRole('button', { name: 'Roteiro.pdf' });
    expect(screen.queryByText('Enviar arquivos')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nova pasta' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mover Roteiro.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Baixar Roteiro.pdf' })).toBeTruthy();
  });
});

describe('sending files', () => {
  const pick = (names: string[], size = 1000) => {
    const input = screen.getByLabelText('Enviar arquivos') as HTMLInputElement;
    const picked = names.map(
      (name) => new File([new Uint8Array(size)], name, { type: 'application/pdf' }),
    );
    fireEvent.change(input, { target: { files: picked } });
    return picked;
  };

  it('sends each file straight to the address the server gave, with progress, and confirms after', async () => {
    post.mockImplementation((path: string, body?: { name: string }) =>
      path === '/drive/uploads'
        ? Promise.resolve({
            ticket: {
              uploadId: `up-${body?.name}`,
              method: 'PUT',
              url: `https://r2.example/bucket/key-${body?.name}?X-Amz-Signature=abc`,
              headers: { 'Content-Type': 'application/pdf' },
              expiresAt: '',
            },
          })
        : Promise.resolve({ file: fileOf({ id: 'new' }) }),
    );
    renderAt();
    await screen.findByRole('button', { name: 'Roteiro.pdf' });
    const [first] = pick(['A.pdf', 'B.pdf']);

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(post.mock.calls[0]).toEqual([
      '/drive/uploads',
      {
        folderId: 'f-mkt',
        name: 'A.pdf',
        mimeType: 'application/pdf',
        byteSize: 1000,
        replaceFileId: undefined,
      },
    ]);
    // The bytes went to storage, not to the API.
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: 'https://r2.example/bucket/key-A.pdf?X-Amz-Signature=abc',
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(sent[0]?.body).toBe(first);
    expect(post.mock.calls.some(([path]) => String(path).endsWith('/complete'))).toBe(false);

    act(() => sent[0]?.progress(0.4));
    const bar = screen.getByRole('progressbar', { name: 'Envio de A.pdf' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');

    act(() => sent[0]?.finish(200));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/drive/uploads/up-A.pdf/complete', undefined),
    );
    expect(await within(bar).findByText('Enviado')).toBeTruthy();
    expect(screen.getByText('Envios: 1 de 2')).toBeTruthy();

    // Storage said no to the other one: it is reported, and never confirmed.
    act(() => sent[1]?.finish(403));
    expect(
      await screen.findByText('O armazenamento recusou o arquivo. Tente de novo.'),
    ).toBeTruthy();
    expect(post).not.toHaveBeenCalledWith('/drive/uploads/up-B.pdf/complete', undefined);
  });

  it('stops a file over the limit before asking the server anything', async () => {
    renderAt();
    await screen.findByRole('button', { name: 'Roteiro.pdf' });
    pick(['Enorme.pdf'], 5_000_001);
    expect(await screen.findByText('Passa do limite de 4,8 MB por arquivo.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('asks what to do when the name is taken: a new version, or both', async () => {
    post.mockImplementation((path: string, body?: { name: string; replaceFileId?: string }) => {
      if (path !== '/drive/uploads') return Promise.resolve({ file: fileOf() });
      if (body?.name === 'Roteiro.pdf' && !body.replaceFileId) {
        return Promise.reject(
          new ApiError(409, {
            error: 'name_taken',
            message: 'Já existe',
            existingFileId: 'file-1',
          } as never),
        );
      }
      return Promise.resolve({
        ticket: {
          uploadId: 'up-1',
          method: 'PUT',
          url: 'https://r2.example/k',
          headers: {},
          expiresAt: '',
        },
      });
    });
    renderAt();
    await screen.findByRole('button', { name: 'Roteiro.pdf' });
    pick(['Roteiro.pdf']);
    fireEvent.click(await screen.findByRole('button', { name: 'Substituir (nova versão)' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(post.mock.calls.at(-1)?.[1]).toMatchObject({
      name: 'Roteiro.pdf',
      replaceFileId: 'file-1',
    });

    expect(numberedName('Roteiro.pdf')).toBe('Roteiro (2).pdf');
    expect(numberedName('Roteiro (2).pdf')).toBe('Roteiro (3).pdf');
    expect(numberedName('LEIAME')).toBe('LEIAME (2)');
  });
});

describe('acting on a file', () => {
  it('moves without dragging, to a folder the person may write in', async () => {
    patch.mockResolvedValue({ file: fileOf({ folderId: 'f-camp' }) });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Mover Roteiro.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Mover Roteiro.pdf' });
    const target = within(dialog).getByLabelText('Para a pasta') as HTMLSelectElement;
    // Not where it already is, and not the folder above that only lets one through.
    expect([...target.options].map((option) => option.textContent)).toEqual([
      '/Formatação/Marketing/Mídia',
      '/Formatação/Marketing/Campanha RJ',
    ]);
    fireEvent.change(target, { target: { value: 'f-camp' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/drive/files/file-1', {
        name: undefined,
        folderId: 'f-camp',
        tags: undefined,
      }),
    );
    expect(await screen.findByText('Movido para /Formatação/Marketing/Campanha RJ.')).toBeTruthy();
  });

  it('moves by dropping a dragged file on a folder of the tree', async () => {
    patch.mockResolvedValue({ file: fileOf({ folderId: 'f-media' }) });
    renderAt();
    await screen.findByRole('button', { name: 'Roteiro.pdf' });
    const tree = screen.getByRole('navigation', { name: 'Pastas' });
    const row = within(tree).getByRole('button', { name: 'Mídia' }).parentElement as HTMLElement;
    fireEvent.drop(row, {
      dataTransfer: {
        getData: () => 'file-1',
        files: [],
        types: ['application/x-wings-drive-file'],
      },
    });
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/drive/files/file-1',
        expect.objectContaining({ folderId: 'f-media' }),
      ),
    );
  });

  it('previews a PDF through a short address asked for at that moment, and sends it to the trash', async () => {
    post.mockResolvedValue({ file: fileOf({ trashedAt: '2026-09-21T13:00:00.000Z' }) });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Roteiro.pdf' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roteiro.pdf' });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/drive/files/file-1/link?disposition=inline'),
    );
    const frame = await within(dialog).findByTitle('Prévia de Roteiro.pdf');
    expect(frame.getAttribute('src')).toBe('https://r2.example/signed');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover para a lixeira' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/drive/files/file-1/trash', undefined));
    expect(await screen.findByText('Movido para a lixeira.')).toBeTruthy();
  });

  it('restores from the trash, and only who manages the Drive may delete for good', async () => {
    trashed = [
      fileOf({ trashedAt: '2026-09-01T12:00:00.000Z', purgeAt: '2026-10-01T12:00:00.000Z' }),
    ];
    post.mockResolvedValue({ file: fileOf() });
    renderAt('/drive/arquivos?ver=lixeira');
    expect(await screen.findByText(/ficam aqui por 30 dias/)).toBeTruthy();
    expect(await screen.findByText(/some em 01\/10\/2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apagar de vez' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/drive/files/file-1/restore', undefined),
    );

    cleanup();
    session.current = userWith('drive.read', 'drive.write', 'drive.manage');
    del.mockResolvedValue({});
    renderAt('/drive/arquivos?ver=lixeira');
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar de vez' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/drive/files/file-1'));
  });
});

describe('the folder model', () => {
  it('shows the model as a tree, adds a folder inside one, and applies it with "Sincronizar pastas"', async () => {
    get.mockResolvedValue({
      nodes: [
        {
          id: 'n-1',
          parentId: null,
          name: 'Comercial',
          kind: 'folder',
          department: 'comercial',
          position: 0,
        },
        {
          id: 'n-2',
          parentId: 'n-1',
          name: 'Clientes',
          kind: 'clients',
          department: 'comercial',
          position: 0,
        },
        {
          id: 'n-3',
          parentId: 'n-2',
          name: 'Propostas',
          kind: 'folder',
          department: 'comercial',
          position: 0,
        },
      ],
    });
    post.mockImplementation((path: string) =>
      path === '/drive/sync'
        ? Promise.resolve({ foldersCreated: 3, foldersRenamed: 1, clients: 2 })
        : Promise.resolve({ node: {} }),
    );
    renderAt('/administracao/drive');
    expect(await screen.findByLabelText('Nome de Clientes')).toBeTruthy();
    expect(screen.getByText('uma pasta por cliente')).toBeTruthy();
    expect(screen.getByText('dentro de cada cliente')).toBeTruthy();

    const row = (screen.getByLabelText('Nome de Comercial').closest('.drive-template-row') ??
      document.body) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Adicionar dentro' }));
    fireEvent.change(within(row).getByLabelText('Nova pasta dentro de Comercial'), {
      target: { value: 'Contratos Fechados' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Adicionar' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/drive/template', {
        parentId: 'n-1',
        name: 'Contratos Fechados',
        kind: 'folder',
        department: 'comercial',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar pastas' }));
    expect(
      await screen.findByText('3 pastas criadas, 1 renomeada, para 2 clientes ativos.'),
    ).toBeTruthy();
  });
});

describe('when a request fails', () => {
  /** The scripted API, except for the paths that match: those fail. */
  function failOn(match: (path: string) => boolean, error: unknown) {
    const answer = get.getMockImplementation()!;
    get.mockImplementation((path: string) => (match(path) ? Promise.reject(error) : answer(path)));
  }

  it('does not call a folder empty because its listing failed', async () => {
    failOn((path) => path === '/drive/folders/f-mkt', new ApiError(500, {}));
    renderAt();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar os arquivos desta pasta: o servidor teve um problema \(erro 500\)/,
    );
    // The subfolders come from the tree, which answered; the files are "—", not "Pasta vazia".
    const list = screen.getByRole('table');
    expect(within(list).getByRole('button', { name: 'Mídia' })).toBeTruthy();
    expect(within(list).getByLabelText('Arquivos indisponíveis').textContent).toBe('—');
    expect(screen.queryByText(/Pasta vazia/)).toBeNull();

    // And in the grid, which has no empty text of its own.
    cleanup();
    localStorage.setItem('wings.drive.view', 'grid');
    renderAt();
    expect(await screen.findByLabelText('Arquivos indisponíveis')).toBeTruthy();
  });

  it('says the folders could not be loaded instead of "Nenhuma pasta liberada" or an empty folder', async () => {
    failOn((path) => path === '/drive/tree', new TypeError('Failed to fetch'));
    renderAt();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar as pastas do Drive: sem conexão com o servidor/,
    );
    expect(screen.queryByText(/Nenhuma pasta do Drive está liberada/)).toBeNull();
    expect(screen.queryByText(/Pasta vazia/)).toBeNull();
    expect(screen.getByLabelText('Arquivos indisponíveis')).toBeTruthy();
  });

  it('shows "—" for a search that failed, not "0 arquivos" or "Nada encontrado"', async () => {
    failOn((path) => path.startsWith('/drive/search'), new ApiError(500, {}));
    renderAt();
    const search = await screen.findByRole('search', { name: 'Busca no Drive' });
    fireEvent.change(within(search).getByLabelText('Busca'), { target: { value: 'roteiro' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar a busca/,
    );
    expect(screen.queryByText(/arquivos? encontrados?/)).toBeNull();
    expect(screen.queryByText('Nada encontrado.')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('—');
  });

  it('does not call the trash empty when it could not be read', async () => {
    failOn((path) => path === '/drive/trash', new ApiError(403, {}));
    renderAt('/drive/arquivos?ver=lixeira');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar a lixeira: você não tem permissão/,
    );
    expect(screen.queryByText('A lixeira está vazia.')).toBeNull();
  });

  it('keeps saying "A lixeira está vazia." when it answered with nothing', async () => {
    renderAt('/drive/arquivos?ver=lixeira');
    expect(await screen.findByText('A lixeira está vazia.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why the folder model could not load', async () => {
    failOn((path) => path === '/drive/template', new ApiError(500, {}));
    renderAt('/administracao/drive');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar o modelo de pastas: o servidor teve um problema/,
    );
  });

  it('says the earlier versions could not be listed, instead of showing none', async () => {
    files = [fileOf({ version: 2 })];
    failOn((path) => path.endsWith('/versions'), new ApiError(500, {}));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Roteiro.pdf' }));
    expect(await screen.findByText(/Não foi possível carregar as versões anteriores/)).toBeTruthy();
    expect(screen.queryByText('Versões anteriores')).toBeNull();
  });
});
