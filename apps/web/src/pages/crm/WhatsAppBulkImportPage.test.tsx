import type { WaBulkImport, WaBulkItem } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { WhatsAppBulkImportPage } from './WhatsAppBulkImportPage.js';

/**
 * WhatsApp → Importar em lote (Admin Master): the exports are read in the browser, each one is
 * paired with a deal by the API, the Admin sees a preview, corrects or skips, confirms with the
 * name of the Wings, and only then each paired conversation is written, one at a time. The lote
 * client is replaced by a small in-memory server; the file reading (`conversationFilesOf`,
 * `exportTextOf`) is the real one.
 */

const { state, api } = vi.hoisted(() => ({
  state: { permissions: { 'whatsapp.import_bulk': 'all' } as Record<string, string> },
  api: {
    create: vi.fn(),
    get: vi.fn(),
    addItem: vi.fn(),
    patchItem: vi.fn(),
    start: vi.fn(),
    applyItem: vi.fn(),
    undo: vi.fn(),
    discard: vi.fn(),
  },
}));

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { id: 'e1', role: 'admin_master', permissions: state.permissions } }),
  hasPermission: (session: { permissions: Record<string, string> } | undefined, key: string) =>
    Boolean(session?.permissions[key]),
  permissionScope: (session: { permissions: Record<string, string> } | undefined, key: string) =>
    session?.permissions[key],
}));

vi.mock('../../api/whatsapp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/whatsapp.js')>()),
  bulkImports: {
    ...api,
    reportUrl: (id: string) => `/api/whatsapp/bulk-imports/${id}/report`,
  },
}));

const BULK_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const LEAD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEAD_FIXED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT = '19/10/2026 09:12 - Contato Teste: Oi\n19/10/2026 09:13 - Wings Company: Olá';

const item = (position: number, over: Partial<WaBulkItem> = {}): WaBulkItem => ({
  id: `i${position}`,
  position,
  fileName: `Conversa ${position}.txt`,
  byteSize: 100 + position,
  platform: 'android',
  contactName: `Contato ${position}`,
  participants: [
    { name: `Contato ${position}`, messages: 4 },
    { name: 'Wings Company', messages: 3 },
  ],
  leadId: LEAD_A,
  leadName: `Negociação ${position}`,
  match: 'telefone',
  candidates: 1,
  messages: 7,
  newMessages: 5,
  existingMessages: 2,
  first: '2026-10-01T15:00:00.000Z',
  last: '2026-10-18T15:00:00.000Z',
  state: 'pendente',
  error: null,
  batchId: null,
  ...over,
});

const bulk = (over: Partial<WaBulkImport> = {}): WaBulkImport => ({
  id: BULK_ID,
  source: 'tela',
  state: 'previa',
  ourName: null,
  suggestedOurName: 'Wings Company',
  hasNameMap: false,
  createdAt: '2026-10-19T14:00:00.000Z',
  createdByName: 'Admin Teste',
  appliedAt: null,
  undoneAt: null,
  items: [],
  ...over,
});

const chat = (n: number, text = CHAT) =>
  new File([text], `Conversa ${n}.txt`, { type: 'text/plain' });

/** The in-memory server behind the stubbed lote client; each test sets what it needs. */
let lote: WaBulkImport;
const server = {
  pairing: {} as Record<string, Partial<WaBulkItem>>,
  suggested: 'Wings Company' as string | null,
  startError: null as unknown,
  applyError: {} as Record<string, unknown>,
  applyOutcome: {} as Record<string, Partial<WaBulkItem>>,
};
/** What the screen asked of the server, in order (reads of the lote excluded). */
const order: string[] = [];

const copy = (): WaBulkImport => ({ ...lote, items: [...lote.items] });
const setItem = (done: WaBulkItem) => {
  lote = { ...lote, items: lote.items.map((i) => (i.id === done.id ? done : i)) };
  return done;
};

beforeEach(() => {
  state.permissions = { 'whatsapp.import_bulk': 'all' };
  server.pairing = {};
  server.suggested = 'Wings Company';
  server.startError = null;
  server.applyError = {};
  server.applyOutcome = {};
  order.length = 0;
  lote = bulk();
  for (const fn of Object.values(api)) fn.mockReset();

  api.create.mockImplementation(async (map?: string) => {
    lote = bulk({ hasNameMap: map !== undefined, suggestedOurName: server.suggested });
    return copy();
  });
  api.get.mockImplementation(async () => ({ ...copy(), suggestedOurName: server.suggested }));
  api.addItem.mockImplementation(
    async (_id: string, input: { fileName: string; byteSize: number; text: string }) => {
      const made = item(lote.items.length + 1, {
        fileName: input.fileName,
        byteSize: input.byteSize,
        ...server.pairing[input.fileName],
      });
      lote = { ...lote, items: [...lote.items, made] };
      return made;
    },
  );
  api.patchItem.mockImplementation(
    async (_id: string, itemId: string, patch: { leadId: string } | { skip: boolean }) => {
      order.push(`patch ${itemId} ${JSON.stringify(patch)}`);
      const current = lote.items.find((i) => i.id === itemId)!;
      if ('skip' in patch)
        return setItem({ ...current, state: patch.skip ? 'pulada' : 'pendente' });
      return setItem({
        ...current,
        leadId: patch.leadId,
        leadName: 'Negociação Corrigida',
        match: 'manual',
      });
    },
  );
  api.start.mockImplementation(async (_id: string, ourName: string) => {
    order.push(`start ${ourName}`);
    if (server.startError) throw server.startError;
    lote = {
      ...lote,
      state: 'gravando',
      ourName,
      items: lote.items.map((i) =>
        i.leadId || i.state !== 'pendente' ? i : { ...i, state: 'pulada', error: 'sem_par' },
      ),
    };
    return copy();
  });
  api.applyItem.mockImplementation(async (_id: string, row: WaBulkItem, file: File) => {
    order.push(`apply ${row.id} ${file.name}`);
    const failure = server.applyError[row.id];
    if (failure) throw failure;
    return setItem({
      ...row,
      state: 'gravada',
      batchId: `batch-${row.id}`,
      ...server.applyOutcome[row.id],
    });
  });
  api.undo.mockImplementation(async (_id: string, itemId?: string) => {
    order.push(itemId ? `undo ${itemId}` : 'undo lote');
    lote = {
      ...lote,
      state: itemId ? lote.state : 'desfeito',
      items: lote.items.map((i) =>
        i.state === 'gravada' && (!itemId || i.id === itemId) ? { ...i, state: 'desfeita' } : i,
      ),
    };
    return copy();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Where() {
  const where = useLocation();
  return <span data-testid="where">{`${where.pathname}${where.search}`}</span>;
}

function show(path = '/crm-vendas/whatsapp/importar-lote') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/crm-vendas/whatsapp/importar-lote"
          element={
            <>
              <WhatsAppBulkImportPage />
              <Where />
            </>
          }
        />
        <Route path="/crm-vendas/whatsapp" element={<p>caixa de entrada</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const pick = (files: File[], map?: File) => {
  fireEvent.change(screen.getByLabelText('Conversas'), { target: { files } });
  if (map)
    fireEvent.change(screen.getByLabelText(/Mapa nome→telefone/), { target: { files: [map] } });
};
const readButton = () => screen.getByRole('button', { name: 'Ler conversas' }) as HTMLButtonElement;

/** Picks the files, reads them and waits until the whole lote is on screen. */
async function readFiles(files: File[], map?: File) {
  pick(files, map);
  fireEvent.click(readButton());
  await screen.findByRole('table');
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
}

const writeButton = () =>
  screen.getByRole('button', { name: /^Gravar \d+ conversa\(s\)$/ }) as HTMLButtonElement;
const nameSelect = () => screen.getByRole('combobox') as HTMLSelectElement;
const rowOf = (fileName: string) => {
  const row = screen.getByText(fileName).closest('tr');
  if (!row) throw new Error(`no row for ${fileName}`);
  return within(row);
};
const cellsOf = (fileName: string) =>
  rowOf(fileName)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('access', () => {
  it('shows the refusal, and no form, to someone without whatsapp.import_bulk', () => {
    state.permissions = { 'leads.whatsapp': 'all' };
    show();

    expect(screen.getByText('Só o Admin Master importa conversas em lote.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ler conversas' })).toBeNull();
    expect(screen.queryByLabelText('Conversas')).toBeNull();
    expect(Object.values(api).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('shows the form and the way back to WhatsApp to the Admin Master', () => {
    show();

    expect(screen.getByRole('heading', { name: 'Importar em lote' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao WhatsApp' }).getAttribute('href')).toBe(
      '/crm-vendas/whatsapp',
    );
  });
});

describe('reading the files', () => {
  it('keeps "Ler conversas" disabled until a file is chosen', () => {
    show();
    expect(readButton().disabled).toBe(true);
    pick([chat(1)]);
    expect(readButton().disabled).toBe(false);
  });

  it('opens a lote, sends each conversation in turn and reads the lote back, keeping its id in the address', async () => {
    show();
    await readFiles([chat(1), chat(2)]);

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith(undefined);
    expect(api.addItem.mock.calls).toEqual([
      [BULK_ID, { fileName: 'Conversa 1.txt', byteSize: chat(1).size, text: CHAT }],
      [BULK_ID, { fileName: 'Conversa 2.txt', byteSize: chat(2).size, text: CHAT }],
    ]);
    expect(api.get).toHaveBeenCalledWith(BULK_ID);
    expect(screen.getByTestId('where').textContent).toBe(
      `/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`,
    );
    expect(
      screen.getByText(/Lote 0a1b2c3d · 2 conversas · 2 a gravar · 0 gravadas\./),
    ).toBeTruthy();
    // Nothing is written before the Admin confirms.
    expect(api.start).not.toHaveBeenCalled();
    expect(api.applyItem).not.toHaveBeenCalled();
  });

  it('sends the text of the optional name map when one is chosen', async () => {
    show();
    const map = new File(['Contato Teste;11900000001'], 'mapa.csv', { type: 'text/csv' });
    await readFiles([chat(1)], map);

    expect(api.create).toHaveBeenCalledWith('Contato Teste;11900000001');
  });

  it('opens a .zip of exports in the browser and sends each export as its own conversation', async () => {
    show();
    const bundle = new File(
      [zipSync({ 'a/Primeira.txt': strToU8(CHAT), 'a/Segunda.txt': strToU8('texto dois') })],
      'Lote.zip',
      { type: 'application/zip' },
    );
    await readFiles([bundle]);

    const sent = api.addItem.mock.calls.map(([, input]) => input) as {
      fileName: string;
      text: string;
    }[];
    expect(sent.map((s) => s.fileName).sort()).toEqual(['Primeira.txt', 'Segunda.txt']);
    expect(Object.fromEntries(sent.map((s) => [s.fileName, s.text]))).toEqual({
      'Primeira.txt': CHAT,
      'Segunda.txt': 'texto dois',
    });
  });

  it('shows the progress of the reading and the conversations already read', async () => {
    const second = deferred<WaBulkItem>();
    const first = api.addItem.getMockImplementation()!;
    api.addItem.mockImplementationOnce(first).mockImplementationOnce(() => second.promise);
    show();
    pick([chat(1), chat(2)]);
    fireEvent.click(readButton());

    expect(await screen.findByText('Lendo 2 de 2…')).toBeTruthy();
    // The first row is already on screen while the second is still being read.
    expect(rowOf('Conversa 1.txt')).toBeTruthy();
    expect(screen.queryByText('Conversa 2.txt')).toBeNull();

    second.resolve(item(2));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('says no conversation was found, and opens no lote, when the files hold none', async () => {
    show();
    pick([new File(['x'], 'foto.jpg', { type: 'image/jpeg' })]);
    fireEvent.click(readButton());

    await screen.findByText('Nenhuma conversa exportada nos arquivos escolhidos.');
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the preview', () => {
  it('shows per conversation the file, the paired deal and how it was found, new, existing and the period', async () => {
    server.pairing = {
      'Conversa 1.txt': { leadId: LEAD_A, leadName: 'Negociação Um', match: 'mapa' },
    };
    show();
    await readFiles([chat(1)]);

    const row = rowOf('Conversa 1.txt');
    const link = row.getByRole('link', { name: 'Negociação Um' });
    expect(link.getAttribute('href')).toBe(`/crm-vendas/negociacoes/${LEAD_A}`);
    expect(cellsOf('Conversa 1.txt')).toEqual([
      'Conversa 1.txt',
      'Negociação Um · mapa nome→telefone',
      '5',
      '2',
      '01/10/2026 a 18/10/2026',
      'a gravar',
      'Corrigir Pular',
    ]);
  });

  it.each([
    ['telefone', 'telefone na conversa'],
    ['mapa', 'mapa nome→telefone'],
    ['nome', 'nome do contato'],
    ['manual', 'corrigido'],
  ] as const)('says a pair found by "%s" as "%s"', async (match, label) => {
    server.pairing = { 'Conversa 1.txt': { match } };
    show();
    await readFiles([chat(1)]);
    expect(rowOf('Conversa 1.txt').getByText(new RegExp(`· ${label}$`))).toBeTruthy();
  });

  it('says "sem par" when no deal fits, with how many looked alike, and cannot be written', async () => {
    server.pairing = {
      'Conversa 1.txt': { leadId: null, leadName: null, match: null, candidates: 0 },
      'Conversa 2.txt': { leadId: null, leadName: null, match: null, candidates: 3 },
      'Conversa 3.txt': {},
    };
    show();
    await readFiles([chat(1), chat(2), chat(3)]);

    expect(cellsOf('Conversa 1.txt')[1]).toBe('sem par');
    expect(cellsOf('Conversa 2.txt')[1]).toBe('sem par (3 parecidas)');
    expect(rowOf('Conversa 1.txt').queryByRole('link')).toBeNull();
    // Only the paired one counts to be written.
    expect(screen.getByText(/3 conversas · 1 a gravar · 0 gravadas\./)).toBeTruthy();
    expect(writeButton().textContent).toBe('Gravar 1 conversa(s)');
  });

  it('shows "—" for a missing period and for the counts of a conversation that failed, with the reason', async () => {
    server.pairing = {
      'Conversa 1.txt': { first: null, last: null },
      'Conversa 2.txt': { state: 'falhou', error: 'unknown_side' },
      'Conversa 3.txt': { state: 'falhou', error: 'erro_novo' },
    };
    show();
    await readFiles([chat(1), chat(2), chat(3)]);

    expect(cellsOf('Conversa 1.txt')[4]).toBe('—');
    expect(cellsOf('Conversa 2.txt').slice(2, 6)).toEqual([
      '—',
      '—',
      '01/10/2026 a 18/10/2026',
      'falhou · o nome da Wings não aparece nesta conversa',
    ]);
    // A reason the screen has no words for is shown as the server gave it, never dropped.
    expect(cellsOf('Conversa 3.txt')[5]).toBe('falhou · erro_novo');
  });

  it('asks which name is the Wings, with each name once, and preselects the one the server guessed', async () => {
    show();
    await readFiles([chat(1), chat(2)]);

    const options = within(nameSelect())
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Escolha', 'Contato 1', 'Wings Company', 'Contato 2']);
    expect(nameSelect().value).toBe('Wings Company');
    expect(writeButton().disabled).toBe(false);
  });

  it('keeps "Gravar" disabled until a name is chosen when the server had no guess', async () => {
    server.suggested = null;
    show();
    await readFiles([chat(1)]);

    expect(nameSelect().value).toBe('');
    expect(writeButton().disabled).toBe(true);
    fireEvent.change(nameSelect(), { target: { value: 'Wings Company' } });
    expect(writeButton().disabled).toBe(false);
  });

  it('keeps "Gravar" disabled when nothing in the lote can be written', async () => {
    server.pairing = { 'Conversa 1.txt': { leadId: null, leadName: null, match: null } };
    show();
    await readFiles([chat(1)]);
    expect(writeButton().disabled).toBe(true);
  });
});

describe('correcting a pair and skipping', () => {
  it('corrects the pair from a pasted deal link: PATCH with the id found in it, and the row shows the new deal', async () => {
    server.pairing = {
      'Conversa 1.txt': { leadId: null, leadName: null, match: null, candidates: 2 },
    };
    show();
    await readFiles([chat(1)]);

    fireEvent.click(rowOf('Conversa 1.txt').getByRole('button', { name: 'Corrigir' }));
    const field = screen.getByLabelText('Link ou id da negociação');
    const use = screen.getByRole('button', { name: 'Usar' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'não é um link' } });
    expect(use.disabled).toBe(true);
    fireEvent.change(field, {
      target: { value: `https://sistema.teste/crm-vendas/negociacoes/${LEAD_FIXED}` },
    });
    expect(use.disabled).toBe(false);
    fireEvent.click(use);

    await waitFor(() =>
      expect(api.patchItem).toHaveBeenCalledWith(BULK_ID, 'i1', { leadId: LEAD_FIXED }),
    );
    const link = await screen.findByRole('link', { name: 'Negociação Corrigida' });
    expect(link.parentElement?.textContent).toContain('corrigido');
    expect(screen.queryByLabelText('Link ou id da negociação')).toBeNull();
    // The corrected pair now counts to be written.
    expect(writeButton().textContent).toBe('Gravar 1 conversa(s)');
  });

  it('accepts the bare id of the deal too', async () => {
    show();
    await readFiles([chat(1)]);

    fireEvent.click(screen.getByRole('button', { name: 'Corrigir' }));
    fireEvent.change(screen.getByLabelText('Link ou id da negociação'), {
      target: { value: LEAD_FIXED.toUpperCase() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Usar' }));

    await waitFor(() =>
      expect(api.patchItem).toHaveBeenCalledWith(BULK_ID, 'i1', {
        leadId: LEAD_FIXED.toUpperCase(),
      }),
    );
  });

  it('skips a conversation (PATCH skip: true), takes it out of the count and offers to include it again', async () => {
    show();
    await readFiles([chat(1), chat(2)]);

    fireEvent.click(rowOf('Conversa 1.txt').getByRole('button', { name: 'Pular' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(BULK_ID, 'i1', { skip: true }));
    expect(await screen.findByText('pulada')).toBeTruthy();
    expect(screen.getByText(/2 conversas · 1 a gravar/)).toBeTruthy();
    expect(writeButton().textContent).toBe('Gravar 1 conversa(s)');

    fireEvent.click(rowOf('Conversa 1.txt').getByRole('button', { name: 'Incluir' }));
    await waitFor(() =>
      expect(api.patchItem).toHaveBeenLastCalledWith(BULK_ID, 'i1', { skip: false }),
    );
    await waitFor(() => expect(writeButton().textContent).toBe('Gravar 2 conversa(s)'));
  });

  it('shows why a correction did not go through and leaves the row as it was', async () => {
    api.patchItem.mockRejectedValueOnce(new ApiError(500, {}));
    show();
    await readFiles([chat(1)]);

    fireEvent.click(screen.getByRole('button', { name: 'Pular' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('— o servidor teve um problema (erro 500)');
    expect(cellsOf('Conversa 1.txt')[5]).toBe('a gravar');
    expect(writeButton().textContent).toBe('Gravar 1 conversa(s)');
  });
});

describe('confirming', () => {
  it('asks for the Wings name, then writes each paired conversation in order, its own file with it', async () => {
    server.pairing = {
      'Conversa 2.txt': { leadId: null, leadName: null, match: null },
      'Conversa 3.txt': { leadId: LEAD_B },
    };
    show();
    const files = [chat(1), chat(2), chat(3), chat(4)];
    await readFiles(files);
    fireEvent.click(rowOf('Conversa 4.txt').getByRole('button', { name: 'Pular' }));
    await waitFor(() => expect(cellsOf('Conversa 4.txt')[5]).toBe('pulada'));
    order.length = 0;

    fireEvent.change(nameSelect(), { target: { value: 'Contato 1' } });
    fireEvent.change(nameSelect(), { target: { value: 'Wings Company' } });
    fireEvent.click(writeButton());

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // Confirmed first, then the paired ones in the list's order; "sem par" and skipped never.
    expect(order).toEqual([
      'start Wings Company',
      'apply i1 Conversa 1.txt',
      'apply i3 Conversa 3.txt',
    ]);
    expect(api.start).toHaveBeenCalledWith(BULK_ID, 'Wings Company');
    expect(api.applyItem.mock.calls.map(([, row, file]) => [row.id, file])).toEqual([
      ['i1', files[0]],
      ['i3', files[2]],
    ]);
    // The screen shows what the server now says.
    expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada');
    expect(cellsOf('Conversa 2.txt')[5]).toBe('pulada · sem negociação');
    expect(cellsOf('Conversa 3.txt')[5]).toBe('gravada');
    expect(cellsOf('Conversa 4.txt')[5]).toBe('pulada');
    expect(screen.getByText(/4 conversas · 0 a gravar · 2 gravadas\./)).toBeTruthy();
    // Confirmed: no more name question, nothing left to write.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Gravar/ })).toBeNull();
  });

  it('shows the progress and blocks a second click while it writes', async () => {
    const slow = deferred<WaBulkItem>();
    api.applyItem.mockImplementationOnce(() => slow.promise);
    show();
    await readFiles([chat(1), chat(2)]);

    fireEvent.click(writeButton());

    expect(await screen.findByText('Gravando 1 de 2…')).toBeTruthy();
    expect(writeButton().disabled).toBe(true);
    // Confirmed: the pairs can no longer be corrected or skipped.
    expect(screen.queryByRole('button', { name: 'Pular' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Corrigir' })).toBeNull();
    expect(api.start).toHaveBeenCalledTimes(1);

    slow.resolve(item(1, { state: 'gravada' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(api.applyItem).toHaveBeenCalledTimes(2);
  });

  it('shows the answer of the server when a conversation fails, and does not try it again', async () => {
    server.applyOutcome = { i1: { state: 'falhou', error: 'lead_without_phone' } };
    show();
    await readFiles([chat(1), chat(2)]);
    fireEvent.click(writeButton());

    await waitFor(() => expect(cellsOf('Conversa 2.txt')[5]).toBe('gravada'));
    expect(cellsOf('Conversa 1.txt')[5]).toBe('falhou · a negociação não tem telefone');
    expect(api.applyItem).toHaveBeenCalledTimes(2);
    // Nothing is left to write: a failed conversation is not offered again.
    expect(screen.queryByRole('button', { name: /^Gravar/ })).toBeNull();
  });

  it('says why the lote could not be confirmed and writes nothing', async () => {
    server.startError = new ApiError(409, {
      error: 'lote_already_applied',
      message: 'Este lote já foi confirmado.',
    });
    show();
    await readFiles([chat(1)]);
    fireEvent.click(writeButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('— este lote já foi confirmado');
    expect(api.applyItem).not.toHaveBeenCalled();
  });

  it('stops at the conversation that failed, keeps what was written, and resumes with the rest without confirming again', async () => {
    server.applyError = { i2: new ApiError(500, {}) };
    show();
    await readFiles([chat(1), chat(2), chat(3)]);
    fireEvent.click(writeButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('— o servidor teve um problema (erro 500)');
    expect(order).toEqual([
      'start Wings Company',
      'apply i1 Conversa 1.txt',
      'apply i2 Conversa 2.txt',
    ]);
    expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada');
    expect(cellsOf('Conversa 2.txt')[5]).toBe('a gravar');
    expect(cellsOf('Conversa 3.txt')[5]).toBe('a gravar');
    expect(screen.getByText(/3 conversas · 2 a gravar · 1 gravadas\./)).toBeTruthy();

    // The same button goes on: the lote is already confirmed, and the written one stays as it is.
    server.applyError = {};
    order.length = 0;
    expect(writeButton().textContent).toBe('Gravar 2 conversa(s)');
    fireEvent.click(writeButton());

    await waitFor(() => expect(cellsOf('Conversa 3.txt')[5]).toBe('gravada'));
    expect(order).toEqual(['apply i2 Conversa 2.txt', 'apply i3 Conversa 3.txt']);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Gravar/ })).toBeNull();
  });
});

describe('resuming a lote after the tab closed', () => {
  const writing = (items: WaBulkItem[]) =>
    bulk({ state: 'gravando', ourName: 'Wings Company', items });

  it('offers to open the lote of the address instead of a new pick', async () => {
    lote = writing([item(1, { state: 'gravada' })]);
    show(`/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`);

    expect(screen.queryByLabelText('Conversas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' }));

    await screen.findByRole('table');
    expect(api.get).toHaveBeenCalledWith(BULK_ID);
    expect(api.create).not.toHaveBeenCalled();
    expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada');
  });

  it('asks for the same files again, and goes on only with the ones that match by name and size', async () => {
    const one = chat(1);
    const two = chat(2);
    lote = writing([
      item(1, { fileName: one.name, byteSize: one.size, state: 'gravada' }),
      item(2, { fileName: two.name, byteSize: two.size }),
    ]);
    show(`/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' }));
    await screen.findByRole('table');

    expect(
      screen.getByText(/1 conversa\(s\) esperam o arquivo: escolha de novo os mesmos arquivos/),
    ).toBeTruthy();
    // The name was asked before: the question does not come back, and the button is enabled.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(writeButton().textContent).toBe('Gravar 1 conversa(s)');

    // Same name, other size: it is not the same file.
    const other = chat(2, `${CHAT}\numa linha a mais`);
    fireEvent.change(screen.getByLabelText('Escolher de novo os arquivos'), {
      target: { files: [other] },
    });
    await waitFor(() => expect(screen.getByLabelText('Escolher de novo os arquivos')).toBeTruthy());
    expect(screen.getByText(/1 conversa\(s\) esperam o arquivo/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Escolher de novo os arquivos'), {
      target: { files: [two] },
    });
    await waitFor(() => expect(screen.queryByText(/esperam o arquivo/)).toBeNull());
    fireEvent.click(writeButton());

    await waitFor(() => expect(cellsOf('Conversa 2.txt')[5]).toBe('gravada'));
    // Resumed: not confirmed again, only the pending one written, with the file chosen again.
    expect(api.start).not.toHaveBeenCalled();
    expect(api.applyItem.mock.calls.map(([, row, file]) => [row.id, file])).toEqual([['i2', two]]);
  });

  it('never writes a conversation whose file is not in this tab', async () => {
    lote = bulk({ items: [item(1)], suggestedOurName: 'Wings Company' });
    show(`/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' }));
    await screen.findByRole('table');
    await waitFor(() => expect(nameSelect().value).toBe('Wings Company'));

    fireEvent.click(writeButton());

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(api.applyItem).not.toHaveBeenCalled();
    expect(cellsOf('Conversa 1.txt')[5]).toBe('a gravar');
  });

  it('shows "—" and the reason, not an empty table, when the lote cannot be opened, and lets it try again', async () => {
    lote = writing([item(1)]);
    api.get.mockRejectedValueOnce(new ApiError(500, {}));
    show(`/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '—Não foi possível carregar o lote: o servidor teve um problema (erro 500).',
    );
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('discarding a preview', () => {
  it('asks, then discards the lote and goes back to picking files', async () => {
    show();
    await readFiles([chat(1)]);
    api.discard.mockResolvedValue(undefined);
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Descartar prévia' }));

    expect(ask).toHaveBeenCalledWith('Descartar esta prévia? Nada foi gravado nas negociações.');
    await waitFor(() => expect(api.discard).toHaveBeenCalledWith(BULK_ID));
    expect(await screen.findByRole('button', { name: 'Ler conversas' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps the preview when the Admin says no, and is not offered once something was written', async () => {
    show();
    await readFiles([chat(1)]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Descartar prévia' }));
    expect(api.discard).not.toHaveBeenCalled();
    expect(screen.getByRole('table')).toBeTruthy();

    fireEvent.click(writeButton());
    await waitFor(() => expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada'));
    expect(screen.queryByRole('button', { name: 'Descartar prévia' })).toBeNull();
  });
});

describe('undoing', () => {
  const written = async () => {
    show();
    await readFiles([chat(1), chat(2)]);
    fireEvent.click(writeButton());
    await waitFor(() => expect(cellsOf('Conversa 2.txt')[5]).toBe('gravada'));
  };

  it('offers to undo the lote only once something was written', async () => {
    show();
    await readFiles([chat(1)]);
    expect(screen.queryByRole('button', { name: 'Desfazer o lote' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull();
  });

  it('asks before undoing the whole lote, and does nothing if the Admin says no', async () => {
    await written();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer o lote' }));

    expect(ask).toHaveBeenCalledWith('Desfazer as 2 conversas gravadas deste lote?');
    expect(api.undo).not.toHaveBeenCalled();
    expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada');
  });

  it('undoes the whole lote after the Admin agrees, and shows every conversation undone', async () => {
    await written();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer o lote' }));

    await waitFor(() => expect(cellsOf('Conversa 1.txt')[5]).toBe('desfeita'));
    expect(cellsOf('Conversa 2.txt')[5]).toBe('desfeita');
    expect(api.undo).toHaveBeenCalledWith(BULK_ID, undefined);
    expect(screen.queryByRole('button', { name: 'Desfazer o lote' })).toBeNull();
  });

  it('undoes one conversation, and only that one', async () => {
    await written();
    const ask = vi.spyOn(window, 'confirm');

    fireEvent.click(rowOf('Conversa 1.txt').getByRole('button', { name: 'Desfazer' }));

    await waitFor(() => expect(cellsOf('Conversa 1.txt')[5]).toBe('desfeita'));
    expect(api.undo).toHaveBeenCalledWith(BULK_ID, 'i1');
    expect(cellsOf('Conversa 2.txt')[5]).toBe('gravada');
    expect(ask).not.toHaveBeenCalled();
    // The other one can still be undone, and the lote button counts what is left.
    expect(screen.getByRole('button', { name: 'Desfazer o lote' })).toBeTruthy();
  });

  it('shows why an undo did not go through', async () => {
    await written();
    api.undo.mockRejectedValueOnce(
      new ApiError(409, { error: 'already_undone', message: 'Já foi desfeita.' }),
    );

    fireEvent.click(rowOf('Conversa 1.txt').getByRole('button', { name: 'Desfazer' }));

    expect((await screen.findByRole('alert')).textContent).toBe('— já foi desfeita');
    expect(cellsOf('Conversa 1.txt')[5]).toBe('gravada');
  });
});

describe('the report', () => {
  it('links the lote’s report (ids and counts only) once the lote is open', async () => {
    show();
    await readFiles([chat(1)]);

    expect(screen.getByRole('link', { name: 'Baixar relatório' }).getAttribute('href')).toBe(
      `/api/whatsapp/bulk-imports/${BULK_ID}/report`,
    );
  });

  it('has no report link before a lote exists', () => {
    show();
    expect(screen.queryByRole('link', { name: 'Baixar relatório' })).toBeNull();
  });
});

describe('when the lote cannot be loaded', () => {
  it('shows "—" and the reason, never an empty table, when the lote cannot be opened', async () => {
    api.create.mockRejectedValue(new ApiError(500, {}));
    show();
    pick([chat(1)]);
    fireEvent.click(readButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '—Não foi possível carregar o lote: o servidor teve um problema (erro 500).',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/0 conversas/)).toBeNull();
    expect(api.addItem).not.toHaveBeenCalled();
    // The form stays, so the Admin can try again.
    expect(readButton().disabled).toBe(false);
  });

  it('says the connection is down when the request never got an answer', async () => {
    api.create.mockRejectedValue(new TypeError('fetch failed'));
    show();
    pick([chat(1)]);
    fireEvent.click(readButton());

    expect((await screen.findByRole('alert')).textContent).toContain('sem conexão com o servidor');
  });

  it('says the session is over on a 401', async () => {
    api.create.mockRejectedValue(new ApiError(401, {}));
    show();
    pick([chat(1)]);
    fireEvent.click(readButton());

    expect((await screen.findByRole('alert')).textContent).toContain('sua sessão expirou');
  });

  it('keeps the way back to the lote when the first conversation fails to go in', async () => {
    api.addItem.mockRejectedValueOnce(new ApiError(500, {}));
    show();
    pick([chat(1)]);
    fireEvent.click(readButton());

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível carregar o lote: o servidor teve um problema (erro 500).',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir o lote 0a1b2c3d' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe(
      `/crm-vendas/whatsapp/importar-lote?lote=${BULK_ID}`,
    );
  });

  it('shows what was read and the reason when a later conversation fails to go in', async () => {
    const real = api.addItem.getMockImplementation()!;
    api.addItem.mockImplementationOnce(real).mockRejectedValueOnce(new ApiError(500, {}));
    show();
    pick([chat(1), chat(2)]);
    fireEvent.click(readButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('— o servidor teve um problema (erro 500)');
    expect(rowOf('Conversa 1.txt')).toBeTruthy();
    expect(screen.queryByText('Conversa 2.txt')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('says why a .zip with no conversation inside could not be read', async () => {
    show();
    const broken = new File([new Uint8Array([1, 2, 3, 4])], 'Lote.zip', {
      type: 'application/zip',
    });
    pick([broken]);
    fireEvent.click(readButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar o lote');
    expect(screen.queryByRole('table')).toBeNull();
  });
});
