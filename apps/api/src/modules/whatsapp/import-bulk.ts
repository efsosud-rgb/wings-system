import {
  WA_BULK_MAX_ITEMS,
  type WaBulkImport,
  type WaBulkItem,
  type WaBulkItemState,
  type WaBulkMatch,
} from '@wings/shared';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees, leads, waBulkImportItems, waBulkImports } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadHasFile } from '../leads/files.js';
import { ImportError, applyImport, previewImport, undoImport } from './import.js';
import { chatPhonesOf, contactNameOf, normalizeName, parseNameMap } from './import-match.js';
import { guessOurSide, parseWhatsAppExport, participantsOf } from './import-parse.js';
import { openLeadByPhone } from './intake.js';

/**
 * "Importar em lote" (docs/whatsapp/importar-conversa.md): many exports at once. A lote-pai
 * (`wa_bulk_imports`) holds one item per conversation, paired with a deal; each item is then written
 * by `applyImport`, the same as one import from the deal's page (no notice, no Sofia, no task, no
 * unread, the 24-hour window untouched), one at a time and resumable. The screen and the CLI
 * (`scripts/whatsapp-import-bulk.ts`) both go through here.
 */

export type BulkErrorCode =
  | 'not_found'
  | 'not_in_preview'
  | 'too_many'
  | 'lead_not_found'
  | 'file_not_found'
  | 'not_pending'
  | 'unknown_side';

export class BulkError extends Error {
  constructor(readonly code: BulkErrorCode) {
    super(code);
  }
}

type Row = typeof waBulkImportItems.$inferSelect;

interface Pair {
  leadId: string | null;
  match: WaBulkMatch | null;
  candidates: number;
}

/** The single deal a set of numbers points to, or how many there are when they disagree. */
async function dealOfPhones(db: Database, phones: string[]) {
  const found = new Set<string>();
  for (const phone of phones) {
    const id = await openLeadByPhone(db, phone);
    if (id) found.add(id);
  }
  return [...found];
}

/** Open deals with a phone whose name or company is exactly this contact name. */
async function dealsNamed(db: Database, contactName: string) {
  const wanted = normalizeName(contactName);
  if (!wanted) return [];
  const rows = await db
    .select({ id: leads.id, name: leads.name, companyName: leads.companyName })
    .from(leads)
    .where(and(isNull(leads.won), isNotNull(leads.phone)));
  return rows
    .filter(
      (row) =>
        (row.name && normalizeName(row.name) === wanted) ||
        (row.companyName && normalizeName(row.companyName) === wanted),
    )
    .map((row) => row.id);
}

/**
 * The deal of a conversation: the contact's number in the chat, then the Admin's map, then the
 * name. Each step takes a deal only when exactly one fits; a tie goes on to the next step and, at
 * the end, leaves the conversation without a pair (with the count of deals that fitted).
 */
export async function pairOf(
  db: Database,
  clues: {
    phones: { authors: string[]; written: string[] };
    contactName: string | null;
    nameMap: Record<string, string>;
  },
): Promise<Pair> {
  let candidates = 0;
  for (const phones of [clues.phones.authors, clues.phones.written]) {
    if (phones.length === 0) continue;
    const deals = await dealOfPhones(db, phones);
    if (deals.length === 1) return { leadId: deals[0]!, match: 'telefone', candidates: 1 };
    candidates = Math.max(candidates, deals.length);
  }
  const mapped = clues.contactName ? clues.nameMap[normalizeName(clues.contactName)] : undefined;
  if (mapped) {
    const deals = await dealOfPhones(db, [mapped]);
    if (deals.length === 1) return { leadId: deals[0]!, match: 'mapa', candidates: 1 };
  }
  if (clues.contactName) {
    const deals = await dealsNamed(db, clues.contactName);
    if (deals.length === 1) return { leadId: deals[0]!, match: 'nome', candidates: 1 };
    candidates = Math.max(candidates, deals.length);
  }
  return { leadId: null, match: null, candidates };
}

async function bulkRow(db: Database, bulkId: string) {
  const bulk = await db.query.waBulkImports.findFirst({ where: eq(waBulkImports.id, bulkId) });
  if (!bulk) throw new BulkError('not_found');
  return bulk;
}

/** A lote-pai, in preview; the map, when given, is read once and kept until the lote ends. */
export async function createBulk(
  db: Database,
  input: { source: 'tela' | 'cli'; createdBy: string; nameMap?: string },
): Promise<string> {
  const [bulk] = await db
    .insert(waBulkImports)
    .values({
      source: input.source,
      createdBy: input.createdBy,
      nameMap: input.nameMap ? parseNameMap(input.nameMap) : null,
    })
    .returning({ id: waBulkImports.id });
  return bulk!.id;
}

/** Counts of a paired conversation against its deal: new lines and the ones it already has. */
async function countsFor(db: Database, leadId: string | null, text: string) {
  if (!leadId) return null;
  const preview = await previewImport(db, leadId, text);
  return { newCount: preview.newMessages };
}

/** One conversation into the lote: read, paired and counted; nothing goes to the deal yet. */
export async function addBulkItem(
  db: Database,
  bulkId: string,
  input: { fileName: string; byteSize: number; text: string },
): Promise<WaBulkItem> {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state !== 'previa') throw new BulkError('not_in_preview');
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waBulkImportItems)
    .where(eq(waBulkImportItems.bulkId, bulkId));
  if (count >= WA_BULK_MAX_ITEMS) throw new BulkError('too_many');
  const base = { bulkId, position: count + 1, fileName: input.fileName, byteSize: input.byteSize };
  const parsed = parseWhatsAppExport(input.text);
  if (!parsed || parsed.messages.length === 0) {
    const [row] = await db
      .insert(waBulkImportItems)
      .values({ ...base, state: 'falhou', error: 'not_an_export' })
      .returning();
    return (await itemsOf(db, [row!]))[0]!;
  }
  const participants = participantsOf(parsed);
  const ourGuess = guessOurSide(participants.map((p) => p.name));
  const contactName = contactNameOf(
    input.fileName,
    participants.map((p) => p.name),
    ourGuess,
  );
  const pair = await pairOf(db, {
    phones: chatPhonesOf(parsed, ourGuess),
    contactName,
    nameMap: bulk.nameMap ?? {},
  });
  const counts = await countsFor(db, pair.leadId, input.text);
  const [row] = await db
    .insert(waBulkImportItems)
    .values({
      ...base,
      chatText: input.text,
      platform: parsed.platform,
      contactName,
      participants,
      leadId: pair.leadId,
      match: pair.match,
      candidates: pair.candidates,
      messageCount: parsed.messages.length,
      newCount: counts?.newCount ?? 0,
      firstAt: parsed.messages[0]!.at,
      lastAt: parsed.messages.at(-1)!.at,
    })
    .returning();
  return (await itemsOf(db, [row!]))[0]!;
}

async function pendingItem(db: Database, bulkId: string, itemId: string) {
  const item = await db.query.waBulkImportItems.findFirst({
    where: and(eq(waBulkImportItems.id, itemId), eq(waBulkImportItems.bulkId, bulkId)),
  });
  if (!item) throw new BulkError('not_found');
  return item;
}

/** The Admin's correction: another deal (`manual`), or skip the conversation, or take it back. */
export async function updateBulkItem(
  db: Database,
  bulkId: string,
  itemId: string,
  patch: { leadId: string } | { skip: boolean },
): Promise<WaBulkItem> {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state !== 'previa') throw new BulkError('not_in_preview');
  const item = await pendingItem(db, bulkId, itemId);
  if (item.state !== 'pendente' && item.state !== 'pulada') throw new BulkError('not_pending');
  let set: Partial<Row>;
  if ('leadId' in patch) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, patch.leadId) });
    if (!lead) throw new BulkError('lead_not_found');
    const counts = await countsFor(db, lead.id, item.chatText ?? '');
    set = {
      leadId: lead.id,
      match: 'manual',
      candidates: 1,
      newCount: counts?.newCount ?? 0,
      state: 'pendente',
    };
  } else set = { state: patch.skip ? 'pulada' : 'pendente' };
  const [row] = await db
    .update(waBulkImportItems)
    .set(set)
    .where(eq(waBulkImportItems.id, item.id))
    .returning();
  return (await itemsOf(db, [row!]))[0]!;
}

/**
 * The Admin confirms: the Wings' name is fixed for every file and the conversations without a
 * pair are skipped. Then each item is written by `applyBulkItem`, one at a time.
 */
export async function startBulk(db: Database, bulkId: string, ourName: string) {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state !== 'previa') throw new BulkError('not_in_preview');
  const items = await db
    .select()
    .from(waBulkImportItems)
    .where(eq(waBulkImportItems.bulkId, bulkId));
  if (!items.some((item) => item.participants.some((p) => p.name === ourName)))
    throw new BulkError('unknown_side');
  await db.transaction(async (tx) => {
    await tx
      .update(waBulkImportItems)
      .set({ state: 'pulada', error: 'sem_par' })
      .where(
        and(
          eq(waBulkImportItems.bulkId, bulkId),
          eq(waBulkImportItems.state, 'pendente'),
          isNull(waBulkImportItems.leadId),
        ),
      );
    await tx
      .update(waBulkImports)
      .set({ state: 'gravando', ourName })
      .where(eq(waBulkImports.id, bulkId));
  });
  await finishIfDone(db, bulkId);
}

/** The lote ends when nothing is pending: written, its map and the waiting texts cleared. */
async function finishIfDone(db: Database, bulkId: string) {
  const [pending] = await db
    .select({ id: waBulkImportItems.id })
    .from(waBulkImportItems)
    .where(and(eq(waBulkImportItems.bulkId, bulkId), eq(waBulkImportItems.state, 'pendente')))
    .limit(1);
  if (pending) return;
  await db
    .update(waBulkImportItems)
    .set({ chatText: null })
    .where(eq(waBulkImportItems.bulkId, bulkId));
  await db
    .update(waBulkImports)
    .set({ state: 'gravado', appliedAt: new Date(), nameMap: null })
    .where(and(eq(waBulkImports.id, bulkId), eq(waBulkImports.state, 'gravando')));
}

const ITEM_ERROR_STATE: Partial<Record<string, WaBulkItemState>> = { nothing_new: 'sem_novas' };

/**
 * Writes one conversation as an ordinary import, with its exported file already among the deal's
 * files. The item row is locked for the whole write, so a second click waits and then finds it done.
 */
export async function applyBulkItem(
  db: Database,
  bulkId: string,
  itemId: string,
  input: { fileId: string; actorEmployeeId: string; ip: string | null },
): Promise<WaBulkItem> {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state !== 'gravando' || !bulk.ourName) throw new BulkError('not_pending');
  const ourName = bulk.ourName;
  const row = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [item] = await tx
      .select()
      .from(waBulkImportItems)
      .where(and(eq(waBulkImportItems.id, itemId), eq(waBulkImportItems.bulkId, bulkId)))
      .for('update');
    if (!item) throw new BulkError('not_found');
    if (item.state !== 'pendente' || !item.leadId || item.chatText === null)
      throw new BulkError('not_pending');
    if (!(await leadHasFile(txDb, item.leadId, input.fileId)))
      throw new BulkError('file_not_found');
    const lead = await txDb.query.leads.findFirst({ where: eq(leads.id, item.leadId) });
    if (!lead) throw new BulkError('lead_not_found');
    let set: Partial<Row>;
    try {
      const batch = await applyImport(txDb, {
        lead,
        text: item.chatText,
        ourName,
        fileId: input.fileId,
        actorEmployeeId: input.actorEmployeeId,
      });
      set = {
        state: 'gravada',
        batchId: batch.id,
        newCount: batch.messageCount,
        driveFileId: input.fileId,
        chatText: null,
        error: null,
      };
      await writeAudit(txDb, {
        actorEmployeeId: input.actorEmployeeId,
        action: 'whatsapp.conversation_imported',
        entity: 'lead',
        entityId: lead.id,
        ip: input.ip,
        metadata: {
          bulkId,
          itemId: item.id,
          batchId: batch.id,
          fileId: input.fileId,
          platform: batch.platform,
          messages: batch.messageCount,
          from: batch.firstAt.toISOString(),
          to: batch.lastAt.toISOString(),
        },
      });
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      set = {
        state: ITEM_ERROR_STATE[error.code] ?? 'falhou',
        error: error.code,
        chatText: null,
        driveFileId: input.fileId,
      };
    }
    const [saved] = await tx
      .update(waBulkImportItems)
      .set(set)
      .where(eq(waBulkImportItems.id, item.id))
      .returning();
    return saved!;
  });
  await finishIfDone(db, bulkId);
  return (await itemsOf(db, [row]))[0]!;
}

/** Undoes the lote's written conversations, or one of them; the exported files stay with the deals. */
export async function undoBulk(
  db: Database,
  bulkId: string,
  input: { itemId?: string; actorEmployeeId: string; ip: string | null },
): Promise<{ undone: number; removed: number }> {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state === 'previa') throw new BulkError('not_pending');
  const written = await db
    .select()
    .from(waBulkImportItems)
    .where(
      and(
        eq(waBulkImportItems.bulkId, bulkId),
        eq(waBulkImportItems.state, 'gravada'),
        ...(input.itemId ? [eq(waBulkImportItems.id, input.itemId)] : []),
      ),
    );
  if (input.itemId && written.length === 0) throw new BulkError('not_found');
  let removed = 0;
  for (const item of written) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const [locked] = await tx
        .select({ state: waBulkImportItems.state })
        .from(waBulkImportItems)
        .where(eq(waBulkImportItems.id, item.id))
        .for('update');
      if (locked?.state !== 'gravada') return;
      const undone = await undoImport(txDb, {
        leadId: item.leadId!,
        batchId: item.batchId!,
        actorEmployeeId: input.actorEmployeeId,
      });
      removed += undone.removed;
      await tx
        .update(waBulkImportItems)
        .set({ state: 'desfeita' })
        .where(eq(waBulkImportItems.id, item.id));
      await writeAudit(txDb, {
        actorEmployeeId: input.actorEmployeeId,
        action: 'whatsapp.import_undone',
        entity: 'lead',
        entityId: item.leadId!,
        ip: input.ip,
        metadata: { bulkId, itemId: item.id, batchId: item.batchId, removed: undone.removed },
      });
    });
  }
  const [left] = await db
    .select({ id: waBulkImportItems.id })
    .from(waBulkImportItems)
    .where(
      and(
        eq(waBulkImportItems.bulkId, bulkId),
        inArray(waBulkImportItems.state, ['gravada', 'pendente']),
      ),
    )
    .limit(1);
  if (!left)
    await db
      .update(waBulkImports)
      .set({
        state: 'desfeito',
        undoneAt: new Date(),
        undoneBy: input.actorEmployeeId,
        nameMap: null,
      })
      // A second undo of a lote already undone keeps the first one's record.
      .where(and(eq(waBulkImports.id, bulkId), ne(waBulkImports.state, 'desfeito')));
  return { undone: written.length, removed };
}

/** A lote still in preview thrown away: its conversations' texts and the map leave the database. */
export async function discardBulk(db: Database, bulkId: string) {
  const bulk = await bulkRow(db, bulkId);
  if (bulk.state !== 'previa') throw new BulkError('not_in_preview');
  await db
    .delete(waBulkImports)
    .where(and(eq(waBulkImports.id, bulkId), eq(waBulkImports.state, 'previa')));
}

async function itemsOf(db: Database, rows: Row[]): Promise<WaBulkItem[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.leadId ? [row.leadId] : [])))];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await db
            .select({ id: leads.id, name: leads.name })
            .from(leads)
            .where(inArray(leads.id, ids))
        ).map((lead) => [lead.id, lead.name] as const),
  );
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    fileName: row.fileName,
    byteSize: row.byteSize,
    platform: row.platform === 'ios' ? 'ios' : row.platform === 'android' ? 'android' : null,
    contactName: row.contactName,
    participants: row.participants,
    leadId: row.leadId,
    leadName: row.leadId ? (names.get(row.leadId) ?? null) : null,
    match: row.match as WaBulkMatch | null,
    candidates: row.candidates,
    messages: row.messageCount,
    newMessages: row.newCount,
    // Without a deal nothing can already be there.
    existingMessages: row.leadId ? Math.max(0, row.messageCount - row.newCount) : 0,
    first: row.firstAt?.toISOString() ?? null,
    last: row.lastAt?.toISOString() ?? null,
    state: row.state as WaBulkItemState,
    error: row.error,
    batchId: row.batchId,
  }));
}

/** The lote and its items, in the order they came in. */
export async function bulkOf(db: Database, bulkId: string): Promise<WaBulkImport> {
  const [found] = await db
    .select({ bulk: waBulkImports, createdByName: employees.fullName })
    .from(waBulkImports)
    .leftJoin(employees, eq(employees.id, waBulkImports.createdBy))
    .where(eq(waBulkImports.id, bulkId));
  if (!found) throw new BulkError('not_found');
  const rows = await db
    .select()
    .from(waBulkImportItems)
    .where(eq(waBulkImportItems.bulkId, bulkId))
    .orderBy(asc(waBulkImportItems.position));
  const votes = new Map<string, number>();
  for (const row of rows) {
    const guess = guessOurSide(row.participants.map((p) => p.name));
    if (guess) votes.set(guess, (votes.get(guess) ?? 0) + 1);
  }
  const suggested = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const { bulk, createdByName } = found;
  return {
    id: bulk.id,
    source: bulk.source === 'cli' ? 'cli' : 'tela',
    state: bulk.state as WaBulkImport['state'],
    ourName: bulk.ourName,
    suggestedOurName: suggested,
    hasNameMap: bulk.nameMap !== null && Object.keys(bulk.nameMap).length > 0,
    createdAt: bulk.createdAt.toISOString(),
    createdByName: createdByName ?? null,
    appliedAt: bulk.appliedAt?.toISOString() ?? null,
    undoneAt: bulk.undoneAt?.toISOString() ?? null,
    items: await itemsOf(db, rows),
  };
}

/**
 * The final report: ids and counts only, as CSV. No file name, contact or deal name, since a
 * file name names the person.
 */
export function bulkReport(bulk: WaBulkImport): string {
  const header = [
    'lote',
    'item',
    'posicao',
    'negociacao',
    'par',
    'situacao',
    'motivo',
    'mensagens',
    'novas',
    'ja_existentes',
    'importacao',
  ];
  const lines = bulk.items.map((item) =>
    [
      bulk.id,
      item.id,
      item.position,
      item.leadId ?? '',
      item.match ?? '',
      item.state,
      item.error ?? '',
      item.messages,
      item.newMessages,
      item.existingMessages,
      item.batchId ?? '',
    ].join(';'),
  );
  return [header.join(';'), ...lines].join('\n') + '\n';
}
