import {
  SESSION_COOKIE,
  WA_BULK_MAX_ITEMS,
  type RoleKey,
  type WaBulkImport,
  type WaBulkItem,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  driveFiles,
  driveFolders,
  leadFiles,
  leads,
  waBulkImportItems,
  waBulkImports,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { addBulkItem, createBulk } from './import-bulk.js';

/**
 * The routes of "Importar em lote": Admin Master only (`whatsapp.import_bulk`), every error code
 * answered with its status, the report as CSV, and audit entries by ids only. Made-up chats; no network.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let folderId: string;
type Session = { id: string; cookies: Record<string, string> };
let admin: Session;
let seller: Session;
let rh: Session;

const OURS = 'Wings Company';
const BASE = '/whatsapp/bulk-imports';

const chat = (contact: string) =>
  [
    `19/10/2026 14:05 - ${OURS}: Olá! Vi o seu interesse.`,
    `19/10/2026 14:06 - ${contact}: Pode sim`,
    `19/10/2026 14:07 - ${contact}: Combinado`,
  ].join('\n');
const fileNameOf = (contact: string) => `Conversa do WhatsApp com ${contact}.txt`;

// Words that must not reach an audit entry or the report: names and text of the chats.
const NEVER_RECORDED = ['Wings', 'Contato Teste', 'Olá', 'Pode sim', 'Combinado', 'Conversa do'];

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
    }),
    db,
    whatsappFetch: (() => {
      throw new Error('the import never calls the WhatsApp API');
    }) as unknown as typeof fetch,
  });
  admin = await sessionFor('admin_master');
  seller = await sessionFor('vendedor_expansao');
  rh = await sessionFor('rh_dp');
  const [folder] = await db
    .insert(driveFolders)
    .values({ name: 'Importação', path: '/Importação', department: 'comercial' })
    .returning({ id: driveFolders.id });
  folderId = folder!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let seq = 0;
/** An open deal with a made-up phone and a name of its own (the name is what pairs the chat). */
async function deal() {
  const n = ++seq;
  const name = `Contato Teste ${n}`;
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name,
      phone: `55119${String(n).padStart(8, '0')}`,
      ownerEmployeeId: admin.id,
      pipeline: 'expansao',
    })
    .returning({ id: leads.id });
  return { id: row!.id, name };
}

/** The exported file, as the deal's file tab keeps it. */
async function fileOf(leadId: string) {
  const [file] = await db
    .insert(driveFiles)
    .values({
      folderId,
      name: 'Conversa do WhatsApp.txt',
      mimeType: 'text/plain',
      byteSize: 10,
      storageKey: `drive/2026-10/bulk-routes-${++seq}`,
      ownerId: admin.id,
    })
    .returning({ id: driveFiles.id });
  await db.insert(leadFiles).values({ leadId, driveFileId: file!.id, addedBy: admin.id });
  return file!.id;
}

const call = (session: Session | null, options: InjectOptions) =>
  app.inject({ ...(session ? { cookies: session.cookies } : {}), ...options });
const asAdmin = (options: InjectOptions) => call(admin, options);

/** A lote in preview with one conversation paired to a deal, made through the service. */
async function fresh() {
  const lead = await deal();
  const bulkId = await createBulk(db, { source: 'tela', createdBy: admin.id });
  const item = await addBulkItem(db, bulkId, {
    fileName: fileNameOf(lead.name),
    byteSize: 100,
    text: chat(lead.name),
  });
  return { bulkId, itemId: item.id, leadId: lead.id, fileId: await fileOf(lead.id) };
}
type Ctx = Awaited<ReturnType<typeof fresh>>;

const confirm = (ctx: Ctx, ourName = OURS) =>
  asAdmin({ method: 'POST', url: `${BASE}/${ctx.bulkId}/apply`, payload: { ourName } });
const writeItem = (ctx: Ctx, fileId = ctx.fileId) =>
  asAdmin({
    method: 'POST',
    url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}/apply`,
    payload: { fileId },
  });
const bulkIn = async (id: string) =>
  (await db.select().from(waBulkImports).where(eq(waBulkImports.id, id)))[0]!;
const itemIn = async (id: string) =>
  (await db.select().from(waBulkImportItems).where(eq(waBulkImportItems.id, id)))[0]!;
const auditsOf = (entityId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));

describe('who may use the routes', () => {
  /** Every route of the feature with a valid id and a valid body, so a 403 is the permission and no more. */
  const routesOf = (ctx: Ctx): InjectOptions[] => [
    { method: 'POST', url: BASE, payload: {} },
    { method: 'GET', url: `${BASE}/${ctx.bulkId}` },
    { method: 'GET', url: `${BASE}/${ctx.bulkId}/report` },
    {
      method: 'POST',
      url: `${BASE}/${ctx.bulkId}/items`,
      payload: { fileName: 'a.txt', byteSize: 1, text: chat('Fulano') },
    },
    { method: 'PATCH', url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}`, payload: { skip: true } },
    { method: 'POST', url: `${BASE}/${ctx.bulkId}/pair`, payload: { ourName: OURS } },
    { method: 'POST', url: `${BASE}/${ctx.bulkId}/apply`, payload: { ourName: OURS } },
    {
      method: 'POST',
      url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}/apply`,
      payload: { fileId: ctx.fileId },
    },
    { method: 'POST', url: `${BASE}/${ctx.bulkId}/undo` },
    { method: 'POST', url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}/undo` },
    { method: 'DELETE', url: `${BASE}/${ctx.bulkId}` },
  ];

  it('refuses a seller and an RH/DP login with 403 on every route, and nothing changes', async () => {
    const ctx = await fresh();
    const before = await db.select().from(waBulkImports);
    for (const session of [seller, rh]) {
      const answers = await Promise.all(routesOf(ctx).map((options) => call(session, options)));
      expect(answers.map((res) => res.statusCode)).toEqual(Array(11).fill(403));
    }
    expect(await db.select().from(waBulkImports)).toHaveLength(before.length);
    expect(await bulkIn(ctx.bulkId)).toMatchObject({ state: 'previa', ourName: null });
    expect(await itemIn(ctx.itemId)).toMatchObject({ state: 'pendente' });
    expect(
      await db.select().from(waBulkImportItems).where(eq(waBulkImportItems.bulkId, ctx.bulkId)),
    ).toHaveLength(1);
    expect(await auditsOf(ctx.bulkId, 'whatsapp.bulk_import_confirmed')).toEqual([]);
  });

  it('answers 401 without a login on every route', async () => {
    const ctx = await fresh();
    const answers = await Promise.all(routesOf(ctx).map((options) => call(null, options)));
    expect(answers.map((res) => res.statusCode)).toEqual(Array(11).fill(401));
  });
});

describe('discarding a preview', () => {
  it('deletes the lote and its conversations, with an audit entry by id', async () => {
    const ctx = await fresh();
    const res = await asAdmin({ method: 'DELETE', url: `${BASE}/${ctx.bulkId}` });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(waBulkImports).where(eq(waBulkImports.id, ctx.bulkId))).toEqual(
      [],
    );
    expect(
      await db.select().from(waBulkImportItems).where(eq(waBulkImportItems.bulkId, ctx.bulkId)),
    ).toEqual([]);
    const audits = await auditsOf(ctx.bulkId, 'whatsapp.bulk_import_discarded');
    expect(audits).toHaveLength(1);
    const written = JSON.stringify(audits[0], (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(written).not.toContain('Conversa do WhatsApp');
  });

  it('refuses a lote already confirmed with 409 not_in_preview, and keeps it', async () => {
    const ctx = await fresh();
    await confirm(ctx);
    const res = await asAdmin({ method: 'DELETE', url: `${BASE}/${ctx.bulkId}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_in_preview' });
    expect(await bulkIn(ctx.bulkId)).toMatchObject({ state: 'gravando' });
  });

  it('answers 404 for a lote that does not exist', async () => {
    const res = await asAdmin({ method: 'DELETE', url: `${BASE}/${crypto.randomUUID()}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('a lote from start to end', () => {
  it('creates it, takes the items, corrects one, confirms, writes, reports and undoes it', async () => {
    const created = await asAdmin({
      method: 'POST',
      url: BASE,
      payload: { nameMap: 'Nome Mapeado Um;(11) 90000-0005' },
    });
    expect(created.statusCode).toBe(201);
    const bulk = created.json<{ bulk: WaBulkImport }>().bulk;
    expect(bulk).toMatchObject({
      source: 'tela',
      state: 'previa',
      hasNameMap: true,
      createdByName: expect.any(String),
      items: [],
    });
    const createdAudits = await auditsOf(bulk.id, 'whatsapp.bulk_import_created');
    expect(createdAudits).toHaveLength(1);
    // The entry names the lote and the person, and holds no map and no name.
    expect(createdAudits[0]).toMatchObject({
      actorEmployeeId: admin.id,
      entity: 'whatsapp_bulk_import',
      entityId: bulk.id,
      metadata: {},
    });
    expect(JSON.stringify(createdAudits[0]?.metadata)).not.toContain('Mapeado');

    const lead = await deal();
    const other = await deal();
    const text = chat(lead.name);
    const added = await asAdmin({
      method: 'POST',
      url: `${BASE}/${bulk.id}/items`,
      payload: { fileName: fileNameOf(lead.name), byteSize: text.length, text },
    });
    expect(added.statusCode).toBe(201);
    const item = added.json<{ item: WaBulkItem }>().item;
    expect(item).toMatchObject({ leadId: lead.id, match: 'nome', messages: 3, state: 'pendente' });

    const patched = await asAdmin({
      method: 'PATCH',
      url: `${BASE}/${bulk.id}/items/${item.id}`,
      payload: { leadId: other.id },
    });
    expect(patched.json<{ item: WaBulkItem }>().item).toMatchObject({
      leadId: other.id,
      match: 'manual',
    });
    const skipped = await asAdmin({
      method: 'PATCH',
      url: `${BASE}/${bulk.id}/items/${item.id}`,
      payload: { skip: true },
    });
    expect(skipped.json<{ item: WaBulkItem }>().item.state).toBe('pulada');
    const back = await asAdmin({
      method: 'PATCH',
      url: `${BASE}/${bulk.id}/items/${item.id}`,
      payload: { leadId: lead.id },
    });
    expect(back.json<{ item: WaBulkItem }>().item).toMatchObject({
      leadId: lead.id,
      state: 'pendente',
    });

    const confirmed = await asAdmin({
      method: 'POST',
      url: `${BASE}/${bulk.id}/apply`,
      payload: { ourName: OURS },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<{ bulk: WaBulkImport }>().bulk).toMatchObject({
      state: 'gravando',
      ourName: OURS,
    });
    const confirmedAudits = await auditsOf(bulk.id, 'whatsapp.bulk_import_confirmed');
    expect(confirmedAudits).toHaveLength(1);
    expect(confirmedAudits[0]).toMatchObject({
      actorEmployeeId: admin.id,
      entity: 'whatsapp_bulk_import',
      entityId: bulk.id,
      metadata: {},
    });

    const fileId = await fileOf(lead.id);
    const written = await asAdmin({
      method: 'POST',
      url: `${BASE}/${bulk.id}/items/${item.id}/apply`,
      payload: { fileId },
    });
    expect(written.statusCode).toBe(200);
    const done = written.json<{ item: WaBulkItem }>().item;
    expect(done).toMatchObject({ state: 'gravada', newMessages: 3, batchId: expect.any(String) });
    // Ids and counts only, in the entry the write leaves.
    const [imported] = await auditsOf(lead.id, 'whatsapp.conversation_imported');
    expect(Object.keys(imported!.metadata as object).sort()).toEqual([
      'batchId',
      'bulkId',
      'fileId',
      'from',
      'itemId',
      'messages',
      'platform',
      'to',
    ]);
    for (const secret of [...NEVER_RECORDED, lead.name])
      expect(JSON.stringify(imported?.metadata)).not.toContain(secret);

    const read = await asAdmin({ method: 'GET', url: `${BASE}/${bulk.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ bulk: WaBulkImport }>().bulk).toMatchObject({
      state: 'gravado',
      items: [{ id: item.id, state: 'gravada' }],
    });

    const report = await asAdmin({ method: 'GET', url: `${BASE}/${bulk.id}/report` });
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(report.headers['content-disposition']).toBe(
      `attachment; filename="lote-${bulk.id}.csv"`,
    );
    const [header, line, ...rest] = report.body.trimEnd().split('\n');
    expect(rest).toEqual([]);
    expect(header).toBe(
      'lote;item;posicao;negociacao;par;situacao;motivo;mensagens;novas;ja_existentes;importacao',
    );
    expect(line).toBe(
      [bulk.id, item.id, 1, lead.id, 'manual', 'gravada', '', 3, 3, 0, done.batchId].join(';'),
    );
    for (const secret of [...NEVER_RECORDED, lead.name, 'Mapeado', '.txt'])
      expect(report.body).not.toContain(secret);

    const undoneItem = await asAdmin({
      method: 'POST',
      url: `${BASE}/${bulk.id}/items/${item.id}/undo`,
    });
    expect(undoneItem.statusCode).toBe(200);
    expect(undoneItem.json()).toMatchObject({
      undone: 1,
      removed: 3,
      bulk: { state: 'desfeito', items: [{ state: 'desfeita' }] },
    });
    const undoneAll = await asAdmin({ method: 'POST', url: `${BASE}/${bulk.id}/undo` });
    expect(undoneAll.statusCode).toBe(200);
    expect(undoneAll.json()).toMatchObject({ undone: 0, removed: 0, bulk: { state: 'desfeito' } });
  });

  it('undoes the whole lote in one call and answers the lote as it is then', async () => {
    const ctx = await fresh();
    await confirm(ctx);
    await writeItem(ctx);
    const res = await asAdmin({ method: 'POST', url: `${BASE}/${ctx.bulkId}/undo` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      undone: 1,
      removed: 3,
      bulk: { id: ctx.bulkId, state: 'desfeito', items: [{ id: ctx.itemId, state: 'desfeita' }] },
    });
  });

  it('writes no confirm entry when the confirm is refused', async () => {
    const ctx = await fresh();
    const refused = await confirm(ctx, 'Outra Pessoa');
    expect(refused.statusCode).toBe(400);
    expect(await auditsOf(ctx.bulkId, 'whatsapp.bulk_import_confirmed')).toEqual([]);
    expect(await bulkIn(ctx.bulkId)).toMatchObject({ state: 'previa', ourName: null });
    expect((await confirm(ctx)).statusCode).toBe(200);
    expect((await confirm(ctx)).statusCode).toBe(409);
    expect(await auditsOf(ctx.bulkId, 'whatsapp.bulk_import_confirmed')).toHaveLength(1);
  });

  it('takes one conversation larger than the default body limit', async () => {
    const ctx = await fresh();
    const lead = await deal();
    const text = Array.from(
      { length: 15_000 },
      (_, i) => `19/10/2026 14:05 - ${i % 2 ? OURS : lead.name}: Mensagem ${i} ${'x'.repeat(60)}`,
    ).join('\n');
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const res = await asAdmin({
      method: 'POST',
      url: `${BASE}/${ctx.bulkId}/items`,
      payload: { fileName: fileNameOf(lead.name), byteSize: text.length, text },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ item: WaBulkItem }>().item).toMatchObject({
      messages: 15_000,
      leadId: lead.id,
    });
  });
});

describe('what is refused', () => {
  const unknownId = () => crypto.randomUUID();
  type Case = [
    name: string,
    run: (ctx: Ctx) => Promise<LightMyRequestResponse>,
    status: number,
    code: string,
  ];
  const cases: Case[] = [
    [
      'a lote that does not exist',
      () => asAdmin({ method: 'GET', url: `${BASE}/${unknownId()}` }),
      404,
      'not_found',
    ],
    ['a malformed lote id', () => asAdmin({ method: 'GET', url: `${BASE}/abc` }), 404, 'not_found'],
    [
      'a malformed lote id on the report',
      () => asAdmin({ method: 'GET', url: `${BASE}/abc/report` }),
      404,
      'not_found',
    ],
    [
      'a malformed item id',
      (ctx) =>
        asAdmin({
          method: 'PATCH',
          url: `${BASE}/${ctx.bulkId}/items/abc`,
          payload: { skip: true },
        }),
      404,
      'not_found',
    ],
    [
      'an item that does not exist',
      (ctx) =>
        asAdmin({
          method: 'PATCH',
          url: `${BASE}/${ctx.bulkId}/items/${unknownId()}`,
          payload: { skip: true },
        }),
      404,
      'not_found',
    ],
    [
      'a correction to a deal that does not exist',
      (ctx) =>
        asAdmin({
          method: 'PATCH',
          url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}`,
          payload: { leadId: unknownId() },
        }),
      404,
      'lead_not_found',
    ],
    [
      'a new item in a lote that was confirmed',
      async (ctx) => {
        await confirm(ctx);
        return asAdmin({
          method: 'POST',
          url: `${BASE}/${ctx.bulkId}/items`,
          payload: { fileName: 'a.txt', byteSize: 1, text: chat('Fulano') },
        });
      },
      409,
      'not_in_preview',
    ],
    [
      'a correction in a lote that was confirmed',
      async (ctx) => {
        await confirm(ctx);
        return asAdmin({
          method: 'PATCH',
          url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}`,
          payload: { skip: true },
        });
      },
      409,
      'not_in_preview',
    ],
    [
      'a second confirm',
      async (ctx) => {
        await confirm(ctx);
        return confirm(ctx);
      },
      409,
      'not_in_preview',
    ],
    [
      'an item past the maximum of the lote',
      async (ctx) => {
        await db.insert(waBulkImportItems).values(
          Array.from({ length: WA_BULK_MAX_ITEMS - 1 }, (_, i) => ({
            bulkId: ctx.bulkId,
            position: i + 2,
            fileName: `arquivo-${i}.txt`,
            byteSize: 1,
            state: 'falhou',
            error: 'not_an_export',
          })),
        );
        return asAdmin({
          method: 'POST',
          url: `${BASE}/${ctx.bulkId}/items`,
          payload: { fileName: 'a.txt', byteSize: 1, text: chat('Fulano') },
        });
      },
      409,
      'too_many',
    ],
    [
      'a file that is not one of the deal files',
      async (ctx) => {
        await confirm(ctx);
        return writeItem(ctx, await fileOf((await deal()).id));
      },
      404,
      'file_not_found',
    ],
    ['an item written before the confirm', (ctx) => writeItem(ctx), 409, 'not_pending'],
    [
      'an item written twice',
      async (ctx) => {
        await confirm(ctx);
        await writeItem(ctx);
        return writeItem(ctx);
      },
      409,
      'not_pending',
    ],
    [
      'an undo of a lote that is still a preview',
      (ctx) => asAdmin({ method: 'POST', url: `${BASE}/${ctx.bulkId}/undo` }),
      409,
      'not_pending',
    ],
    [
      'an undo of an item that was not written',
      async (ctx) => {
        await confirm(ctx);
        return asAdmin({ method: 'POST', url: `${BASE}/${ctx.bulkId}/items/${ctx.itemId}/undo` });
      },
      404,
      'not_found',
    ],
    [
      'an undo of a lote that does not exist',
      () => asAdmin({ method: 'POST', url: `${BASE}/${unknownId()}/undo` }),
      404,
      'not_found',
    ],
    ['a name that no file has', (ctx) => confirm(ctx, 'Outra Pessoa'), 400, 'unknown_side'],
  ];

  it.each(cases)('answers %s with its status and code', async (_name, run, status, code) => {
    const res = await run(await fresh());
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code, message: expect.stringMatching(/\S/) });
  });

  it('answers the report of a lote that does not exist with 404 not_found', async () => {
    const res = await asAdmin({ method: 'GET', url: `${BASE}/${crypto.randomUUID()}/report` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  const invalid =
    (url: (ctx: Ctx) => string, payload: unknown, method: 'POST' | 'PATCH' = 'POST') =>
    (ctx: Ctx) =>
      asAdmin({ method, url: url(ctx), payload: payload as object });
  const itemsUrl = (ctx: Ctx) => `${BASE}/${ctx.bulkId}/items`;
  const itemUrl = (ctx: Ctx) => `${BASE}/${ctx.bulkId}/items/${ctx.itemId}`;
  const goodItem = { fileName: 'a.txt', byteSize: 1, text: chat('Fulano') };

  it.each([
    ['a map that is not text', invalid(() => BASE, { nameMap: 5 })],
    ['an item with no file name', invalid(itemsUrl, { ...goodItem, fileName: '' })],
    ['an item with no text', invalid(itemsUrl, { fileName: 'a.txt', byteSize: 1 })],
    ['an item with an empty text', invalid(itemsUrl, { ...goodItem, text: '' })],
    ['an item with a negative size', invalid(itemsUrl, { ...goodItem, byteSize: -1 })],
    ['an empty correction', invalid(itemUrl, {}, 'PATCH')],
    ['a correction with a deal that is not an id', invalid(itemUrl, { leadId: 'x' }, 'PATCH')],
    ['a correction that skips with a word', invalid(itemUrl, { skip: 'sim' }, 'PATCH')],
    ['a confirm with no name', invalid((ctx) => `${BASE}/${ctx.bulkId}/apply`, {})],
    [
      'a confirm with a blank name',
      invalid((ctx) => `${BASE}/${ctx.bulkId}/apply`, { ourName: '   ' }),
    ],
    ['a write with no file', invalid((ctx) => `${itemUrl(ctx)}/apply`, {})],
    [
      'a write with a file that is not an id',
      invalid((ctx) => `${itemUrl(ctx)}/apply`, { fileId: 'x' }),
    ],
  ])('answers 400 invalid_request for %s', async (_name, run) => {
    const ctx = await fresh();
    const res = await run(ctx);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'invalid_request',
      message: expect.stringMatching(/\S/),
    });
    // A refused request leaves the lote as it was.
    expect(await bulkIn(ctx.bulkId)).toMatchObject({ state: 'previa' });
    expect(await itemIn(ctx.itemId)).toMatchObject({ state: 'pendente' });
  });
});
