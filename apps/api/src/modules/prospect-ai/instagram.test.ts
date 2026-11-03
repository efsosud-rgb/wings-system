import {
  SESSION_COOKIE,
  whatsappOptInMissing,
  WINGS_CLIENT_ID,
  type InstagramProspect,
  type PasteConfirmResponse,
  type PastePreviewResponse,
  type RoleKey,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  contactOptOuts,
  igPasteBatches,
  leadEvents,
  leads,
  prospectEvidence,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmRequest } from '../agent/llm.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import { upsertLead } from '../leads/service.js';
import { runInstagramHousekeeping } from './housekeeping.js';

/**
 * Prospecção Instagram, parte 2, against the API and a throwaway database, with a scripted model
 * (no network). Every @ and text is made up (docs/prospeccao/instagram.md §4.1).
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let noAi: FastifyInstance;
let off: FastifyInstance;
const llmSeen: LlmRequest[] = [];
let clock = new Date('2026-10-31T15:00:00Z');

const env = (extra: Record<string, string>) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ...extra,
  });

/** Buys whatever says "quero", praises the rest; the phrase is always the whole text. */
/** What happens elsewhere while the model answers (a test of a race sets it). */
let duringAi: (() => Promise<void>) | null = null;
const scriptedLlm: AgentLlm = {
  async complete(request) {
    llmSeen.push(request);
    if (duringAi) await duringAi();
    const user = request.messages.find((m) => m.role === 'user')!.content;
    const { comentarios } = JSON.parse(user) as { comentarios: { i: number; texto: string }[] };
    const itens = comentarios.map(({ i, texto }) => ({
      i,
      sinal: /quero/i.test(texto) ? 'quer_comprar' : 'duvida',
      categoria: 'formatacao_franquias',
      intencao: 'interesse_declarado',
      confianca: /quero/i.test(texto) ? 90 : 60,
      frase: texto.slice(0, 200),
    }));
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: 'classificar_lote', arguments: JSON.stringify({ itens }) }],
      usage: { inputTokens: 800, outputTokens: 200, costUsd: 0.002 },
      finishReason: 'tool_calls',
    };
  },
};

type Session = { id: string; cookies: Record<string, string> };
let sellerA: Session;
let sellerB: Session;
let gerente: Session;
let board: Session;
let expansao: Session;

async function loginAs(role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const call = (
  who: Session,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  target: FastifyInstance = app,
) =>
  target.inject({
    method,
    url: `/prospect-ai/instagram${url}`,
    cookies: who.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

let post = 0;
/** A new post link each time, so the same comment on another post is another comment. */
const newPost = () => `https://www.instagram.com/p/PostTeste${String(++post).padStart(4, '0')}/`;

const EXAMPLE_1 = `marca.concorrente.exemplo
Verificado
Quer ter a sua própria rede? Comente QUERO 👇
2 sem
usuario.teste01
quanto custa pra abrir uma unidade?
2 sem
3 curtidas
Responder
Ver respostas (1)
marca.concorrente.exemplo
Autor
@usuario.teste01 te chamamos no direct!
2 sem
Responder
loja_ficticia_02
👏👏👏
1 sem
Responder
Ver tradução
Carregar mais comentários`;

const paste = (who: Session, text: string, postUrl = newPost(), target = app) =>
  call(who, 'POST', '/pastes', { text, postUrl }, target);

const prospectsOf = async (who: Session, query = '') =>
  (await call(who, 'GET', `/prospects${query}`)).json<{ prospects: InstagramProspect[] }>()
    .prospects;

/** Scanning every column takes seconds when other test files load the database too. */
const SCAN_TIMEOUT = 60_000;

/** Every text or json column of the public schema that holds `needle`. */
async function columnsHolding(needle: string): Promise<string[]> {
  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'jsonb', 'json', 'character varying', 'ARRAY')`);
  const hits: string[] = [];
  for (const { table_name, column_name } of columns.rows) {
    const found = await db.execute(
      sql`select 1 from ${sql.identifier(table_name)} where ${sql.identifier(column_name)}::text like ${`%${needle}%`} limit 1`,
    );
    if (found.rows.length > 0) hits.push(`${table_name}.${column_name}`);
  }
  return hits;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const base = { db, agentLlm: scriptedLlm, now: () => clock };
  app = await buildApp({
    ...base,
    env: env({
      PROSPECT_AI_INSTAGRAM_PASTE_ENABLED: 'true',
      PROSPECT_AI_CLASSIFIER_ENABLED: 'true',
    }),
  });
  noAi = await buildApp({ ...base, env: env({ PROSPECT_AI_INSTAGRAM_PASTE_ENABLED: 'true' }) });
  off = await buildApp({ ...base, env: env({}) });
  sellerA = await loginAs('vendedor_formatacao');
  sellerB = await loginAs('vendedor_formatacao');
  gerente = await loginAs('gerente_comercial');
  board = await loginAs('diretoria');
  expansao = await loginAs('vendedor_expansao');
  // Known people: a "não contatar", a lead and a client, by their @.
  await recordContactOptOut(db, {
    instagramUser: 'pessoa.bloqueada',
    channels: ['instagram'],
    origin: 'crm',
    reason: 'teste',
    createdBy: null,
  });
  await upsertLead(db, {
    source: 'manual',
    name: 'Pessoa Lead Teste',
    phone: '21990001234',
    fields: { instagram: '@pessoa.lead' },
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    ownerEmployeeId: sellerA.id,
    skipResearch: true,
    event: { kind: 'lead.created_manually' },
  });
  await db.insert(clients).values({
    name: 'Cliente Teste',
    slug: 'cliente-teste-ig',
    number: 9901,
    social: { instagram: '@pessoa.cliente' },
  });
});

afterAll(async () => {
  await Promise.all([app?.close(), noAi?.close(), off?.close()]);
  await harness?.drop();
});

describe('access (§9)', () => {
  it('off by default: 503 on every route but the status', async () => {
    expect((await call(sellerA, 'GET', '/status', undefined, off)).json()).toMatchObject({
      enabled: false,
    });
    const refused = await paste(sellerA, EXAMPLE_1, newPost(), off);
    expect(refused.statusCode).toBe(503);
    expect(await db.select().from(igPasteBatches)).toHaveLength(0);
  });

  it('Diretoria reads and does not paste; the Expansão seller gets 403 everywhere', async () => {
    expect((await call(board, 'GET', '/prospects')).statusCode).toBe(200);
    expect((await paste(board, EXAMPLE_1)).statusCode).toBe(403);
    expect(
      (await call(board, 'POST', '/pastes/preview', { text: EXAMPLE_1, postUrl: newPost() }))
        .statusCode,
    ).toBe(403);
    expect((await call(expansao, 'GET', '/prospects')).statusCode).toBe(403);
    expect((await call(expansao, 'GET', '/status')).statusCode).toBe(403);
  });
});

describe('preview (§1.2 step 3): reads and crosses, writes nothing, no AI', () => {
  it('example 1: 2 comments, 9 interface lines, 0 unrecognized', async () => {
    const before = llmSeen.length;
    const res = await call(sellerA, 'POST', '/pastes/preview', {
      text: EXAMPLE_1,
      postUrl: newPost(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PastePreviewResponse>();
    expect(body.comments.map((c) => c.username)).toEqual(['usuario.teste01', 'loja_ficticia_02']);
    expect([body.linesIgnored, body.linesUnrecognized]).toEqual([9, 0]);
    expect(llmSeen.length).toBe(before);
    expect(await db.select().from(prospectEvidence)).toHaveLength(0);
    expect(await db.select().from(igPasteBatches)).toHaveLength(0);
  });

  it('tags "não contatar", lead and client', async () => {
    const res = await call(sellerA, 'POST', '/pastes/preview', {
      text: '@pessoa.bloqueada: quero\n@pessoa.lead: quero\n@pessoa.cliente: quero\n@pessoa.nova: quero',
      postUrl: newPost(),
    });
    const body = res.json<PastePreviewResponse>();
    expect(body.comments.map((c) => c.tag?.kind ?? null)).toEqual([
      'nao_contatar',
      'lead',
      'cliente',
      null,
    ]);
    expect(body.usable).toBe(1);
  });

  it('refuses a bad link (400), a long text (413) and 301 comments (422)', async () => {
    expect(
      (
        await call(sellerA, 'POST', '/pastes/preview', {
          text: 'x',
          postUrl: 'https://exemplo.com/p/x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(sellerA, 'POST', '/pastes/preview', {
          text: 'a'.repeat(50_001),
          postUrl: newPost(),
        })
      ).json(),
    ).toMatchObject({ error: 'colagem_grande' });
    const many = Array.from({ length: 301 }, (_, i) => `@usuario.n${i}: quero`).join('\n');
    const res = await call(sellerA, 'POST', '/pastes/preview', { text: many, postUrl: newPost() });
    expect([res.statusCode, res.json().error]).toEqual([422, 'colagem_muitos_comentarios']);
  });
});

describe('confirm (§1.2 step 4)', () => {
  it(
    'the pasted text is in no table; phone and e-mail only as [número] and [e-mail]',
    async () => {
      const text = `${EXAMPLE_1}\n@usuario.dados: quero franquear, zap 11 91357-2468 e teste.ficticio@exemplo.com`;
      const res = await paste(sellerA, text);
      expect(res.statusCode).toBe(200);
      expect(await columnsHolding(text)).toEqual([]);
      expect(await columnsHolding('Quer ter a sua própria rede')).toEqual([]);
      expect(await columnsHolding('91357')).toEqual([]);
      expect(await columnsHolding('teste.ficticio@exemplo.com')).toEqual([]);
      const [evidence] = await db
        .select()
        .from(prospectEvidence)
        .where(eq(prospectEvidence.authorUsername, 'usuario.dados'));
      expect(evidence!.excerpt).toBe('quero franquear, zap [número] e [e-mail]');
    },
    SCAN_TIMEOUT,
  );

  it('"não contatar", lead and client never become prospects; nothing is kept about them', async () => {
    await paste(sellerA, '@pessoa.bloqueada: quero\n@pessoa.lead: quero\n@pessoa.cliente: quero');
    for (const who of ['pessoa.bloqueada', 'pessoa.lead', 'pessoa.cliente'])
      expect(
        await db.select().from(prospectEvidence).where(eq(prospectEvidence.authorUsername, who)),
      ).toHaveLength(0);
  });

  it('the same paste twice duplicates nothing', async () => {
    const link = newPost();
    const first = (
      await paste(sellerA, '@usuario.rep1: quero abrir\n@usuario.rep2: top', link)
    ).json<PasteConfirmResponse>();
    const second = (
      await paste(sellerA, '@usuario.rep1: quero abrir\n@usuario.rep2: top', link)
    ).json<PasteConfirmResponse>();
    expect([first.created, second.created, second.repeated]).toEqual([2, 0, 2]);
    expect(
      await db
        .select()
        .from(prospectEvidence)
        .where(eq(prospectEvidence.authorUsername, 'usuario.rep1')),
    ).toHaveLength(1);
  });

  it('AI on: "quero" goes to Quer comprar; praise to Outros; AI off: the rest to Revisar with the reason', async () => {
    const withAi = (
      await paste(sellerA, '@usuario.ai1: quero franquear minha marca\n@usuario.ai2: top!')
    ).json<PasteConfirmResponse>();
    expect(withAi.lists).toMatchObject({ querComprar: 1, revisar: 0 });
    expect(withAi.lists.outros.elogio).toBe(1);
    const without = (
      await paste(sellerB, '@usuario.sem1: quero franquear minha marca', newPost(), noAi)
    ).json<PasteConfirmResponse>();
    expect(without.lists.revisar).toBe(1);
    const [p] = await prospectsOf(sellerB);
    expect(p).toMatchObject({ list: 'revisar', reviewReason: 'sem_ia', username: 'usuario.sem1' });
  });

  it('the 11th paste of the day is 429, and nothing of it is kept', async () => {
    const seller = await loginAs('vendedor_formatacao');
    for (let i = 0; i < 10; i += 1)
      expect((await paste(seller, `@usuario.dia${i}: oi`)).statusCode).toBe(200);
    const eleventh = await paste(seller, '@usuario.dia11: quero');
    expect([eleventh.statusCode, eleventh.json().error]).toEqual([429, 'colagem_limite_dia']);
    expect(
      await db
        .select()
        .from(prospectEvidence)
        .where(eq(prospectEvidence.authorUsername, 'usuario.dia11')),
    ).toHaveLength(0);
  });

  it('a paste with no new comment (known people or repeated) writes no batch and is not counted', async () => {
    const seller = await loginAs('vendedor_formatacao');
    const link = newPost();
    expect((await paste(seller, '@usuario.vazio1: quero abrir', link)).statusCode).toBe(200);
    // 12 pastes with nothing new: more than the 10 of the day, and none is refused.
    for (let i = 0; i < 12; i += 1) {
      const empty =
        i % 2 === 0
          ? await paste(seller, '@usuario.vazio1: quero abrir', link)
          : await paste(seller, '@pessoa.cliente: quero\n@pessoa.bloqueada: quero');
      expect(empty.statusCode).toBe(200);
      expect(empty.json<PasteConfirmResponse>()).toMatchObject({
        batchId: null,
        created: 0,
        joined: 0,
      });
    }
    expect(
      await db.select().from(igPasteBatches).where(eq(igPasteBatches.createdBy, seller.id)),
    ).toHaveLength(1);
    expect((await call(seller, 'GET', '/status')).json()).toMatchObject({ pastesToday: 1 });
    const next = await paste(seller, '@usuario.vazio2: quero abrir');
    expect(next.json<PasteConfirmResponse>()).toMatchObject({ created: 1 });
  });

  it('a "não me contate" written while the AI runs keeps the @ out of the list', async () => {
    duringAi = async () => {
      await recordContactOptOut(db, {
        instagramUser: 'usuario.corrida',
        channels: ['instagram'],
        origin: 'crm',
        reason: 'teste',
        createdBy: null,
      });
    };
    try {
      // A text no other test classifies: not in the cache, so the model runs.
      const res = await paste(sellerA, '@usuario.corrida: quero levar a marca para minha cidade');
      expect(res.json<PasteConfirmResponse>()).toMatchObject({ created: 0, skippedKnown: 1 });
    } finally {
      duringAi = null;
    }
    expect(
      await db
        .select()
        .from(prospectEvidence)
        .where(eq(prospectEvidence.authorUsername, 'usuario.corrida')),
    ).toHaveLength(0);
  });

  it('a second comment of an open prospect joins it, without the AI', async () => {
    await paste(sellerA, '@usuario.junta: quero saber mais');
    const calls = llmSeen.length;
    const again = (
      await paste(sellerA, '@usuario.junta: e quanto custa?')
    ).json<PasteConfirmResponse>();
    expect([again.joined, again.created, llmSeen.length]).toEqual([1, 0, calls]);
    const mine = (await prospectsOf(sellerA)).find((p) => p.username === 'usuario.junta');
    expect(mine!.moreComments).toBe(1);
  });
});

describe('working a prospect (§1.2 step 5)', () => {
  // A new São Paulo day: the sellers' 10 pastes of yesterday no longer count.
  beforeAll(() => {
    clock = new Date('2026-11-01T15:00:00Z');
  });
  const mineOf = async (who: Session, username: string) =>
    (await prospectsOf(who)).find((p) => p.username === username)!;

  it('another seller cannot see or touch it (404); the manager transfers, the seller cannot', async () => {
    await paste(sellerA, '@usuario.dono: quero abrir uma unidade');
    const p = await mineOf(sellerA, 'usuario.dono');
    expect((await prospectsOf(sellerB)).some((x) => x.id === p.id)).toBe(false);
    expect((await call(sellerB, 'POST', `/prospects/${p.id}/approached`)).statusCode).toBe(404);
    expect(
      (await call(sellerA, 'POST', `/prospects/${p.id}/transfer`, { ownerEmployeeId: sellerB.id }))
        .statusCode,
    ).toBe(403);
    const moved = await call(gerente, 'POST', `/prospects/${p.id}/transfer`, {
      ownerEmployeeId: sellerB.id,
    });
    expect(moved.json().prospect).toMatchObject({ ownerEmployeeId: sellerB.id });
    expect((await call(sellerA, 'POST', `/prospects/${p.id}/approached`)).statusCode).toBe(404);
  });

  it('a seller sees only "outro vendedor" for a prospect another holds, never the @', async () => {
    const body = (
      await call(sellerA, 'POST', '/pastes/preview', {
        text: '@usuario.dono: quero mesmo',
        postUrl: newPost(),
      })
    ).json<PastePreviewResponse>();
    expect(body.comments[0]).toMatchObject({
      username: '—',
      excerpt: '',
      tag: { kind: 'prospect', ownerName: null },
    });
  });

  it('Abordei, then Criar lead: origin instagram_colagem, no WhatsApp without the person asking', async () => {
    await paste(sellerA, '@usuario.lead1: quero franquear minha rede');
    const p = await mineOf(sellerA, 'usuario.lead1');
    const approached = await call(sellerA, 'POST', `/prospects/${p.id}/approached`);
    expect(approached.json().prospect).toMatchObject({ state: 'abordada' });
    const created = await call(sellerA, 'POST', `/prospects/${p.id}/lead`, {
      contactName: 'Pessoa Instagram Teste',
      phone: '21990009999',
      whatsappOptIn: false,
    });
    expect(created.statusCode).toBe(200);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, created.json().leadId) });
    expect(lead).toMatchObject({
      source: 'instagram_colagem',
      ownerEmployeeId: sellerA.id,
      pipeline: 'formatacao',
      instagram: 'usuario.lead1',
    });
    expect(whatsappOptInMissing(lead!)).toBe(true);
    expect((await mineOf(sellerA, 'usuario.lead1')).state).toBe('aprovada');
    const [ev] = await db
      .select()
      .from(prospectEvidence)
      .where(eq(prospectEvidence.authorUsername, 'usuario.lead1'));
    expect(ev!.retentionUntil).toBeNull();
  });

  it("an approved prospect's lead is not deleted from under it (no action, never set null)", async () => {
    // Set null could never clear it: the approved CHECK requires lead_id (revisão do PR #70).
    const fk = await db.execute<{ action: string }>(
      sql`select confdeltype as action from pg_constraint where conname = 'prospect_opportunities_lead_id_leads_id_fk'`,
    );
    expect(fk.rows).toEqual([{ action: 'a' }]);
  });

  it('Criar lead with a phone under "não me contate" is refused and writes nothing', async () => {
    await recordContactOptOut(db, {
      phone: '21990007777',
      channels: ['all'],
      origin: 'crm',
      reason: 'teste',
      createdBy: null,
    });
    await paste(sellerA, '@usuario.lead2: quero abrir');
    const p = await mineOf(sellerA, 'usuario.lead2');
    const before = await db.select({ id: leads.id }).from(leads);
    const res = await call(sellerA, 'POST', `/prospects/${p.id}/lead`, {
      contactName: 'Pessoa Teste',
      phone: '21990007777',
      whatsappOptIn: true,
    });
    expect([res.statusCode, res.json().error]).toEqual([409, 'contact_blocked']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.select({ id: leads.id }).from(leads)).toHaveLength(before.length);
    expect((await mineOf(sellerA, 'usuario.lead2')).state).toBe('nova');
  });

  it('Não contatar: in the register by the @, the prospect closed, the next paste tags it', async () => {
    await paste(sellerA, '@usuario.parar: quero saber');
    const p = await mineOf(sellerA, 'usuario.parar');
    await call(sellerA, 'POST', `/prospects/${p.id}/do-not-contact`, {});
    const rows = await db
      .select()
      .from(contactOptOuts)
      .where(eq(contactOptOuts.keyValue, 'usuario.parar'));
    expect(rows.map((r) => [r.keyKind, r.channel, r.origin])).toEqual([
      ['instagram_user', 'instagram', 'prospeccao'],
    ]);
    expect((await mineOf(sellerA, 'usuario.parar')).state).toBe('rejeitada');
    const again = (
      await call(sellerA, 'POST', '/pastes/preview', {
        text: '@usuario.parar: quero',
        postUrl: newPost(),
      })
    ).json<PastePreviewResponse>();
    expect(again.comments[0]!.tag).toEqual({ kind: 'nao_contatar' });
  });

  it('Outros back to Quer comprar by the seller; a discarded one only by the manager', async () => {
    await paste(sellerA, '@usuario.elogio: top!\n@usuario.descarte: quero');
    const outros = await mineOf(sellerA, 'usuario.elogio');
    expect(outros.list).toBe('outros');
    expect(
      (await call(sellerA, 'POST', `/prospects/${outros.id}/promote`)).json().prospect,
    ).toMatchObject({ state: 'nova' });
    const d = await mineOf(sellerA, 'usuario.descarte');
    expect(
      (await call(sellerA, 'POST', `/prospects/${d.id}/discard`, { reason: 'sem perfil' })).json()
        .prospect,
    ).toMatchObject({ state: 'rejeitada' });
    expect((await call(sellerA, 'POST', `/prospects/${d.id}/promote`)).statusCode).toBe(403);
    expect(
      (await call(gerente, 'POST', `/prospects/${d.id}/promote`)).json().prospect,
    ).toMatchObject({ state: 'nova' });
  });

  it('attaches the comment of someone who is already a lead to the timeline', async () => {
    const lead = await db.query.leads.findFirst({ where: eq(leads.instagram, 'pessoa.lead') });
    const res = await call(sellerA, 'POST', '/pastes/attach', {
      leadId: lead!.id,
      postUrl: newPost(),
      username: '@pessoa.lead',
      text: 'quero, me liga 11 97777-0000',
      when: '2 d',
    });
    expect(res.statusCode).toBe(200);
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.kind, 'prospect.instagram_comment_seen'));
    expect((event!.detail as { excerpt: string }).excerpt).toBe('quero, me liga [número]');
    expect(
      (
        await call(sellerB, 'POST', '/pastes/attach', {
          leadId: lead!.id,
          postUrl: newPost(),
          username: 'pessoa.lead',
          text: 'oi',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('audit carries ids and counts, never the @ or the excerpt', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} like 'prospect_ai.instagram%'`);
    expect(rows.length).toBeGreaterThan(5);
    expect(JSON.stringify(rows.map((row) => row.metadata))).not.toMatch(/usuario\.|quero/);
  });

  it("a manager lists every seller's prospects, a seller only her own", async () => {
    const all = await prospectsOf(gerente);
    expect(new Set(all.map((p) => p.ownerEmployeeId)).size).toBeGreaterThan(1);
    expect((await prospectsOf(sellerA)).every((p) => p.mine)).toBe(true);
  });
});

describe('purge after 30 days (§8.4) and nothing personal in the dw (§2.7)', () => {
  it(
    'clock + 31 days: the @ is gone from every table but contact_opt_outs; a lead stays',
    async () => {
      const later = new Date(clock.getTime() + 31 * 86_400_000);
      const result = await runInstagramHousekeeping(db, later);
      expect(result).toMatchObject({ ran: true });
      expect(await columnsHolding('usuario.dono')).toEqual([]);
      expect(await columnsHolding('usuario.junta')).toEqual([]);
      expect(await columnsHolding('usuario.parar')).toEqual(['contact_opt_outs.key_value']);
      // Became a lead: its comment follows the lead's retention.
      expect(await columnsHolding('usuario.lead1')).toContain('prospect_evidence.author_username');
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'prospect_ai.instagram_purged'));
      expect((audit!.metadata as { count: number }).count).toBeGreaterThan(5);
    },
    SCAN_TIMEOUT,
  );

  it(
    'a day before the deadline nothing is purged',
    async () => {
      await paste(sellerB, '@usuario.recente: quero abrir');
      const result = await runInstagramHousekeeping(
        db,
        new Date(clock.getTime() + 29 * 86_400_000),
      );
      expect(result).toMatchObject({ purged: 0 });
      expect(await columnsHolding('usuario.recente')).not.toEqual([]);
    },
    SCAN_TIMEOUT,
  );

  it('no column of the dw is named after the @, the excerpt, the post or the IGSID', async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns where table_schema = 'dw'`);
    expect(columns.rows.length).toBeGreaterThan(0);
    const personal = columns.rows.filter((c) =>
      /username|excerpt|trecho|igsid|instagram|post_url|comment/.test(c.column_name),
    );
    expect(personal).toEqual([]);
  });
});
