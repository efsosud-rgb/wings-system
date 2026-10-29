import { normalizeContactKey, WHATSAPP_OPT_IN_MISSING_TEXT, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { leads, prospects, waContacts } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  contactBlock,
  leadContactOptOuts,
  recordContactOptOut,
  revokeContactOptOuts,
} from './contact-block.js';
import { upsertLead } from './service.js';

/** The one "não me contate" check, against a throwaway database (made-up people only). */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

let seq = 0;
const arrive = async (over: Partial<Parameters<typeof upsertLead>[1]> = {}) => {
  seq += 1;
  const { lead } = await upsertLead(db, {
    source: 'site_form',
    name: `Pessoa Teste ${seq}`,
    phone: `11 9${String(70000000 + seq)}`,
    email: `pessoa${seq}@exemplo.test`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: null,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
    ...over,
  });
  return lead;
};

describe('normalizeContactKey', () => {
  it('stores a phone canonical, an e-mail lower case, an @ without the @', () => {
    expect(normalizeContactKey('phone', '(11) 98765-4321')).toBe('5511987654321');
    // Meta's wa_id without the 9th digit is the same person.
    expect(normalizeContactKey('phone', '551187654321')).toBe('5511987654321');
    expect(normalizeContactKey('phone', '0000')).toBeNull();
    expect(normalizeContactKey('email', '  Fulano@Exemplo.TEST ')).toBe('fulano@exemplo.test');
    expect(normalizeContactKey('email', 'sem-arroba')).toBeNull();
    expect(normalizeContactKey('instagram_user', '@Perfil.Teste')).toBe('perfil.teste');
    expect(normalizeContactKey('cnpj', '11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizeContactKey('cnpj', '123')).toBeNull();
  });
});

describe('contactBlock', () => {
  it('is open for a person nobody registered', async () => {
    const lead = await arrive();
    expect(await contactBlock(db, 'whatsapp', { leadId: lead.id })).toEqual({
      blocked: false,
      reason: null,
      origin: null,
    });
  });

  it('records once, by every key of the lead, and blocks by any of them', async () => {
    const lead = await arrive();
    const first = await recordContactOptOut(db, {
      leadId: lead.id,
      channels: ['email'],
      origin: 'crm',
      reason: 'Pediu por telefone',
      createdBy: null,
    });
    expect(first).toBeGreaterThanOrEqual(3); // lead, phone, e-mail
    const again = await recordContactOptOut(db, {
      leadId: lead.id,
      channels: ['email'],
      origin: 'crm',
      reason: 'De novo',
      createdBy: null,
    });
    expect(again).toBe(0);

    // The e-mail in another form, with no lead: blocked; another channel: open.
    expect((await contactBlock(db, 'email', { email: lead.email!.toUpperCase() })).blocked).toBe(
      true,
    );
    expect((await contactBlock(db, 'whatsapp', { leadId: lead.id })).blocked).toBe(false);
    // Another deal of the same phone is reached too.
    const other = await arrive({ phone: lead.phone, email: null, forceNew: true });
    const block = await contactBlock(db, 'email', { leadId: other.id, email: 'x@exemplo.test' });
    expect(block).toMatchObject({ blocked: true, origin: 'crm' });
    expect(block.reason).toContain('e-mail');
  });

  it('"all" blocks every channel', async () => {
    const lead = await arrive();
    await recordContactOptOut(db, {
      leadId: lead.id,
      channels: ['all', 'email'],
      origin: 'crm',
      reason: 'Não quer contato',
      createdBy: null,
    });
    for (const channel of ['whatsapp', 'phone', 'email', 'instagram'] as const)
      expect((await contactBlock(db, channel, { leadId: lead.id })).blocked).toBe(true);
  });

  it('reads the WhatsApp SAIR (opt_out_at) for WhatsApp only, in both phone forms', async () => {
    const lead = await arrive();
    const canonical = normalizeContactKey('phone', lead.phone)!;
    await db.insert(waContacts).values({ phone: canonical, optOutAt: new Date() });
    const short = canonical.slice(0, 4) + canonical.slice(5);
    expect(await contactBlock(db, 'whatsapp', { phone: short })).toMatchObject({
      blocked: true,
      origin: 'whatsapp_palavra',
    });
    expect((await contactBlock(db, 'email', { leadId: lead.id })).blocked).toBe(false);
  });

  it('reads a prospect marked nao_contatar, by place_id and by the lead it became', async () => {
    const lead = await arrive();
    await db.update(leads).set({ googlePlaceId: 'place-teste-1' }).where(eq(leads.id, lead.id));
    await db.insert(prospects).values({ placeId: 'place-teste-1', status: 'nao_contatar' });
    expect(await contactBlock(db, 'email', { placeId: 'place-teste-1' })).toMatchObject({
      blocked: true,
      origin: 'prospeccao',
    });
    const linked = await arrive();
    await db
      .insert(prospects)
      .values({ placeId: 'place-teste-2', status: 'nao_contatar', leadId: linked.id });
    expect((await contactBlock(db, 'phone', { leadId: linked.id })).blocked).toBe(true);
    expect((await contactBlock(db, 'phone', { leadId: lead.id })).blocked).toBe(true);
  });

  it('keeps the Prospecção opt-in rule as it is, for WhatsApp only', async () => {
    const noYes = await arrive({ source: 'google_places', legalBasis: 'legitimate_interest' });
    expect(await contactBlock(db, 'whatsapp', { leadId: noYes.id })).toEqual({
      blocked: true,
      reason: WHATSAPP_OPT_IN_MISSING_TEXT,
      origin: 'prospeccao',
    });
    expect((await contactBlock(db, 'email', { leadId: noYes.id })).blocked).toBe(false);
    const yes = await arrive({ source: 'google_places', legalBasis: 'consent' });
    expect((await contactBlock(db, 'whatsapp', { leadId: yes.id })).blocked).toBe(false);
  });

  it('is open again once a channel is revoked, and the badge lists what is left', async () => {
    const manager = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const lead = await arrive();
    await recordContactOptOut(db, {
      leadId: lead.id,
      channels: ['whatsapp', 'email'],
      origin: 'crm',
      reason: 'Pediu',
      createdBy: manager.id,
    });
    const before = await leadContactOptOuts(db, lead.id);
    expect(before.entries.map((e) => e.channel).sort()).toEqual(['email', 'whatsapp']);
    expect(before.blocks.whatsapp.blocked).toBe(true);
    const revoked = await revokeContactOptOuts(db, {
      leadId: lead.id,
      channel: 'whatsapp',
      reason: 'Voltou a falar',
      by: manager.id,
      at: new Date(),
    });
    expect(revoked).toBeGreaterThan(0);
    const after = await leadContactOptOuts(db, lead.id);
    expect(after.blocks.whatsapp.blocked).toBe(false);
    expect(after.blocks.email.blocked).toBe(true);
    // A new "não me contate" after a revoke is a new row, not a conflict.
    expect(
      await recordContactOptOut(db, {
        leadId: lead.id,
        channels: ['whatsapp'],
        origin: 'crm',
        reason: 'Pediu de novo',
        createdBy: manager.id,
      }),
    ).toBeGreaterThan(0);
  });
});
