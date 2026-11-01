import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contactOptOuts,
  leadEvents,
  waContacts,
  waConversations,
  waTemplates,
} from '../../db/schema/index.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  admin,
  ago,
  apply,
  app,
  chatOfPerson,
  db,
  deal,
  fixtures,
  mediaUploads,
  NUMBER_TOKEN,
  numberId,
  owner,
  PERSON,
  resetCentral,
  sends,
  startCentral,
  stopCentral,
  WORK_ID,
} from './central-fixtures.js';
import { fakeRecording } from './voice-fixtures.js';

/**
 * The one "não me contate" register (docs/crm/nao-me-contate.md, #56) on the Central's own ways
 * out: a work number's template, text, file and voice, inside its window too (Eric, 30/10), a SAIR
 * said to the official number included, and a template to a conversation no deal took yet. Setup
 * in `central-fixtures.ts`.
 */

let recording: Buffer;

beforeAll(async () => {
  await startCentral();
  recording = await fakeRecording(2);
}, 60_000);
afterAll(stopCentral);
beforeEach(async () => {
  await resetCentral();
  await db.delete(contactOptOuts);
});

const template = (conversationId: string, cookies: Record<string, string>, name: string) =>
  app.inject({
    method: 'POST',
    url: `/whatsapp/conversations/${conversationId}/template`,
    cookies,
    payload: { name, language: 'pt_BR', params: [], companyArticle: 'a' },
  });

const say = (conversationId: string) =>
  app.inject({
    method: 'POST',
    url: `/whatsapp/conversations/${conversationId}/text`,
    cookies: owner.cookies,
    payload: { text: 'Certo, anotado.' },
  });

/** Text, file and voice on the work number's chat: 409, on the timeline, nothing to Meta. */
async function expectRefused(chatId: string, leadId: string, origin: string) {
  const refusals = [
    await say(chatId),
    await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chatId}/media`,
      cookies: owner.cookies,
      payload: { fileId: randomUUID(), caption: 'Proposta' },
    }),
    await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chatId}/voice`,
      cookies: owner.cookies,
      headers: { 'content-type': 'audio/webm;codecs=opus', 'idempotency-key': randomUUID() },
      payload: recording,
    }),
  ];
  expect(refusals.map((r) => [r.statusCode, r.json().error])).toEqual(
    refusals.map(() => [409, 'contact_blocked']),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(sends).toHaveLength(0);
  expect(mediaUploads).toHaveLength(0);
  const events = await db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'lead.contact_blocked')));
  expect(events.map((e) => e.detail).slice(-3)).toEqual(
    ['texto', 'arquivo', 'audio_gravado'].map((path) => ({ channel: 'whatsapp', path, origin })),
  );
}

describe('"não me contate" on what the Central starts', () => {
  it('a work number sends nothing to a deal with the register: template, text, file or voice', async () => {
    await apply(fixtures.message('wamid.CB1', ago(5)));
    const chat = (await chatOfPerson())!;
    const leadId = await deal(PERSON, owner.id);
    await db.update(waConversations).set({ leadId }).where(eq(waConversations.id, chat.id));
    await recordContactOptOut(db, {
      leadId,
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: owner.id,
    });

    // The number's templates are read first, as "Usar modelo" does: only the register refuses.
    const synced = await app.inject({
      method: 'GET',
      url: `/whatsapp/templates?numberId=${numberId}`,
      cookies: owner.cookies,
    });
    expect(synced.statusCode).toBe(200);
    // Inside the window a template would go as a common message: it is still Wings starting.
    const blocked = await template(chat.id, owner.cookies, 'retomar_conversa_numero');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'contact_blocked',
      message: expect.stringContaining('Pediu para não ser contatado'),
    });
    expect(sends).toHaveLength(0);
    const events = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'lead.contact_blocked')));
    expect(events.map((e) => e.detail)).toEqual([
      { channel: 'whatsapp', path: 'modelo', origin: 'crm' },
    ]);

    // The person wrote first, to this number: inside its window, nothing goes either (Eric, 30/10).
    await expectRefused(chat.id, leadId, 'crm');
  });

  it("a SAIR to the official number stops the work number's text, file and voice", async () => {
    await apply(fixtures.message('wamid.CB2', ago(5)));
    const chat = (await chatOfPerson())!;
    const leadId = await deal(PERSON, owner.id);
    await db.update(waConversations).set({ leadId }).where(eq(waConversations.id, chat.id));
    // What intake.ts writes on a SAIR: the official number's contact and the register, by phone.
    await db
      .update(waContacts)
      .set({ optOutAt: ago(2) })
      .where(eq(waContacts.phone, PERSON));
    await recordContactOptOut(db, {
      phone: PERSON,
      channels: ['whatsapp'],
      origin: 'whatsapp_palavra',
      reason: null,
      createdBy: null,
    });
    await expectRefused(chat.id, leadId, 'whatsapp_palavra');

    // Without the lock, the same typed reply goes, by the number's own token.
    await db.update(waContacts).set({ optOutAt: null }).where(eq(waContacts.phone, PERSON));
    await db.update(contactOptOuts).set({ revokedAt: ago(1) });
    const reply = await say(chat.id);
    expect(reply.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: `/v23.0/${WORK_ID}/messages`,
      auth: `Bearer ${NUMBER_TOKEN}`,
      body: { type: 'text' },
    });
  });

  it('a conversation no deal took yet is checked by its phone, on the official number too', async () => {
    const phone = '5521988880077';
    await db
      .insert(waTemplates)
      .values({
        name: 'so_do_oficial',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Olá! Só no número oficial.' }],
      })
      .onConflictDoNothing();
    const [contact] = await db
      .insert(waContacts)
      .values({ phone })
      .onConflictDoUpdate({ target: [waContacts.tenantId, waContacts.phone], set: { phone } })
      .returning({ id: waContacts.id });
    const [conversation] = await db
      .insert(waConversations)
      .values({ contactId: contact!.id, leadId: null, numberId: null })
      .returning({ id: waConversations.id });
    await recordContactOptOut(db, {
      phone,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: null,
      createdBy: admin.id,
    });

    const blocked = await template(conversation!.id, admin.cookies, 'so_do_oficial');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'contact_blocked' });
    expect(sends).toHaveLength(0);

    // Revoked, the same template goes: the register was the only thing in the way.
    await db.update(contactOptOuts).set({ revokedAt: ago(1) });
    const sent = await template(conversation!.id, admin.cookies, 'so_do_oficial');
    expect(sent.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toMatchObject({ type: 'template' });
  });
});
