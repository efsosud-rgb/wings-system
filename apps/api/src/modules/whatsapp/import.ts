import {
  canonicalWhatsAppPhone,
  type WaImportBatch,
  type WaImportLine,
  type WaImportPreview,
} from '@wings/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import {
  employees,
  leadEvents,
  waContacts,
  waConversations,
  waImportBatches,
  waMessages,
} from '../../db/schema/index.js';
import {
  guessOurSide,
  parseWhatsAppExport,
  participantsOf,
  type ExportMessage,
  type ParsedExport,
} from './import-parse.js';
import { conversationFor } from './intake.js';
import { contactOfPhone } from './thread.js';

/**
 * A conversation brought in from a phone's "Exportar conversa" (docs/whatsapp/importar-conversa.md),
 * always onto a deal that already exists: the file has no phone number, so the deal is the link.
 * The messages are history: no Sofia turn, no notice, no task, and the 24-hour window stays as it
 * was (the contact's last inbound is not touched). Nothing here logs a name or a text.
 */

export type ImportErrorCode =
  | 'not_an_export'
  | 'unknown_side'
  | 'nothing_new'
  | 'lead_without_phone'
  | 'not_found'
  | 'already_undone';

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

const INSERT_CHUNK = 1000;
const HASH_CHUNK = 5000;

function parseOrThrow(text: string): ParsedExport {
  const parsed = parseWhatsAppExport(text);
  if (!parsed || parsed.messages.length === 0) throw new ImportError('not_an_export');
  return parsed;
}

const lineOf = (message: ExportMessage): WaImportLine => ({
  at: message.at.toISOString(),
  author: message.author,
  kind: message.kind,
  text: message.text,
  file: message.file,
});

/** The hashes of these lines this deal already has (an earlier import of the same chat). */
async function knownHashes(db: Database, leadId: string, hashes: string[]) {
  const known = new Set<string>();
  for (let i = 0; i < hashes.length; i += HASH_CHUNK) {
    const rows = await db
      .select({ hash: waMessages.importHash })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.leadId, leadId),
          inArray(waMessages.importHash, hashes.slice(i, i + HASH_CHUNK)),
        ),
      );
    for (const row of rows) if (row.hash) known.add(row.hash);
  }
  return known;
}

/** What the file holds, before anything is written. */
export async function previewImport(
  db: Database,
  leadId: string,
  text: string,
): Promise<WaImportPreview> {
  const parsed = parseOrThrow(text);
  const known = await knownHashes(
    db,
    leadId,
    parsed.messages.map((message) => message.hash),
  );
  const participants = participantsOf(parsed);
  return {
    platform: parsed.platform,
    participants,
    ourName: guessOurSide(participants.map((p) => p.name)),
    messages: parsed.messages.length,
    newMessages: parsed.messages.filter((message) => !known.has(message.hash)).length,
    media: parsed.messages.filter((message) => message.file !== null || message.omitted).length,
    skipped: parsed.skipped,
    first: lineOf(parsed.messages[0]!),
    last: lineOf(parsed.messages.at(-1)!),
  };
}

/** The deal's contact (any form of its number) and conversation, opened when missing. */
async function conversationOfLead(db: Database, lead: { id: string; phone: string | null }) {
  if (!lead.phone) throw new ImportError('lead_without_phone');
  const contact =
    (await contactOfPhone(db, lead.phone)) ??
    (
      await db
        .insert(waContacts)
        .values({ phone: canonicalWhatsAppPhone(lead.phone) })
        .onConflictDoUpdate({
          target: [waContacts.tenantId, waContacts.phone],
          set: { updatedAt: new Date() },
        })
        .returning()
    )[0]!;
  const conversation = await conversationFor(db, contact.id, lead.id, {
    referral: null,
    originCode: null,
  });
  return { contact, conversation };
}

/**
 * Writes the lines the deal does not have yet, as one import. Each message keeps the file's time;
 * lines of the same minute keep the file's order a millisecond apart (`created_at`), which is
 * what the conversation is sorted by.
 */
export async function applyImport(
  db: Database,
  input: {
    lead: { id: string; phone: string | null };
    text: string;
    ourName: string;
    fileId: string;
    actorEmployeeId: string;
  },
) {
  const parsed = parseOrThrow(input.text);
  if (!participantsOf(parsed).some((p) => p.name === input.ourName))
    throw new ImportError('unknown_side');
  const { contact, conversation } = await conversationOfLead(db, input.lead);

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(waImportBatches)
      .values({
        leadId: input.lead.id,
        conversationId: conversation.id,
        driveFileId: input.fileId,
        platform: parsed.platform,
        messageCount: 0,
        firstAt: parsed.messages[0]!.at,
        lastAt: parsed.messages.at(-1)!.at,
        importedBy: input.actorEmployeeId,
      })
      .returning();
    const sameTime = new Map<number, number>();
    const rows = parsed.messages.map((message) => {
      const time = message.at.getTime();
      const order = sameTime.get(time) ?? 0;
      sameTime.set(time, order + 1);
      const ours = message.author === input.ourName;
      return {
        conversationId: conversation.id,
        contactId: contact.id,
        leadId: input.lead.id,
        direction: ours ? 'out' : 'in',
        author: ours ? 'app' : 'contact',
        kind: message.kind,
        text: message.text,
        content: {
          imported: { file: message.file, ...(message.omitted ? { omitted: true } : {}) },
        },
        waTimestamp: message.at,
        createdAt: new Date(time + order),
        importBatchId: batch!.id,
        importHash: message.hash,
      };
    });
    const written: { at: Date | null; createdAt: Date }[] = [];
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      written.push(
        ...(await tx
          .insert(waMessages)
          .values(rows.slice(i, i + INSERT_CHUNK))
          .onConflictDoNothing()
          .returning({ at: waMessages.waTimestamp, createdAt: waMessages.createdAt })),
      );
    }
    // Thrown inside the transaction: the empty import row goes away with it.
    if (written.length === 0) throw new ImportError('nothing_new');
    const times = written.map((row) => row.at!.getTime());
    const firstAt = new Date(times.reduce((a, b) => Math.min(a, b)));
    const lastAt = new Date(times.reduce((a, b) => Math.max(a, b)));
    const newest = written.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).createdAt;
    const [saved] = await tx
      .update(waImportBatches)
      .set({ messageCount: written.length, firstAt, lastAt })
      .where(eq(waImportBatches.id, batch!.id))
      .returning();
    await tx
      .update(waConversations)
      .set({
        lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${newest.toISOString()}::timestamptz)`,
      })
      .where(eq(waConversations.id, conversation.id));
    await tx.insert(leadEvents).values({
      leadId: input.lead.id,
      kind: 'whatsapp.conversation_imported',
      actorEmployeeId: input.actorEmployeeId,
      detail: {
        batchId: saved!.id,
        messages: written.length,
        from: firstAt.toISOString(),
        to: lastAt.toISOString(),
      },
    });
    return saved!;
  });
}

/** Removes exactly what one import wrote; the exported file stays among the deal's files. */
export async function undoImport(
  db: Database,
  input: { leadId: string; batchId: string; actorEmployeeId: string },
) {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(waImportBatches)
      .where(and(eq(waImportBatches.id, input.batchId), eq(waImportBatches.leadId, input.leadId)))
      .for('update');
    if (!batch) throw new ImportError('not_found');
    if (batch.undoneAt) throw new ImportError('already_undone');
    const removed = await tx
      .delete(waMessages)
      .where(eq(waMessages.importBatchId, batch.id))
      .returning({ id: waMessages.id });
    const [saved] = await tx
      .update(waImportBatches)
      .set({ undoneAt: new Date(), undoneBy: input.actorEmployeeId })
      .where(eq(waImportBatches.id, batch.id))
      .returning();
    await tx
      .update(waConversations)
      .set({
        lastMessageAt: sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${batch.conversationId})`,
      })
      .where(eq(waConversations.id, batch.conversationId));
    await tx.insert(leadEvents).values({
      leadId: input.leadId,
      kind: 'whatsapp.import_undone',
      actorEmployeeId: input.actorEmployeeId,
      detail: { batchId: batch.id, messages: removed.length },
    });
    return { batch: saved!, removed: removed.length };
  });
}

/** The deal's imports, newest first. */
export async function listImports(db: Database, leadId: string): Promise<WaImportBatch[]> {
  const importer = alias(employees, 'importer');
  const undoer = alias(employees, 'undoer');
  const rows = await db
    .select({
      batch: waImportBatches,
      importedByName: importer.fullName,
      undoneByName: undoer.fullName,
    })
    .from(waImportBatches)
    .leftJoin(importer, eq(importer.id, waImportBatches.importedBy))
    .leftJoin(undoer, eq(undoer.id, waImportBatches.undoneBy))
    .where(eq(waImportBatches.leadId, leadId))
    .orderBy(desc(waImportBatches.importedAt));
  return rows.map(({ batch, importedByName, undoneByName }) => ({
    id: batch.id,
    fileId: batch.driveFileId,
    platform: batch.platform === 'ios' ? 'ios' : 'android',
    messages: batch.messageCount,
    from: batch.firstAt.toISOString(),
    to: batch.lastAt.toISOString(),
    importedAt: batch.importedAt.toISOString(),
    importedByName: importedByName ?? null,
    undoneAt: batch.undoneAt?.toISOString() ?? null,
    undoneByName: undoneByName ?? null,
  }));
}
