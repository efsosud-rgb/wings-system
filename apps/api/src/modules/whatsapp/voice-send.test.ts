import { randomUUID } from 'node:crypto';
import { WA_VOICE_MAX_SECONDS, WA_VOICE_UPLOAD_MAX_BYTES, type WaMessage } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  leadEvents,
  leadFiles,
  waMessages,
  waVoiceSends,
} from '../../db/schema/index.js';
import { setOfficialLive } from '../../test/factories.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  admin,
  app,
  db,
  deal,
  nextPhone,
  personWrites,
  resetMediaSend,
  seller,
  sends,
  sessionFor,
  setNextUpload,
  startMediaSend,
  stopMediaSend,
  uploads,
  json as metaAnswer,
  type Session,
} from './media-send-fixtures.js';
import { fakeRecording } from './voice-fixtures.js';

/**
 * A voice note recorded in the conversation (docs/whatsapp/cloud-api.md, "Gravar áudio"), on the
 * official number, against a simulated Meta and the local storage: converted to OGG/OPUS, kept in
 * the deal's files, sent once by the one way out with `voice: true`, and refused with nothing kept
 * by the same locks as a typed reply plus "não me contate". The work number's own token is in
 * `central-voice.test.ts`. No test reaches the network and no real message leaves.
 */

let recording: Buffer;
let diretoria: Session;

beforeAll(async () => {
  await startMediaSend();
  recording = await fakeRecording(2);
  diretoria = await sessionFor('diretoria');
}, 60_000);
afterAll(stopMediaSend);
beforeEach(resetMediaSend);

/** The screen's key goes with every recording; the same key is the same recording sent again. */
const record = (
  session: Session,
  leadId: string,
  body: Buffer,
  type = 'audio/webm;codecs=opus',
  key: string = randomUUID(),
) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/whatsapp/voice`,
    cookies: session.cookies,
    headers: { 'content-type': type, 'idempotency-key': key },
    payload: body,
  });

/** A deal of the seller; the person wrote (window open) unless told otherwise. */
async function sellerDeal(open = true) {
  const phone = nextPhone();
  const leadId = await deal(phone, seller.id);
  if (open) await personWrites(phone);
  return { phone, leadId };
}

const filesOf = (leadId: string) => db.select().from(leadFiles).where(eq(leadFiles.leadId, leadId));

describe('a voice note recorded in the conversation', () => {
  it('is converted, kept in the deal files and sent once as a voice message', async () => {
    const { leadId } = await sellerDeal();
    const res = await record(seller, leadId, recording);
    expect(res.statusCode).toBe(201);
    const message = res.json<{ message: WaMessage }>().message;
    expect(message).toMatchObject({
      direction: 'out',
      kind: 'audio',
      status: 'sent',
      media: { mimeType: 'audio/ogg', filename: expect.stringMatching(/^audio-whatsapp-.+\.ogg$/) },
    });
    // Up to Meta as OGG, much smaller than what the browser recorded.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.type).toBe('audio/ogg');
    expect(uploads[0]!.size).toBeLessThan(recording.length);
    expect(sends).toEqual([
      expect.objectContaining({ type: 'audio', audio: { id: 'MEDIA1', voice: true } }),
    ]);
    // In the deal's Arquivos, like an attached file, and the bubble plays it from there.
    const files = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/files`,
      cookies: seller.cookies,
    });
    const [kept] = files.json<{ files: { fileId: string; mimeType: string }[] }>().files;
    expect(kept).toMatchObject({ mimeType: 'audio/ogg' });
    const [row] = await db.select().from(waMessages).where(eq(waMessages.id, message.id));
    expect(row!.content).toMatchObject({
      file: { fileId: kept!.fileId, version: 1 },
      voice: { seconds: 2 },
    });
    const bubble = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${message.id}/media`,
      cookies: seller.cookies,
    });
    expect(bubble.statusCode).toBeLessThan(400);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'whatsapp.message_sent'), eq(auditLog.entityId, leadId)));
    expect(audit!.metadata).toMatchObject({
      kind: 'voice',
      voice: true,
      fileId: kept!.fileId,
      sentAs: 'audio',
      outcome: 'sent',
    });
  });

  it("takes Safari's MP4 and Firefox's OGG too", async () => {
    for (const [container, type] of [
      ['mp4', 'audio/mp4'],
      ['ogg', 'audio/ogg;codecs=opus'],
    ] as const) {
      const { leadId } = await sellerDeal();
      const res = await record(seller, leadId, await fakeRecording(1, container), type);
      expect(res.statusCode).toBe(201);
    }
    expect(sends.map((s) => s.audio)).toEqual([
      { id: 'MEDIA1', voice: true },
      { id: 'MEDIA2', voice: true },
    ]);
  });
});

describe('what is refused, with nothing kept and nothing sent', () => {
  it('refuses a format the system does not read, and bytes that are not audio', async () => {
    const { leadId } = await sellerDeal();
    const wav = await record(seller, leadId, recording, 'audio/wav');
    expect(wav.statusCode).toBe(415);
    expect(wav.json()).toMatchObject({ error: 'unsupported_audio' });
    const json = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/voice`,
      cookies: seller.cookies,
      payload: { audio: 'x' },
    });
    expect(json.statusCode).toBe(415);
    const garbage = await record(seller, leadId, Buffer.from('não é áudio'));
    expect(garbage.statusCode).toBe(422);
    expect(garbage.json()).toMatchObject({ error: 'voice_unreadable' });
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('refuses a recording too big to take, and one too long', async () => {
    const { leadId } = await sellerDeal();
    const big = await record(seller, leadId, Buffer.alloc(WA_VOICE_UPLOAD_MAX_BYTES + 1));
    expect(big.statusCode).toBe(413);
    const long = await record(seller, leadId, await fakeRecording(WA_VOICE_MAX_SECONDS + 5));
    expect(long.statusCode).toBe(413);
    expect(long.json()).toMatchObject({ error: 'voice_too_long' });
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 30_000);

  it('refuses outside the 24-hour window', async () => {
    const { leadId } = await sellerDeal(false);
    const res = await record(seller, leadId, recording);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'window_closed' });
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('refuses to a deal with "não me contate", and writes why on the timeline', async () => {
    const { leadId } = await sellerDeal();
    await recordContactOptOut(db, {
      leadId,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: null,
      createdBy: seller.id,
    });
    const res = await record(seller, leadId, recording);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'contact_blocked' });
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'lead.contact_blocked')));
    expect(event!.detail).toMatchObject({ channel: 'whatsapp', path: 'audio_gravado' });
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("keeps the seller's lock of the official number", async () => {
    const { leadId } = await sellerDeal();
    await setOfficialLive(db, false);
    const res = await record(seller, leadId, recording);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'whatsapp_soon' });
    expect(sends).toHaveLength(0);
  });

  it('refuses who does not hold the conversation, and who does not edit the deal', async () => {
    const { leadId } = await sellerDeal();
    expect((await record(seller, leadId, recording)).statusCode).toBe(201);
    // The seller holds it now: the admin takes it before answering.
    const notHolder = await record(admin, leadId, recording);
    expect(notHolder.statusCode).toBe(409);
    expect(notHolder.json()).toMatchObject({ error: 'not_holder' });
    // Diretoria talks on any deal but does not edit it: the audio would go into its files.
    const phone = nextPhone();
    const other = { leadId: await deal(phone, diretoria.id) };
    await personWrites(phone);
    const reader = await record(diretoria, other.leadId, recording);
    expect(reader.statusCode).toBe(403);
    expect(reader.json()).toMatchObject({ error: 'files_forbidden' });
    expect(await filesOf(other.leadId)).toHaveLength(0);
    expect(sends).toHaveLength(1);
  });
});

describe('one recording, one audio (review of t084)', () => {
  it('a second try with the same key gets the message that went, not a second audio', async () => {
    const { leadId } = await sellerDeal();
    const key = randomUUID();
    const first = await record(seller, leadId, recording, undefined, key);
    expect(first.statusCode).toBe(201);
    // The answer was lost on the way (a network error): the screen sends the same recording again.
    const again = await record(seller, leadId, recording, undefined, key);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ message: WaMessage }>().message.id).toBe(
      first.json<{ message: WaMessage }>().message.id,
    );
    expect(sends).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(await filesOf(leadId)).toHaveLength(1);
  });

  it('two clicks at the same moment send one audio and keep one file', async () => {
    const { leadId } = await sellerDeal();
    const key = randomUUID();
    const both = await Promise.all([
      record(seller, leadId, recording, undefined, key),
      record(seller, leadId, recording, undefined, key),
    ]);
    const codes = both.map((r) => r.statusCode).sort();
    // The second one either waits for nothing (still going) or finds the message that went.
    expect(codes[0] === 200 || codes[0] === 201).toBe(true);
    expect([201, 409]).toContain(codes[1]);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(await filesOf(leadId)).toHaveLength(1);
  });

  it('keeps nothing when Meta does not take the upload, and a new click keeps one audio', async () => {
    const { leadId } = await sellerDeal();
    const key = randomUUID();
    setNextUpload(() =>
      metaAnswer({ error: { code: 131053, message: 'Media upload error' } }, 400),
    );
    const failed = await record(seller, leadId, recording, undefined, key);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: 'media_upload_failed' });
    expect(failed.json().message).toContain('Nada foi enviado nem guardado');
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(await db.select().from(waVoiceSends).where(eq(waVoiceSends.key, key))).toHaveLength(0);
    // The same recording again, once Meta takes it: one file, one audio.
    setNextUpload(() => null);
    const sent = await record(seller, leadId, recording, undefined, key);
    expect(sent.statusCode).toBe(201);
    expect(await filesOf(leadId)).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it('refuses a recording without the key, with nothing kept and nothing sent', async () => {
    const { leadId } = await sellerDeal();
    const res = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/voice`,
      cookies: seller.cookies,
      headers: { 'content-type': 'audio/webm;codecs=opus' },
      payload: recording,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'voice_key_missing' });
    expect(await filesOf(leadId)).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
