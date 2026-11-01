import type { WaMessage } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  driveFiles,
  driveFileVersions,
  leadFiles,
  waMessageFiles,
} from '../../db/schema/index.js';
import { storageOf } from '../../lib/storage/index.js';
import { storeWhatsAppMedia } from './media-store.js';
import {
  app,
  clock,
  db,
  downloads,
  openDealWith,
  otherSeller,
  PDF,
  PHONE_ID,
  resetMediaSend,
  seller,
  sendFile,
  startMediaSend,
  stopMediaSend,
  TOKEN,
  WABA,
  whatsappFetch,
  type Session,
} from './media-send-fixtures.js';

/**
 * The bubble of a file we sent on WhatsApp: it opens the Drive file (the version that went), a
 * file in the trash is taken from Meta, another seller gets 404, and the received-files queue
 * leaves it alone. Setup in `media-send-fixtures.ts`. No test reaches the network.
 */

beforeAll(startMediaSend, 60_000);
afterAll(stopMediaSend);
beforeEach(resetMediaSend);

describe('the bubble of a sent file', () => {
  const open = (session: Session, messageId: string) =>
    app.inject({ url: `/whatsapp/messages/${messageId}/media`, cookies: session.cookies });
  const follow = (location: string) =>
    app.inject({ url: location.replace('http://localhost:5173/api', '') });

  it('opens the Drive file, the version that went, and writes the read down by id', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;

    const first = await open(seller, messageId);
    expect(first.statusCode).toBe(302);
    expect((await follow(first.headers.location as string)).rawPayload.equals(PDF)).toBe(true);
    expect(downloads).toHaveLength(0);
    const [read] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'drive.file_previewed'), eq(auditLog.entityId, fileId)));
    expect(read!.metadata).toMatchObject({
      purpose: 'whatsapp_message',
      messageId,
      leadId,
      version: 1,
    });

    // The file gets a new version in the Drive: the bubble keeps showing what was sent.
    const file = await db.query.driveFiles.findFirst({ where: eq(driveFiles.id, fileId) });
    const newer = Buffer.from('%PDF-1.4 proposta revista');
    const newKey = `${file!.storageKey}-v2`;
    await storageOf(app.wings)!.put(newKey, newer, 'application/pdf');
    await db.insert(driveFileVersions).values({
      fileId,
      version: 1,
      mimeType: file!.mimeType,
      byteSize: file!.byteSize,
      storageKey: file!.storageKey,
    });
    await db
      .update(driveFiles)
      .set({ version: 2, storageKey: newKey, byteSize: newer.length })
      .where(eq(driveFiles.id, fileId));
    const again = await open(seller, messageId);
    expect((await follow(again.headers.location as string)).rawPayload.equals(PDF)).toBe(true);
  });

  it('a file put in the trash is taken from Meta, as a received one', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;
    await db.update(driveFiles).set({ trashedAt: clock }).where(eq(driveFiles.id, fileId));
    const res = await open(seller, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('FROMMETA');
    expect(downloads).toEqual(['/v23.0/MEDIA1']);
  });

  it('another seller gets 404', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const res = await open(otherSeller, sent.json<{ message: WaMessage }>().message.id);
    expect(res.statusCode).toBe(404);
  });

  it('the received-files queue never copies back from Meta what we sent', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;
    await storeWhatsAppMedia({
      db,
      storage: storageOf(app.wings)!,
      config: { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA },
      fetchImpl: whatsappFetch,
      log: () => {},
      now: () => clock,
    });
    const queued = await db
      .select()
      .from(waMessageFiles)
      .where(eq(waMessageFiles.messageId, messageId));
    expect(queued).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    // The link between the deal and the file is the deal's Arquivos, untouched.
    expect(
      await db.$count(
        leadFiles,
        and(eq(leadFiles.leadId, leadId), eq(leadFiles.driveFileId, fileId)),
      ),
    ).toBe(1);
  });
});
