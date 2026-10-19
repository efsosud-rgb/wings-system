import type { LeadFile, WaImportBatch, WaImportPreview } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { zipSync } from 'fflate';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportChatPanel } from './ImportChatPanel.js';

/**
 * "Importar conversa do celular": the exported chat is read in the browser, the server says what
 * it holds, the person says which name is Wings, the file is kept among the deal's files and only
 * then the messages come in. The real API client runs here against a stubbed `fetch`; only the
 * file upload (a pre-signed storage address) is replaced.
 */

const { sendLeadFile } = vi.hoisted(() => ({ sendLeadFile: vi.fn() }));

vi.mock('../../api/crm.js', () => ({
  sendLeadFile: (...args: unknown[]) => sendLeadFile(...args),
}));

const FILE_ID = '5b8a6f0e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const CHAT = '[18/10/2026 12:00:00] Wings Company: Olá!\n[18/10/2026 12:01:00] Elena Prado: Oi!';

const preview = (over: Partial<WaImportPreview> = {}): WaImportPreview => ({
  platform: 'android',
  participants: [
    { name: 'Elena Prado', messages: 7 },
    { name: 'Wings Company', messages: 5 },
  ],
  ourName: 'Wings Company',
  messages: 12,
  newMessages: 12,
  media: 0,
  skipped: 0,
  first: {
    at: '2026-10-01T15:00:00.000Z',
    author: 'Elena Prado',
    kind: 'text',
    text: 'Oi, vi o anúncio de vocês',
    file: null,
  },
  last: {
    at: '2026-10-18T15:00:00.000Z',
    author: 'Wings Company',
    kind: 'image',
    text: null,
    file: 'IMG-20261018-WA0003.jpg',
  },
  ...over,
});

const batch = (over: Partial<WaImportBatch> = {}): WaImportBatch => ({
  id: 'b-live',
  fileId: FILE_ID,
  platform: 'android',
  messages: 12,
  from: '2026-10-01T15:00:00.000Z',
  to: '2026-10-18T15:00:00.000Z',
  importedAt: '2026-10-19T14:05:00.000Z',
  importedByName: 'Vendedor Teste',
  undoneAt: null,
  undoneByName: null,
  ...over,
});

const kept = { id: 'lf1', fileId: FILE_ID, name: 'x', version: 1 } as LeadFile;

/** What the stubbed server answers; each test sets what it needs. */
const server = {
  preview: preview() as WaImportPreview | Response,
  imports: [] as WaImportBatch[],
  apply: batch() as WaImportBatch | Response,
  undo: null as Response | null,
};
const calls: { method: string; path: string; body: unknown }[] = [];
const order: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const asResponse = (value: unknown) => (value instanceof Response ? value : null);

async function fakeFetch(url: string, init: RequestInit = {}) {
  const method = init.method ?? 'GET';
  const path = url.replace(/^\/api/, '');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  if (method === 'POST' && path.endsWith('/whatsapp/imports/preview'))
    return asResponse(server.preview) ?? json({ preview: server.preview });
  if (method === 'POST' && path.endsWith('/whatsapp/imports')) {
    order.push('import');
    return asResponse(server.apply) ?? json({ import: server.apply });
  }
  if (method === 'DELETE') {
    const id = path.split('/').pop();
    server.imports = server.imports.map((b) =>
      b.id === id ? { ...b, undoneAt: '2026-10-19T16:30:00.000Z', undoneByName: 'Admin Teste' } : b,
    );
    return server.undo ?? json({ import: server.imports.find((b) => b.id === id), removed: 12 });
  }
  if (method === 'GET' && path.endsWith('/whatsapp/imports'))
    return json({ imports: server.imports });
  throw new Error(`unexpected request ${method} ${path}`);
}

const callsTo = (method: string, suffix: string) =>
  calls.filter((c) => c.method === method && c.path.endsWith(suffix));

const onClose = vi.fn();

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportChatPanel leadId="l1" onClose={onClose} />
    </QueryClientProvider>,
  );
}

const chosen = new File([CHAT], 'Conversa do WhatsApp com Elena.txt', { type: 'text/plain' });

async function choose(file: File = chosen) {
  fireEvent.change(screen.getByLabelText('Arquivo exportado'), { target: { files: [file] } });
  await screen.findByRole('group', { name: 'Qual nome é a Wings?' });
}

const importButton = (name: string | RegExp) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  calls.length = 0;
  order.length = 0;
  onClose.mockClear();
  server.preview = preview();
  server.imports = [];
  server.apply = batch();
  server.undo = null;
  sendLeadFile.mockReset();
  sendLeadFile.mockImplementation(async () => {
    order.push('upload');
    return kept;
  });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('choosing the exported file', () => {
  it('asks the server what the .txt holds and shows the counts, the first and last line', async () => {
    server.preview = preview({ messages: 12, newMessages: 10, media: 3, skipped: 1 });
    show();
    await choose();

    expect(callsTo('POST', '/imports/preview')).toEqual([
      { method: 'POST', path: '/leads/l1/whatsapp/imports/preview', body: { text: CHAT } },
    ]);
    expect(screen.getByText('Android')).toBeTruthy();
    expect(screen.getByText('12 · 2 já estão na conversa e não entram de novo')).toBeTruthy();
    expect(
      screen.getByText(
        '3 fotos, áudios ou arquivos: ficam dentro do arquivo exportado, em Arquivos',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 ignorado')).toBeTruthy();
    expect(screen.getByText(/Elena Prado: Oi, vi o anúncio de vocês$/)).toBeTruthy();
    // A line with no text names its kind instead.
    expect(screen.getByText(/Wings Company: Imagem$/)).toBeTruthy();
    expect(importButton('Importar 10 mensagens').disabled).toBe(false);
  });

  it('preselects the name the server guessed as Wings', async () => {
    show();
    await choose();

    const sides = within(screen.getByRole('group', { name: 'Qual nome é a Wings?' }));
    expect(
      (sides.getByRole('radio', { name: /Wings Company · 5 mensagens/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (sides.getByRole('radio', { name: /Elena Prado · 7 mensagens/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(importButton('Importar 12 mensagens').disabled).toBe(false);
  });

  it('keeps the import button disabled until a name is picked when the server had no guess', async () => {
    server.preview = preview({ ourName: null });
    show();
    await choose();

    const sides = within(screen.getByRole('group', { name: 'Qual nome é a Wings?' }));
    for (const radio of sides.getAllByRole('radio'))
      expect((radio as HTMLInputElement).checked).toBe(false);
    expect(importButton('Importar 12 mensagens').disabled).toBe(true);

    fireEvent.click(sides.getByRole('radio', { name: /Wings Company/ }));
    expect(importButton('Importar 12 mensagens').disabled).toBe(false);
  });

  it('has nothing to import when every message is already in the conversation', async () => {
    server.preview = preview({ newMessages: 0 });
    show();
    await choose();

    expect(importButton('Nada novo para importar').disabled).toBe(true);
  });

  it('shows the server refusal (422 with its message) and offers no import', async () => {
    server.preview = json(
      { error: 'invalid_export', message: 'Não achei mensagens neste arquivo. Exporte de novo.' },
      422,
    );
    show();
    fireEvent.change(screen.getByLabelText('Arquivo exportado'), { target: { files: [chosen] } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Não achei mensagens neste arquivo. Exporte de novo.');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Importar \d+ mensagens?$/ })).toBeNull();
  });

  it('says why a .zip without the chat could not be read, without asking the server', async () => {
    show();
    const empty = new File([zipSync({ 'IMG-1.jpg': new Uint8Array([1, 2, 3]) })], 'x.zip', {
      type: 'application/zip',
    });
    fireEvent.change(screen.getByLabelText('Arquivo exportado'), { target: { files: [empty] } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'O .zip não tem a conversa (.txt). Exporte de novo pelo WhatsApp.',
    );
    expect(callsTo('POST', '/imports/preview')).toHaveLength(0);
  });
});

describe('importing', () => {
  it('keeps the file first, then writes the messages with the chosen name and the file id', async () => {
    show();
    await choose();
    fireEvent.click(importButton('Importar 12 mensagens'));

    const status = await screen.findByRole('status');
    expect(status.textContent).toBe(
      '12 mensagens importadas, de 01/10/2026 a 18/10/2026. O arquivo ficou em Arquivos.',
    );
    expect(order).toEqual(['upload', 'import']);

    // The file goes under its own name plus the day and time of the import.
    const [{ leadId, file }] = sendLeadFile.mock.calls[0] as [{ leadId: string; file: File }];
    expect(leadId).toBe('l1');
    expect(file.name).toMatch(
      /^Conversa do WhatsApp com Elena \(importada \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.txt$/,
    );
    expect(file.type).toBe('text/plain');

    expect(callsTo('POST', '/whatsapp/imports')[0]).toEqual({
      method: 'POST',
      path: '/leads/l1/whatsapp/imports',
      body: { text: CHAT, ourName: 'Wings Company', fileId: FILE_ID },
    });
    // The preview is gone and the list asked again.
    expect(screen.queryByRole('group', { name: 'Qual nome é a Wings?' })).toBeNull();
    await waitFor(() => expect(callsTo('GET', '/whatsapp/imports')).toHaveLength(2));
  });

  it('sends the name the person picked, not the guess', async () => {
    show();
    await choose();
    fireEvent.click(screen.getByRole('radio', { name: /Elena Prado/ }));
    fireEvent.click(importButton('Importar 12 mensagens'));

    await screen.findByRole('status');
    expect((callsTo('POST', '/whatsapp/imports')[0]?.body as { ourName: string }).ourName).toBe(
      'Elena Prado',
    );
  });

  it('shows the progress of the file and then "Gravando as mensagens…"', async () => {
    let finish: (value: LeadFile) => void = () => {};
    let progress: (fraction: number) => void = () => {};
    sendLeadFile.mockImplementation(
      (input: { onProgress: (fraction: number) => void }) =>
        new Promise<LeadFile>((resolve) => {
          progress = input.onProgress;
          finish = resolve;
        }),
    );
    show();
    await choose();
    fireEvent.click(importButton('Importar 12 mensagens'));

    await screen.findByRole('button', { name: 'Guardando o arquivo… 0%' });
    act(() => progress(0.4));
    expect(importButton('Guardando o arquivo… 40%').disabled).toBe(true);
    act(() => {
      progress(1);
      finish(kept);
    });
    await screen.findByRole('status');
    expect(order).toEqual(['import']);
  });

  it('shows why the messages did not come in and keeps the preview to try again', async () => {
    server.apply = json(
      { error: 'import_failed', message: 'Esta conversa já foi importada por inteiro.' },
      409,
    );
    show();
    await choose();
    fireEvent.click(importButton('Importar 12 mensagens'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Esta conversa já foi importada por inteiro.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(importButton('Importar 12 mensagens').disabled).toBe(false);
  });

  it('does not write any message when the file could not be kept', async () => {
    sendLeadFile.mockRejectedValue(new Error('O armazenamento recusou o arquivo. Tente de novo.'));
    show();
    await choose();
    fireEvent.click(importButton('Importar 12 mensagens'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('O armazenamento recusou o arquivo. Tente de novo.');
    expect(callsTo('POST', '/whatsapp/imports')).toHaveLength(0);
  });
});

describe('the imports of the deal', () => {
  it('says "Nenhuma ainda." for a deal with no import', async () => {
    show();
    const list = await screen.findByRole('region', { name: 'Importações desta negociação' });
    await within(list).findByText('Nenhuma ainda.');
  });

  it('lists a live import with "Desfazer importação" and an undone one as "Desfeita em"', async () => {
    server.imports = [
      batch(),
      batch({
        id: 'b-old',
        messages: 1,
        undoneAt: '2026-10-19T15:00:00.000Z',
        undoneByName: 'Admin Teste',
      }),
    ];
    show();

    const list = within(
      await screen.findByRole('region', { name: 'Importações desta negociação' }),
    );
    const [live, undone] = await list.findAllByRole('listitem');
    expect(live?.textContent).toMatch(
      /12 mensagens de 01\/10\/2026 a 18\/10\/2026 · Vendedor TesteDesfazer importação$/,
    );
    expect(within(live!).getByRole('button', { name: 'Desfazer importação' })).toBeTruthy();
    expect(undone?.textContent).toMatch(/1 mensagem de 01\/10\/2026 a 18\/10\/2026/);
    expect(undone?.textContent).toMatch(
      /Desfeita em \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2} por Admin Teste/,
    );
    expect(within(undone!).queryByRole('button')).toBeNull();
  });

  it('asks before undoing and does nothing when the person says no', async () => {
    server.imports = [batch()];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer importação' }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('As 12 mensagens dela saem da conversa'),
    );
    expect(callsTo('DELETE', '/b-live')).toHaveLength(0);
  });

  it('deletes the batch once confirmed and then shows it as undone', async () => {
    server.imports = [batch()];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer importação' }));

    await screen.findByText(/Desfeita em .* por Admin Teste/);
    expect(callsTo('DELETE', '/b-live')).toEqual([
      { method: 'DELETE', path: '/leads/l1/whatsapp/imports/b-live', body: undefined },
    ]);
    expect(screen.queryByRole('button', { name: 'Desfazer importação' })).toBeNull();
  });

  it('shows why an import could not be undone', async () => {
    server.imports = [batch()];
    server.undo = json(
      { error: 'forbidden', message: 'Você não pode desfazer esta importação.' },
      403,
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer importação' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Você não pode desfazer esta importação.');
  });

  it('shows "—" and the reason when the list cannot be read, never "Nenhuma ainda."', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'server_error', message: 'Falha no servidor.' }, 500)),
    );
    show();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar as importações');
    expect(screen.queryByText('Nenhuma ainda.')).toBeNull();
  });
});

describe('closing', () => {
  it('closes with Escape and with "Fechar"', () => {
    show();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
