import type { DealWhatsApp, WaInboxPage, WaNewTarget } from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  leadEvents,
  waContacts,
  waConversations,
  waMessages,
  waNumberTemplates,
  waTemplates,
} from '../../db/schema/index.js';
import { setOfficialLive } from '../../test/factories.js';
import { applyWhatsAppPayload } from './intake.js';
import {
  admin,
  ago,
  apply,
  app,
  chatOfPerson,
  db,
  deal,
  fixtures,
  list,
  NUMBER_TOKEN,
  numberId,
  otherSeller,
  owner,
  PERSON,
  PHONE_ID,
  resetCentral,
  sends,
  startCentral,
  stopCentral,
  templateReads,
  unix,
  WABA,
  WORK_ID,
  WORK_WABA,
  workChange,
  clock,
} from './central-fixtures.js';

/**
 * The Central WhatsApp (docs/whatsapp/central.md), what the team does: sending through the work
 * number's own token, who reaches a work number's chat, the list's filters and pages, and joining a
 * chat to a deal. Setup in `central-fixtures.ts`.
 */
beforeAll(startCentral, 60_000);
afterAll(stopCentral);
beforeEach(resetCentral);

describe('sending through a work number', () => {
  it('goes with the number’s own token and id, inside the 24 h of the person’s last message there', async () => {
    // Sellers are locked out of the official number; their own work number is not.
    await setOfficialLive(db, false);
    await apply(fixtures.message('wamid.S1', ago(60)));
    const chat = await chatOfPerson();
    const res = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi! Aqui é do comercial.' },
    });
    expect(res.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: `/v23.0/${WORK_ID}/messages`,
      auth: `Bearer ${NUMBER_TOKEN}`,
    });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.message_sent'),
      orderBy: (t, { desc }) => [desc(t.at)],
    });
    expect(audit?.metadata).toMatchObject({ numberId, outcome: 'sent' });
  });

  it('refuses free text outside the 24 h, without calling Meta', async () => {
    await apply(fixtures.message('wamid.S2', ago(60 * 25)));
    const chat = await chatOfPerson();
    const late = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'window_closed' });
    expect(sends).toHaveLength(0);
  });

  it("outside the 24 h, sends its own WABA's templates, read with its token; never the official ones", async () => {
    await apply(fixtures.message('wamid.S3', ago(60 * 25)));
    const chat = await chatOfPerson();
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
    const list = await app.inject({
      method: 'GET',
      url: `/whatsapp/templates?numberId=${numberId}`,
      cookies: owner.cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ templates: { name: string }[] }>().templates.map((t) => t.name)).toEqual([
      'retomar_conversa_numero',
    ]);
    expect(templateReads).toEqual([
      { url: `/v23.0/${WORK_WABA}/message_templates`, auth: `Bearer ${NUMBER_TOKEN}` },
    ]);
    // A seller who does not reach the number does not read its templates either...
    const asOther = () =>
      app.inject({
        method: 'GET',
        url: `/whatsapp/templates?numberId=${numberId}`,
        cookies: otherSeller.cookies,
      });
    expect((await asOther()).statusCode).toBe(404);
    // ...until one of its chats is given to them.
    await db
      .update(waConversations)
      .set({ assigneeEmployeeId: otherSeller.id })
      .where(eq(waConversations.id, chat!.id));
    expect((await asOther()).statusCode).toBe(200);
    await db
      .update(waConversations)
      .set({ assigneeEmployeeId: null })
      .where(eq(waConversations.id, chat!.id));
    const send = (name: string) =>
      app.inject({
        method: 'POST',
        url: `/whatsapp/conversations/${chat!.id}/template`,
        cookies: owner.cookies,
        payload: { name, language: 'pt_BR', params: [], companyArticle: 'a' },
      });
    // SAIR is said to the company: no template by any of our numbers.
    await db
      .update(waContacts)
      .set({ optOutAt: ago(5) })
      .where(eq(waContacts.id, chat!.contactId));
    const optedOut = await send('retomar_conversa_numero');
    expect(optedOut.statusCode).toBe(409);
    expect(optedOut.json()).toMatchObject({ error: 'opted_out' });
    await db.update(waContacts).set({ optOutAt: null }).where(eq(waContacts.id, chat!.contactId));
    const official = await send('so_do_oficial');
    expect(official.statusCode).toBe(422);
    expect(official.json()).toMatchObject({ error: 'template_unknown' });
    expect(sends).toHaveLength(0);
    const sent = await send('retomar_conversa_numero');
    expect(sent.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: `/v23.0/${WORK_ID}/messages`,
      auth: `Bearer ${NUMBER_TOKEN}`,
      body: { type: 'template', template: { name: 'retomar_conversa_numero' } },
    });
    // Its review on Meta moves only its own row.
    await apply(
      workChange('message_template_status_update', {
        event: 'PAUSED',
        message_template_id: '9100000000000001',
        message_template_name: 'retomar_conversa_numero',
        message_template_language: 'pt_BR',
        reason: null,
      }),
    );
    const [row] = await db
      .select()
      .from(waNumberTemplates)
      .where(eq(waNumberTemplates.numberId, numberId));
    expect(row?.status).toBe('PAUSED');
  });
});

describe('who reaches a work number’s chat', () => {
  it('its owner and full scope; another seller gets 404 everywhere, even owning the deal', async () => {
    const leadId = await deal(PERSON, otherSeller.id);
    await apply(fixtures.message('wamid.R1', ago(5)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBe(leadId);
    await apply(
      workChange('messages', {
        messages: [
          {
            from: PERSON,
            id: 'wamid.R2',
            timestamp: unix(ago(4)),
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg' },
          },
        ],
      }),
    );
    const [image] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.wamid, `${numberId}:wamid.R2`));

    for (const reader of [owner, admin]) {
      const page = (await list(reader.cookies)).json<WaInboxPage>();
      expect(page.conversations.map((c) => c.conversationId)).toContain(chat!.id);
      const row = page.conversations.find((c) => c.conversationId === chat!.id);
      expect(row?.number).toMatchObject({ id: numberId, label: 'Comercial Expansão' });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/whatsapp/conversations/${chat!.id}`,
            cookies: reader.cookies,
          })
        ).statusCode,
      ).toBe(200);
    }
    const outside = (await list(otherSeller.cookies)).json<WaInboxPage>();
    expect(outside.conversations.map((c) => c.conversationId)).not.toContain(chat!.id);
    for (const url of [
      `/whatsapp/conversations/${chat!.id}`,
      `/whatsapp/messages/${image!.id}/media`,
    ])
      expect(
        (await app.inject({ method: 'GET', url, cookies: otherSeller.cookies })).statusCode,
      ).toBe(404);
    const send = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: otherSeller.cookies,
      payload: { text: 'Oi' },
    });
    expect(send.statusCode).toBe(404);

    // The deal's own page shows its official chat only, and points to the number's chat for those who reach it.
    const dealPage = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: admin.cookies,
    });
    const data = dealPage.json<DealWhatsApp>();
    expect(data.messages).toHaveLength(0);
    expect(data.numberChats).toEqual([
      { conversationId: chat!.id, number: expect.objectContaining({ id: numberId }) },
    ]);
    const sellerPage = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: otherSeller.cookies,
    });
    expect(sellerPage.json<DealWhatsApp>().numberChats).toEqual([]);
  });

  it('Sofia’s screen never lists a work number’s chat', async () => {
    await apply(fixtures.message('wamid.SF1', ago(5)));
    const chat = await chatOfPerson();
    const sofia = await app.inject({
      method: 'GET',
      url: '/sofia/conversations',
      cookies: admin.cookies,
    });
    expect(
      sofia
        .json<{ conversations: { conversationId: string }[] }>()
        .conversations.map((c) => c.conversationId),
    ).not.toContain(chat!.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/sofia/conversations/${chat!.id}`,
          cookies: admin.cookies,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the Central’s list', () => {
  it('narrows by number, responsible, Sofia or person, department, state and day, and pages on', async () => {
    // An official conversation with no deal (Sofia's) and the work number's chat.
    await apply({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                contacts: [{ wa_id: '5521988880002', profile: { name: 'Oficial' } }],
                messages: [
                  {
                    from: '5521988880002',
                    id: 'wamid.OF1',
                    timestamp: unix(ago(90)),
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await db
      .update(waConversations)
      .set({ attendance: 'sofia' })
      .where(isNull(waConversations.numberId));
    await apply(fixtures.message('wamid.L1', ago(10)));
    const chat = await chatOfPerson();
    const ids = async (query: string) =>
      (await list(admin.cookies, query))
        .json<WaInboxPage>()
        .conversations.map((c) => c.conversationId);

    expect(await ids(`?number=${numberId}`)).toEqual([chat!.id]);
    expect(await ids('?number=official')).not.toContain(chat!.id);
    expect(await ids('?filter=sofia')).not.toContain(chat!.id);
    expect(await ids('?filter=human')).toContain(chat!.id);
    expect(await ids('?sector=comercial')).toEqual([chat!.id]);
    expect(await ids('?sector=marketing')).toEqual([]);
    expect(await ids('?state=with_person')).toContain(chat!.id);
    // The chat has no deal: its number's owner is the responsible.
    expect(
      (await list(owner.cookies, '?filter=mine'))
        .json<WaInboxPage>()
        .conversations.map((c) => c.conversationId),
    ).toEqual([chat!.id]);
    expect(await ids('?filter=unassigned')).not.toContain(chat!.id);
    expect(await ids('?from=2026-10-07&to=2026-10-07')).toContain(chat!.id);
    expect(await ids('?to=2026-10-06')).toEqual([]);
    expect((await list(admin.cookies, '?before=nonsense')).statusCode).toBe(400);

    // History is never unread.
    await apply(fixtures.history(ago(60 * 24 * 40)));
    const row = (await list(owner.cookies))
      .json<WaInboxPage>()
      .conversations.find((c) => c.conversationId === chat!.id);
    expect(row?.unreadCount).toBe(1);
  });

  it('pages: 50 a time, the next page starts after the last one, nothing repeated or skipped', async () => {
    for (let i = 0; i < 53; i++)
      await applyWhatsAppPayload(
        { db, phoneNumberId: PHONE_ID, wabaId: WABA, log: () => {}, now: () => clock },
        workChange('messages', {
          messages: [
            {
              from: `55219888${String(10000 + i)}`,
              id: `wamid.P${i}`,
              timestamp: unix(ago(100 - i)),
              type: 'text',
              text: { body: `m${i}` },
            },
          ],
        }),
      );
    const first = (await list(owner.cookies, `?number=${numberId}`)).json<WaInboxPage>();
    expect(first.conversations).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = (
      await list(owner.cookies, `?number=${numberId}&before=${encodeURIComponent(first.next!)}`)
    ).json<WaInboxPage>();
    expect(second.conversations).toHaveLength(3);
    expect(second.next).toBeNull();
    const all = [...first.conversations, ...second.conversations].map((c) => c.conversationId);
    expect(new Set(all).size).toBe(53);
  });
});

describe('joining a chat to a deal (the person chooses)', () => {
  it('lists the deals of the phone in the reader’s reach; joins one, once, written in its history and the audit', async () => {
    const a = await deal(PERSON, owner.id, 'Primeira');
    await deal(PERSON, owner.id, 'Segunda');
    const foreign = await deal('5521988889999', owner.id, 'De outro telefone');
    await apply(fixtures.message('wamid.J1', ago(5)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBeNull();
    const deals = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${chat!.id}/deals`,
      cookies: owner.cookies,
    });
    expect(
      deals
        .json<{ deals: WaNewTarget[] }>()
        .deals.map((d) => d.name)
        .sort(),
    ).toEqual(['Primeira', 'Segunda']);
    const wrong = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: foreign },
    });
    expect(wrong.statusCode).toBe(404);
    const linked = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: a },
    });
    expect(linked.statusCode).toBe(204);
    expect((await chatOfPerson())?.leadId).toBe(a);
    const again = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: a },
    });
    expect(again.statusCode).toBe(409);
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, a), eq(leadEvents.kind, 'lead.whatsapp_linked')));
    expect(event).toMatchObject({ actorEmployeeId: owner.id, detail: { via: 'manual', numberId } });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.conversation_linked'),
    });
    expect(audit).toMatchObject({ entityId: a, metadata: { conversationId: chat!.id, numberId } });
    expect(JSON.stringify(audit?.metadata)).not.toContain(PERSON);
  });

  it('"Nova conversa" by a work number opens its chat on the deal’s phone, sending nothing', async () => {
    const leadId = await deal(PERSON, owner.id);
    const numbers = await app.inject({
      method: 'GET',
      url: '/whatsapp/chat-numbers',
      cookies: owner.cookies,
    });
    expect(numbers.json<{ numbers: { id: string; connected: boolean }[] }>().numbers).toEqual([
      expect.objectContaining({ id: numberId, connected: true }),
    ]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/chat-numbers',
          cookies: otherSeller.cookies,
        })
      ).json<{ numbers: unknown[] }>().numbers,
    ).toEqual([]);
    const started = await app.inject({
      method: 'POST',
      url: `/whatsapp/chat-numbers/${numberId}/conversations`,
      cookies: owner.cookies,
      payload: { leadId, phone: PERSON },
    });
    expect(started.statusCode).toBe(200);
    const chat = await chatOfPerson();
    expect(started.json()).toEqual({ conversationId: chat!.id });
    expect(chat?.leadId).toBe(leadId);
    expect(sends).toHaveLength(0);
    const notTheirs = await app.inject({
      method: 'POST',
      url: `/whatsapp/chat-numbers/${numberId}/conversations`,
      cookies: owner.cookies,
      payload: { leadId, phone: '5521988887777' },
    });
    expect(notTheirs.statusCode).toBe(422);
  });
});
