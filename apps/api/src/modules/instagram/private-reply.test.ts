import {
  DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
  DEFAULT_PRIVATE_REPLY_TEXT,
  whatsappOptInMissing,
  type InstagramProspect,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contactOptOuts,
  igPeople,
  igPrivateReplies,
  leadEvents,
  leads,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import { runInstagramHousekeeping } from '../prospect-ai/housekeeping.js';
import { loadInstagramSettings } from '../prospect-ai/settings.js';
import {
  call,
  comment,
  createHarness,
  direct,
  loginAs,
  POLICY,
  replyCalls,
  setReply,
  type Harness,
  type Session,
} from './fake-meta.js';
import { retryPrivateReplies } from './private-reply.js';

/**
 * The one private reply (docs/prospeccao/instagram.md §5.2, §5.3, §9) with a fake Meta and a
 * throwaway database: nothing leaves without the gates, and nothing leaves twice. Every id, @ and
 * text is made up.
 */

let h: Harness;
let seller: Session;
let other: Session;
let gerente: Session;
let board: Session;
let expansao: Session;
let admin: Session;
let person = 6000;

beforeAll(async () => {
  h = await createHarness();
  [seller, other, gerente, board, expansao, admin] = [
    await loginAs(h, 'vendedor_formatacao'),
    await loginAs(h, 'vendedor_formatacao'),
    await loginAs(h, 'gerente_comercial'),
    await loginAs(h, 'diretoria'),
    await loginAs(h, 'vendedor_expansao'),
    await loginAs(h, 'admin_master'),
  ];
}, 60_000);
afterAll(async () => h.close());
beforeEach(async () => {
  h.clock.now = new Date('2026-11-01T15:00:00Z');
  h.nextReplies.length = 0;
  await setReply(h, 'clique');
});

/** A buying comment of a new person, as an opportunity owned by the seller. */
async function buying(text = 'quanto custa?', at?: Date, ai = false) {
  const from = String(++person);
  const commentId = await comment(h, { from, username: `pessoa.${from}`, text, at }, ai);
  const [row] = await h.db
    .select({ id: prospectOpportunities.id })
    .from(prospectOpportunities)
    .innerJoin(prospectEvidence, eq(prospectEvidence.id, prospectOpportunities.evidenceId))
    .where(eq(prospectEvidence.externalId, commentId));
  if (row)
    await h.db
      .update(prospectOpportunities)
      .set({ ownerEmployeeId: seller.id })
      .where(eq(prospectOpportunities.id, row.id));
  return { id: row?.id ?? null, from, commentId };
}

const click = (who: Session, id: string) => call(h, who, 'POST', `/prospects/${id}/private-reply`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const replyOf = async (commentId: string) =>
  (await h.db.select().from(igPrivateReplies).where(eq(igPrivateReplies.commentId, commentId)))[0];
/** The loop's retry of the replies Meta asked to wait for, at `now` (the switch on unless null). */
const retry = async (now: Date, config: { token: string; accountId: string } | null = CONFIG) =>
  retryPrivateReplies({
    db: h.db,
    fetch: h.app.wings.instagramFetch!,
    config,
    settings: await loadInstagramSettings(h.db),
    now,
  });
const CONFIG = { token: 't', accountId: '17841400000000001' };
const WAIT = { status: 400, body: { error: { code: 80006 } } };
const MINUTE = 60_000;
/** A comment whose 7 days (less Meta's hour of margin) end `minutes` from now. */
const endingIn = (minutes: number) =>
  new Date(h.clock.now.getTime() - (7 * 24 - 1) * 3_600_000 + minutes * MINUTE);

describe('the click (§5.2, modo clique)', () => {
  it('nothing leaves without the button; the button sends once, the fixed text with the link', async () => {
    const before = replyCalls(h).length;
    const { id, commentId } = await buying();
    expect(replyCalls(h).length).toBe(before);
    const sent = await click(seller, id!);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ ok: true, status: 'sent' });
    const calls = replyCalls(h).slice(before);
    expect(calls).toHaveLength(1);
    const text = DEFAULT_PRIVATE_REPLY_TEXT.replace('{link_politica}', POLICY);
    expect(calls[0]!.body).toEqual({ recipient: { comment_id: commentId }, message: { text } });
    const [row] = await h.db
      .select()
      .from(igPrivateReplies)
      .where(eq(igPrivateReplies.commentId, commentId));
    expect(row).toMatchObject({ status: 'sent', trigger: 'clique', requestedBy: seller.id });
    expect(row!.messageSha256).toBe(createHash('sha256').update(text).digest('hex'));
    // The second click on the same comment does not reach Meta.
    const again = await click(seller, id!);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('ja_tratado');
    await settle();
    expect(replyCalls(h).length).toBe(before + 1);
  });

  it('two clicks at once make one call', async () => {
    const before = replyCalls(h).length;
    const { id } = await buying();
    const answers = await Promise.all([click(seller, id!), click(gerente, id!)]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 409]);
    expect(replyCalls(h).length).toBe(before + 1);
  });

  it('a comment of 7 days and 2 hours is refused before any call', async () => {
    const before = replyCalls(h).length;
    const { id } = await buying(
      'quanto custa?',
      new Date(h.clock.now.getTime() - (7 * 24 + 2) * 3_600_000),
    );
    const refused = await click(seller, id!);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('prazo_meta');
    await settle();
    expect(replyCalls(h).length).toBe(before);
  });

  it('"não me contate" refuses before any call', async () => {
    const before = replyCalls(h).length;
    const { id, from } = await buying();
    await recordContactOptOut(h.db, {
      instagramIgsid: from,
      channels: ['all'],
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const refused = await click(seller, id!);
    expect(refused.json().error).toBe('nao_contatar');
    await settle();
    expect(replyCalls(h).length).toBe(before);
  });

  it('off (mode desligado, or no policy link) refuses before any call', async () => {
    const before = replyCalls(h).length;
    const { id } = await buying();
    await setReply(h, 'desligado');
    expect((await click(seller, id!)).json().error).toBe('desligado');
    await setReply(h, 'clique', null);
    expect((await click(seller, id!)).json().error).toBe('sem_texto');
    await settle();
    expect(replyCalls(h).length).toBe(before);
  });

  it('one reply per person every 7 days, even on another comment', async () => {
    const first = await buying();
    expect((await click(seller, first.id!)).statusCode).toBe(200);
    await h.db
      .update(prospectOpportunities)
      .set({ state: 'rejeitada', decidedAt: h.clock.now })
      .where(eq(prospectOpportunities.id, first.id!));
    const before = replyCalls(h).length;
    await comment(h, { from: first.from, username: `pessoa.${first.from}`, text: 'qual o valor?' });
    const [second] = await h.db
      .select({ id: prospectOpportunities.id })
      .from(prospectOpportunities)
      .innerJoin(igPeople, eq(igPeople.id, prospectOpportunities.igPersonId))
      .where(and(eq(prospectOpportunities.state, 'nova'), eq(igPeople.igsid, first.from)));
    const refused = await click(gerente, second!.id);
    expect(refused.json().error).toBe('limite_pessoa');
    expect(replyCalls(h).length).toBe(before);
  });

  it('a timeout is unknown and never sent again; a limit is tried again only inside the 7 days', async () => {
    const lost = await buying();
    h.nextReplies.push('timeout');
    expect((await click(seller, lost.id!)).json()).toEqual({ ok: true, status: 'unknown' });
    const waited = await buying();
    h.nextReplies.push({ status: 400, body: { error: { code: 80006 } } });
    expect((await click(seller, waited.id!)).json()).toEqual({ ok: true, status: 'rate_limited' });
    const before = replyCalls(h).length;
    const settings = await loadInstagramSettings(h.db);
    const deps = {
      db: h.db,
      fetch: h.app.wings.instagramFetch!,
      config: { token: 't', accountId: '17841400000000001' },
      settings,
    };
    expect(await retryPrivateReplies({ ...deps, now: h.clock.now })).toBe(0);
    expect(replyCalls(h).length).toBe(before);
    const later = new Date(h.clock.now.getTime() + 6 * 60_000);
    expect(await retryPrivateReplies({ ...deps, now: later })).toBe(1);
    expect(replyCalls(h).length).toBe(before + 1);
    expect(
      await retryPrivateReplies({ ...deps, now: new Date(later.getTime() + 86_400_000) }),
    ).toBe(0);
    const [unknown] = await h.db
      .select()
      .from(igPrivateReplies)
      .where(eq(igPrivateReplies.commentId, lost.commentId));
    expect(unknown).toMatchObject({ status: 'unknown', lastError: 'sem_resposta' });
    expect(replyCalls(h).length).toBe(before + 1);
  });

  it('the 601st reply of the hour waits (429), with no call', async () => {
    const { id } = await buying();
    const base = { opportunityId: null, trigger: 'clique', status: 'sent' };
    await h.db.insert(igPrivateReplies).values(
      Array.from({ length: 600 }, (_, i) => ({
        ...base,
        commentId: `hora-${i}`,
        commentCreatedAt: h.clock.now,
        sentAt: new Date(h.clock.now.getTime() - 60_000),
      })),
    );
    const before = replyCalls(h).length;
    const refused = await click(seller, id!);
    expect(refused.statusCode).toBe(429);
    expect(replyCalls(h).length).toBe(before);
    await h.db.delete(igPrivateReplies).where(eq(igPrivateReplies.trigger, 'clique'));
  });
});

describe('modo automatico (§5.2)', () => {
  it('confidence 84 waits for the click; 85 goes once', async () => {
    await setReply(h, 'automatico');
    const before = replyCalls(h).length;
    const low = await buying('quero franquear conf84', undefined, true);
    expect(low.id).not.toBeNull();
    expect(replyCalls(h).length).toBe(before);
    const high = await buying('quero franquear conf85', undefined, true);
    expect(replyCalls(h).length).toBe(before + 1);
    const [row] = await h.db
      .select()
      .from(igPrivateReplies)
      .where(eq(igPrivateReplies.commentId, high.commentId));
    expect(row).toMatchObject({ status: 'sent', trigger: 'automatico', requestedBy: null });
  });
});

describe('who clicks (§9)', () => {
  it('another seller 404, Diretoria and the Expansão seller 403, the manager may', async () => {
    const { id } = await buying();
    expect((await click(other, id!)).statusCode).toBe(404);
    expect((await click(board, id!)).statusCode).toBe(403);
    expect((await click(expansao, id!)).statusCode).toBe(403);
    expect((await click(gerente, id!)).statusCode).toBe(200);
  });

  it('the queue of parte 1 lists the seller her own, with the deadline and the reply', async () => {
    const { id } = await buying();
    await click(seller, id!);
    const mine = (await call(h, seller, 'GET', '/prospects?parte=1')).json() as {
      prospects: InstagramProspect[];
    };
    const found = mine.prospects.find((p) => p.id === id);
    expect(found).toMatchObject({ part: 1, privateReply: { status: 'sent', alone: false } });
    expect(found?.respondBy).not.toBeNull();
    const theirs = (await call(h, other, 'GET', '/prospects?parte=1')).json() as {
      prospects: InstagramProspect[];
    };
    expect(theirs.prospects.some((p) => p.id === id)).toBe(false);
  });

  it('only the Admin Master turns the reply on alone or changes its text', async () => {
    const base = {
      ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
      messages: { ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS.messages, linkPolitica: POLICY },
    };
    const alone = { ...base, privateReply: { ...base.privateReply, modo: 'automatico' } };
    const put = (who: Session, body: unknown) => call(h, who, 'PUT', '/settings', body);
    expect(
      (await put(gerente, { ...base, privateReply: { ...base.privateReply, modo: 'clique' } }))
        .statusCode,
    ).toBe(200);
    expect((await put(gerente, alone)).statusCode).toBe(403);
    expect(
      (
        await put(gerente, {
          ...base,
          privateReply: {
            ...base.privateReply,
            modo: 'clique',
            texto: `Outro texto. {link_politica}`,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect((await put(admin, alone)).statusCode).toBe(200);
    expect(
      (await put(gerente, { ...base, privateReply: { ...base.privateReply, modo: 'clique' } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('WhatsApp only when she asked (§5.5)', () => {
  it('the lead from the Direct has no WhatsApp consent until the seller marks it', async () => {
    const { id, from } = await buying('quero franquear minha marca', undefined, true);
    await direct(h, { from, text: 'meu número é 11 96666-5555' });
    const [lead] = await h.db
      .select()
      .from(leads)
      .where(eq(leads.instagram, `pessoa.${from}`));
    expect(lead?.source).toBe('instagram_comment');
    expect(whatsappOptInMissing(lead!)).toBe(true);
    expect((await call(h, other, 'POST', `/prospects/${id}/whatsapp-asked`)).statusCode).toBe(404);
    expect((await call(h, seller, 'POST', `/prospects/${id}/whatsapp-asked`)).statusCode).toBe(200);
    const [after] = await h.db.select().from(leads).where(eq(leads.id, lead!.id));
    expect(after?.legalBasis).toBe('consent');
    expect(whatsappOptInMissing(after!)).toBe(false);
  });
});

describe('the reply Meta asked to wait for (lição 4: every retry repeats the gates)', () => {
  it('stops, with no call, when she asked to stop in between', async () => {
    const { id, from, commentId } = await buying();
    h.nextReplies.push(WAIT);
    expect((await click(seller, id!)).json()).toEqual({ ok: true, status: 'rate_limited' });
    await recordContactOptOut(h.db, {
      instagramIgsid: from,
      channels: ['instagram'],
      origin: 'instagram',
      reason: null,
      createdBy: null,
    });
    const before = replyCalls(h).length;
    expect(await retry(new Date(h.clock.now.getTime() + 6 * MINUTE))).toBe(0);
    await settle();
    expect(replyCalls(h).length).toBe(before);
    expect(await replyOf(commentId)).toMatchObject({
      status: 'failed',
      lastError: 'nao_contatar',
      nextAttemptAt: null,
    });
  });

  it('stops, with no call, when the switch went off in between', async () => {
    const { id, commentId } = await buying();
    h.nextReplies.push(WAIT);
    await click(seller, id!);
    const before = replyCalls(h).length;
    expect(await retry(new Date(h.clock.now.getTime() + 6 * MINUTE), null)).toBe(0);
    expect(replyCalls(h).length).toBe(before);
    expect(await replyOf(commentId)).toMatchObject({ status: 'failed', lastError: 'desligado' });
  });

  it('stops, with no call, when the 7 days ran out in between', async () => {
    const { id, commentId } = await buying('quanto custa?', endingIn(10));
    h.nextReplies.push(WAIT);
    expect((await click(seller, id!)).json()).toEqual({ ok: true, status: 'rate_limited' });
    const before = replyCalls(h).length;
    expect(await retry(new Date(h.clock.now.getTime() + 11 * MINUTE))).toBe(0);
    expect(replyCalls(h).length).toBe(before);
    expect(await replyOf(commentId)).toMatchObject({ status: 'failed', lastError: 'prazo_meta' });
  });

  it('a wait that would end past the 7 days is not kept for later', async () => {
    const { id, commentId } = await buying('quanto custa?', endingIn(3));
    h.nextReplies.push(WAIT);
    expect((await click(seller, id!)).json()).toEqual({ ok: true, status: 'failed' });
    expect(await replyOf(commentId)).toMatchObject({ status: 'failed', nextAttemptAt: null });
  });

  it("waits again, with no call, while the hour's 600 are used", async () => {
    const { id, commentId } = await buying();
    h.nextReplies.push(WAIT);
    await click(seller, id!);
    const later = new Date(h.clock.now.getTime() + 6 * MINUTE);
    await h.db.insert(igPrivateReplies).values(
      Array.from({ length: 600 }, (_, i) => ({
        opportunityId: null,
        trigger: 'clique',
        status: 'sent',
        commentId: `hora-reenvio-${i}`,
        commentCreatedAt: h.clock.now,
        sentAt: later,
      })),
    );
    const before = replyCalls(h).length;
    expect(await retry(later)).toBe(0);
    expect(replyCalls(h).length).toBe(before);
    expect(await replyOf(commentId)).toMatchObject({ status: 'rate_limited' });
    await h.db
      .delete(igPrivateReplies)
      .where(sql`${igPrivateReplies.commentId} like 'hora-reenvio-%'`);
    expect(await retry(later)).toBe(1);
    expect(replyCalls(h).length).toBe(before + 1);
  });
});

describe('the echo of our own reply (§5.5)', () => {
  it("is not a human answer; a seller's message in the Direct is", async () => {
    const { id, from } = await buying();
    expect((await click(seller, id!)).json()).toEqual({ ok: true, status: 'sent' });
    const [row] = await h.db
      .select()
      .from(igPrivateReplies)
      .where(eq(igPrivateReplies.opportunityId, id!));
    const text = DEFAULT_PRIVATE_REPLY_TEXT.replace('{link_politica}', POLICY);
    const answered = async () =>
      (
        await h.db
          .select({ at: prospectOpportunities.respondedAt })
          .from(prospectOpportunities)
          .where(eq(prospectOpportunities.id, id!))
      )[0]!.at;
    // By Meta's id, and by the text when the echo's id is another.
    await direct(h, { from, echo: true, text, mid: row!.graphMessageId! });
    await direct(h, { from, echo: true, text });
    expect(await answered()).toBeNull();
    await direct(h, { from, echo: true, text: 'Oi! Aqui é da Wings, posso te ligar?' });
    expect(await answered()).not.toBeNull();
  });
});

describe('"Criar lead" on a comment (the click, not the Direct)', () => {
  it('ties the person to the lead: her next comment goes on its timeline, never a reply alone', async () => {
    const { id, from, commentId } = await buying('quero franquear', undefined, true);
    const created = await call(h, seller, 'POST', `/prospects/${id}/lead`, {
      contactName: 'Pessoa Teste',
      phone: '11944443333',
      whatsappOptIn: false,
    });
    expect(created.statusCode).toBe(200);
    const leadId = (created.json() as { leadId: string }).leadId;
    const [person] = await h.db.select().from(igPeople).where(eq(igPeople.igsid, from));
    expect(person?.leadId).toBe(leadId);

    await setReply(h, 'automatico');
    const before = replyCalls(h).length;
    const next = await comment(
      h,
      { from, username: `pessoa.${from}`, text: 'quero comprar conf95' },
      true,
    );
    await settle();
    expect(replyCalls(h).length).toBe(before);
    const opportunities = await h.db
      .select({ id: prospectOpportunities.id })
      .from(prospectOpportunities)
      .where(eq(prospectOpportunities.igPersonId, person!.id));
    expect(opportunities).toHaveLength(1);
    expect(
      await h.db.select().from(prospectEvidence).where(eq(prospectEvidence.externalId, next)),
    ).toEqual([]);
    const seen = await h.db
      .select()
      .from(leadEvents)
      .where(
        and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'prospect.instagram_comment_seen')),
      );
    expect(seen).toHaveLength(1);
    expect(commentId).not.toBe(next);

    // A lead's person is not purged at 30 days, and her PARAR then takes the lead's keys too.
    await runInstagramHousekeeping(h.db, new Date(h.clock.now.getTime() + 31 * 86_400_000));
    expect(await h.db.select().from(igPeople).where(eq(igPeople.igsid, from))).toHaveLength(1);
    await direct(h, { from, text: 'PARAR' });
    const keys = await h.db
      .select({ kind: contactOptOuts.keyKind, value: contactOptOuts.keyValue })
      .from(contactOptOuts)
      .where(eq(contactOptOuts.origin, 'instagram'));
    expect(keys).toEqual(
      expect.arrayContaining([
        { kind: 'instagram_igsid', value: from },
        { kind: 'phone', value: '5511944443333' },
      ]),
    );
  });
});
