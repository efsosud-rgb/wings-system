import { whatsappOptInMissing, WINGS_CLIENT_ID } from '@wings/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  contactOptOuts,
  igPeople,
  igWebhookEvents,
  leadEvents,
  leads,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import { upsertLead } from '../leads/service.js';
import { runInstagramHousekeeping } from '../prospect-ai/housekeeping.js';
import {
  comment,
  commentBody,
  createHarness,
  deliver,
  direct,
  messageBody,
  nextId,
  runIntake,
  sign,
  VERIFY_TOKEN,
  WINGS_ACCOUNT,
  type Harness,
} from './fake-meta.js';

/**
 * Parte 1 (docs/prospeccao/instagram.md §1.4, §5.1, §5.5, §5.6): the webhook and the loop with a
 * fake Meta and a throwaway database. Every id, @, phone and text is made up.
 */

let h: Harness;
let off: Harness;

beforeAll(async () => {
  h = await createHarness();
  off = await createHarness({ INSTAGRAM_WEBHOOK_ENABLED: 'false' });
}, 60_000);
afterAll(async () => {
  await h.close();
  await off.close();
});

const eventCount = async (target = h) =>
  (await target.db.select({ n: sql<number>`count(*)::int` }).from(igWebhookEvents))[0]!.n;

const opportunityOf = async (commentId: string) => {
  const [row] = await h.db
    .select({ opportunity: prospectOpportunities, evidence: prospectEvidence })
    .from(prospectEvidence)
    .leftJoin(prospectOpportunities, eq(prospectOpportunities.id, prospectEvidence.opportunityId))
    .where(eq(prospectEvidence.externalId, commentId));
  return row ?? null;
};

describe('the webhook (§5.1)', () => {
  it('answers the handshake only for our verify token', async () => {
    const ok = await h.app.inject({
      method: 'GET',
      url: `/integrations/instagram/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=desafio123`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('desafio123');
    const wrong = await h.app.inject({
      method: 'GET',
      url: '/integrations/instagram/webhook?hub.mode=subscribe&hub.verify_token=outro-token-qualquer&hub.challenge=x',
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('refuses a body changed by one byte, an absent signature or one without sha256=', async () => {
    const body = commentBody({ text: 'quanto custa?' }, h.clock.now);
    const raw = JSON.stringify(body);
    const before = await eventCount();
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/integrations/instagram/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw.replace('quanto', 'Quanto'),
    });
    expect(tampered.statusCode).toBe(401);
    expect((await deliver(h, body, null)).statusCode).toBe(401);
    expect((await deliver(h, body, sign(raw).slice('sha256='.length))).statusCode).toBe(401);
    expect(await eventCount()).toBe(before);
  });

  it('stores a repeat once, one row per event, and answers before processing anything', async () => {
    const id = nextId();
    const body = commentBody({ id, text: 'quanto custa?' }, h.clock.now);
    const before = await eventCount();
    const first = await deliver(h, body);
    expect(first.json()).toEqual({ received: 1, queued: 1 });
    expect((await deliver(h, body)).json()).toEqual({ received: 1, queued: 0 });
    const two = {
      object: 'instagram',
      entry: [
        { ...commentBody({ text: 'a' }, h.clock.now).entry[0] },
        {
          ...commentBody({ text: 'b' }, h.clock.now).entry[0],
          messaging: messageBody({ from: '5999', text: 'oi' }, h.clock.now).entry[0]!.messaging,
        },
      ],
    };
    expect((await deliver(h, two)).json()).toEqual({ received: 3, queued: 3 });
    expect(await eventCount()).toBe(before + 4);
    const [row] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${id}`));
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    await runIntake(h);
  });

  it('checks the signature over the exact bytes whatever the content type says', async () => {
    const raw = JSON.stringify(commentBody({ text: 'quanto custa?' }, h.clock.now));
    const response = await h.app.inject({
      method: 'POST',
      url: '/integrations/instagram/webhook',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(response.json()).toEqual({ received: 1, queued: 1 });
    await runIntake(h);
  });

  it('off, or without the secret, answers 503 and stores nothing; a body that is not JSON 400', async () => {
    const response = await deliver(off, commentBody({ text: 'x' }, off.clock.now));
    expect(response.statusCode).toBe(503);
    expect(await eventCount(off)).toBe(0);
    const garbage = await h.app.inject({
      method: 'POST',
      url: '/integrations/instagram/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('{x') },
      payload: '{x',
    });
    expect(garbage.statusCode).toBe(400);
  });
});

describe('a comment on a Wings post (§1.4, §3.2)', () => {
  it('"quanto custa?" opens an opportunity; "top!" creates nothing', async () => {
    const price = await comment(h, {
      from: '5101',
      username: 'pessoa.preco',
      text: 'quanto custa?',
    });
    const top = await comment(h, { from: '5102', username: 'pessoa.top', text: 'top! 👏' });
    const found = await opportunityOf(price);
    expect(found?.opportunity).toMatchObject({
      state: 'nova',
      buySignal: 'pediu_preco',
      confidence: 75,
      source: 'instagram_comment',
    });
    expect(found!.opportunity!.respondBy!.getTime() - found!.evidence.occurredAt.getTime()).toBe(
      7 * 86_400_000,
    );
    expect(found!.evidence).toMatchObject({
      authorIgsid: '5101',
      authorUsername: 'pessoa.preco',
      url: 'https://www.instagram.com/p/PostWings/',
    });
    expect(await opportunityOf(top)).toBeNull();
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${top}`));
    // Nothing is kept of a praise: not even the raw event waits the 30 days.
    expect(event).toMatchObject({ status: 'done', lastError: null, payload: null });
    const [kept] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${price}`));
    expect(kept?.payload).not.toBeNull();
  });

  it("a comment on another account the app sees is not Wings': ignored, nothing kept", async () => {
    const body = commentBody(
      { from: '5110', username: 'pessoa.outra', text: 'quanto custa?' },
      h.clock.now,
    );
    body.entry[0]!.id = '17841499999999999';
    const value = body.entry[0]!.changes[0]!.value as { comment_id: string };
    await deliver(h, body);
    await runIntake(h);
    expect(await opportunityOf(value.comment_id)).toBeNull();
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${value.comment_id}`));
    expect(event).toMatchObject({ status: 'ignored', payload: null });
    expect(await h.db.select().from(igPeople).where(eq(igPeople.igsid, '5110'))).toEqual([]);
  });

  it("ignores Wings' own comment", async () => {
    const own = await comment(h, {
      from: WINGS_ACCOUNT,
      username: 'wings',
      text: 'quero, quanto custa?',
    });
    expect(await opportunityOf(own)).toBeNull();
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${own}`));
    expect(event?.status).toBe('ignored');
  });

  it('keeps nothing about a person under "não me contate"', async () => {
    await recordContactOptOut(h.db, {
      instagramUser: 'pessoa.bloqueada',
      channels: ['instagram'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const id = await comment(h, {
      from: '5103',
      username: 'pessoa.bloqueada',
      text: 'quanto custa?',
    });
    expect(await opportunityOf(id)).toBeNull();
    expect(await h.db.select().from(igPeople).where(eq(igPeople.igsid, '5103'))).toEqual([]);
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${id}`));
    expect(event).toMatchObject({ status: 'done', payload: null });
  });

  it('a second comment of the same person joins her open opportunity', async () => {
    const first = await comment(h, {
      from: '5104',
      username: 'pessoa.dois',
      text: 'quanto custa?',
    });
    const second = await comment(h, {
      from: '5104',
      username: 'pessoa.dois',
      text: 'qual o valor?',
    });
    const a = await opportunityOf(first);
    const b = await opportunityOf(second);
    expect(b?.evidence.opportunityId).toBe(a?.opportunity?.id);
  });

  it('a comment of someone already a lead goes on the timeline and tells the owner', async () => {
    const lead = await upsertLead(h.db, {
      source: 'manual',
      name: 'Pessoa Lead',
      phone: '11977776666',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      event: { kind: 'lead.created' },
    });
    await comment(h, { from: '5105', username: 'pessoa.lead', text: 'quanto custa?' });
    await h.db.update(igPeople).set({ leadId: lead.lead.id }).where(eq(igPeople.igsid, '5105'));
    const again = await comment(h, {
      from: '5105',
      username: 'pessoa.lead',
      text: 'quero saber mais',
    });
    expect(await opportunityOf(again)).toBeNull();
    const events = await h.db
      .select()
      .from(leadEvents)
      .where(
        and(
          eq(leadEvents.leadId, lead.lead.id),
          eq(leadEvents.kind, 'prospect.instagram_comment_seen'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('a payload without the commenter fails once, with no retry', async () => {
    const body = commentBody({ text: 'x' }, h.clock.now);
    const value = body.entry[0]!.changes[0]!.value as Record<string, unknown>;
    delete value.from;
    await deliver(h, body);
    await runIntake(h);
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, `comment:${String(value.comment_id)}`));
    expect(event).toMatchObject({ status: 'failed', lastError: 'payload_invalido', attempts: 1 });
  });
});

describe('the answer in the Direct (§5.5) and the ad (§5.6)', () => {
  it('an ad comment keeps the ad id, and her phone in the Direct makes an instagram_ad lead without WhatsApp consent', async () => {
    const id = await comment(
      h,
      {
        from: '5201',
        username: 'pessoa.anuncio',
        text: 'quero franquear minha marca',
        adId: '6001',
      },
      true,
    );
    const found = await opportunityOf(id);
    expect(found?.evidence).toMatchObject({ source: 'instagram_ad_comment', adId: '6001' });
    await direct(h, { from: '5201', text: 'pode me ligar no (11) 98888-7777' });
    const [lead] = await h.db.select().from(leads).where(eq(leads.instagram, 'pessoa.anuncio'));
    expect(lead).toMatchObject({
      source: 'instagram_ad',
      channel: 'instagram',
      pipeline: 'formatacao',
      phone: '5511988887777',
      legalBasis: 'pre_contract',
      consentSource: 'instagram',
      adPlatform: 'meta',
      adExternalId: '6001',
    });
    expect(whatsappOptInMissing(lead!)).toBe(true);
    const after = await opportunityOf(id);
    expect(after?.opportunity).toMatchObject({ state: 'aprovada', leadId: lead!.id });
    const dm = await h.db
      .select()
      .from(prospectEvidence)
      .where(
        and(eq(prospectEvidence.source, 'instagram_dm'), eq(prospectEvidence.authorIgsid, '5201')),
      );
    expect(dm[0]?.excerpt).toBe('pode me ligar no [número]');
  });

  it('her message moves the deadline to 24 h; the echo marks the answer', async () => {
    const id = await comment(h, { from: '5202', username: 'pessoa.janela', text: 'quanto custa?' });
    await direct(h, { from: '5202', text: 'oi, tudo bem?' });
    const found = await opportunityOf(id);
    expect(found!.opportunity!.respondBy!.getTime()).toBe(h.clock.now.getTime() + 24 * 3_600_000);
    await direct(h, { from: '5202', text: 'Oi! Sou da Wings.', echo: true });
    expect((await opportunityOf(id))!.opportunity!.respondedAt).not.toBeNull();
  });

  it('PARAR records "não me contate" by IGSID and @ and closes her opportunities', async () => {
    const id = await comment(h, { from: '5203', username: 'pessoa.parar', text: 'quanto custa?' });
    await direct(h, { from: '5203', text: 'PARAR' });
    expect((await opportunityOf(id))!.opportunity).toMatchObject({ state: 'rejeitada' });
    const keys = await h.db
      .select({ kind: contactOptOuts.keyKind, value: contactOptOuts.keyValue })
      .from(contactOptOuts)
      .where(eq(contactOptOuts.origin, 'instagram'));
    expect(keys).toEqual(
      expect.arrayContaining([
        { kind: 'instagram_igsid', value: '5203' },
        { kind: 'instagram_user', value: 'pessoa.parar' },
      ]),
    );
    // Even under another @ (the IGSID is the same person), nothing opens again.
    const later = await comment(h, { from: '5203', username: 'outro.nome', text: 'quanto custa?' });
    expect(await opportunityOf(later)).toBeNull();
  });

  it('a phone in the Direct that is under "não me contate" makes no lead (every key, lição 3)', async () => {
    // With a funnel (the model's category), so only "não me contate" can stop the lead.
    const id = await comment(
      h,
      { from: '5204', username: 'pessoa.fone', text: 'quero franquear minha marca' },
      true,
    );
    expect((await opportunityOf(id))!.opportunity!.category).toBe('formatacao_franquias');
    await recordContactOptOut(h.db, {
      phone: '11955554444',
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    await direct(h, { from: '5204', text: 'meu número é 11 95555-4444', mid: 'mid.fone.1' });
    expect(await h.db.select().from(leads).where(eq(leads.instagram, 'pessoa.fone'))).toEqual([]);
    expect((await opportunityOf(id))!.opportunity).toMatchObject({ state: 'nova', leadId: null });
    const [person] = await h.db.select().from(igPeople).where(eq(igPeople.igsid, '5204'));
    expect(person?.leadId).toBeNull();
    const [event] = await h.db
      .select()
      .from(igWebhookEvents)
      .where(eq(igWebhookEvents.eventKey, 'message:mid.fone.1'));
    expect(event).toMatchObject({ status: 'done', payload: null });
  });

  it('a Direct from someone who never commented keeps nothing', async () => {
    await direct(h, { from: '5299', text: 'meu telefone é 11 97777-1111' });
    expect(await h.db.select().from(igPeople).where(eq(igPeople.igsid, '5299'))).toEqual([]);
  });
});

describe('the 30 days (§8.4)', () => {
  it('31 days later the @ is gone from every table but the opt-out register', async () => {
    const id = await comment(h, {
      from: '5301',
      username: 'pessoa.expurgo',
      text: 'quanto custa?',
    });
    expect(await opportunityOf(id)).not.toBeNull();
    const result = await runInstagramHousekeeping(
      h.db,
      new Date(h.clock.now.getTime() + 31 * 86_400_000),
    );
    expect(result.ran).toBe(true);
    expect(await opportunityOf(id)).toBeNull();
    expect(await h.db.select().from(igPeople).where(eq(igPeople.igsid, '5301'))).toEqual([]);
    const raw = await h.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ig_webhook_events where payload::text like '%pessoa.expurgo%'`,
    );
    expect(raw.rows[0]?.n).toBe(0);
  });

  it('a person purged alone (no opportunity of hers) is counted in the audit too', async () => {
    const later = new Date(h.clock.now.getTime() + 40 * 86_400_000);
    await runInstagramHousekeeping(h.db, later);
    const at = new Date(h.clock.now.getTime() - 86_400_000);
    await h.db.insert(igPeople).values({ igsid: '5399', firstSeenAt: at, lastSeenAt: at });
    const result = await runInstagramHousekeeping(h.db, later);
    expect(result).toMatchObject({ ran: true, purged: 0, people: 1 });
    const [audit] = await h.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'prospect_ai.instagram_purged'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit?.metadata).toMatchObject({ count: 0, people: 1 });
  });

  it('an opportunity past its 7 days with no answer becomes prazo_vencido', async () => {
    const id = await comment(h, { from: '5302', username: 'pessoa.prazo', text: 'quanto custa?' });
    await runInstagramHousekeeping(h.db, new Date(h.clock.now.getTime() + 8 * 86_400_000));
    expect((await opportunityOf(id))!.opportunity!.state).toBe('prazo_vencido');
  });
});
