import type { WaMessage } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  clients,
  driveFiles,
  driveFolders,
  leads,
  waContacts,
  waConversations,
  waMediaUploads,
  waMessages,
} from '../../db/schema/index.js';
import { storageOf } from '../../lib/storage/index.js';
import { fakeJpeg } from '../../test/factories.js';
import {
  accepted,
  admin,
  app,
  clock,
  db,
  DAY,
  deal,
  dealFile,
  json,
  nextPhone,
  openDealWith,
  otherSeller,
  PDF,
  personWrites,
  PHOTO,
  PHONE_ID,
  resetMediaSend,
  seller,
  sendFile,
  sends,
  setClock,
  setNextSend,
  setNextUpload,
  signed,
  START,
  startMediaSend,
  stopMediaSend,
  unix,
  uploads,
  WABA,
} from './media-send-fixtures.js';

/**
 * A deal's file sent in its WhatsApp conversation, end to end against a simulated Meta and the
 * local storage: the file goes up to the deal's files first, then by its id; only inside the
 * 24-hour window, only a file of that deal, the brand's voice on the caption and the name, a photo
 * over 5 MB as a document, Meta's id kept and uploaded again when Meta loses it, and the audit by
 * id. The bubble is in `media-bubble.test.ts`; setup in `media-send-fixtures.ts`. No test reaches
 * the network and no real message leaves.
 */

beforeAll(startMediaSend, 60_000);
afterAll(stopMediaSend);
beforeEach(resetMediaSend);

describe('sending a file of the deal', () => {
  it('a photo goes by its Meta id with the caption, kept in the deal and audited by id', async () => {
    const { leadId, fileId } = await openDealWith('fachada.jpg', 'image/jpeg', PHOTO);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Olha a fachada',
    });
    expect(res.statusCode).toBe(201);
    const message = res.json<{ message: WaMessage }>().message;
    expect(message).toMatchObject({
      direction: 'out',
      kind: 'image',
      text: 'Olha a fachada',
      status: 'sent',
      media: { mimeType: 'image/jpeg', filename: 'fachada.jpg' },
    });
    expect(uploads).toEqual([{ type: 'image/jpeg', size: PHOTO.length, name: 'fachada.jpg' }]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      type: 'image',
      image: { id: 'MEDIA1', caption: 'Olha a fachada' },
    });
    const [row] = await db.select().from(waMessages).where(eq(waMessages.id, message.id));
    expect(row!.content).toEqual({
      media: { id: 'MEDIA1', mimeType: 'image/jpeg', filename: 'fachada.jpg' },
      file: { fileId, version: 1 },
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'whatsapp.message_sent'), eq(auditLog.entityId, leadId)));
    expect(audit!.metadata).toMatchObject({
      messageId: message.id,
      kind: 'media',
      fileId,
      sentAs: 'image',
      outcome: 'sent',
    });
    expect(JSON.stringify(audit!.metadata)).not.toContain('fachada');
  });

  it('the second send of the same file reuses the Meta id; a new version goes up again', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    for (const caption of ['Segue a proposta', 'De novo']) {
      const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId, caption });
      expect(res.statusCode).toBe(201);
    }
    expect(uploads).toHaveLength(1);
    expect(sends.map((s) => s.document)).toEqual([
      { id: 'MEDIA1', caption: 'Segue a proposta', filename: 'proposta.pdf' },
      { id: 'MEDIA1', caption: 'De novo', filename: 'proposta.pdf' },
    ]);
    // 25 days later Meta's copy is about to go: it goes up again.
    setClock(new Date(START.getTime() + 25 * DAY));
    await personWrites((await db.query.leads.findFirst({ where: eq(leads.id, leadId) }))!.phone!);
    const later = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(later.statusCode).toBe(201);
    expect(uploads).toHaveLength(2);
    expect(sends.at(-1)).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA2', filename: 'proposta.pdf' },
    });
    expect((sends.at(-1)!.document as Record<string, unknown>).caption).toBeUndefined();
  });

  it('a new version of the file in the Drive goes up again', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    expect((await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId })).statusCode).toBe(
      201,
    );
    const file = await db.query.driveFiles.findFirst({ where: eq(driveFiles.id, fileId) });
    const newer = Buffer.from('%PDF-1.4 proposta revista, mais longa');
    const newKey = `${file!.storageKey}-v2`;
    await storageOf(app.wings)!.put(newKey, newer, 'application/pdf');
    await db
      .update(driveFiles)
      .set({ version: 2, storageKey: newKey, byteSize: newer.length })
      .where(eq(driveFiles.id, fileId));
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(201);
    expect(uploads.map((u) => u.size)).toEqual([PDF.length, newer.length]);
    expect(sends.at(-1)).toMatchObject({ document: { id: 'MEDIA2' } });
    const [row] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.id, res.json<{ message: WaMessage }>().message.id));
    expect(row!.content).toMatchObject({ file: { fileId, version: 2 } });
  });

  it('an MP4 goes as a video with its caption', async () => {
    const { leadId, fileId } = await openDealWith(
      'volta.mp4',
      'video/mp4',
      Buffer.from('fake mp4 bytes'),
    );
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Tour pela loja',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ message: WaMessage }>().message.kind).toBe('video');
    expect(uploads[0]!.type).toBe('video/mp4');
    expect(sends[0]).toMatchObject({
      type: 'video',
      video: { id: 'MEDIA1', caption: 'Tour pela loja' },
    });
  });

  it('a file the storage cannot read is not sent', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    await db
      .update(driveFiles)
      .set({ storageKey: 'drive/nao-existe' })
      .where(eq(driveFiles.id, fileId));
    const before = await db.$count(waMessages);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'media_upload_failed' });
    expect(res.json().message).toContain('Nada foi enviado');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(await db.$count(waMessages)).toBe(before);
  });

  it("a deal's file kept in another department's folder: the seller cannot send it, the Drive's reader can", async () => {
    const { leadId, fileId } = await openDealWith('contrato.pdf', 'application/pdf', PDF);
    // As if someone with that Drive attached a Jurídico file to the deal.
    const juridico = await db.query.driveFolders.findFirst({
      where: eq(driveFolders.department, 'juridico'),
    });
    await db.update(driveFiles).set({ folderId: juridico!.id }).where(eq(driveFiles.id, fileId));
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('file_not_found');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    // The seller holds the conversation: the Admin takes it first (attendance.ts).
    const [conversation] = await db
      .select({ id: waConversations.id, version: waConversations.version })
      .from(waConversations)
      .where(eq(waConversations.leadId, leadId));
    const take = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation!.id}/assign`,
      cookies: admin.cookies,
      payload: { version: conversation!.version, employeeId: admin.id },
    });
    expect(take.statusCode).toBe(204);
    const byAdmin = await sendFile(admin, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(byAdmin.statusCode).toBe(201);
  });

  it('a send Meta fails because the file is gone drops the id; the next one uploads again', async () => {
    const { leadId, fileId } = await openDealWith('lista.pdf', 'application/pdf', PDF);
    setNextSend(() => json({ error: { code: 131053, message: 'media upload error' } }, 400));
    const failed = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(failed.statusCode).toBe(201);
    expect(failed.json<{ message: WaMessage }>().message.status).toBe('failed');
    const [kept] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.driveFileId, fileId));
    expect(kept!.invalidAt).not.toBeNull();
    setNextSend(() => accepted());
    const again = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(again.json<{ message: WaMessage }>().message.status).toBe('sent');
    expect(uploads).toHaveLength(2);
  });

  it('a failure that comes later by the webhook drops the id too', async () => {
    const { leadId, fileId } = await openDealWith('mapa.pdf', 'application/pdf', PDF);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const id = res.json<{ message: WaMessage }>().message.id;
    const [row] = await db.select().from(waMessages).where(eq(waMessages.id, id));
    await signed(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556696643', phone_number_id: PHONE_ID },
                  statuses: [
                    {
                      id: row!.wamid,
                      status: 'failed',
                      timestamp: unix(clock),
                      recipient_id: '552199990001',
                      errors: [{ code: 131052, title: 'Media download error' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const [kept] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.driveFileId, fileId));
    expect(kept!.invalidAt).not.toBeNull();
  });

  it('a photo over 5 MB goes as a document with its name', async () => {
    const big = fakeJpeg(4000, 3000, 6_000_000);
    const { leadId, fileId } = await openDealWith('obra.jpg', 'image/jpeg', big);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Em alta',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ message: WaMessage }>().message.kind).toBe('document');
    expect(uploads[0]).toMatchObject({ type: 'image/jpeg', size: big.length });
    expect(sends[0]).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA1', caption: 'Em alta', filename: 'obra.jpg' },
    });
  });

  it("an M4A goes as audio under Meta's name for it, and an audio takes no caption", async () => {
    const { leadId, fileId } = await openDealWith(
      'recado.m4a',
      'audio/x-m4a',
      Buffer.from('fake m4a audio bytes'),
    );
    const captioned = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Ouça',
    });
    expect(captioned.statusCode).toBe(422);
    expect(captioned.json().error).toBe('caption_not_allowed');
    expect(uploads).toHaveLength(0);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(201);
    expect(uploads[0]!.type).toBe('audio/mp4');
    expect(sends[0]).toEqual(expect.objectContaining({ type: 'audio', audio: { id: 'MEDIA1' } }));
    const message = res.json<{ message: WaMessage }>().message;
    expect(message).toMatchObject({ kind: 'audio', text: null });
    // The bubble's player gets it as audio, in place, not as a download.
    const bubble = await app.inject({
      url: `/whatsapp/messages/${message.id}/media`,
      cookies: seller.cookies,
    });
    expect(bubble.statusCode).toBe(302);
    const served = await app.inject({
      url: (bubble.headers.location as string).replace('http://localhost:5173/api', ''),
    });
    expect(served.headers['content-type']).toContain('audio/x-m4a');
    expect(String(served.headers['content-disposition'])).toMatch(/^inline/);
  });

  it('outside the 24-hour window nothing goes up nor out', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    setClock(new Date(START.getTime() + DAY + 60_000));
    const before = await db.$count(waMessages);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('window_closed');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(await db.$count(waMessages)).toBe(before);
  });

  it('a file of another deal, or one taken out of the deal, is not found', async () => {
    const mine = await openDealWith('minha.pdf', 'application/pdf', PDF);
    const theirs = await openDealWith('outra.pdf', 'application/pdf', PDF);
    const res = await sendFile(seller, `/leads/${mine.leadId}/whatsapp/media`, {
      fileId: theirs.fileId,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('file_not_found');
    await app.inject({
      method: 'DELETE',
      url: `/leads/${mine.leadId}/files/${mine.fileId}`,
      cookies: seller.cookies,
    });
    const removed = await sendFile(seller, `/leads/${mine.leadId}/whatsapp/media`, {
      fileId: mine.fileId,
    });
    expect(removed.statusCode).toBe(404);
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("another seller's deal answers 404, by deal and by conversation", async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const [conversation] = await db
      .select({ id: waConversations.id })
      .from(waConversations)
      .where(eq(waConversations.leadId, leadId));
    for (const path of [
      `/leads/${leadId}/whatsapp/media`,
      `/whatsapp/conversations/${conversation!.id}/media`,
    ]) {
      const res = await sendFile(otherSeller, path, { fileId });
      expect(res.statusCode, path).toBe(404);
    }
    expect(sends).toHaveLength(0);
  });

  it('by the conversation, the file of its deal goes to that conversation', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const [conversation] = await db
      .select({ id: waConversations.id })
      .from(waConversations)
      .where(eq(waConversations.leadId, leadId));
    const res = await sendFile(seller, `/whatsapp/conversations/${conversation!.id}/media`, {
      fileId,
    });
    expect(res.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
  });

  it('a conversation no deal took yet has no files to send', async () => {
    const phone = nextPhone();
    await personWrites(phone);
    const contact = await db.query.waContacts.findFirst({ where: eq(waContacts.phone, phone) });
    const [conversation] = await db
      .select({ id: waConversations.id, leadId: waConversations.leadId })
      .from(waConversations)
      .where(eq(waConversations.contactId, contact!.id));
    expect(conversation!.leadId).toBeNull();
    const { fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const res = await sendFile(admin, `/whatsapp/conversations/${conversation!.id}/media`, {
      fileId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_deal');
    expect(uploads).toHaveLength(0);
  });

  it("a brand's lead: a caption or a file name citing Wings is refused before anything goes", async () => {
    const [brand] = await db
      .insert(clients)
      .values({
        name: 'Casal do Churros',
        slug: 'casal-do-churros-arquivo',
        number: 91,
        relationship: 'expansao',
        franchiseOnSale: true,
        article: 'o',
      })
      .returning({ id: clients.id });
    const phone = nextPhone();
    const leadId = await deal(phone, seller.id, { pipeline: 'expansao', clientId: brand!.id });
    await personWrites(phone);
    const plain = await dealFile(seller, leadId, 'cardapio.pdf', 'application/pdf', PDF);
    const named = await dealFile(seller, leadId, 'Wings - cardapio.pdf', 'application/pdf', PDF);
    const caption = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId: plain,
      caption: 'Da Wings para você',
    });
    expect(caption.statusCode).toBe(422);
    expect(caption.json()).toMatchObject({ error: 'brand_voice' });
    const name = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId: named });
    expect(name.statusCode).toBe(422);
    expect(name.json().message).toContain('o nome do arquivo cita a Wings');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const fine = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId: plain,
      caption: 'Segue o cardápio',
    });
    expect(fine.statusCode).toBe(201);
  });

  it('a file Meta refuses to take is not sent, and the reason says so', async () => {
    const { leadId, fileId } = await openDealWith(
      'pacote.zip',
      'application/zip',
      Buffer.from('PK fake zip'),
    );
    setNextUpload(() => json({ error: { code: 100, message: 'Param file must be...' } }, 400));
    const before = await db.$count(waMessages);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'media_upload_failed',
      message: expect.stringContaining('a Meta não aceita este tipo de arquivo'),
    });
    expect(res.json().message).toContain('Nada foi enviado');
    // The same file would be refused again: the way out is another format.
    expect(res.json().message).toContain('envie em outro formato');
    expect(res.json().message).not.toContain('tente de novo');
    expect(sends).toHaveLength(0);
    expect(await db.$count(waMessages)).toBe(before);
  });

  it('a file over 100 MB is refused before it goes up', async () => {
    const { leadId, fileId } = await openDealWith('video.mov', 'video/quicktime', PDF);
    // Recorded as the Drive keeps it; the bytes themselves are never read.
    await db.update(driveFiles).set({ byteSize: 150_000_000 }).where(eq(driveFiles.id, fileId));
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(413);
    expect(uploads).toHaveLength(0);
  });
});
