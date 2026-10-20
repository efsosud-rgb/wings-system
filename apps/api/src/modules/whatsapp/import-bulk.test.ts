import {
  SESSION_COOKIE,
  WA_BULK_MAX_ITEMS,
  type DealWhatsApp,
  type WaConversationItem,
} from '@wings/shared';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  crmNotifications,
  driveFiles,
  driveFolders,
  jobs,
  leadEvents,
  leadFiles,
  leadTasks,
  leads,
  sofiaAiRuns,
  waBulkImportItems,
  waBulkImports,
  waContacts,
  waConversations,
  waImportBatches,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import {
  BulkError,
  addBulkItem,
  applyBulkItem,
  bulkOf,
  bulkReport,
  createBulk,
  pairOf,
  startBulk,
  undoBulk,
  updateBulkItem,
} from './import-bulk.js';
import { normalizeName } from './import-match.js';
import { applyImport } from './import.js';

/**
 * "Importar em lote": the pairing order, the lote-pai and its items, the Admin's corrections, the
 * confirm, the write of each conversation (the same history rules as one import), the undo and the
 * final report. Made-up chats and deals; no network.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let folderId: string;
let adminId: string;
let adminCookies: Record<string, string>;

const OURS = 'Wings Company';

/** A chat of three lines that ends with the contact's, as the single import's tests do. */
const chat = (contact: string) =>
  [
    `19/10/2026 14:05 - ${OURS}: Olá! Vi o seu interesse.`,
    `19/10/2026 14:06 - ${contact}: Pode sim`,
    `19/10/2026 14:07 - ${contact}: Combinado`,
  ].join('\n');
/** The same chat, a day later: two more lines. */
const longer = (contact: string) =>
  [
    chat(contact),
    `19/10/2026 14:08 - ${OURS}: Até amanhã`,
    `19/10/2026 14:09 - ${contact}: Até logo`,
  ].join('\n');
const fileNameOf = (contact: string) => `Conversa do WhatsApp com ${contact}.txt`;

// What must never be in an audit entry, an event or the report: names and words of the chats.
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
  const admin = await createEmployee(db, { role: 'admin_master' });
  adminId = admin.id;
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: admin.email, password: admin.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  adminCookies = { [SESSION_COOKIE]: token };
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

let seq = 0;
/** A made-up mobile (5511 9 0000 00NN) and the way a person writes it. */
const phoneFor = (n: number) => `55119${String(n).padStart(8, '0')}`;
const writtenPhone = (phone: string) =>
  `+${phone.slice(0, 2)} ${phone.slice(2, 4)} ${phone.slice(4, 9)}-${phone.slice(9)}`;

/** An open deal. The name is unique per deal, since a name is a pairing clue. */
async function deal(
  over: { name?: string; companyName?: string | null; phone?: string | null; won?: boolean } = {},
) {
  const n = ++seq;
  const name = over.name ?? `Contato Teste ${n}`;
  const phone = over.phone === undefined ? phoneFor(n) : over.phone;
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name,
      companyName: over.companyName ?? null,
      phone,
      won: over.won ?? null,
      ownerEmployeeId: adminId,
      pipeline: 'expansao',
    })
    .returning({ id: leads.id });
  return { id: row!.id, name, phone };
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
      storageKey: `drive/2026-10/bulk-${++seq}`,
      ownerId: adminId,
    })
    .returning({ id: driveFiles.id });
  await db.insert(leadFiles).values({ leadId, driveFileId: file!.id, addedBy: adminId });
  return file!.id;
}

const newBulk = (nameMap?: string) =>
  createBulk(db, { source: 'tela', createdBy: adminId, ...(nameMap ? { nameMap } : {}) });
const add = (
  bulkId: string,
  contact: string,
  text = chat(contact),
  fileName = fileNameOf(contact),
) => addBulkItem(db, bulkId, { fileName, byteSize: text.length, text });
const applyItem = (bulkId: string, itemId: string, fileId: string) =>
  applyBulkItem(db, bulkId, itemId, { fileId, actorEmployeeId: adminId, ip: null });
const undo = (bulkId: string, itemId?: string) =>
  undoBulk(db, bulkId, { ...(itemId ? { itemId } : {}), actorEmployeeId: adminId, ip: null });

/** The code of the `BulkError` a call ends with (the test fails when it ends any other way). */
async function refusal(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BulkError);
  return (error as BulkError).code;
}

const itemRow = async (id: string) =>
  (await db.select().from(waBulkImportItems).where(eq(waBulkImportItems.id, id)))[0]!;
const bulkRow = async (id: string) =>
  (await db.select().from(waBulkImports).where(eq(waBulkImports.id, id)))[0]!;
const messagesOf = (leadId: string) =>
  db.select().from(waMessages).where(eq(waMessages.leadId, leadId));
const batchesOf = (leadId: string) =>
  db.select().from(waImportBatches).where(eq(waImportBatches.leadId, leadId));
const auditsOf = (leadId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, action)));
const eventsOf = (leadId: string, kind: string) =>
  db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, kind)));

/** A lote already written: `size` deals, each with its conversation paired by name. */
async function writtenBulk(size: number) {
  const bulkId = await newBulk();
  const rows = [];
  for (let i = 0; i < size; i++) {
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    rows.push({ lead, item, fileId: await fileOf(lead.id) });
  }
  await startBulk(db, bulkId, OURS);
  for (const row of rows) await applyItem(bulkId, row.item.id, row.fileId);
  return { bulkId, rows };
}

describe('pairing a conversation with its deal', () => {
  const clues = (
    over: Partial<Parameters<typeof pairOf>[1]> = {},
  ): Parameters<typeof pairOf>[1] => ({
    phones: { authors: [], written: [] },
    contactName: null,
    nameMap: {},
    ...over,
  });

  it("takes the contact's number in the chat before the number written in a message, the map and the name", async () => {
    const byAuthor = await deal();
    const byText = await deal();
    const byName = await deal();
    const pair = await pairOf(
      db,
      clues({
        phones: { authors: [byAuthor.phone!], written: [byText.phone!] },
        contactName: byName.name,
        nameMap: { [normalizeName(byName.name)]: byText.phone! },
      }),
    );
    expect(pair).toEqual({ leadId: byAuthor.id, match: 'telefone', candidates: 1 });
  });

  it('goes on to the number written in a message when no deal has the author number', async () => {
    const byText = await deal();
    const byName = await deal();
    const stranger = phoneFor(++seq);
    const pair = await pairOf(
      db,
      clues({
        phones: { authors: [stranger], written: [byText.phone!] },
        contactName: byName.name,
        nameMap: { [normalizeName(byName.name)]: byName.phone! },
      }),
    );
    expect(pair).toEqual({ leadId: byText.id, match: 'telefone', candidates: 1 });
  });

  it("goes on to the Admin's map before the name", async () => {
    const mapped = await deal();
    const contactName = `Nome Mapeado ${++seq}`;
    const pair = await pairOf(
      db,
      clues({ contactName, nameMap: { [normalizeName(contactName)]: mapped.phone! } }),
    );
    expect(pair).toEqual({ leadId: mapped.id, match: 'mapa', candidates: 1 });
    // The same name is also a deal's name: the map still wins.
    const clash = await deal({ name: contactName });
    const again = await pairOf(
      db,
      clues({ contactName, nameMap: { [normalizeName(contactName)]: mapped.phone! } }),
    );
    expect(again).toMatchObject({ leadId: mapped.id, match: 'mapa' });
    expect(clash.id).not.toBe(mapped.id);
  });

  it('falls back to the name when the map points to a number with no open deal', async () => {
    const named = await deal({ name: `Fulana Mapa Solta ${++seq}` });
    const pair = await pairOf(
      db,
      clues({
        contactName: named.name,
        nameMap: { [normalizeName(named.name)]: phoneFor(++seq) },
      }),
    );
    expect(pair).toEqual({ leadId: named.id, match: 'nome', candidates: 1 });
  });

  it('matches the name of the deal or of its company, without case, accents, emoji or punctuation', async () => {
    const n = ++seq;
    const person = await deal({ name: `Mariá Ávila ${n}` });
    const company = await deal({ name: `Fulano Sem Nome ${n}`, companyName: `Loja Teste ${n}` });
    expect(await pairOf(db, clues({ contactName: `MARIA avila ${n} 🌸` }))).toEqual({
      leadId: person.id,
      match: 'nome',
      candidates: 1,
    });
    expect(await pairOf(db, clues({ contactName: `loja, teste ${n}!` }))).toEqual({
      leadId: company.id,
      match: 'nome',
      candidates: 1,
    });
  });

  it('counts the two forms of one mobile number as one deal, not a tie', async () => {
    const lead = await deal();
    const withoutNine = lead.phone!.slice(0, 4) + lead.phone!.slice(5);
    const pair = await pairOf(
      db,
      clues({ phones: { authors: [lead.phone!, withoutNine], written: [] } }),
    );
    expect(pair).toEqual({ leadId: lead.id, match: 'telefone', candidates: 1 });
  });

  it('leaves a tie between two open deals unpaired and says how many fitted', async () => {
    const first = await deal({ name: `Empate Nome ${++seq}` });
    await deal({ name: first.name });
    expect(await pairOf(db, clues({ contactName: first.name }))).toEqual({
      leadId: null,
      match: null,
      candidates: 2,
    });

    const a = await deal();
    const b = await deal();
    expect(
      await pairOf(db, clues({ phones: { authors: [a.phone!, b.phone!], written: [] } })),
    ).toEqual({
      leadId: null,
      match: null,
      candidates: 2,
    });
  });

  it('lets a tie go on to the next step, which may still find the deal', async () => {
    const a = await deal();
    const b = await deal();
    const text = await deal();
    const viaText = await pairOf(
      db,
      clues({ phones: { authors: [a.phone!, b.phone!], written: [text.phone!] } }),
    );
    expect(viaText).toEqual({ leadId: text.id, match: 'telefone', candidates: 1 });

    const named = await deal();
    const viaName = await pairOf(
      db,
      clues({ phones: { authors: [a.phone!, b.phone!], written: [] }, contactName: named.name }),
    );
    expect(viaName).toEqual({ leadId: named.id, match: 'nome', candidates: 1 });
  });

  it('counts only open deals, and by name only the ones with a phone', async () => {
    const closed = await deal({ won: true });
    const noPhone = await deal({ phone: null });
    expect(await pairOf(db, clues({ phones: { authors: [closed.phone!], written: [] } }))).toEqual({
      leadId: null,
      match: null,
      candidates: 0,
    });
    expect(await pairOf(db, clues({ contactName: closed.name }))).toMatchObject({ leadId: null });
    expect(await pairOf(db, clues({ contactName: noPhone.name }))).toEqual({
      leadId: null,
      match: null,
      candidates: 0,
    });
  });

  it('answers no pair and no candidates when there are no clues', async () => {
    expect(await pairOf(db, clues())).toEqual({ leadId: null, match: null, candidates: 0 });
  });
});

describe('the lote-pai and its items', () => {
  it('opens in preview, keeps the name map parsed and shows the name most files give to the Wings', async () => {
    const without = await newBulk();
    expect(await bulkRow(without)).toMatchObject({
      state: 'previa',
      source: 'tela',
      createdBy: adminId,
      nameMap: null,
    });

    const bulkId = await newBulk('Nome Mapeado Um;(11) 90000-0005\nNome Sem Numero;nada');
    expect((await bulkRow(bulkId)).nameMap).toEqual({ 'nome mapeado um': '5511900000005' });
    const lead = await deal();
    await add(bulkId, lead.name);
    expect(await bulkOf(db, bulkId)).toMatchObject({
      state: 'previa',
      hasNameMap: true,
      suggestedOurName: OURS,
      ourName: null,
      appliedAt: null,
      undoneAt: null,
    });
    expect(await bulkOf(db, without)).toMatchObject({ hasNameMap: false, suggestedOurName: null });
    expect(await refusal(bulkOf(db, crypto.randomUUID()))).toBe('not_found');
  });

  it('reads, pairs and counts a conversation, and writes nothing to the deal', async () => {
    const lead = await deal();
    const bulkId = await newBulk();
    const item = await add(bulkId, lead.name);
    expect(item).toMatchObject({
      position: 1,
      platform: 'android',
      contactName: lead.name,
      participants: [
        { name: lead.name, messages: 2 },
        { name: OURS, messages: 1 },
      ],
      leadId: lead.id,
      leadName: lead.name,
      match: 'nome',
      candidates: 1,
      messages: 3,
      newMessages: 3,
      existingMessages: 0,
      first: '2026-10-19T17:05:00.000Z',
      last: '2026-10-19T17:07:00.000Z',
      state: 'pendente',
      error: null,
      batchId: null,
    });
    // The text waits in the item; the deal has nothing yet.
    expect((await itemRow(item.id)).chatText).toBe(chat(lead.name));
    expect(await messagesOf(lead.id)).toEqual([]);
    expect(await batchesOf(lead.id)).toEqual([]);
  });

  it('pairs by the number the contact has in the chat, and by a number written in a message', async () => {
    const byAuthor = await deal();
    const byText = await deal();
    const bulkId = await newBulk();
    const authorText = [
      `19/10/2026 14:05 - ${OURS}: Olá`,
      `19/10/2026 14:06 - ${writtenPhone(byAuthor.phone!)}: Oi`,
    ].join('\n');
    const first = await add(bulkId, 'ignorado', authorText, 'WhatsApp Chat with Sem Nome.txt');
    expect(first).toMatchObject({ leadId: byAuthor.id, match: 'telefone' });

    const textText = [
      `19/10/2026 14:05 - ${OURS}: Olá`,
      `19/10/2026 14:06 - Pessoa Sem Negociacao ${++seq}: Meu WhatsApp é ${writtenPhone(byText.phone!)}`,
    ].join('\n');
    const second = await add(
      bulkId,
      'ignorado',
      textText,
      'Conversa do WhatsApp com Fulano Solto.txt',
    );
    expect(second).toMatchObject({ leadId: byText.id, match: 'telefone', position: 2 });
  });

  it("pairs by the Admin's map when the name is not a deal's", async () => {
    const mapped = await deal();
    const contact = `Nome Mapeado ${++seq}`;
    const bulkId = await newBulk(`${contact};${writtenPhone(mapped.phone!)}`);
    const item = await add(bulkId, contact);
    expect(item).toMatchObject({ leadId: mapped.id, match: 'mapa', candidates: 1 });
  });

  it('leaves a tie unpaired with the number of deals that fitted', async () => {
    const first = await deal({ name: `Empate Item ${++seq}` });
    await deal({ name: first.name });
    const item = await add(await newBulk(), first.name);
    expect(item).toMatchObject({ leadId: null, leadName: null, match: null, candidates: 2 });
    expect(item.state).toBe('pendente');
  });

  it('counts the lines the deal already has apart from the new ones, and the period is the whole file', async () => {
    const lead = await deal();
    await applyImport(db, {
      lead,
      text: chat(lead.name),
      ourName: OURS,
      fileId: await fileOf(lead.id),
      actorEmployeeId: adminId,
    });
    const item = await add(await newBulk(), lead.name, longer(lead.name));
    expect(item).toMatchObject({
      messages: 5,
      newMessages: 2,
      existingMessages: 3,
      first: '2026-10-19T17:05:00.000Z',
      last: '2026-10-19T17:09:00.000Z',
    });
    // Still a preview: the deal has only what it had.
    expect(await messagesOf(lead.id)).toHaveLength(3);
  });

  it('does not count an unpaired conversation as already present on a deal', async () => {
    const item = await add(await newBulk(), `Sem Negociacao ${++seq}`);
    expect(item.leadId).toBeNull();
    expect(item.existingMessages).toBe(0);
  });

  it('keeps a file that is not an export as an item that failed, and numbers the next one after it', async () => {
    const bulkId = await newBulk();
    const bad = await add(bulkId, 'x', 'Lista de compras\n- arroz', 'compras.txt');
    expect(bad).toMatchObject({
      position: 1,
      state: 'falhou',
      error: 'not_an_export',
      leadId: null,
      messages: 0,
      participants: [],
    });
    expect((await itemRow(bad.id)).chatText).toBeNull();
    const lead = await deal();
    expect((await add(bulkId, lead.name)).position).toBe(2);
  });

  it('refuses the item past WA_BULK_MAX_ITEMS, and a lote that was confirmed or does not exist', async () => {
    const bulkId = await newBulk();
    await db.insert(waBulkImportItems).values(
      Array.from({ length: WA_BULK_MAX_ITEMS - 1 }, (_, i) => ({
        bulkId,
        position: i + 1,
        fileName: `arquivo-${i}.txt`,
        byteSize: 1,
        state: 'falhou',
        error: 'not_an_export',
      })),
    );
    const last = await add(bulkId, (await deal()).name);
    expect(last.position).toBe(WA_BULK_MAX_ITEMS);
    expect(await refusal(add(bulkId, (await deal()).name))).toBe('too_many');
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(waBulkImportItems)
      .where(eq(waBulkImportItems.bulkId, bulkId));
    expect(total).toBe(WA_BULK_MAX_ITEMS);

    const confirmed = await newBulk();
    await add(confirmed, (await deal()).name);
    await startBulk(db, confirmed, OURS);
    expect(await refusal(add(confirmed, (await deal()).name))).toBe('not_in_preview');
    expect(await refusal(add(crypto.randomUUID(), 'x'))).toBe('not_found');
  });
});

describe("the Admin's corrections", () => {
  it('pairs the conversation with another deal, as manual, and counts again against that deal', async () => {
    const stranger = `Sem Negociacao ${++seq}`;
    const bulkId = await newBulk();
    const item = await add(bulkId, stranger);
    expect(item).toMatchObject({ leadId: null, match: null, newMessages: 0 });

    const target = await deal();
    await applyImport(db, {
      lead: target,
      text: chat(stranger),
      ourName: OURS,
      fileId: await fileOf(target.id),
      actorEmployeeId: adminId,
    });
    const fixed = await updateBulkItem(db, bulkId, item.id, { leadId: target.id });
    expect(fixed).toMatchObject({
      leadId: target.id,
      leadName: target.name,
      match: 'manual',
      candidates: 1,
      messages: 3,
      newMessages: 0,
      existingMessages: 3,
      state: 'pendente',
    });
  });

  it('skips a conversation and takes it back, without touching its pair', async () => {
    const lead = await deal();
    const bulkId = await newBulk();
    const item = await add(bulkId, lead.name);
    const skipped = await updateBulkItem(db, bulkId, item.id, { skip: true });
    expect(skipped).toMatchObject({ state: 'pulada', leadId: lead.id, match: 'nome' });
    const back = await updateBulkItem(db, bulkId, item.id, { skip: false });
    expect(back).toMatchObject({ state: 'pendente', leadId: lead.id, match: 'nome' });
    // Choosing a deal for a skipped conversation puts it back to pending.
    await updateBulkItem(db, bulkId, item.id, { skip: true });
    const other = await deal();
    expect(await updateBulkItem(db, bulkId, item.id, { leadId: other.id })).toMatchObject({
      state: 'pendente',
      leadId: other.id,
    });
  });

  it('refuses a deal that does not exist, a failed item, a foreign item and a lote past the preview', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    expect(
      await refusal(updateBulkItem(db, bulkId, item.id, { leadId: crypto.randomUUID() })),
    ).toBe('lead_not_found');
    const failed = await add(bulkId, 'x', 'não é uma exportação', 'a.txt');
    expect(await refusal(updateBulkItem(db, bulkId, failed.id, { skip: true }))).toBe(
      'not_pending',
    );

    const otherBulk = await newBulk();
    expect(await refusal(updateBulkItem(db, otherBulk, item.id, { skip: true }))).toBe('not_found');
    expect(await refusal(updateBulkItem(db, bulkId, crypto.randomUUID(), { skip: true }))).toBe(
      'not_found',
    );
    expect(await refusal(updateBulkItem(db, crypto.randomUUID(), item.id, { skip: true }))).toBe(
      'not_found',
    );

    await startBulk(db, bulkId, OURS);
    expect(await refusal(updateBulkItem(db, bulkId, item.id, { skip: true }))).toBe(
      'not_in_preview',
    );
    // Nothing moved in the refused calls.
    expect((await itemRow(item.id)).state).toBe('pendente');
  });
});

describe('confirming the lote', () => {
  it('refuses a name that no file has, and the lote stays a preview', async () => {
    const lead = await deal();
    const bulkId = await newBulk();
    await add(bulkId, lead.name);
    expect(await refusal(startBulk(db, bulkId, 'Outra Pessoa'))).toBe('unknown_side');
    expect(await refusal(startBulk(db, bulkId, lead.name + ' x'))).toBe('unknown_side');
    expect(await bulkRow(bulkId)).toMatchObject({ state: 'previa', ourName: null });
    expect(await refusal(startBulk(db, crypto.randomUUID(), OURS))).toBe('not_found');
  });

  it('skips the conversations with no pair as sem_par, keeps the rest pending and fixes the name', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const paired = await add(bulkId, lead.name);
    const unpaired = await add(bulkId, `Sem Negociacao ${++seq}`);
    const skippedByAdmin = await add(bulkId, (await deal()).name);
    await updateBulkItem(db, bulkId, skippedByAdmin.id, { skip: true });
    const failed = await add(bulkId, 'x', 'não é uma exportação', 'a.txt');

    await startBulk(db, bulkId, OURS);

    expect(await bulkRow(bulkId)).toMatchObject({
      state: 'gravando',
      ourName: OURS,
      appliedAt: null,
    });
    expect(await itemRow(paired.id)).toMatchObject({ state: 'pendente', error: null });
    expect(await itemRow(unpaired.id)).toMatchObject({ state: 'pulada', error: 'sem_par' });
    expect(await itemRow(skippedByAdmin.id)).toMatchObject({ state: 'pulada', error: null });
    expect(await itemRow(failed.id)).toMatchObject({ state: 'falhou', error: 'not_an_export' });
    // The confirm is once only.
    expect(await refusal(startBulk(db, bulkId, OURS))).toBe('not_in_preview');
  });

  it('ends the lote at once when nothing is left to write, with the map and the waiting texts cleared', async () => {
    const bulkId = await newBulk('Nome Mapeado Dois;(11) 90000-0006');
    const unpaired = await add(bulkId, `Sem Negociacao ${++seq}`);
    await startBulk(db, bulkId, OURS);
    expect(await bulkRow(bulkId)).toMatchObject({ state: 'gravado', nameMap: null });
    expect((await bulkRow(bulkId)).appliedAt).toBeInstanceOf(Date);
    expect((await itemRow(unpaired.id)).chatText).toBeNull();
  });
});

describe('writing a conversation', () => {
  it('writes one import per conversation and ends the lote when the last one is written', async () => {
    const bulkId = await newBulk('Nome Mapeado Tres;(11) 90000-0007');
    const first = await deal();
    const second = await deal();
    const firstItem = await add(bulkId, first.name);
    const secondItem = await add(bulkId, second.name);
    const firstFile = await fileOf(first.id);
    const secondFile = await fileOf(second.id);
    await startBulk(db, bulkId, OURS);

    const done = await applyItem(bulkId, firstItem.id, firstFile);
    expect(done).toMatchObject({ state: 'gravada', error: null, messages: 3, newMessages: 3 });
    // One conversation written, one still waiting: the lote is still being written.
    expect((await bulkRow(bulkId)).state).toBe('gravando');
    expect((await bulkRow(bulkId)).nameMap).not.toBeNull();
    await applyItem(bulkId, secondItem.id, secondFile);

    const [firstBatch] = await batchesOf(first.id);
    const [secondBatch] = await batchesOf(second.id);
    expect(await batchesOf(first.id)).toHaveLength(1);
    expect(await batchesOf(second.id)).toHaveLength(1);
    expect(firstBatch).toMatchObject({
      id: done.batchId,
      driveFileId: firstFile,
      conversationId: expect.any(String),
      messageCount: 3,
      platform: 'android',
      importedBy: adminId,
      undoneAt: null,
    });
    expect(secondBatch!.id).not.toBe(firstBatch!.id);
    expect(secondBatch!.conversationId).not.toBe(firstBatch!.conversationId);
    expect(await messagesOf(first.id)).toHaveLength(3);
    expect(await messagesOf(second.id)).toHaveLength(3);

    expect(await itemRow(firstItem.id)).toMatchObject({
      state: 'gravada',
      batchId: firstBatch!.id,
      driveFileId: firstFile,
      chatText: null,
      newCount: 3,
      error: null,
    });
    expect(await bulkRow(bulkId)).toMatchObject({ state: 'gravado', nameMap: null });
    expect((await bulkRow(bulkId)).appliedAt).toBeInstanceOf(Date);
  });

  it('records the import by ids and counts only', async () => {
    const { bulkId, rows } = await writtenBulk(1);
    const { lead, item, fileId } = rows[0]!;
    const [audit, ...rest] = await auditsOf(lead.id, 'whatsapp.conversation_imported');
    expect(rest).toEqual([]);
    const batch = (await batchesOf(lead.id))[0]!;
    expect(audit).toMatchObject({
      actorEmployeeId: adminId,
      entity: 'lead',
      metadata: {
        bulkId,
        itemId: item.id,
        batchId: batch.id,
        fileId,
        platform: 'android',
        messages: 3,
        from: '2026-10-19T17:05:00.000Z',
        to: '2026-10-19T17:07:00.000Z',
      },
    });
    const [event] = await eventsOf(lead.id, 'whatsapp.conversation_imported');
    expect(event).toMatchObject({
      actorEmployeeId: adminId,
      detail: { batchId: batch.id, messages: 3 },
    });
    const recorded = JSON.stringify([audit?.metadata, event?.detail]);
    for (const secret of [...NEVER_RECORDED, lead.name]) expect(recorded).not.toContain(secret);
  });

  it('is history, as the single import is: no window, no Sofia, no notice, no task, nothing unread', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    const fileId = await fileOf(lead.id);
    await startBulk(db, bulkId, OURS);
    const [{ jobsBefore } = { jobsBefore: 0 }] = await db
      .select({ jobsBefore: count() })
      .from(jobs);
    await applyItem(bulkId, item.id, fileId);

    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, lead.phone!));
    expect(contact?.lastInboundAt).toBeNull();
    const [conversation] = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.leadId, lead.id));
    // A conversation the import opens starts closed, so the next real message is routed as a new one.
    expect(conversation).toMatchObject({
      contactId: contact?.id,
      attendance: 'closed',
      sofiaDueAt: null,
    });
    expect(conversation?.lastMessageAt?.toISOString()).toBe('2026-10-19T17:07:00.000Z');

    const thread = (
      await app.inject({ url: `/leads/${lead.id}/whatsapp`, cookies: adminCookies })
    ).json<DealWhatsApp>();
    expect(thread.window.open).toBe(false);
    expect(thread.messages.map((m) => m.text)).toEqual([
      'Olá! Vi o seu interesse.',
      'Pode sim',
      'Combinado',
    ]);
    for (const message of thread.messages.filter((m) => m.direction === 'out'))
      expect(message).toMatchObject({ status: null, error: null, bySofia: false });
    const inbox = await app.inject({ url: '/whatsapp/conversations', cookies: adminCookies });
    expect(
      inbox
        .json<{ conversations: WaConversationItem[] }>()
        .conversations.find((c) => c.leadId === lead.id),
    ).toMatchObject({ lastDirection: 'in', unreadCount: 0 });

    expect(
      await db.select().from(crmNotifications).where(eq(crmNotifications.leadId, lead.id)),
    ).toEqual([]);
    expect(await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead.id))).toEqual([]);
    const [{ runs } = { runs: 0 }] = await db
      .select({ runs: count() })
      .from(sofiaAiRuns)
      .where(eq(sofiaAiRuns.conversationId, conversation!.id));
    expect(runs).toBe(0);
    const [{ jobsAfter } = { jobsAfter: 0 }] = await db.select({ jobsAfter: count() }).from(jobs);
    expect(jobsAfter).toBe(jobsBefore);
  });

  it('writes only the new lines of a conversation the deal partly has, and says sem_novas when none is new', async () => {
    const lead = await deal();
    const bulkId = await newBulk();
    await applyImport(db, {
      lead,
      text: chat(lead.name),
      ourName: OURS,
      fileId: await fileOf(lead.id),
      actorEmployeeId: adminId,
    });
    const partial = await add(bulkId, lead.name, longer(lead.name));
    const same = await deal();
    await applyImport(db, {
      lead: same,
      text: chat(same.name),
      ourName: OURS,
      fileId: await fileOf(same.id),
      actorEmployeeId: adminId,
    });
    const nothing = await add(bulkId, same.name);
    expect(nothing).toMatchObject({ newMessages: 0, existingMessages: 3 });
    await startBulk(db, bulkId, OURS);

    const wrote = await applyItem(bulkId, partial.id, await fileOf(lead.id));
    expect(wrote).toMatchObject({
      state: 'gravada',
      newMessages: 2,
      messages: 5,
      existingMessages: 3,
    });
    expect(await messagesOf(lead.id)).toHaveLength(5);

    const none = await applyItem(bulkId, nothing.id, await fileOf(same.id));
    expect(none).toMatchObject({ state: 'sem_novas', error: 'nothing_new', batchId: null });
    expect((await itemRow(nothing.id)).chatText).toBeNull();
    // No second import, event or audit entry for the conversation that added nothing.
    expect(await batchesOf(same.id)).toHaveLength(1);
    expect(await eventsOf(same.id, 'whatsapp.conversation_imported')).toHaveLength(1);
    expect(await auditsOf(same.id, 'whatsapp.conversation_imported')).toHaveLength(0);
    expect(await messagesOf(same.id)).toHaveLength(3);
    // Both items done: the lote ends.
    expect((await bulkRow(bulkId)).state).toBe('gravado');
  });

  it("refuses a file that is not one of the paired deal's, and the item keeps waiting", async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    const foreign = await fileOf((await deal()).id);
    const trashed = await fileOf(lead.id);
    await db.update(driveFiles).set({ trashedAt: new Date() }).where(eq(driveFiles.id, trashed));
    await startBulk(db, bulkId, OURS);

    for (const fileId of [foreign, crypto.randomUUID(), trashed])
      expect(await refusal(applyItem(bulkId, item.id, fileId))).toBe('file_not_found');
    expect(await itemRow(item.id)).toMatchObject({ state: 'pendente', batchId: null, error: null });
    expect((await itemRow(item.id)).chatText).not.toBeNull();
    expect(await batchesOf(lead.id)).toEqual([]);
    expect(await messagesOf(lead.id)).toEqual([]);
    // The right file still goes in afterwards.
    expect((await applyItem(bulkId, item.id, await fileOf(lead.id))).state).toBe('gravada');
  });

  it('refuses an item that is not waiting: before the confirm, skipped, written, or not in the lote', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    const skipped = await add(bulkId, (await deal()).name);
    await updateBulkItem(db, bulkId, skipped.id, { skip: true });
    const fileId = await fileOf(lead.id);

    expect(await refusal(applyItem(bulkId, item.id, fileId))).toBe('not_pending');
    await startBulk(db, bulkId, OURS);
    expect(await refusal(applyItem(bulkId, skipped.id, fileId))).toBe('not_pending');
    expect(await refusal(applyItem(bulkId, crypto.randomUUID(), fileId))).toBe('not_found');
    expect(await refusal(applyItem(crypto.randomUUID(), item.id, fileId))).toBe('not_found');
    expect((await applyItem(bulkId, item.id, fileId)).state).toBe('gravada');
    expect(await refusal(applyItem(bulkId, item.id, fileId))).toBe('not_pending');
    expect(await batchesOf(lead.id)).toHaveLength(1);
    expect(await messagesOf(lead.id)).toHaveLength(3);
  });

  it('writes a conversation once when the button is pressed twice at the same time', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    const fileId = await fileOf(lead.id);
    await startBulk(db, bulkId, OURS);

    const results = await Promise.allSettled([
      applyItem(bulkId, item.id, fileId),
      applyItem(bulkId, item.id, fileId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(BulkError);
    expect((lost.reason as BulkError).code).toBe('not_pending');
    expect(await batchesOf(lead.id)).toHaveLength(1);
    expect(await messagesOf(lead.id)).toHaveLength(3);
  });

  it('marks as failed the item whose file lacks the chosen name, or whose deal has no phone, and goes on', async () => {
    const bulkId = await newBulk();
    const ok = await deal();
    const okItem = await add(bulkId, ok.name);
    const otherSide = await deal();
    const otherText = [
      `19/10/2026 14:05 - Outro Perfil: Olá`,
      `19/10/2026 14:06 - ${otherSide.name}: Oi`,
    ].join('\n');
    const otherItem = await add(bulkId, otherSide.name, otherText);
    const noPhone = await deal({ phone: null });
    const stray = await add(bulkId, `Sem Negociacao ${++seq}`);
    await updateBulkItem(db, bulkId, stray.id, { leadId: noPhone.id });
    await startBulk(db, bulkId, OURS);

    const failedSide = await applyItem(bulkId, otherItem.id, await fileOf(otherSide.id));
    expect(failedSide).toMatchObject({ state: 'falhou', error: 'unknown_side', batchId: null });
    const failedPhone = await applyItem(bulkId, stray.id, await fileOf(noPhone.id));
    expect(failedPhone).toMatchObject({ state: 'falhou', error: 'lead_without_phone' });
    expect((await applyItem(bulkId, okItem.id, await fileOf(ok.id))).state).toBe('gravada');

    expect(await batchesOf(otherSide.id)).toEqual([]);
    expect(await messagesOf(otherSide.id)).toEqual([]);
    expect(await batchesOf(noPhone.id)).toEqual([]);
    expect((await itemRow(otherItem.id)).chatText).toBeNull();
    expect((await bulkRow(bulkId)).state).toBe('gravado');
  });
});

describe('undoing a lote', () => {
  it('refuses to undo a lote that is still a preview', async () => {
    const bulkId = await newBulk();
    await add(bulkId, (await deal()).name);
    expect(await refusal(undo(bulkId))).toBe('not_pending');
    expect(await refusal(undo(crypto.randomUUID()))).toBe('not_found');
  });

  it('removes what every written conversation brought, and leaves the exported files with the deals', async () => {
    const { bulkId, rows } = await writtenBulk(2);

    const result = await undo(bulkId);
    expect(result).toEqual({ undone: 2, removed: 6 });
    for (const { lead, item, fileId } of rows) {
      expect(await messagesOf(lead.id)).toEqual([]);
      expect((await itemRow(item.id)).state).toBe('desfeita');
      const [batch] = await batchesOf(lead.id);
      expect(batch).toMatchObject({ undoneBy: adminId });
      expect(batch?.undoneAt).toBeInstanceOf(Date);
      const [audit, ...rest] = await auditsOf(lead.id, 'whatsapp.import_undone');
      expect(rest).toEqual([]);
      expect(audit).toMatchObject({
        actorEmployeeId: adminId,
        metadata: { bulkId, itemId: item.id, batchId: batch!.id, removed: 3 },
      });
      for (const secret of [...NEVER_RECORDED, lead.name])
        expect(JSON.stringify(audit?.metadata)).not.toContain(secret);
      expect(await eventsOf(lead.id, 'whatsapp.import_undone')).toHaveLength(1);
      // The exported file stays among the deal's files.
      const kept = await db.select().from(leadFiles).where(eq(leadFiles.driveFileId, fileId));
      expect(kept).toHaveLength(1);
    }
    expect(await bulkRow(bulkId)).toMatchObject({
      state: 'desfeito',
      nameMap: null,
      undoneBy: adminId,
    });
    expect((await bulkRow(bulkId)).undoneAt).toBeInstanceOf(Date);
  });

  it('undoes one conversation and keeps the lote written while another is still there', async () => {
    const { bulkId, rows } = await writtenBulk(2);
    const [one, two] = rows as [(typeof rows)[number], (typeof rows)[number]];

    expect(await undo(bulkId, one.item.id)).toEqual({ undone: 1, removed: 3 });
    expect(await messagesOf(one.lead.id)).toEqual([]);
    expect(await messagesOf(two.lead.id)).toHaveLength(3);
    expect((await itemRow(one.item.id)).state).toBe('desfeita');
    expect((await itemRow(two.item.id)).state).toBe('gravada');
    expect((await bulkRow(bulkId)).state).toBe('gravado');
    // The undone one is no longer a written one; a conversation that never was is not found.
    expect(await refusal(undo(bulkId, one.item.id))).toBe('not_found');
    expect(await refusal(undo(bulkId, crypto.randomUUID()))).toBe('not_found');
    expect(await auditsOf(one.lead.id, 'whatsapp.import_undone')).toHaveLength(1);

    expect(await undo(bulkId, two.item.id)).toEqual({ undone: 1, removed: 3 });
    expect((await bulkRow(bulkId)).state).toBe('desfeito');
  });

  it('leaves the skipped and the failed items as they were', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    const item = await add(bulkId, lead.name);
    const skipped = await add(bulkId, (await deal()).name);
    await updateBulkItem(db, bulkId, skipped.id, { skip: true });
    const failed = await add(bulkId, 'x', 'não é uma exportação', 'a.txt');
    const fileId = await fileOf(lead.id);
    await startBulk(db, bulkId, OURS);
    await applyItem(bulkId, item.id, fileId);

    expect(await undo(bulkId)).toEqual({ undone: 1, removed: 3 });
    expect((await itemRow(skipped.id)).state).toBe('pulada');
    expect(await itemRow(failed.id)).toMatchObject({ state: 'falhou', error: 'not_an_export' });
  });

  it('answers a second undo of the whole lote with nothing undone, and keeps who undid it first', async () => {
    const { bulkId } = await writtenBulk(1);
    await undo(bulkId);
    const first = await bulkRow(bulkId);
    expect(await undo(bulkId)).toEqual({ undone: 0, removed: 0 });
    const second = await bulkRow(bulkId);
    expect(second.state).toBe('desfeito');
    expect(second.undoneAt).toEqual(first.undoneAt);
  });
});

describe('the final report', () => {
  it('has ids and counts only: no file name, contact name, deal name or text', async () => {
    const { bulkId, rows } = await writtenBulk(2);
    const [one, two] = rows as [(typeof rows)[number], (typeof rows)[number]];
    await undo(bulkId, two.item.id);

    const csv = bulkReport(await bulkOf(db, bulkId));
    expect(csv.endsWith('\n')).toBe(true);
    const [header, ...lines] = csv.trimEnd().split('\n');
    expect(header).toBe(
      'lote;item;posicao;negociacao;par;situacao;motivo;mensagens;novas;ja_existentes;importacao',
    );
    expect(lines).toHaveLength(2);
    const batchOf = async (leadId: string) => (await batchesOf(leadId))[0]!.id;
    expect(lines[0]!.split(';')).toEqual([
      bulkId,
      one.item.id,
      '1',
      one.lead.id,
      'nome',
      'gravada',
      '',
      '3',
      '3',
      '0',
      await batchOf(one.lead.id),
    ]);
    expect(lines[1]!.split(';')).toEqual([
      bulkId,
      two.item.id,
      '2',
      two.lead.id,
      'nome',
      'desfeita',
      '',
      '3',
      '3',
      '0',
      await batchOf(two.lead.id),
    ]);
    for (const secret of [...NEVER_RECORDED, 'Teste', '.txt', one.lead.name, two.lead.name, OURS])
      expect(csv).not.toContain(secret);
  });

  it('shows the reason of an item that was skipped for lack of a pair, and one that failed', async () => {
    const bulkId = await newBulk();
    const lead = await deal();
    await add(bulkId, lead.name);
    await add(bulkId, `Sem Negociacao ${++seq}`);
    await add(bulkId, 'x', 'não é uma exportação', 'a.txt');
    await startBulk(db, bulkId, OURS);

    const lines = bulkReport(await bulkOf(db, bulkId))
      .trimEnd()
      .split('\n')
      .slice(1);
    const rows = lines.map((line) => line.split(';'));
    expect(rows.map((r) => [r[2], r[5], r[6]])).toEqual([
      ['1', 'pendente', ''],
      ['2', 'pulada', 'sem_par'],
      ['3', 'falhou', 'not_an_export'],
    ]);
    // A pair that was not found has no deal and no pairing in its columns.
    expect(rows[1]!.slice(3, 5)).toEqual(['', '']);
    expect(rows.every((r) => r.length === 11)).toBe(true);
  });
});
