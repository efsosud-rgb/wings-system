import { SOFIA_DEFAULT_SETTINGS, type DealWhatsApp, type WaFailedEvent } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  crmNotifications,
  leadEvents,
  leadTriageQueue,
  leads,
  waContacts,
  waConversations,
  waMessages,
  waNumbers,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { configureLeadTriage } from '../leads/triage-schedule.js';
import { saveSofiaSettings } from '../sofia/settings.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { processWhatsAppEvents, storeWhatsAppEvent } from './intake.js';
import { storeWhatsAppMedia } from './media-store.js';
import { numberConfigOf } from './numbers.js';
import {
  admin,
  ago,
  apply,
  app,
  chatOfPerson,
  db,
  deal,
  fixtures,
  json,
  NOW,
  NUMBER_TOKEN,
  numberId,
  otherSeller,
  owner,
  PERSON,
  PHONE_ID,
  resetCentral,
  sends,
  setClock,
  startCentral,
  stopCentral,
  TOKEN,
  unix,
  WABA,
  workChange,
  KEY,
  clock,
} from './central-fixtures.js';

/**
 * The Central WhatsApp (docs/whatsapp/central.md), what comes in: a work number's own traffic
 * entering the CRM as its chat (messages, phone echoes, the history, the phone's contacts), never
 * Sofia's nor the triage's; our sends Meta never answered; the webhook queue waiting longer after
 * each failure; and a work number's received file. Setup in `central-fixtures.ts`.
 */
beforeAll(startCentral, 60_000);
afterAll(stopCentral);
beforeEach(resetCentral);

describe('a work number’s own traffic in the CRM', () => {
  it('the person’s message, the phone’s echo, the history and the phone’s contact name land in one chat, never Sofia’s', async () => {
    await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: true }, null, NOW);
    const triaged: unknown[] = [];
    configureLeadTriage((target) => triaged.push(target));
    try {
      await apply(fixtures.history(ago(60 * 24 * 30)));
      await apply(fixtures.message('wamid.LIVE1', ago(30)));
      await apply(fixtures.echo('wamid.ECHO1', ago(20)));
      await apply(fixtures.contacts());
      // Meta re-sends: nothing doubles.
      await apply(fixtures.message('wamid.LIVE1', ago(30)));
    } finally {
      configureLeadTriage(null);
      await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: false }, null, NOW);
    }
    expect(triaged).toEqual([]);
    const chat = await chatOfPerson();
    expect(chat).toMatchObject({
      attendance: 'with_person',
      sofiaDueAt: null,
      phoneContactName: 'Nome no Celular',
      leadId: null,
    });
    const messages = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.conversationId, chat!.id))
      .orderBy(waMessages.createdAt);
    expect(
      messages.map((m) => [
        m.wamid,
        m.direction,
        m.author,
        m.status,
        Boolean((m.content as { history?: boolean }).history),
      ]),
    ).toEqual([
      [`${numberId}:wamid.HIST1`, 'in', 'contact', null, true],
      [`${numberId}:wamid.HIST2`, 'out', 'app', 'delivered', true],
      [`${numberId}:wamid.LIVE1`, 'in', 'contact', null, false],
      [`${numberId}:wamid.ECHO1`, 'out', 'app', 'sent', false],
    ]);
    // The history keeps its own day.
    expect(messages[0]!.createdAt.toISOString()).toBe(ago(60 * 24 * 30).toISOString());
    expect(await db.select().from(leadTriageQueue)).toHaveLength(0);
    // The official number's window and opt-out are not touched.
    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, PERSON));
    expect(contact).toMatchObject({ lastInboundAt: null, optOutAt: null });
    const [number] = await db.select().from(waNumbers).where(eq(waNumbers.id, numberId));
    expect(number?.historyProgress).toBe(55);

    // A contact removed on the phone takes the saved name away.
    await apply(fixtures.contacts(true));
    expect((await chatOfPerson())?.phoneContactName).toBeNull();

    // The owner reads it as the number's chat: what went from the phone says so, no Sofia.
    const view = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${chat!.id}`,
      cookies: owner.cookies,
    });
    const data = view.json<DealWhatsApp>();
    expect(data.messages.map((m) => m.fromPhone)).toEqual([false, true, false, true]);
    expect(data).toMatchObject({
      number: { id: numberId, label: 'Comercial Expansão' },
      configured: true,
      calling: false,
      window: { open: true },
    });
  });

  it('joins the deal only when exactly one open deal has the phone, and says so in its history', async () => {
    const first = await deal(PERSON, owner.id);
    await deal(PERSON, otherSeller.id, 'Outra negociação');
    await apply(fixtures.message('wamid.AMB1', ago(10)));
    expect((await chatOfPerson())?.leadId).toBeNull();

    await db.delete(waMessages);
    await db.delete(waConversations);
    await db.update(leads).set({ won: true }).where(eq(leads.name, 'Outra negociação'));
    await apply(fixtures.message('wamid.ONE1', ago(10)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBe(first);
    const [message] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.conversationId, chat!.id));
    expect(message?.leadId).toBe(first);
    const [event] = await db.select().from(leadEvents).where(eq(leadEvents.leadId, first));
    expect(event).toMatchObject({
      kind: 'lead.whatsapp_linked',
      detail: { via: 'auto', numberId, conversationId: chat!.id },
    });
  });

  it('moves our own send’s status forward under the number', async () => {
    await apply(fixtures.message('wamid.W1', ago(10)));
    const chat = await chatOfPerson();
    const sent = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Olá pelo número do comercial' },
    });
    expect(sent.statusCode).toBe(201);
    await apply(
      workChange('messages', {
        statuses: [
          { id: 'wamid.SENT1', status: 'read', timestamp: unix(NOW), recipient_id: PERSON },
        ],
      }),
    );
    const [row] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.wamid, `${numberId}:wamid.SENT1`));
    expect(row?.status).toBe('read');
  });
});

describe('our sends Meta never answered', () => {
  it('are marked unknown after 10 minutes and the sender hears; nothing is sent again', async () => {
    const phone = '5521977771234';
    const [contact] = await db.insert(waContacts).values({ phone }).returning();
    const [conversation] = await db
      .insert(waConversations)
      .values({ contactId: contact!.id, lastMessageAt: ago(30) })
      .returning();
    const [stuck] = await db
      .insert(waMessages)
      .values({
        conversationId: conversation!.id,
        contactId: contact!.id,
        direction: 'out',
        author: 'employee',
        employeeId: owner.id,
        kind: 'text',
        text: 'Mensagem de teste',
        status: 'pending',
        createdAt: ago(20),
      })
      .returning();
    const [fresh] = await db
      .insert(waMessages)
      .values({
        conversationId: conversation!.id,
        contactId: contact!.id,
        direction: 'out',
        author: 'employee',
        employeeId: owner.id,
        kind: 'text',
        text: 'Ainda indo',
        status: 'pending',
        createdAt: ago(2),
      })
      .returning();
    const swept = await processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });
    expect(swept.processed).toBe(0);
    const [after] = await db.select().from(waMessages).where(eq(waMessages.id, stuck!.id));
    expect(after).toMatchObject({ status: 'pending', wamid: null, errorTitle: 'unknown_outcome' });
    const [still] = await db.select().from(waMessages).where(eq(waMessages.id, fresh!.id));
    expect(still!.errorTitle).toBeNull();
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.kind, 'whatsapp_send_unknown'));
    expect(notices.map((n) => n.recipientEmployeeId)).toEqual([owner.id]);
    expect(sends).toHaveLength(0);
    // A second pass tells nobody twice.
    await processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });
    expect(
      await db.$count(crmNotifications, eq(crmNotifications.kind, 'whatsapp_send_unknown')),
    ).toBe(1);
  });
});

describe('the webhook queue', () => {
  // A timestamp no Date can hold: the body fails every time, as a broken database would.
  const broken = () =>
    workChange('messages', {
      messages: [
        { from: PERSON, id: 'wamid.BAD', timestamp: '1e30', type: 'text', text: { body: 'x' } },
      ],
    });
  const run = () =>
    processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });

  it('waits longer after each failure, gives up after 5, and the Admin Master sends it back, without its content', async () => {
    const id = await storeWhatsAppEvent(db, broken());
    const state = async () =>
      (await db.select().from(waWebhookEvents).where(eq(waWebhookEvents.id, id)))[0]!;
    await run();
    expect(await state()).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await state()).nextAttemptAt.toISOString()).toBe(
      new Date(NOW.getTime() + 2 * 60_000).toISOString(),
    );
    // Before its time nothing happens.
    setClock(new Date(NOW.getTime() + 60_000));
    expect((await run()).processed).toBe(0);
    for (const minutes of [3, 8, 17, 34]) {
      setClock(new Date(NOW.getTime() + minutes * 60_000));
      await run();
    }
    expect(await state()).toMatchObject({ status: 'failed', attempts: 5 });
    // The Admin Master hears it in Avisos, once, by the screen it is on (never its content).
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.kind, 'whatsapp_webhook_failed'));
    expect(notices.map((n) => n.recipientEmployeeId)).toContain(admin.id);
    expect(notices.map((n) => n.recipientEmployeeId)).not.toContain(owner.id);
    expect(JSON.stringify(notices)).not.toContain(PERSON);

    const failed = await app.inject({
      method: 'GET',
      url: '/whatsapp/webhook-events/failed',
      cookies: admin.cookies,
    });
    expect(failed.json<{ events: WaFailedEvent[] }>().events).toEqual([
      expect.objectContaining({ id, attempts: 5, lastError: 'error', hasPayload: true }),
    ]);
    expect(failed.body).not.toContain(PERSON);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/webhook-events/failed',
          cookies: owner.cookies,
        })
      ).statusCode,
    ).toBe(403);
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/webhook-events/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(retry.statusCode).toBe(202);
    expect(await state()).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.webhook_event_retried'),
    });
    expect(audit).toMatchObject({ entityId: id, metadata: {} });
    // A body the purge cleared has nothing left to send back.
    await db
      .update(waWebhookEvents)
      .set({ status: 'failed', payload: null })
      .where(eq(waWebhookEvents.id, id));
    const gone = await app.inject({
      method: 'POST',
      url: `/whatsapp/webhook-events/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(gone.statusCode).toBe(409);
    expect(await db.select().from(waMessages)).toHaveLength(0);
  });
});

describe('a work number’s received file', () => {
  it('is copied to our storage with that number’s own token, never the official one', async () => {
    await apply(
      workChange('messages', {
        messages: [
          {
            from: PERSON,
            id: 'wamid.IMG1',
            timestamp: unix(ago(2)),
            type: 'image',
            image: { id: 'media-work', mime_type: 'image/jpeg' },
          },
        ],
      }),
    );
    const auths: (string | null)[] = [];
    const mediaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      auths.push(new Headers(init?.headers).get('authorization'));
      if (url.hostname === 'lookaside.fbsbx.com') return new Response('JPEGDATA');
      return json({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        mime_type: 'image/jpeg',
        file_size: 8,
      });
    }) as typeof fetch;
    const put: string[] = [];
    const storage = {
      put: async (key: string) => {
        put.push(key);
      },
      delete: async () => undefined,
    } as unknown as ObjectStorage;
    const result = await storeWhatsAppMedia({
      db,
      storage,
      config: { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA },
      numberConfig: (id) => numberConfigOf(db, createSecretBox(KEY), id),
      fetchImpl: mediaFetch,
      log: () => {},
      now: () => clock,
    });
    expect(result).toMatchObject({ queued: 1, stored: 1 });
    expect(put).toHaveLength(1);
    expect(auths).toEqual([`Bearer ${NUMBER_TOKEN}`, `Bearer ${NUMBER_TOKEN}`]);
  });
});
