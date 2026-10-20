import type { LeadFile, WaBulkImport, WaBulkItem } from '@wings/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { bulkImports } from './whatsapp.js';

/**
 * "Importar em lote": the client's calls to /whatsapp/bulk-imports. The real API client runs
 * against a stubbed `fetch`; only the upload of a file to a deal (a pre-signed address) is replaced.
 */

const { sendLeadFile } = vi.hoisted(() => ({ sendLeadFile: vi.fn() }));

vi.mock('./crm.js', () => ({
  sendLeadFile: (...args: unknown[]) => sendLeadFile(...args),
}));

const BULK_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const ITEM_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const LEAD_ID = '0a1b2c3d-0000-4000-8000-000000000003';
const FILE_ID = '0a1b2c3d-0000-4000-8000-000000000004';

const item = (over: Partial<WaBulkItem> = {}): WaBulkItem => ({
  id: ITEM_ID,
  position: 1,
  fileName: 'Conversa do WhatsApp com Contato Teste.txt',
  byteSize: 90,
  platform: 'android',
  contactName: 'Contato Teste',
  participants: [{ name: 'Contato Teste', messages: 2 }],
  leadId: LEAD_ID,
  leadName: 'Contato Teste',
  match: 'telefone',
  candidates: 1,
  messages: 2,
  newMessages: 2,
  existingMessages: 0,
  first: '2026-10-01T15:00:00.000Z',
  last: '2026-10-02T15:00:00.000Z',
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
  suggestedOurName: null,
  hasNameMap: false,
  createdAt: '2026-10-19T14:00:00.000Z',
  createdByName: 'Admin Teste',
  appliedAt: null,
  undoneAt: null,
  items: [],
  ...over,
});

const calls: { method: string; path: string; body: unknown }[] = [];
const order: string[] = [];
/** The answer of the next request, set per test. */
let answer: Response | (() => Response) = new Response('{}');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls.length = 0;
  order.length = 0;
  answer = json({});
  sendLeadFile.mockReset();
  sendLeadFile.mockImplementation(async () => {
    order.push('upload');
    return { id: 'lf1', fileId: FILE_ID, name: 'x', version: 1 } as LeadFile;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      order.push(`${init.method ?? 'GET'} ${url.replace(/^\/api/, '')}`);
      calls.push({
        method: init.method ?? 'GET',
        path: url.replace(/^\/api/, ''),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return typeof answer === 'function' ? answer() : answer;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bulkImports', () => {
  it('create opens a lote with an empty body when there is no name map', async () => {
    answer = json({ bulk: bulk() });
    expect(await bulkImports.create()).toEqual(bulk());
    expect(calls).toEqual([{ method: 'POST', path: '/whatsapp/bulk-imports', body: {} }]);
  });

  it('create sends the name map text when there is one', async () => {
    answer = json({ bulk: bulk({ hasNameMap: true }) });
    await bulkImports.create('Contato Teste;11900000001');
    expect(calls[0]?.body).toEqual({ nameMap: 'Contato Teste;11900000001' });
  });

  it('get reads the lote with its conversations', async () => {
    answer = json({ bulk: bulk({ items: [item()] }) });
    const found = await bulkImports.get(BULK_ID);
    expect(found.items).toHaveLength(1);
    expect(calls).toEqual([
      { method: 'GET', path: `/whatsapp/bulk-imports/${BULK_ID}`, body: undefined },
    ]);
  });

  it('addItem posts one conversation (file name, size, text) and returns the paired item', async () => {
    answer = json({ item: item() });
    const input = { fileName: 'Conversa.txt', byteSize: 90, text: 'texto' };
    expect(await bulkImports.addItem(BULK_ID, input)).toEqual(item());
    expect(calls).toEqual([
      { method: 'POST', path: `/whatsapp/bulk-imports/${BULK_ID}/items`, body: input },
    ]);
  });

  it.each([
    ['corrects the pair', { leadId: LEAD_ID }],
    ['skips the conversation', { skip: true }],
    ['includes it again', { skip: false }],
  ])('patchItem %s with a PATCH on the item', async (_label, patch) => {
    answer = json({ item: item() });
    expect(await bulkImports.patchItem(BULK_ID, ITEM_ID, patch)).toEqual(item());
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: `/whatsapp/bulk-imports/${BULK_ID}/items/${ITEM_ID}`,
        body: patch,
      },
    ]);
  });

  it('start confirms the lote with the name that is the Wings', async () => {
    answer = json({ bulk: bulk({ state: 'gravando', ourName: 'Wings Company' }) });
    const started = await bulkImports.start(BULK_ID, 'Wings Company');
    expect(started.state).toBe('gravando');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/whatsapp/bulk-imports/${BULK_ID}/apply`,
        body: { ourName: 'Wings Company' },
      },
    ]);
  });

  it('applyItem keeps the file among the paired deal’s files first, then applies the item with its id', async () => {
    answer = json({ item: item({ state: 'gravada', batchId: 'b1' }) });
    const file = new File(['texto'], 'Conversa do WhatsApp com Contato Teste.txt', {
      type: 'text/plain',
    });

    const done = await bulkImports.applyItem(BULK_ID, item(), file);

    expect(done.state).toBe('gravada');
    expect(order).toEqual([
      'upload',
      `POST /whatsapp/bulk-imports/${BULK_ID}/items/${ITEM_ID}/apply`,
    ]);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/whatsapp/bulk-imports/${BULK_ID}/items/${ITEM_ID}/apply`,
        body: { fileId: FILE_ID },
      },
    ]);
    // Uploaded to the paired deal, under its own name plus the day and time of the import.
    const [{ leadId, file: sent }] = sendLeadFile.mock.calls[0] as [{ leadId: string; file: File }];
    expect(leadId).toBe(LEAD_ID);
    expect(sent.name).toMatch(
      /^Conversa do WhatsApp com Contato Teste \(importada \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.txt$/,
    );
    expect(sent.type).toBe('text/plain');
  });

  it('applyItem does not apply the item when the file could not be kept', async () => {
    sendLeadFile.mockRejectedValue(new Error('O armazenamento recusou o arquivo. Tente de novo.'));
    await expect(bulkImports.applyItem(BULK_ID, item(), new File(['x'], 'a.txt'))).rejects.toThrow(
      'O armazenamento recusou o arquivo.',
    );
    expect(calls).toEqual([]);
  });

  it('undo without an item undoes the whole lote', async () => {
    answer = json({ bulk: bulk({ state: 'desfeito' }), undone: 3, removed: 40 });
    const undone = await bulkImports.undo(BULK_ID);
    expect(undone.state).toBe('desfeito');
    expect(calls).toEqual([
      { method: 'POST', path: `/whatsapp/bulk-imports/${BULK_ID}/undo`, body: undefined },
    ]);
  });

  it('undo with an item undoes only that conversation', async () => {
    answer = json({ bulk: bulk(), undone: 1, removed: 12 });
    await bulkImports.undo(BULK_ID, ITEM_ID);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/whatsapp/bulk-imports/${BULK_ID}/items/${ITEM_ID}/undo`,
        body: undefined,
      },
    ]);
  });

  it('reportUrl is the API address of the lote’s report, for a plain link', () => {
    expect(bulkImports.reportUrl(BULK_ID)).toBe(`/api/whatsapp/bulk-imports/${BULK_ID}/report`);
  });

  it('turns a refusal into an ApiError with its status and code', async () => {
    answer = json({ error: 'forbidden', message: 'Sem permissão.' }, 403);
    const failure = await bulkImports.get(BULK_ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(403);
    expect((failure as ApiError).code).toBe('forbidden');
  });
});
