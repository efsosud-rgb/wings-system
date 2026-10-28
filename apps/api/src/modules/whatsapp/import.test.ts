import {
  SESSION_COOKIE,
  WA_MESSAGES_PAGE,
  type DealWhatsApp,
  type RoleKey,
  type WaConversationItem,
  type WaImportBatch,
  type WaImportPreview,
  type WaMessage,
} from '@wings/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  driveFiles,
  driveFolders,
  leadEvents,
  leadFiles,
  leads,
  waContacts,
  waConversations,
  waImportBatches,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * Importing a phone's "Exportar conversa" onto a deal: the preview writes nothing, the apply writes
 * history (no window, no Sofia, no unread), the same file twice adds nothing, "Desfazer" removes
 * exactly one import, and a seller reaches only their own deals. Made-up chats; no network.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let folderId: string;
type Session = { id: string; cookies: Record<string, string> };
let admin: Session;
let seller: Session;
let otherSeller: Session;

const OURS = 'Wings Company';
const THEIRS = 'Marta Teste';

const CHAT = [
  '19/10/2026 14:00 - As mensagens e as chamadas são protegidas com a criptografia de ponta a ponta.',
  `19/10/2026 14:05 - ${OURS}: Olá! Vi o seu interesse.`,
  'Posso ligar hoje?',
  `19/10/2026 14:05 - ${THEIRS}: Pode sim`,
  `19/10/2026 14:05 - ${THEIRS}: IMG-20261019-WA0001.jpg (arquivo anexado)`,
  'Minha loja',
  `19/10/2026 14:06 - ${OURS}: ok`,
  `19/10/2026 14:06 - ${OURS}: ok`,
  `19/10/2026 14:07 - ${THEIRS}: <Mídia oculta>`,
].join('\n');

const LATER = [
  `19/10/2026 14:08 - ${OURS}: Combinado, amanhã às 10h`,
  `19/10/2026 14:09 - ${THEIRS}: Até logo`,
].join('\n');

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
  otherSeller = await sessionFor('vendedor_expansao');
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
/** A deal with a made-up phone, owned by `ownerId` (null: nobody). */
async function deal(ownerId: string | null, phone: string | null = `5521999${100000 + ++seq}`) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Negociação de Teste',
      phone,
      ownerEmployeeId: ownerId,
      pipeline: 'expansao',
    })
    .returning({ id: leads.id });
  return { id: row!.id, phone };
}

/** The exported file, as the deal's file tab keeps it: a Drive file linked to the deal. */
async function fileOf(leadId: string) {
  const [file] = await db
    .insert(driveFiles)
    .values({
      folderId,
      name: 'Conversa do WhatsApp.txt',
      mimeType: 'text/plain',
      byteSize: 10,
      storageKey: `drive/2026-10/import-${++seq}`,
      ownerId: admin.id,
    })
    .returning({ id: driveFiles.id });
  await db.insert(leadFiles).values({ leadId, driveFileId: file!.id, addedBy: admin.id });
  return file!.id;
}

const preview = (session: Session, leadId: string, text: string) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/whatsapp/imports/preview`,
    cookies: session.cookies,
    payload: { text },
  });
const apply = (
  session: Session,
  leadId: string,
  payload: { text: string; ourName?: string; fileId: string },
) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/whatsapp/imports`,
    cookies: session.cookies,
    payload: { ourName: OURS, ...payload },
  });
const list = (session: Session, leadId: string) =>
  app.inject({ url: `/leads/${leadId}/whatsapp/imports`, cookies: session.cookies });
const undo = (session: Session, leadId: string, batchId: string) =>
  app.inject({
    method: 'DELETE',
    url: `/leads/${leadId}/whatsapp/imports/${batchId}`,
    cookies: session.cookies,
  });
const older = (session: Session, leadId: string, before: string) =>
  app.inject({
    url: `/leads/${leadId}/whatsapp/messages?before=${before}`,
    cookies: session.cookies,
  });
const thread = async (session: Session, leadId: string) =>
  (
    await app.inject({ url: `/leads/${leadId}/whatsapp`, cookies: session.cookies })
  ).json<DealWhatsApp>();

const messagesOf = (leadId: string) =>
  db
    .select()
    .from(waMessages)
    .where(eq(waMessages.leadId, leadId))
    .orderBy(asc(waMessages.createdAt));
const batchesOf = (leadId: string) =>
  db.select().from(waImportBatches).where(eq(waImportBatches.leadId, leadId));
const eventsOf = (leadId: string, kind: string) =>
  db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, kind)));
const auditsOf = (leadId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, action)));
const conversationOf = async (leadId: string) =>
  (await db.select().from(waConversations).where(eq(waConversations.leadId, leadId)))[0];

/** A long export: one line a minute from 08:00, `Mensagem <n>`, the two sides taking turns. */
const longChat = (lines: number) =>
  Array.from({ length: lines }, (_, i) => {
    const minutes = 8 * 60 + i;
    const clock = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    return `19/10/2026 ${clock} - ${i % 2 === 0 ? OURS : THEIRS}: Mensagem ${i}`;
  }).join('\n');

describe('the preview', () => {
  it('describes the file and writes nothing', async () => {
    const lead = await deal(admin.id);
    const res = await preview(admin, lead.id, CHAT);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ preview: WaImportPreview }>().preview).toEqual({
      platform: 'android',
      participants: [
        { name: THEIRS, messages: 3 },
        { name: OURS, messages: 3 },
      ],
      ourName: OURS,
      messages: 6,
      newMessages: 6,
      media: 2,
      skipped: 1,
      first: {
        at: '2026-10-19T17:05:00.000Z',
        author: OURS,
        kind: 'text',
        text: 'Olá! Vi o seu interesse.\nPosso ligar hoje?',
        file: null,
      },
      last: {
        at: '2026-10-19T17:07:00.000Z',
        author: THEIRS,
        kind: 'unsupported',
        text: null,
        file: null,
      },
    });

    expect(await messagesOf(lead.id)).toEqual([]);
    expect(await batchesOf(lead.id)).toEqual([]);
    expect(await conversationOf(lead.id)).toBeUndefined();
    expect(await eventsOf(lead.id, 'whatsapp.conversation_imported')).toEqual([]);
    expect(await auditsOf(lead.id, 'whatsapp.conversation_imported')).toEqual([]);
  });
});

describe('applying an import', () => {
  it('writes the lines as history, in the file order, and records the import by ids and counts', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const res = await apply(admin, lead.id, { text: CHAT, fileId });
    expect(res.statusCode).toBe(201);
    const batch = res.json<{ import: WaImportBatch }>().import;
    expect(batch).toMatchObject({
      fileId,
      platform: 'android',
      messages: 6,
      from: '2026-10-19T17:05:00.000Z',
      to: '2026-10-19T17:07:00.000Z',
      undoneAt: null,
      undoneByName: null,
    });

    const rows = await messagesOf(lead.id);
    expect(
      rows.map((r) => [r.direction, r.author, r.kind, r.text, r.importBatchId === batch.id]),
    ).toEqual([
      ['out', 'app', 'text', 'Olá! Vi o seu interesse.\nPosso ligar hoje?', true],
      ['in', 'contact', 'text', 'Pode sim', true],
      ['in', 'contact', 'image', 'Minha loja', true],
      ['out', 'app', 'text', 'ok', true],
      ['out', 'app', 'text', 'ok', true],
      ['in', 'contact', 'unsupported', null, true],
    ]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.importHash ?? ''))).toBe(true);
    expect(new Set(rows.map((r) => r.importHash)).size).toBe(6);
    expect(rows[2]?.content).toEqual({ imported: { file: 'IMG-20261019-WA0001.jpg' } });
    expect(rows[5]?.content).toEqual({ imported: { file: null, omitted: true } });
    // The file's time, and a millisecond apart for lines of the same minute (that is the sort key).
    expect(rows.map((r) => r.waTimestamp?.toISOString())).toEqual([
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:06:00.000Z',
      '2026-10-19T17:06:00.000Z',
      '2026-10-19T17:07:00.000Z',
    ]);
    expect(rows.map((r) => r.createdAt.toISOString())).toEqual([
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:05:00.001Z',
      '2026-10-19T17:05:00.002Z',
      '2026-10-19T17:06:00.000Z',
      '2026-10-19T17:06:00.001Z',
      '2026-10-19T17:07:00.000Z',
    ]);

    const [event] = await eventsOf(lead.id, 'whatsapp.conversation_imported');
    expect(event).toMatchObject({
      actorEmployeeId: admin.id,
      detail: {
        batchId: batch.id,
        messages: 6,
        from: '2026-10-19T17:05:00.000Z',
        to: '2026-10-19T17:07:00.000Z',
      },
    });

    const [audit, ...rest] = await auditsOf(lead.id, 'whatsapp.conversation_imported');
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({
      actorEmployeeId: admin.id,
      entity: 'lead',
      metadata: { batchId: batch.id, fileId, platform: 'android', messages: 6 },
    });
    // Ids and counts only: neither side's name nor a word of the chat.
    const recorded = JSON.stringify([audit?.metadata, event?.detail]);
    for (const secret of [
      THEIRS,
      'Marta',
      OURS,
      'Wings',
      'Olá',
      'Pode sim',
      'Minha loja',
      'IMG-',
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it("imports an iPhone export, leaving out the app's own notice", async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const text = [
      `\u200e[19/10/2026 14:00:01] ${THEIRS}: \u200eAs mensagens e as ligações são protegidas com a criptografia de ponta a ponta.`,
      `\u200e[19/10/2026 14:05:33] ${OURS}: Bom dia!`,
      `\u200e[19/10/2026 14:06:10] ${THEIRS}: \u200e<anexado: 00000012-PHOTO-2026-10-19-14-06-10.jpg>`,
    ].join('\n');
    const seen = await preview(admin, lead.id, text);
    expect(seen.json<{ preview: WaImportPreview }>().preview).toMatchObject({
      platform: 'ios',
      messages: 2,
      media: 1,
      skipped: 1,
    });
    const res = await apply(admin, lead.id, { text, fileId });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ import: WaImportBatch }>().import).toMatchObject({
      platform: 'ios',
      messages: 2,
      from: '2026-10-19T17:05:33.000Z',
      to: '2026-10-19T17:06:10.000Z',
    });
    expect((await messagesOf(lead.id)).map((m) => [m.direction, m.kind, m.text])).toEqual([
      ['out', 'text', 'Bom dia!'],
      ['in', 'image', null],
    ]);
  });

  it('is history: the 24-hour window, Sofia and unread stay as they were', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    expect((await apply(admin, lead.id, { text: CHAT, fileId })).statusCode).toBe(201);

    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, lead.phone!));
    expect(contact).toBeDefined();
    expect(contact?.lastInboundAt).toBeNull();
    const conversation = await conversationOf(lead.id);
    expect(conversation).toMatchObject({ contactId: contact?.id, sofiaDueAt: null });
    expect(conversation?.lastMessageAt?.toISOString()).toBe('2026-10-19T17:07:00.000Z');
    expect((await thread(admin, lead.id)).window.open).toBe(false);
  });

  it('opens the conversation it needs closed, so the next real message starts a new one', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    expect((await apply(admin, lead.id, { text: CHAT, fileId })).statusCode).toBe(201);
    const conversation = await conversationOf(lead.id);
    expect(conversation).toMatchObject({ attendance: 'closed', sofiaDueAt: null });
    expect(conversation?.stateChangedAt).not.toBeNull();
  });

  it.each(['with_person', 'waiting_seller'] as const)(
    'leaves a conversation that already existed as it was (%s)',
    async (attendance) => {
      const lead = await deal(admin.id);
      const [contact] = await db.insert(waContacts).values({ phone: lead.phone! }).returning();
      const [existing] = await db
        .insert(waConversations)
        .values({ contactId: contact!.id, leadId: lead.id, attendance })
        .returning();
      const fileId = await fileOf(lead.id);

      const res = await apply(admin, lead.id, { text: CHAT, fileId });
      expect(res.statusCode).toBe(201);

      const after = await db
        .select()
        .from(waConversations)
        .where(eq(waConversations.leadId, lead.id));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: existing!.id,
        attendance,
        stateChangedAt: existing!.stateChangedAt,
        sofiaDueAt: null,
      });
      expect(after[0]?.lastMessageAt?.toISOString()).toBe('2026-10-19T17:07:00.000Z');
      expect((await messagesOf(lead.id)).every((m) => m.conversationId === existing!.id)).toBe(
        true,
      );
    },
  );

  it('shows the imported lines on the deal with their mark, and no delivery status on ours', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    await apply(admin, lead.id, { text: CHAT, fileId });

    const messages = (await thread(admin, lead.id)).messages;
    expect(messages.map((m) => m.text)).toEqual([
      'Olá! Vi o seu interesse.\nPosso ligar hoje?',
      'Pode sim',
      'Minha loja',
      'ok',
      'ok',
      null,
    ]);
    expect(messages.map((m) => m.imported)).toEqual([
      { file: null, omitted: false },
      { file: null, omitted: false },
      { file: 'IMG-20261019-WA0001.jpg', omitted: false },
      { file: null, omitted: false },
      { file: null, omitted: false },
      { file: null, omitted: true },
    ]);
    for (const message of messages.filter((m) => m.direction === 'out')) {
      expect(message).toMatchObject({ status: null, error: null, bySofia: false });
    }
    expect(messages.map((m) => m.at)).toEqual([
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:05:00.000Z',
      '2026-10-19T17:06:00.000Z',
      '2026-10-19T17:06:00.000Z',
      '2026-10-19T17:07:00.000Z',
    ]);
  });

  it('does not count the imported lines as unread in the inbox', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    await apply(admin, lead.id, { text: CHAT, fileId });

    const inbox = await app.inject({ url: '/whatsapp/conversations', cookies: admin.cookies });
    const item = inbox
      .json<{ conversations: WaConversationItem[] }>()
      .conversations.find((c) => c.leadId === lead.id);
    expect(item).toBeDefined();
    // The last line is the person's, after our last reply: unread but for the import mark.
    expect(item).toMatchObject({ lastDirection: 'in', unreadCount: 0 });
  });
});

describe('the same chat again', () => {
  it('adds nothing the second time, and the preview says so', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    expect((await apply(admin, lead.id, { text: CHAT, fileId })).statusCode).toBe(201);

    const again = await apply(admin, lead.id, { text: CHAT, fileId });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'nothing_new' });
    expect(await batchesOf(lead.id)).toHaveLength(1);
    expect(await messagesOf(lead.id)).toHaveLength(6);
    expect(await eventsOf(lead.id, 'whatsapp.conversation_imported')).toHaveLength(1);
    expect(await auditsOf(lead.id, 'whatsapp.conversation_imported')).toHaveLength(1);

    const seen = await preview(admin, lead.id, CHAT);
    expect(seen.json<{ preview: WaImportPreview }>().preview).toMatchObject({
      messages: 6,
      newMessages: 0,
    });
  });

  it('imports only the new lines of a longer export of the same chat', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    await apply(admin, lead.id, { text: CHAT, fileId });

    const longer = `${CHAT}\n${LATER}`;
    const seen = await preview(admin, lead.id, longer);
    expect(seen.json<{ preview: WaImportPreview }>().preview).toMatchObject({
      messages: 8,
      newMessages: 2,
    });
    const res = await apply(admin, lead.id, { text: longer, fileId });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ import: WaImportBatch }>().import).toMatchObject({
      messages: 2,
      from: '2026-10-19T17:08:00.000Z',
      to: '2026-10-19T17:09:00.000Z',
    });
    expect((await messagesOf(lead.id)).map((m) => m.text)).toEqual([
      'Olá! Vi o seu interesse.\nPosso ligar hoje?',
      'Pode sim',
      'Minha loja',
      'ok',
      'ok',
      null,
      'Combinado, amanhã às 10h',
      'Até logo',
    ]);
    expect(await batchesOf(lead.id)).toHaveLength(2);
    expect((await conversationOf(lead.id))?.lastMessageAt?.toISOString()).toBe(
      '2026-10-19T17:09:00.000Z',
    );
  });
});

describe('undoing an import', () => {
  it('removes exactly what the import wrote, once, and the same text can be imported again', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const first = (await apply(admin, lead.id, { text: CHAT, fileId })).json<{
      import: WaImportBatch;
    }>().import;
    // A later import of other lines stays when the first is undone.
    const second = (await apply(admin, lead.id, { text: `${CHAT}\n${LATER}`, fileId })).json<{
      import: WaImportBatch;
    }>().import;
    expect(await messagesOf(lead.id)).toHaveLength(8);

    const res = await undo(admin, lead.id, first.id);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ import: WaImportBatch; removed: number }>();
    expect(body.removed).toBe(6);
    expect(body.import).toMatchObject({ id: first.id, importedByName: expect.any(String) });
    expect(body.import.undoneAt).not.toBeNull();
    expect(body.import.undoneByName).not.toBeNull();

    expect((await messagesOf(lead.id)).map((m) => m.text)).toEqual([
      'Combinado, amanhã às 10h',
      'Até logo',
    ]);
    const [row] = await db.select().from(waImportBatches).where(eq(waImportBatches.id, first.id));
    expect(row?.undoneAt).toBeInstanceOf(Date);
    expect(row?.undoneBy).toBe(admin.id);
    expect(
      (await db.select().from(waImportBatches).where(eq(waImportBatches.id, second.id)))[0]
        ?.undoneAt,
    ).toBeNull();

    const [event] = await eventsOf(lead.id, 'whatsapp.import_undone');
    expect(event).toMatchObject({ detail: { batchId: first.id, messages: 6 } });
    const [audit] = await auditsOf(lead.id, 'whatsapp.import_undone');
    expect(audit).toMatchObject({
      actorEmployeeId: admin.id,
      metadata: { batchId: first.id, removed: 6 },
    });

    const twice = await undo(admin, lead.id, first.id);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: 'already_undone' });
    expect(await auditsOf(lead.id, 'whatsapp.import_undone')).toHaveLength(1);

    const listed = (await list(admin, lead.id)).json<{ imports: WaImportBatch[] }>().imports;
    expect(listed.map((b) => [b.id, b.undoneAt !== null])).toEqual([
      [second.id, false],
      [first.id, true],
    ]);

    // The undone lines are gone for good, so the whole export goes in again.
    const again = await apply(admin, lead.id, { text: `${CHAT}\n${LATER}`, fileId });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ import: WaImportBatch }>().import.messages).toBe(6);
    expect(await messagesOf(lead.id)).toHaveLength(8);
  });

  it('answers 404 for an import that is not this deal', async () => {
    const lead = await deal(admin.id);
    const other = await deal(admin.id);
    const fileId = await fileOf(other.id);
    const batch = (await apply(admin, other.id, { text: CHAT, fileId })).json<{
      import: WaImportBatch;
    }>().import;

    const wrongDeal = await undo(admin, lead.id, batch.id);
    expect(wrongDeal.statusCode).toBe(404);
    expect(wrongDeal.json()).toMatchObject({ error: 'not_found' });
    expect((await undo(admin, lead.id, crypto.randomUUID())).statusCode).toBe(404);
    expect(await messagesOf(other.id)).toHaveLength(6);
  });
});

describe('who may import', () => {
  it("a seller reaches only their own deal; another seller's gets 404 on every route", async () => {
    const lead = await deal(seller.id);
    const fileId = await fileOf(lead.id);
    const batch = (await apply(admin, lead.id, { text: CHAT, fileId })).json<{
      import: WaImportBatch;
    }>().import;
    const [anyMessage] = await messagesOf(lead.id);

    const refused = [
      await preview(otherSeller, lead.id, CHAT),
      await apply(otherSeller, lead.id, { text: `${CHAT}\n${LATER}`, fileId }),
      await list(otherSeller, lead.id),
      await undo(otherSeller, lead.id, batch.id),
      await older(otherSeller, lead.id, anyMessage!.id),
    ];
    expect(refused.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404]);
    // Nothing moved: the import is still there, the later lines never arrived.
    expect(await messagesOf(lead.id)).toHaveLength(6);
    expect((await batchesOf(lead.id)).map((b) => b.undoneAt)).toEqual([null]);
  });

  it('a seller cannot touch a deal nobody owns', async () => {
    const lead = await deal(null);
    const fileId = await fileOf(lead.id);
    expect((await preview(seller, lead.id, CHAT)).statusCode).toBe(404);
    expect((await apply(seller, lead.id, { text: CHAT, fileId })).statusCode).toBe(404);
    expect((await list(seller, lead.id)).statusCode).toBe(404);
    expect(await messagesOf(lead.id)).toEqual([]);
  });

  it('the owner imports, lists and undoes on their own deal', async () => {
    const lead = await deal(seller.id);
    const fileId = await fileOf(lead.id);
    expect((await preview(seller, lead.id, CHAT)).statusCode).toBe(200);
    const applied = await apply(seller, lead.id, { text: CHAT, fileId });
    expect(applied.statusCode).toBe(201);
    const batch = applied.json<{ import: WaImportBatch }>().import;

    const listed = (await list(seller, lead.id)).json<{ imports: WaImportBatch[] }>().imports;
    expect(listed.map((b) => b.id)).toEqual([batch.id]);
    expect((await auditsOf(lead.id, 'whatsapp.conversation_imported'))[0]?.actorEmployeeId).toBe(
      seller.id,
    );
    expect((await undo(seller, lead.id, batch.id)).statusCode).toBe(200);
    expect(await messagesOf(lead.id)).toEqual([]);
  });

  it('Diretoria reads the history but never imports or undoes one (no leads.write)', async () => {
    const board = await sessionFor('diretoria');
    const lead = await deal(seller.id);
    const fileId = await fileOf(lead.id);
    const batch = (await apply(seller, lead.id, { text: CHAT, fileId })).json<{
      import: WaImportBatch;
    }>().import;

    expect((await list(board, lead.id)).statusCode).toBe(200);
    const refused = [
      await preview(board, lead.id, CHAT),
      await apply(board, lead.id, { text: `${CHAT}\n${LATER}`, fileId }),
      await undo(board, lead.id, batch.id),
    ];
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect(await messagesOf(lead.id)).toHaveLength(6);
    expect((await batchesOf(lead.id)).map((b) => b.undoneAt)).toEqual([null]);
  });

  it('a level without leads.whatsapp is refused with 403', async () => {
    const marketing = await sessionFor('marketing');
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const batch = (await apply(admin, lead.id, { text: CHAT, fileId })).json<{
      import: WaImportBatch;
    }>().import;
    const [anyMessage] = await messagesOf(lead.id);

    const refused = [
      await preview(marketing, lead.id, CHAT),
      await apply(marketing, lead.id, { text: CHAT, fileId }),
      await list(marketing, lead.id),
      await undo(marketing, lead.id, batch.id),
      await older(marketing, lead.id, anyMessage!.id),
    ];
    expect(refused.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
  });
});

describe('what is refused', () => {
  it("answers 404 file_not_found for a file that is not one of the deal's", async () => {
    const lead = await deal(admin.id);
    const other = await deal(admin.id);
    const foreign = await fileOf(other.id);
    for (const fileId of [foreign, crypto.randomUUID()]) {
      const res = await apply(admin, lead.id, { text: CHAT, fileId });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'file_not_found' });
    }
    expect(await messagesOf(lead.id)).toEqual([]);
    expect(await batchesOf(lead.id)).toEqual([]);
  });

  it('answers 409 lead_without_phone for a deal with no phone', async () => {
    const lead = await deal(admin.id, null);
    const fileId = await fileOf(lead.id);
    const res = await apply(admin, lead.id, { text: CHAT, fileId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'lead_without_phone' });
    expect(await batchesOf(lead.id)).toEqual([]);
    expect(await conversationOf(lead.id)).toBeUndefined();
  });

  it('answers 400 unknown_side when the chosen name is not in the file', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const res = await apply(admin, lead.id, { text: CHAT, ourName: 'Outra Pessoa', fileId });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unknown_side' });
    expect(await batchesOf(lead.id)).toEqual([]);
    expect(await messagesOf(lead.id)).toEqual([]);
  });

  it('answers 422 not_an_export for a text that is not a WhatsApp export', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const text = 'Lista de compras\n- arroz\n- feijão';
    const seen = await preview(admin, lead.id, text);
    expect(seen.statusCode).toBe(422);
    expect(seen.json()).toMatchObject({ error: 'not_an_export' });
    const res = await apply(admin, lead.id, { text, fileId });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'not_an_export' });
    expect(await batchesOf(lead.id)).toEqual([]);
  });

  it('answers 400 for an empty text or a missing side, and 404 for a malformed deal id', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    expect((await preview(admin, lead.id, '')).statusCode).toBe(400);
    const noSide = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/whatsapp/imports`,
      cookies: admin.cookies,
      payload: { text: CHAT, fileId },
    });
    expect(noSide.statusCode).toBe(400);
    expect((await preview(admin, 'not-a-uuid', CHAT)).statusCode).toBe(404);
  });
});

describe('older messages', () => {
  it('shows the newest page of a long chat and pages back to the oldest, in order', async () => {
    const lead = await deal(admin.id);
    const fileId = await fileOf(lead.id);
    const total = WA_MESSAGES_PAGE + 20;
    const res = await apply(admin, lead.id, { text: longChat(total), fileId });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ import: WaImportBatch }>().import.messages).toBe(total);

    const shown = (await thread(admin, lead.id)).messages;
    expect(shown).toHaveLength(WA_MESSAGES_PAGE);
    expect(shown.map((m) => m.text)).toEqual(
      Array.from({ length: WA_MESSAGES_PAGE }, (_, i) => `Mensagem ${i + 20}`),
    );

    const page = await older(admin, lead.id, shown[0]!.id);
    expect(page.statusCode).toBe(200);
    const olderOnes = page.json<{ messages: WaMessage[] }>().messages;
    expect(olderOnes.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Mensagem ${i}`),
    );
    expect(olderOnes.every((m) => m.imported !== null)).toBe(true);

    // Nothing is older than the oldest line.
    const end = await older(admin, lead.id, olderOnes[0]!.id);
    expect(end.json<{ messages: WaMessage[] }>().messages).toEqual([]);
    // A message of another deal is no anchor.
    const other = await deal(admin.id);
    const otherFile = await fileOf(other.id);
    await apply(admin, other.id, { text: CHAT, fileId: otherFile });
    const [foreign] = await messagesOf(other.id);
    const stray = await older(admin, lead.id, foreign!.id);
    expect(stray.json<{ messages: WaMessage[] }>().messages).toEqual([]);
    expect((await older(admin, lead.id, 'not-a-uuid')).statusCode).toBe(400);
  });
});
