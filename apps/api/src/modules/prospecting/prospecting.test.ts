import {
  prospectLeadSchema,
  SESSION_COOKIE,
  WHATSAPP_OPT_IN_MISSING_TEXT,
  WINGS_CLIENT_ID,
  type Lead,
  type Prospect,
  type ProspectEnrichResponse,
  type ProspectingUsage,
  type ProspectPlaceResponse,
  type ProspectSearchResponse,
  type RoleKey,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  crmContacts,
  employees,
  leadContacts,
  leadEvents,
  leadNotes,
  leads,
  prospectCalls,
  prospects,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { PageTransport } from '../../lib/public-probe.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmRequest } from '../agent/llm.js';
import { entryStageOf } from '../leads/crm.js';
import { upsertLead } from '../leads/service.js';
import { fakePlace, fakePlacesApi, type FakePlacesOptions } from './fake-places-api.js';
import { quotaRefusal } from './quota.js';
import { convertProspect, updateProspect } from './service.js';

/**
 * Prospecção against the API, with a scripted Google (`fake-places-api.ts`), a
 * scripted site and a scripted model: no test reaches the network. Made-up
 * companies only.
 */

const KEY = 'test-places-key-never-printed';
const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ...extra,
  });

// --- Google's places (made up) ---------------------------------------------------------------
const P = Array.from({ length: 10 }, (_, i) => fakePlace(i + 1));
const p = (n: number) => P[n - 1]!;
p(5).userRatingCount = 600; // reviews500 instead of reviews200
p(6).displayName = { text: 'Rede Exemplo Burger Centro' };
p(9).rating = 3.9;
p(9).businessStatus = 'CLOSED_PERMANENTLY';
p(7).displayName = { text: 'Hamburgueria Rede Teste' };
p(10).displayName = { text: 'Hamburgueria Rede Teste' };
const GONE = 'ChIJgoneForGood0001';
const ICARAI = 'hamburguerias em Icaraí';
const CENTRO = 'hamburguerias em Centro';
const PLACES: FakePlacesOptions = {
  key: KEY,
  searches: {
    [ICARAI]: [[p(1), p(2), p(3), p(4), p(5), p(7)], [p(8)]],
    [CENTRO]: [[p(3), p(6), p(9), p(10)]],
  },
  places: P,
};

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let bare: FastifyInstance;
let google = fakePlacesApi(PLACES);
let clock: Date | null = null;
const llmSeen: LlmRequest[] = [];
let llmArguments = '';

const siteTransport: PageTransport = async (url) =>
  url.pathname === '/'
    ? {
        status: 200,
        location: null,
        body: '<a href="https://www.instagram.com/hamburgueria.teste1/">insta</a>',
      }
    : { status: 404, location: null, body: '' };

const scriptedLlm: AgentLlm = {
  async complete(request) {
    llmSeen.push(request);
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: 'parametros_da_busca', arguments: llmArguments }],
      usage: { inputTokens: 50, outputTokens: 30, costUsd: 0.0001 },
      finishReason: 'tool_calls',
    };
  },
};

type Session = { id: string; role: RoleKey; cookies: Record<string, string> };
let sellerA: Session;
let sellerB: Session;
let expansao: Session;
let gerente: Session;
let board: Session;
let admin: Session;

async function loginAs(target: FastifyInstance, role: RoleKey, name?: string): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  if (name) await db.update(employees).set({ fullName: name }).where(eq(employees.id, employee.id));
  const login = await target.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, role, cookies: { [SESSION_COOKIE]: token } };
}

const call = (
  session: Session,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  target: FastifyInstance = app,
) =>
  target.inject({
    method,
    url,
    cookies: session.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

const search = (session: Session, body: Record<string, unknown>) =>
  call(session, 'POST', '/prospecting/search', { segment: 'hamburguerias', ...body });

const usage = async (session: Session) =>
  (await call(session, 'GET', '/prospecting/usage')).json<ProspectingUsage>();

let leadByPhone: string;
let leadByPlace: string;
let prospectB: Prospect;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: env({ GOOGLE_PLACES_API_KEY: KEY }),
    db,
    placesFetch: ((input: unknown, init?: RequestInit) =>
      google.fetch(input as string, init)) as typeof fetch,
    siteTransport,
    agentLlm: scriptedLlm,
    now: () => clock ?? new Date(),
  });
  bare = await buildApp({ env: env(), db });

  sellerA = await loginAs(app, 'vendedor_formatacao', 'Ana Vendedora Teste');
  sellerB = await loginAs(app, 'vendedor_formatacao', 'Bruna Vendedora Teste');
  expansao = await loginAs(app, 'vendedor_expansao');
  gerente = await loginAs(app, 'gerente_comercial', 'Gil Gerente Teste');
  board = await loginAs(app, 'diretoria');
  admin = await loginAs(app, 'admin_master');

  // Already ours: a lead with p2's phone (Bruna's), a lead with p4's place_id (nobody's), a client with p5's WhatsApp.
  leadByPhone = (
    await upsertLead(db, {
      source: 'manual',
      name: 'Pessoa Teste Dois',
      phone: '21990000002',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      ownerEmployeeId: sellerB.id,
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    })
  ).lead.id;
  leadByPlace = (
    await upsertLead(db, {
      source: 'manual',
      name: 'Pessoa Teste Quatro',
      email: 'quatro@empresa-teste.com.br',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    })
  ).lead.id;
  await db
    .update(leads)
    .set({ googlePlaceId: p(4).id })
    .where(eq(leads.id, leadByPlace));
  await db.insert(clients).values({
    name: 'Cliente Teste Cinco',
    slug: 'cliente-teste-cinco',
    number: 9905,
    whatsapp: '21990000005',
  });

  const reserved = await call(sellerB, 'POST', '/prospecting/prospects', {
    placeId: p(1).id,
    action: 'reserve',
  });
  expect(reserved.statusCode).toBe(201);
  prospectB = reserved.json<Prospect>();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await harness?.drop();
});

describe('who reaches Prospecção', () => {
  it('refuses the Vendedor Expansão on every route', async () => {
    const id = prospectB.id;
    const routes: [InjectOptions['method'], string, unknown?][] = [
      ['GET', '/prospecting/status'],
      ['GET', '/prospecting/usage'],
      ['GET', '/prospecting/owners'],
      ['GET', '/prospecting/settings'],
      ['PUT', '/prospecting/settings/icp', {}],
      ['PUT', '/prospecting/settings/quota', {}],
      ['POST', '/prospecting/parse', { text: 'hamburguerias em Niterói' }],
      ['POST', '/prospecting/search', { segment: 'x', places: ['y'] }],
      ['GET', '/prospecting/prospects'],
      ['POST', '/prospecting/prospects', { placeId: p(3).id, action: 'reserve' }],
      ['PATCH', `/prospecting/prospects/${id}`, { notes: 'x' }],
      ['GET', `/prospecting/prospects/${id}/place`],
      ['GET', `/prospecting/leads/${leadByPlace}/place`],
      ['POST', `/prospecting/prospects/${id}/enrich`, { website: 'https://x.com.br/' }],
      ['POST', `/prospecting/prospects/${id}/lead`, {}],
    ];
    const before = google.calls.length;
    for (const [method, url, payload] of routes) {
      const res = await call(expansao, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(google.calls.length).toBe(before);
  });

  it('gives the ICP and exclusion list to the manager, the quota to the Admin only', async () => {
    const icp = {
      weights: {
        rating45: 2,
        rating42: 1,
        reviews500: 3,
        reviews200: 2,
        reviews50: 1,
        website: 1,
        instagram: 1,
        multiUnit: 2,
      },
      excludedNames: ['Rede Exemplo Burger'],
    };
    const quota = { perUserDaily: 40, monthlySearches: 950, monthlyDetails: 950 };
    expect((await call(sellerA, 'PUT', '/prospecting/settings/icp', icp)).statusCode).toBe(403);
    expect((await call(gerente, 'PUT', '/prospecting/settings/quota', quota)).statusCode).toBe(403);
    expect((await call(board, 'PUT', '/prospecting/settings/icp', icp)).statusCode).toBe(403);
    const saved = await call(gerente, 'PUT', '/prospecting/settings/icp', icp);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().icp.excludedNames).toEqual(['Rede Exemplo Burger']);
    expect((await call(admin, 'PUT', '/prospecting/settings/quota', quota)).statusCode).toBe(200);
    // Saving one part leaves the other.
    const settings = (await call(sellerA, 'GET', '/prospecting/settings')).json();
    expect(settings.icp.excludedNames).toEqual(['Rede Exemplo Burger']);
    expect(settings.quota).toEqual(quota);
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'prospecting.icp_changed'),
    });
    expect(audit?.metadata).toMatchObject({ excludedCount: 1 });
    expect(JSON.stringify(audit?.metadata)).not.toContain('Rede Exemplo');
  });

  it('lists the owners a manager may hand a prospect to; a seller sees only themselves', async () => {
    const owners = (await call(gerente, 'GET', '/prospecting/owners')).json<{ id: string }[]>();
    const ids = owners.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([sellerA.id, sellerB.id, gerente.id]));
    expect(ids).not.toContain(expansao.id);
    expect((await call(sellerA, 'GET', '/prospecting/owners')).json()).toEqual([
      { id: sellerA.id, name: 'Ana Vendedora Teste' },
    ]);
  });
});

describe('search', () => {
  it('a sweep needs the calls confirmed first', async () => {
    const before = google.calls.length;
    const res = await search(sellerA, { places: ['Icaraí', 'Centro'] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'confirm_calls', calls: 2 });
    expect(google.calls.length).toBe(before);
  });

  it('a sweep: repeated places once, filters, exclusion, held by others hidden, tags and ICP', async () => {
    const res = await search(sellerA, {
      places: ['Icaraí', 'Centro'],
      confirmCalls: 2,
      minRating: 4,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProspectSearchResponse>();
    expect(body.callsSpent).toBe(2);
    expect(body.nextPageToken).toBeNull();
    expect(body.hidden).toEqual({ excluded: 1, filtered: 1, heldByOthers: 1, repeated: 1 });
    const ids = body.items.map((item) => item.placeId);
    expect(ids).not.toContain(p(1).id); // Bruna's
    expect(ids).not.toContain(p(6).id); // Rede Exemplo Burger (excluded)
    expect(ids).not.toContain(p(9).id); // 3.9 and closed
    expect(ids.filter((id) => id === p(3).id)).toHaveLength(1);
    const item = (n: number) => body.items.find((i) => i.placeId === p(n).id)!;
    expect(item(2).tags).toContainEqual({ kind: 'lead', text: 'já é lead: dono Bruna' });
    expect(item(2).leadId).toBeNull(); // Bruna's lead: the seller sees the tag, not the deal
    expect(item(4).tags).toContainEqual({ kind: 'lead', text: 'já é lead: sem dono' });
    expect(item(5).tags).toContainEqual({ kind: 'client', text: 'já é cliente' });
    expect(item(7).tags).toContainEqual({ kind: 'multi_unit', text: 'várias unidades' });
    expect(item(7).icp.reasons).toContain('Mesmo nome em mais de um endereço (+2)');
    expect(item(7).icp.score).toBe(7);
    expect(item(5).icp.score).toBe(6);
    const scores = body.items.map((i) => i.icp.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // The Google call: one per place, the segment "em" the place, page 1 each.
    const sent = google.calls.slice(-2).map((c) => c.body?.textQuery);
    expect(sent.sort()).toEqual([CENTRO, ICARAI].sort());
    expect(body.usage.today.used).toBe(2);
  });

  it('a manager sees what sellers hold, with the tag, and the leads; pages 2 and 3 by token', async () => {
    const res = await search(gerente, { places: ['Icaraí'] });
    const body = res.json<ProspectSearchResponse>();
    const first = body.items.find((i) => i.placeId === p(1).id);
    expect(first?.tags).toContainEqual({ kind: 'reserved', text: 'reservado por Bruna' });
    expect(first?.prospect).toMatchObject({ id: prospectB.id, status: 'reservado', mine: false });
    expect(body.items.find((i) => i.placeId === p(2).id)?.leadId).toBe(leadByPhone);
    expect(body.hidden.heldByOthers).toBe(0);
    expect(body.nextPageToken).toBe(`${ICARAI}|1`);
    const next = await search(gerente, {
      places: ['Icaraí'],
      page: 2,
      pageToken: body.nextPageToken,
    });
    const page2 = next.json<ProspectSearchResponse>();
    expect(page2.items.map((i) => i.placeId)).toEqual([p(8).id]);
    expect(page2.nextPageToken).toBeNull();
    expect(google.calls.at(-1)?.body).toMatchObject({ pageToken: `${ICARAI}|1` });
  });

  it('a place twice is one call, not a sweep', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    const res = await search(seller, { places: ['Icaraí', 'Icaraí'] });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProspectSearchResponse>().callsSpent).toBe(1);
    expect((await usage(seller)).today.used).toBe(1);
  });

  it("turns the seller's sentence into parameters, and sends the model nothing else", async () => {
    llmArguments = JSON.stringify({
      segmento: 'hamburguerias',
      locais: ['Icaraí, Niterói', 'Centro', 'Icaraí ,Niterói'],
      nota_min: 4.5,
      avaliacoes_min: null,
      exige_site: true,
    });
    const before = google.calls.length;
    const res = await call(sellerA, 'POST', '/prospecting/parse', {
      text: 'hamburguerias em Icaraí e Centro com nota 4,5+ e site',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      segmento: 'hamburguerias',
      // One place keeps its city: the form's comma would make it two calls.
      locais: ['Icaraí - Niterói', 'Centro'],
      nota_min: 4.5,
      exige_site: true,
    });
    const request = llmSeen.at(-1)!;
    expect(request.model).toBe('anthropic/claude-haiku-4.5');
    expect(request.noDataCollection).toBe(true);
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: 'hamburguerias em Icaraí e Centro com nota 4,5+ e site',
    });
    expect(google.calls.length).toBe(before); // the AI never searches
    llmArguments = '{"segmento": 3}';
    const bad = await call(sellerA, 'POST', '/prospecting/parse', { text: 'qualquer coisa' });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe('ai_failed');
  });
});

describe('reserve, discard, scope', () => {
  it('one winner when two sellers reserve the same place at once', async () => {
    const [a, b] = await Promise.all([
      call(sellerA, 'POST', '/prospecting/prospects', { placeId: p(3).id, action: 'reserve' }),
      call(sellerB, 'POST', '/prospecting/prospects', { placeId: p(3).id, action: 'reserve' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe('prospect_taken');
    expect(loser.json().message).toMatch(/^Já reservado por (Ana|Bruna)\.$/);
  });

  it("refuses another seller's held prospect, takes over a discarded one, discards with a reason", async () => {
    const taken = await call(sellerA, 'POST', '/prospecting/prospects', {
      placeId: p(1).id,
      action: 'reserve',
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().message).toBe('Já reservado por Bruna.');
    expect(
      (
        await call(sellerA, 'POST', '/prospecting/prospects', {
          placeId: p(5).id,
          action: 'discard',
        })
      ).statusCode,
    ).toBe(400);
    const discarded = await call(sellerA, 'POST', '/prospecting/prospects', {
      placeId: p(5).id,
      action: 'discard',
      reason: 'Já atendido por outra consultoria',
    });
    expect(discarded.statusCode).toBe(201);
    expect(discarded.json<Prospect>()).toMatchObject({ status: 'descartado', mine: true });
    const takeover = await call(sellerB, 'POST', '/prospecting/prospects', {
      placeId: p(5).id,
      action: 'reserve',
    });
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json<Prospect>()).toMatchObject({
      status: 'reservado',
      reason: null,
      mine: true,
    });
  });

  it("a seller sees only their own prospects and gets 404 on another's", async () => {
    await call(sellerA, 'POST', '/prospecting/prospects', { placeId: p(7).id, action: 'reserve' });
    const mine = (await call(sellerA, 'GET', '/prospecting/prospects')).json<Prospect[]>();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.ownerEmployeeId === sellerA.id)).toBe(true);
    const id = prospectB.id;
    expect(
      (await call(sellerA, 'PATCH', `/prospecting/prospects/${id}`, { notes: 'x' })).statusCode,
    ).toBe(404);
    expect((await call(sellerA, 'GET', `/prospecting/prospects/${id}/place`)).statusCode).toBe(404);
    expect(
      (
        await call(sellerA, 'POST', `/prospecting/prospects/${id}/enrich`, {
          website: 'https://x.com.br/',
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(sellerA, 'GET', `/prospecting/leads/${leadByPhone}/place`)).statusCode).toBe(
      404,
    );
  });

  it('a manager sees every prospect and transfers; a seller cannot', async () => {
    const all = (await call(gerente, 'GET', '/prospecting/prospects')).json<Prospect[]>();
    const owners = new Set(all.map((row) => row.ownerEmployeeId));
    expect(owners.has(sellerA.id) && owners.has(sellerB.id)).toBe(true);
    const ofB = (await call(gerente, 'GET', `/prospecting/prospects?owner=${sellerB.id}`)).json<
      Prospect[]
    >();
    expect(ofB.every((row) => row.ownerEmployeeId === sellerB.id)).toBe(true);

    const seller = await call(sellerB, 'PATCH', `/prospecting/prospects/${prospectB.id}`, {
      ownerEmployeeId: sellerA.id,
    });
    expect(seller.statusCode).toBe(403);
    const toExpansao = await call(gerente, 'PATCH', `/prospecting/prospects/${prospectB.id}`, {
      ownerEmployeeId: expansao.id,
    });
    expect(toExpansao.statusCode).toBe(400);
    const moved = await call(gerente, 'PATCH', `/prospecting/prospects/${prospectB.id}`, {
      ownerEmployeeId: sellerA.id,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<Prospect>()).toMatchObject({
      ownerEmployeeId: sellerA.id,
      ownerName: 'Ana Vendedora Teste',
    });
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(auditLog.action, 'prospect.transferred'), eq(auditLog.entityId, prospectB.id)),
    });
    expect(audit?.metadata).toEqual({ from: sellerB.id, to: sellerA.id, status: 'reservado' });
    // Now Ana's: she sets a status and notes.
    const contacted = await call(sellerA, 'PATCH', `/prospecting/prospects/${prospectB.id}`, {
      status: 'contatado',
      notes: 'Ligar de novo na terça',
    });
    expect(contacted.json<Prospect>()).toMatchObject({
      status: 'contatado',
      notes: 'Ligar de novo na terça',
    });
  });

  it('a change from a row read before another seller took the place over lands on nothing', async () => {
    const placeId = 'ChIJraceTestPlace0013';
    const discarded = (
      await call(sellerA, 'POST', '/prospecting/prospects', {
        placeId,
        action: 'discard',
        reason: 'fora do perfil',
      })
    ).json<Prospect>();
    const stale = (await db.query.prospects.findFirst({ where: eq(prospects.id, discarded.id) }))!;
    const taken = await call(sellerB, 'POST', '/prospecting/prospects', {
      placeId,
      action: 'reserve',
    });
    expect(taken.statusCode).toBe(200);
    const ana = {
      employeeId: sellerA.id,
      role: sellerA.role,
      sector: 'comercial',
      isSectorManager: false,
    } as const;
    const changed = { ok: false, error: 'prospect_changed' };
    expect(await updateProspect(db, ana, stale, { notes: 'x' }, new Date())).toMatchObject(changed);
    const input = prospectLeadSchema.parse({
      companyName: 'Empresa Teste Treze',
      contactName: 'Contato Teste',
      phone: '21 98888-0113',
      whatsappOptIn: false,
    });
    expect(await convertProspect(db, ana, stale, input, new Date())).toMatchObject(changed);
    const row = await db.query.prospects.findFirst({ where: eq(prospects.id, discarded.id) });
    expect(row).toMatchObject({ status: 'reservado', ownerEmployeeId: sellerB.id, notes: null });
  });
});

describe('ficha, enrichment and the lead', () => {
  it('opens the live ficha (1 ficha of the month); a place Google lost becomes "não encontrado"', async () => {
    const before = await usage(sellerA);
    const res = await call(sellerA, 'GET', `/prospecting/prospects/${prospectB.id}/place`);
    const body = res.json<ProspectPlaceResponse>();
    expect(body.found && body.place.name).toBe('Hamburgueria Teste 1');
    expect(body.usage.month.details).toBe(before.month.details + 1);
    expect(res.headers['cache-control']).toBe('no-store'); // Google's ficha: no HTTP cache

    const gone = (
      await call(sellerA, 'POST', '/prospecting/prospects', { placeId: GONE, action: 'reserve' })
    ).json<Prospect>();
    const lost = (await call(sellerA, 'GET', `/prospecting/prospects/${gone.id}/place`)).json();
    expect(lost).toMatchObject({ found: false, message: 'Não encontrado no Google.' });
    const row = await db.query.prospects.findFirst({ where: eq(prospects.id, gone.id) });
    expect(row?.status).toBe('nao_encontrado');
    // The company's "do not contact" outlives Google losing the place.
    await db.update(prospects).set({ status: 'nao_contatar' }).where(eq(prospects.id, gone.id));
    await call(gerente, 'GET', `/prospecting/prospects/${gone.id}/place`);
    const kept = await db.query.prospects.findFirst({ where: eq(prospects.id, gone.id) });
    expect(kept?.status).toBe('nao_contatar');
  });

  it('enriches from the company site only what it shows, with the source, never the URL', async () => {
    const res = await call(sellerA, 'POST', `/prospecting/prospects/${prospectB.id}/enrich`, {
      website: p(1).websiteUri,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProspectEnrichResponse>();
    expect(body.pagesRead).toBe(1);
    expect(body.prospect.enrichment.instagram).toMatchObject({
      value: 'https://www.instagram.com/hamburgueria.teste1/',
      source: 'site da empresa',
    });
    const row = await db.query.prospects.findFirst({ where: eq(prospects.id, prospectB.id) });
    expect(JSON.stringify(row)).not.toContain('example.com.br');
    // The Instagram found counts in the ICP from then on.
    const again = (await search(gerente, { places: ['Icaraí'] })).json<ProspectSearchResponse>();
    expect(again.items.find((i) => i.placeId === p(1).id)?.icp.reasons).toContain(
      'Instagram achado no site (+1)',
    );
  });

  it('Diretoria does not create the lead (no leads.write)', async () => {
    const res = await call(board, 'POST', `/prospecting/prospects/${prospectB.id}/lead`, {
      companyName: 'Lanchonete do Contato',
      contactName: 'Carla Contato',
      phone: '21 98888-0101',
      whatsappOptIn: false,
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates the lead in Formatação's entry stage, owned by the prospect's owner, with the WhatsApp answer", async () => {
    const expansaoStage = await entryStageOf(db, 'expansao');
    const wrongStage = await call(sellerA, 'POST', `/prospecting/prospects/${prospectB.id}/lead`, {
      companyName: 'Lanchonete do Contato',
      contactName: 'Carla Contato',
      phone: '21 98888-0101',
      whatsappOptIn: false,
      stageId: expansaoStage.id,
    });
    expect(wrongStage.statusCode).toBe(400);

    const res = await call(sellerA, 'POST', `/prospecting/prospects/${prospectB.id}/lead`, {
      companyName: 'Lanchonete do Contato',
      contactName: 'Carla Contato',
      contactRole: 'Sócia',
      phone: '21 98888-0101',
      email: 'carla@lanchonete-do-contato.com.br',
      instagram: '@lanchonetedocontato',
      notes: 'Tem duas lojas e quer franquear.',
      whatsappOptIn: false,
    });
    expect(res.statusCode).toBe(201);
    const { leadId } = res.json<{ leadId: string }>();
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    expect(lead).toMatchObject({
      source: 'google_places',
      externalId: p(1).id,
      googlePlaceId: p(1).id,
      pipeline: 'formatacao',
      stage: 'Sem contato',
      ownerEmployeeId: sellerA.id,
      legalBasis: 'legitimate_interest',
      consentSource: 'prospeccao',
      enrichmentState: 'none',
    });
    expect(lead?.consentText).toMatch(
      /^Não aceitou receber WhatsApp no primeiro contato \(\d{2}\/\d{2}\/\d{4}\)\.$/,
    );
    const [contact] = await db
      .select({ jobTitle: crmContacts.jobTitle })
      .from(leadContacts)
      .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
      .where(eq(leadContacts.leadId, leadId));
    expect(contact?.jobTitle).toBe('Sócia');
    const notes = await db.select().from(leadNotes).where(eq(leadNotes.leadId, leadId));
    expect(notes.map((n) => n.body)).toEqual(['Tem duas lojas e quer franquear.']);
    const card = (await call(sellerA, 'GET', `/leads/${leadId}`)).json<{ lead: Lead }>();
    expect(card.lead.googlePlaceId).toBe(p(1).id);
    expect(
      (await db.query.prospects.findFirst({ where: eq(prospects.id, prospectB.id) }))?.status,
    ).toBe('virou_lead');
    // Converted: no second lead, no new reservation.
    const twice = await call(sellerA, 'POST', `/prospecting/prospects/${prospectB.id}/lead`, {
      companyName: 'Lanchonete do Contato',
      contactName: 'Carla Contato',
      phone: '21 98888-0101',
      whatsappOptIn: true,
    });
    expect(twice.json().error).toBe('prospect_converted');
    const again = await call(sellerB, 'POST', '/prospecting/prospects', {
      placeId: p(1).id,
      action: 'reserve',
    });
    expect(again.statusCode).toBe(409);

    // The card loads the live place on a click; another seller gets 404.
    const live = await call(sellerA, 'GET', `/prospecting/leads/${leadId}/place`);
    expect(live.json<ProspectPlaceResponse>().found).toBe(true);
    expect((await call(sellerB, 'GET', `/prospecting/leads/${leadId}/place`)).statusCode).toBe(404);
    expect((await call(gerente, 'GET', `/prospecting/leads/${leadByPhone}/place`)).statusCode).toBe(
      404,
    );
  });

  it("nothing from Google is stored: prospects, calls, audit and the lead's timeline", async () => {
    const dump = JSON.stringify(
      [
        await db.select().from(prospects),
        await db.select().from(prospectCalls),
        await db.select().from(auditLog),
        await db.select().from(leadEvents),
        await db
          .select({
            name: leads.name,
            company: leads.companyName,
            phone: leads.phone,
            website: leads.website,
          })
          .from(leads)
          .where(eq(leads.source, 'google_places')),
      ],
      (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    );
    for (const place of P) {
      expect(dump).not.toContain(place.displayName!.text);
      expect(dump).not.toContain(place.formattedAddress!);
      expect(dump).not.toContain(place.nationalPhoneNumber!);
      expect(dump).not.toContain(place.nationalPhoneNumber!.replace(/\D/g, ''));
      expect(dump).not.toContain(place.websiteUri!);
      expect(dump).not.toContain(place.googleMapsUri!);
    }
  });

  it("keeps Google's words out of the tables: no column named for them", async () => {
    const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name in ('prospects', 'prospect_calls', 'prospecting_settings')`);
    expect(columns.rows.length).toBeGreaterThan(15);
    const google = columns.rows.filter((c) =>
      /(name|nome|address|endere|phone|telefone|fone|site|website|url|uri|rating|nota|review|avalia|hour|horario)/i.test(
        c.column_name,
      ),
    );
    expect(google).toEqual([]);
  });

  it('nothing from Google in any table of the database, whatever its name', async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`);
    expect(tables.rows.length).toBeGreaterThan(50);
    let dump = '';
    for (const { table_name } of tables.rows) {
      const rows = await db.execute<{ all: string | null }>(
        sql`select string_agg(row_to_json(t)::text, ' ') as all from ${sql.identifier(table_name)} t`,
      );
      dump += rows.rows[0]?.all ?? '';
    }
    // Phones are left out: the fixtures above hold our own lead and client with a Google phone.
    for (const place of P) {
      expect(dump).not.toContain(place.displayName!.text);
      expect(dump).not.toContain(place.formattedAddress!);
      expect(dump).not.toContain(place.websiteUri!);
      expect(dump).not.toContain(place.googleMapsUri!);
    }
  });
});

describe('WhatsApp needs the opt-in for a prospecting lead', () => {
  it('refuses messages and calls without it, lets them through with it', async () => {
    const reserve = async (n: number) =>
      (
        await call(sellerA, 'POST', '/prospecting/prospects', {
          placeId: p(n).id,
          action: 'reserve',
        })
      ).json<Prospect>();
    const lead = async (prospect: Prospect, optIn: boolean, phone: string) =>
      (
        await call(sellerA, 'POST', `/prospecting/prospects/${prospect.id}/lead`, {
          companyName: `Empresa ${phone}`,
          contactName: 'Contato Teste',
          phone,
          whatsappOptIn: optIn,
        })
      ).json<{ leadId: string }>().leadId;
    const without = await lead(await reserve(10), false, '21 98888-0110');
    const withIt = await lead(await reserve(8), true, '21 98888-0108');

    const text = await call(gerente, 'POST', `/leads/${without}/whatsapp/text`, { text: 'Olá!' });
    expect(text.statusCode).toBe(403);
    expect(text.json()).toEqual({
      error: 'whatsapp_no_opt_in',
      message: WHATSAPP_OPT_IN_MISSING_TEXT,
    });
    const template = await call(gerente, 'POST', `/leads/${without}/whatsapp/template`, {
      name: 'x',
      language: 'pt_BR',
      params: [],
      companyArticle: 'a',
    });
    expect(template.json().error).toBe('whatsapp_no_opt_in');
    const ring = await call(gerente, 'POST', `/leads/${without}/whatsapp/calls`, { sdp: 'v=0' });
    expect(ring.json().error).toBe('whatsapp_no_opt_in');
    const permission = await call(gerente, 'POST', `/leads/${without}/whatsapp/call-permission`);
    expect(permission.json().error).toBe('whatsapp_no_opt_in');

    // With the opt-in the gate lets it pass (here the number is off, so it stops there).
    const allowed = await call(gerente, 'POST', `/leads/${withIt}/whatsapp/text`, { text: 'Olá!' });
    expect(allowed.json().error).toBe('whatsapp_off');
    expect((await db.query.leads.findFirst({ where: eq(leads.id, withIt) }))?.legalBasis).toBe(
      'consent',
    );
  });

  it('a "não" merged into an existing deal of the seller is enforced there too', async () => {
    const existing = await upsertLead(db, {
      source: 'manual',
      name: 'Pessoa Teste Doze',
      phone: '21988880112',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      ownerEmployeeId: sellerA.id,
      legalBasis: 'consent',
      consentSource: 'site_form:teste',
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    });
    const prospect = (
      await call(sellerA, 'POST', '/prospecting/prospects', {
        placeId: 'ChIJmergeTestPlace0012',
        action: 'reserve',
      })
    ).json<Prospect>();
    const merged = await call(sellerA, 'POST', `/prospecting/prospects/${prospect.id}/lead`, {
      companyName: 'Empresa Teste Doze',
      contactName: 'Contato Teste',
      phone: '21 98888-0112',
      whatsappOptIn: false,
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().leadId).toBe(existing.lead.id);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, existing.lead.id) });
    expect(lead).toMatchObject({
      source: 'manual',
      legalBasis: 'legitimate_interest',
      consentSource: 'prospeccao',
    });
    const text = await call(gerente, 'POST', `/leads/${existing.lead.id}/whatsapp/text`, {
      text: 'Olá!',
    });
    expect(text.statusCode).toBe(403);
    expect(text.json().error).toBe('whatsapp_no_opt_in');
  });
});

describe('quota', () => {
  it("says each refusal in the seller's words", () => {
    const base: ProspectingUsage = {
      today: { used: 0, limit: 40 },
      month: { searches: 0, searchLimit: 950, details: 0, detailsLimit: 950 },
    };
    expect(quotaRefusal(base, 'search', 1)).toBeNull();
    expect(quotaRefusal({ ...base, today: { used: 40, limit: 40 } }, 'search', 1)).toBe(
      'Você já usou as 40 chamadas ao Google de hoje. A cota volta amanhã.',
    );
    expect(quotaRefusal({ ...base, today: { used: 37, limit: 40 } }, 'search', 5)).toBe(
      'A varredura gasta 5 chamadas e só restam 3 hoje.',
    );
    expect(quotaRefusal({ ...base, month: { ...base.month, searches: 950 } }, 'search', 1)).toBe(
      'O mês chegou a 950 buscas no Google (cota grátis). A busca volta no dia 1º.',
    );
    expect(quotaRefusal({ ...base, month: { ...base.month, details: 950 } }, 'details', 1)).toBe(
      'O mês chegou a 950 fichas no Google (cota grátis). A ficha volta no dia 1º.',
    );
  });

  it('40 a day per person; a sweep goes whole or not at all', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    await db.insert(prospectCalls).values({ employeeId: seller.id, kind: 'search', count: 37 });
    const before = google.calls.length;
    const sweep = await search(seller, {
      places: ['Icaraí', 'Centro', 'Ingá', 'Gragoatá'],
      confirmCalls: 4,
    });
    expect(sweep.statusCode).toBe(429);
    expect(sweep.json()).toEqual({
      error: 'prospecting_quota',
      message: 'A varredura gasta 4 chamadas e só restam 3 hoje.',
    });
    expect(google.calls.length).toBe(before);
    expect((await usage(seller)).today.used).toBe(37);
    expect(
      (await search(seller, { places: ['Icaraí', 'Centro', 'Ingá'], confirmCalls: 3 })).statusCode,
    ).toBe(200);
    expect((await usage(seller)).today.used).toBe(40);
    const over = await search(seller, { places: ['Icaraí'] });
    expect(over.statusCode).toBe(429);
    expect(over.json().message).toBe(
      'Você já usou as 40 chamadas ao Google de hoje. A cota volta amanhã.',
    );
  });

  it('950 a month per kind for the company: searches stop, fichas go on', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    const [filler] = await db
      .insert(prospectCalls)
      .values({ employeeId: gerente.id, kind: 'search', count: 950 })
      .returning();
    try {
      const res = await search(seller, { places: ['Icaraí'] });
      expect(res.statusCode).toBe(429);
      expect(res.json().message).toBe(
        'O mês chegou a 950 buscas no Google (cota grátis). A busca volta no dia 1º.',
      );
      const prospect = (
        await call(seller, 'POST', '/prospecting/prospects', {
          placeId: p(2).id,
          action: 'reserve',
        })
      ).json<Prospect>();
      expect(
        (await call(seller, 'GET', `/prospecting/prospects/${prospect.id}/place`)).statusCode,
      ).toBe(200);
    } finally {
      // A test-only cleanup: in the app this table is append-only.
      await db.delete(prospectCalls).where(eq(prospectCalls.id, filler!.id));
    }
  });

  it('a call Google failed still counts, and the log never gets its text', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    google = fakePlacesApi({ ...PLACES, failWith: { httpStatus: 500, status: 'INTERNAL' } });
    // Every request's logger, wrapped: what the route writes at warn and error is kept here.
    const logged: string[] = [];
    const child = app.log.child.bind(app.log);
    const spy = vi.spyOn(app.log, 'child').mockImplementation((...args) => {
      const log = child(...args);
      for (const level of ['warn', 'error'] as const) {
        const write = log[level].bind(log) as (...a: unknown[]) => void;
        (log as FastifyBaseLogger)[level] = ((...a: unknown[]) => {
          logged.push(inspect(a, { depth: 4 }));
          write(...a);
        }) as FastifyBaseLogger['warn'];
      }
      return log;
    });
    try {
      const res = await search(seller, { places: ['Icaraí'] });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: 'places_unavailable',
        message: 'O Google não respondeu agora. Tente de novo em instantes.',
      });
      expect((await usage(seller)).today.used).toBe(1);
      expect(google.calls).toHaveLength(1); // never retried
      const log = logged.join('\n');
      expect(log).toContain('prospecting: Google call failed');
      expect(log).toContain("code: 'unavailable'");
      expect(log).not.toContain('Fake Google error');
      expect(log).not.toContain(KEY);
      expect(log).not.toContain('googleapis');
    } finally {
      spy.mockRestore();
      google = fakePlacesApi(PLACES);
    }
  });

  it('days and months turn at midnight in São Paulo, not UTC', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    // 31/03/2027 23:30 in São Paulo is already 01/04 02:30 UTC.
    clock = new Date('2027-04-01T02:30:00Z');
    try {
      expect((await search(seller, { places: ['Icaraí'] })).statusCode).toBe(200);
      clock = new Date('2027-04-01T02:59:00Z');
      expect(await usage(seller)).toMatchObject({ today: { used: 1 }, month: { searches: 1 } });
      clock = new Date('2027-04-01T03:00:00Z'); // 01/04 00:00 in São Paulo
      expect(await usage(seller)).toMatchObject({ today: { used: 0 }, month: { searches: 0 } });
    } finally {
      clock = null;
    }
  });
});

describe('without the Google key', () => {
  it('answers 503 on every call to Google and says so in the status', async () => {
    const seller = await loginAs(bare, 'vendedor_formatacao');
    const status = await call(seller, 'GET', '/prospecting/status', undefined, bare);
    expect(status.json()).toEqual({ configured: false, aiConfigured: false });
    const notConfigured = {
      error: 'places_not_configured',
      message: 'Chave do Google não configurada.',
    };
    const searched = await call(
      seller,
      'POST',
      '/prospecting/search',
      { segment: 'x', places: ['y'] },
      bare,
    );
    expect(searched.statusCode).toBe(503);
    expect(searched.json()).toEqual(notConfigured);
    const ficha = await call(
      seller,
      'GET',
      `/prospecting/prospects/${prospectB.id}/place`,
      undefined,
      bare,
    );
    expect(ficha.statusCode).toBe(503);
    const card = await call(
      seller,
      'GET',
      `/prospecting/leads/${leadByPlace}/place`,
      undefined,
      bare,
    );
    expect(card.statusCode).toBe(503);
    const parsed = await call(
      seller,
      'POST',
      '/prospecting/parse',
      { text: 'hamburguerias' },
      bare,
    );
    expect(parsed.statusCode).toBe(503);
    expect(parsed.json().error).toBe('ai_unavailable');
    expect((await call(sellerA, 'GET', '/prospecting/status')).json()).toEqual({
      configured: true,
      aiConfigured: true,
    });
  });
});
