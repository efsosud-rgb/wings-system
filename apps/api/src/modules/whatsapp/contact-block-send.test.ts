import { randomUUID } from 'node:crypto';
import type { DealWhatsApp } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  contactOptOuts,
  leadEvents,
  leadFiles,
  leads,
  waContacts,
  waMessages,
  waTemplates,
  waVoiceSends,
} from '../../db/schema/index.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import {
  app,
  clock,
  db,
  dealFile,
  openDealWith,
  PDF,
  PHONE_ID,
  resetMediaSend,
  seller,
  sends,
  sessionFor,
  signed,
  startMediaSend,
  stopMediaSend,
  unix,
  uploads,
  WABA,
  type Session,
} from './media-send-fixtures.js';
import { fakeRecording } from './voice-fixtures.js';

/**
 * "Não me contate" (or SAIR) stops everything that goes to the person on WhatsApp, a reply inside
 * the 24 hours included (Eric, 30/10 and 31/10; docs/crm/nao-me-contate.md): the typed text, the
 * deal's file, the recorded voice note, the template and the call request answer 409
 * `contact_blocked`, the timeline says which way was refused, and nothing reaches Meta, not even a
 * moment later. Without the lock, the same sends go. Official number here; the work number's in
 * `central-contact-block.test.ts`. No test reaches the network and no real message leaves.
 */

let recording: Buffer;
let manager: Session;

beforeAll(async () => {
  await startMediaSend();
  recording = await fakeRecording(2);
  manager = await sessionFor('gerente_comercial');
  await db
    .insert(waTemplates)
    .values({
      name: 'retomar_simples',
      language: 'pt_BR',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Olá! Podemos continuar a conversa?' }],
    })
    .onConflictDoNothing();
}, 60_000);
afterAll(stopMediaSend);
beforeEach(async () => {
  await resetMediaSend();
  // A voice note that went in an earlier test keeps its key: only this test's count.
  await db.delete(waVoiceSends);
});

const PATHS = ['text', 'media', 'voice', 'template', 'call_permission'] as const;
type Path = (typeof PATHS)[number];

/** One send of each kind, from the deal, as the conversation screen makes it. */
function sendBy(path: Path, leadId: string, fileId: string) {
  const url = `/leads/${leadId}/whatsapp/${path === 'call_permission' ? 'call-permission' : path}`;
  if (path === 'voice')
    return app.inject({
      method: 'POST',
      url,
      cookies: seller.cookies,
      headers: { 'content-type': 'audio/webm;codecs=opus', 'idempotency-key': randomUUID() },
      payload: recording,
    });
  const payload = {
    text: { text: 'Segue a proposta.' },
    media: { fileId, caption: 'Proposta' },
    template: { name: 'retomar_simples', language: 'pt_BR', params: [], companyArticle: 'a' },
    call_permission: {},
  }[path];
  return app.inject({ method: 'POST', url, cookies: seller.cookies, payload });
}

/** The person writes `text` to the official number now (SAIR, or anything else). */
async function personSays(phone: string, text: string) {
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
                contacts: [{ profile: { name: 'Pessoa' }, wa_id: phone }],
                messages: [
                  {
                    from: phone,
                    id: `wamid.SAY${randomUUID()}`,
                    timestamp: unix(clock),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Nothing went or stayed: no call to Meta (a moment later either), no message, no file kept. */
async function expectNothingWent(leadId: string, filesBefore: number) {
  await pause(200);
  expect(sends).toHaveLength(0);
  expect(uploads).toHaveLength(0);
  expect(
    await db.$count(
      waMessages,
      and(eq(waMessages.leadId, leadId), eq(waMessages.direction, 'out')),
    ),
  ).toBe(0);
  expect(await db.$count(leadFiles, eq(leadFiles.leadId, leadId))).toBe(filesBefore);
  expect(await db.$count(waVoiceSends)).toBe(0);
}

const blockedPaths = async (leadId: string) =>
  (
    await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'lead.contact_blocked')))
  ).map((e) => e.detail);

const thread = async (leadId: string) =>
  (
    await app.inject({ method: 'GET', url: `/leads/${leadId}/whatsapp`, cookies: seller.cookies })
  ).json<DealWhatsApp>();

describe('"não me contate" inside the 24 hours: nothing goes', () => {
  it('from the CRM: text, file, voice, template and call request are refused; revoked, all go', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    await recordContactOptOut(db, {
      leadId,
      channels: ['whatsapp'],
      origin: 'crm',
      reason: 'Pediu por telefone',
      createdBy: seller.id,
    });
    expect((await thread(leadId)).window.open).toBe(true);
    for (const path of PATHS) {
      const refused = await sendBy(path, leadId, fileId);
      expect([refused.statusCode, refused.json()], path).toEqual([
        409,
        {
          error: 'contact_blocked',
          message: expect.stringContaining('Pediu para não ser contatado'),
        },
      ]);
    }
    await expectNothingWent(leadId, 1);
    expect(await blockedPaths(leadId)).toEqual(
      ['texto', 'arquivo', 'audio_gravado', 'modelo', 'pedido_ligacao'].map((path) => ({
        channel: 'whatsapp',
        path,
        origin: 'crm',
      })),
    );

    // The same sends, the lock revoked: each one goes.
    await db.update(contactOptOuts).set({ revokedAt: clock });
    for (const path of PATHS) {
      const sent = await sendBy(path, leadId, fileId);
      expect(sent.statusCode, path).toBe(201);
    }
    expect(sends).toHaveLength(PATHS.length);
  }, 30_000);

  it('by another key of the deal: a "não me contate" on its e-mail, for every channel', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    await recordContactOptOut(db, {
      email: 'pessoa-bloqueada@exemplo.com.br',
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: seller.id,
    });
    // Not this deal's address yet: the text goes.
    expect((await sendBy('text', leadId, fileId)).statusCode).toBe(201);
    await db
      .update(leads)
      .set({ email: 'Pessoa-Bloqueada@exemplo.com.br' })
      .where(eq(leads.id, leadId));
    sends.length = 0;
    for (const path of ['text', 'media'] as const) {
      const refused = await sendBy(path, leadId, fileId);
      expect([refused.statusCode, refused.json().error], path).toEqual([409, 'contact_blocked']);
    }
    await pause(200);
    expect(sends).toHaveLength(0);
  });
});

describe('SAIR, then the person writes again (Eric, 31/10)', () => {
  it('the new message waits for a person, nothing goes until a manager revokes, with who and why', async () => {
    const { phone, leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    await personSays(phone, 'SAIR');
    await personSays(phone, 'Na verdade, quero falar com alguém');
    // Writing again lifts the SAIR of the official number's contact, never the register.
    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, phone));
    expect(contact!.optOutAt).toBeNull();
    const shown = await thread(leadId);
    expect(shown.window.open).toBe(true);
    expect(shown.contactBlock).toMatchObject({ blocked: true, origin: 'whatsapp_palavra' });

    for (const path of PATHS) {
      const refused = await sendBy(path, leadId, fileId);
      expect([refused.statusCode, refused.json().error], path).toEqual([409, 'contact_blocked']);
    }
    await expectNothingWent(leadId, 1);
    expect((await blockedPaths(leadId)).map((d) => (d as { origin: string }).origin)).toEqual(
      PATHS.map(() => 'whatsapp_palavra'),
    );

    // Lifting it is a manager's explicit act, with a reason, audited.
    const revoke = (session: Session) =>
      app.inject({
        method: 'POST',
        url: `/leads/${leadId}/contact-opt-outs/revoke`,
        cookies: session.cookies,
        payload: { channel: 'whatsapp', reason: 'Voltou a pedir contato pelo WhatsApp' },
      });
    expect((await revoke(seller)).statusCode).toBe(403);
    expect((await sendBy('text', leadId, fileId)).statusCode).toBe(409);
    expect((await revoke(manager)).statusCode).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'lead.contact_opt_out_revoked'), eq(auditLog.entityId, leadId)),
      );
    expect(audit).toMatchObject({
      actorEmployeeId: manager.id,
      metadata: { channel: 'whatsapp', reason: 'Voltou a pedir contato pelo WhatsApp' },
    });
    expect(audit!.at).toBeInstanceOf(Date);
    expect((await sendBy('text', leadId, fileId)).statusCode).toBe(201);
    expect((await sendBy('media', leadId, fileId)).statusCode).toBe(201);
    expect(sends).toHaveLength(2);
  });

  it('a SAIR not yet followed by anything: the revoke alone does not reopen it', async () => {
    const { phone, leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    await personSays(phone, 'parar');
    await db.update(contactOptOuts).set({ revokedAt: clock });
    // The person's last word is still SAIR (wa_contacts.opt_out_at): nothing goes.
    const refused = await sendBy('text', leadId, fileId);
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'contact_blocked']);
    await pause(200);
    expect(sends).toHaveLength(0);
  });

  it('a deal file of another deal is never looked up for a blocked person', async () => {
    const { leadId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const other = await openDealWith('outra.pdf', 'application/pdf', PDF);
    const otherFile = await dealFile(seller, other.leadId, 'mais.pdf', 'application/pdf', PDF);
    await recordContactOptOut(db, {
      leadId,
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: seller.id,
    });
    // The lock answers first, whatever the file: 409, never 404.
    const refused = await sendBy('media', leadId, otherFile);
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'contact_blocked']);
    await pause(200);
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
