import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contactOptOuts,
  crmContacts,
  leadContacts,
  leadEvents,
  waContacts,
  waConversations,
  waTemplates,
} from '../../db/schema/index.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  admin,
  ago,
  app,
  apply,
  db,
  deal,
  owner,
  PHONE_ID,
  resetCentral,
  sends,
  startCentral,
  stopCentral,
  unix,
  WABA,
} from './central-fixtures.js';

/**
 * WA-03 through the deal's contacts: a number Sofia or the team is attending with no deal yet does
 * not join a seller's deal as a contact (the next message would carry the conversation there), and
 * a conversation that did join a deal through a contact keeps the one "não me contate" check.
 * Setup in `central-fixtures.ts`; phones and names are made up.
 */

beforeAll(startCentral, 60_000);
afterAll(stopCentral);
beforeEach(async () => {
  await db.delete(leadContacts);
  await resetCentral();
  await db.delete(contactOptOuts);
  await db.delete(crmContacts);
});

/** A conversation on the official number, waiting with no deal, as GET /whatsapp/targets says "busy". */
async function waiting(phone: string, attendance = 'sofia') {
  const [contact] = await db
    .insert(waContacts)
    .values({ phone, lastInboundAt: ago(10) })
    .onConflictDoUpdate({ target: [waContacts.tenantId, waContacts.phone], set: { phone } })
    .returning({ id: waContacts.id });
  const [conversation] = await db
    .insert(waConversations)
    .values({ contactId: contact!.id, leadId: null, numberId: null, attendance })
    .returning({ id: waConversations.id });
  return conversation!.id;
}

/** The person writes again to the official number. */
const writes = (phone: string, id: string) =>
  apply({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5521900000000', phone_number_id: PHONE_ID },
              contacts: [{ wa_id: phone, profile: { name: 'Pessoa Fictícia' } }],
              messages: [
                { from: phone, id, timestamp: unix(ago(1)), type: 'text', text: { body: 'Oi' } },
              ],
            },
          },
        ],
      },
    ],
  });

const leadOf = async (conversationId: string) =>
  (await db.query.waConversations.findFirst({ where: eq(waConversations.id, conversationId) }))
    ?.leadId ?? null;

const link = (cookies: Record<string, string>, leadId: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/leads/${leadId}/contacts`, cookies, payload });

describe("a number in attendance does not join a seller's deal as a contact (WA-03)", () => {
  it('neither typed on the deal, nor as a contact made first, nor by editing a linked contact', async () => {
    const phone = '5521977770001';
    const chat = await waiting(phone);
    const leadId = await deal('5521977779001', owner.id);

    const typed = await link(owner.cookies, leadId, {
      contact: { name: 'Contato Fictício', phone: '21 97777-0001' },
    });
    expect(typed.statusCode).toBe(409);
    expect(typed.json<{ error: string }>().error).toBe('number_in_attendance');
    // Refused before anything was made: no contact holds the number.
    expect(await db.query.crmContacts.findFirst({ where: eq(crmContacts.phone, phone) })).toBe(
      undefined,
    );

    // A contact of their own with the number is not a deal yet; linking it is.
    const made = await app.inject({
      method: 'POST',
      url: '/crm/contacts',
      cookies: owner.cookies,
      payload: { name: 'Contato Fictício', phone },
    });
    expect(made.statusCode).toBe(201);
    const contactId = made.json<{ contact: { id: string } }>().contact.id;
    const byId = await link(owner.cookies, leadId, { contactId });
    expect(byId.statusCode).toBe(409);
    expect(byId.json<{ error: string }>().error).toBe('number_in_attendance');

    // A contact already on the deal does not take the number by an edit either.
    const other = await link(owner.cookies, leadId, {
      contact: { name: 'Outro Fictício', phone: '5521977778001' },
    });
    expect(other.statusCode).toBe(201);
    const otherId = (await db.query.crmContacts.findFirst({
      where: eq(crmContacts.phone, '5521977778001'),
    }))!.id;
    const edited = await app.inject({
      method: 'PATCH',
      url: `/crm/contacts/${otherId}`,
      cookies: owner.cookies,
      payload: { phone },
    });
    expect(edited.statusCode).toBe(409);
    // Saving the contact with its own phone again is not a change.
    const resaved = await app.inject({
      method: 'PATCH',
      url: `/crm/contacts/${otherId}`,
      cookies: owner.cookies,
      payload: { phone: '5521977778001', jobTitle: 'Sócio' },
    });
    expect(resaved.statusCode).toBe(200);

    // The person writes again: the conversation is still nobody's deal.
    await writes(phone, 'wamid.WA03-1');
    expect(await leadOf(chat)).toBeNull();
  });

  it('whoever may assign deals still links it, and the conversation goes to that deal', async () => {
    const phone = '5521977770002';
    const chat = await waiting(phone);
    const leadId = await deal('5521977779002', owner.id);
    const linked = await link(admin.cookies, leadId, {
      contact: { name: 'Contato Fictício', phone },
    });
    expect(linked.statusCode).toBe(201);
    await writes(phone, 'wamid.WA03-2');
    expect(await leadOf(chat)).toBe(leadId);
  });

  it("a closed conversation is nobody's: the seller links the number", async () => {
    const phone = '5521977770003';
    await waiting(phone, 'closed');
    const leadId = await deal('5521977779003', owner.id);
    const linked = await link(owner.cookies, leadId, {
      contact: { name: 'Contato Fictício', phone },
    });
    expect(linked.statusCode).toBe(201);
  });
});

describe('"não me contate" on a conversation a deal took through a contact', () => {
  const template = (conversationId: string) =>
    app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/template`,
      // The deal's seller holds the conversation it took.
      cookies: owner.cookies,
      payload: { name: 'so_do_oficial', language: 'pt_BR', params: [], companyArticle: 'a' },
    });

  beforeEach(async () => {
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
  });

  /** The contact's phone is not the deal's: the conversation reaches the deal only by the link. */
  async function linkedChat(phone: string) {
    const chat = await waiting(phone);
    const leadId = await deal('5521977779100', owner.id);
    const linked = await link(admin.cookies, leadId, {
      contact: { name: 'Contato Fictício', phone },
    });
    expect(linked.statusCode).toBe(201);
    await writes(phone, `wamid.WA03-${phone}`);
    expect(await leadOf(chat)).toBe(leadId);
    return { chat, leadId };
  }

  it("the register on the contact's phone stops a template on the deal, and says why", async () => {
    const phone = '5521977770010';
    await recordContactOptOut(db, {
      phone,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: null,
      createdBy: admin.id,
    });
    const { chat, leadId } = await linkedChat(phone);

    const blocked = await template(chat);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'contact_blocked' });
    expect(sends).toHaveLength(0);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId));
    expect(events.filter((e) => e.kind === 'lead.contact_blocked').map((e) => e.detail)).toEqual([
      { channel: 'whatsapp', path: 'modelo', origin: 'crm' },
    ]);
  });

  it("the register on the deal stops it too, though the phone is the contact's", async () => {
    const { chat, leadId } = await linkedChat('5521977770011');
    await recordContactOptOut(db, {
      leadId,
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: admin.id,
    });
    const blocked = await template(chat);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'contact_blocked' });
    expect(sends).toHaveLength(0);

    // Revoked, the same template goes: the register was the only thing in the way.
    await db.update(contactOptOuts).set({ revokedAt: ago(1) });
    const sent = await template(chat);
    expect(sent.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
  });
});
