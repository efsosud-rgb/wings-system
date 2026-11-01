import {
  PROSPECT_APPROACH_DAILY_MAX,
  PROSPECT_FOLLOW_UP_TITLE,
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Prospect,
  type ProspectApproach,
  type ProspectBatchResponse,
  type ProspectingMetrics,
  type ProspectSearchHistoryItem,
  type ProspectSearchResponse,
  type RoleKey,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  leadEvents,
  leadNotes,
  leads,
  leadTasks,
  prospectCalls,
  prospects,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import type { PageTransport } from '../../lib/public-probe.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmRequest } from '../agent/llm.js';
import { upsertLead } from '../leads/service.js';
import { fakePlace, fakePlacesApi, type FakePlacesOptions } from './fake-places-api.js';
import { prospectsToCsv } from './insights.js';

/**
 * Wings Maps Prospecting on top of Prospecção: search filters and flags, batch reservation,
 * history, numbers, export, the approach suggestion and the whole way from a search to a lead
 * with its follow-up. Google, the company's site and the model are scripted: no test reaches the
 * network. Made-up companies only.
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
const q = (n: number, overrides: Parameters<typeof fakePlace>[1] = {}) =>
  fakePlace(n, { displayName: { text: `Padaria Teste ${n}` }, ...overrides });
const A = q(41); // complete
const B = q(42, { nationalPhoneNumber: undefined, rating: undefined }); // incomplete
const C = q(43, { nationalPhoneNumber: '(21) 99000-0044' }); // same phone as D
const D = q(44);
const E = q(45, { websiteUri: 'https://padaria-teste-ja-lead.example.com.br/' }); // a deal's site
const F = q(46, { websiteUri: 'https://www.instagram.com/padaria.teste.46/' }); // a profile
const G = q(47);
const H = q(48);
const SEGMENT_PLACE = 'padarias em Ingá';
const PLACES: FakePlacesOptions = {
  key: KEY,
  searches: { [SEGMENT_PLACE]: [[A, B, C, D, E, F, G, H]] },
  places: [A, B, C, D, E, F, G, H],
};
const GOOGLE_WORDS = [
  'Padaria Teste',
  'Rua Fictícia',
  '99000-00',
  'example.com.br',
  'maps.google.com',
];

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let bare: FastifyInstance;
const google = fakePlacesApi(PLACES);
let failFetch: ((url: string) => Promise<Response>) | null = null;
const llmSeen: LlmRequest[] = [];
let approachArguments = '';

const siteTransport: PageTransport = async (url) =>
  url.pathname === '/'
    ? {
        status: 200,
        location: null,
        body: '<a href="https://www.instagram.com/padaria.teste41/">insta</a>',
      }
    : { status: 404, location: null, body: '' };

const scriptedLlm: AgentLlm = {
  async complete(request) {
    llmSeen.push(request);
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: request.toolChoice ?? '', arguments: approachArguments }],
      usage: { inputTokens: 50, outputTokens: 30, costUsd: 0.0001 },
      finishReason: 'tool_calls',
    };
  },
};

type Session = { id: string; role: RoleKey; cookies: Record<string, string> };
let sellerA: Session;
let sellerB: Session;
let gerente: Session;
let board: Session;

async function loginAs(target: FastifyInstance, role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
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

const search = (session: Session, body: Record<string, unknown> = {}) =>
  call(session, 'POST', '/prospecting/search', { segment: 'padarias', places: ['Ingá'], ...body });

const approachAnswer = {
  abertura: 'Olá, aqui é da Wings Company. Vocês já pensaram em franquear a padaria?',
  pontos: ['Como a Wings formata franquias', 'O que muda na operação'],
  proximo_passo: 'Uma conversa de 20 minutos nesta semana',
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: env({ GOOGLE_PLACES_API_KEY: KEY }),
    db,
    placesFetch: ((input: unknown, init?: RequestInit) =>
      failFetch ? failFetch(String(input)) : google.fetch(input as string, init)) as typeof fetch,
    siteTransport,
    agentLlm: scriptedLlm,
  });
  bare = await buildApp({ env: env(), db });
  sellerA = await loginAs(app, 'vendedor_formatacao');
  sellerB = await loginAs(app, 'vendedor_formatacao');
  gerente = await loginAs(app, 'gerente_comercial');
  board = await loginAs(app, 'diretoria');

  // A deal whose site is E's domain (typed with www and a path); one whose "site" is a profile.
  const withSite = await upsertLead(db, {
    source: 'manual',
    name: 'Pessoa Teste Site',
    email: 'site@empresa-teste.com.br',
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    ownerEmployeeId: sellerB.id,
    skipResearch: true,
    event: { kind: 'lead.created_manually' },
  });
  await db
    .update(leads)
    .set({ website: 'WWW.Padaria-Teste-Ja-Lead.example.com.br/contato' })
    .where(eq(leads.id, withSite.lead.id));
  const withProfile = await upsertLead(db, {
    source: 'manual',
    name: 'Pessoa Teste Perfil',
    email: 'perfil@empresa-teste.com.br',
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    skipResearch: true,
    event: { kind: 'lead.created_manually' },
  });
  await db
    .update(leads)
    .set({ website: 'https://instagram.com/outra.empresa.teste' })
    .where(eq(leads.id, withProfile.lead.id));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await harness?.drop();
});

describe('search: filters, incomplete records, possible duplicates', () => {
  it('validates the parameters before any call to Google', async () => {
    const before = google.calls.length;
    for (const body of [
      { segment: 'x' },
      { places: [] },
      { requirePhone: 'sim' },
      { minRating: 6 },
      { page: 2 },
    ])
      expect((await search(sellerA, body)).statusCode).toBe(400);
    expect(google.calls.length).toBe(before);
  });

  it('flags what Google did not give, and duplicates without merging them', async () => {
    const res = await search(sellerA);
    expect(res.statusCode).toBe(200);
    const answer = res.json<ProspectSearchResponse>();
    const item = (id: string) => answer.items.find((i) => i.placeId === id)!;
    expect(answer.items).toHaveLength(8);
    expect(item(A.id).missing).toEqual([]);
    expect(item(B.id).missing).toEqual(['phone', 'rating']);
    expect(item(B.id).icp.reasons.some((r) => r.startsWith('Nota'))).toBe(false);
    // C and D share a phone: both flagged, both kept, each its own place.
    for (const place of [C, D])
      expect(item(place.id).tags).toContainEqual({
        kind: 'possible_duplicate',
        text: 'possível duplicidade: mesmo telefone',
      });
    expect(item(E.id).tags).toContainEqual({
      kind: 'possible_duplicate',
      text: 'possível lead: mesmo site de uma negociação',
    });
    // A profile page is not a company's own site: no duplicate by it.
    expect(item(F.id).tags.filter((t) => t.kind === 'possible_duplicate')).toEqual([]);
    expect(item(A.id).tags).toEqual([]);
  });

  it('a "não me contate" on the place or on its phone shows on the card', async () => {
    await recordContactOptOut(db, {
      placeId: G.id,
      channels: ['all'],
      origin: 'crm',
      reason: 'Pediu',
      createdBy: null,
    });
    await recordContactOptOut(db, {
      phone: H.nationalPhoneNumber,
      channels: ['whatsapp'],
      origin: 'whatsapp_palavra',
      reason: null,
      createdBy: null,
    });
    const answer = (await search(sellerA)).json<ProspectSearchResponse>();
    const tags = (id: string) => answer.items.find((i) => i.placeId === id)!.tags;
    expect(tags(G.id)).toContainEqual({
      kind: 'do_not_contact',
      text: expect.stringMatching(
        /^não me contate: todos os canais, desde \d{2}\/\d{2}\/\d{4} \(registrado no CRM\)$/,
      ),
    });
    expect(tags(H.id).find((t) => t.kind === 'do_not_contact')?.text).toContain('WhatsApp');
    expect(tags(A.id)).toEqual([]);
  });

  it('"só com telefone" leaves out the results without one and says so', async () => {
    const answer = (await search(sellerA, { requirePhone: true })).json<ProspectSearchResponse>();
    expect(answer.items.map((i) => i.placeId)).not.toContain(B.id);
    expect(answer.items).toHaveLength(7);
    expect(answer.hidden.filtered).toBe(1);
  });
});

describe('Google failing', () => {
  it('a timeout and a rate limit answer 502 in words, count the call, and are not retried', async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    let calls = 0;
    failFetch = async () => {
      calls += 1;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    try {
      const timedOut = await search(seller);
      expect(timedOut.statusCode).toBe(502);
      expect(timedOut.json()).toEqual({
        error: 'places_timeout',
        message: 'O Google não respondeu agora. Tente de novo em instantes.',
      });
      failFetch = async () => {
        calls += 1;
        return Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
      };
      const limited = await search(seller);
      expect(limited.statusCode).toBe(502);
      expect(limited.json()).toMatchObject({ error: 'places_quota_exceeded' });
      expect(calls).toBe(2);
      const usage = await call(seller, 'GET', '/prospecting/usage');
      expect(usage.json()).toMatchObject({ today: { used: 2 } });
    } finally {
      failFetch = null;
    }
  });
});

describe('batch reservation', () => {
  it('validates the batch', async () => {
    const twice = await call(sellerA, 'POST', '/prospecting/prospects/batch', {
      placeIds: [A.id, A.id],
    });
    expect(twice.statusCode).toBe(400);
    const many = await call(sellerA, 'POST', '/prospecting/prospects/batch', {
      placeIds: Array.from({ length: 61 }, (_, i) => fakePlace(500 + i).id),
    });
    expect(many.statusCode).toBe(400);
    expect(
      (await call(sellerA, 'POST', '/prospecting/prospects/batch', { placeIds: [] })).statusCode,
    ).toBe(400);
  });

  it('reserves each place on its own and says why the others did not go', async () => {
    // G is held by seller B; H asked not to be contacted.
    expect(
      (await call(sellerB, 'POST', '/prospecting/prospects', { placeId: G.id, action: 'reserve' }))
        .statusCode,
    ).toBe(201);
    const h = (
      await call(sellerB, 'POST', '/prospecting/prospects', { placeId: H.id, action: 'reserve' })
    ).json<Prospect>();
    await call(sellerB, 'PATCH', `/prospecting/prospects/${h.id}`, { status: 'nao_contatar' });

    const res = await call(sellerA, 'POST', '/prospecting/prospects/batch', {
      placeIds: [C.id, G.id, H.id, D.id],
    });
    expect(res.statusCode).toBe(200);
    const batch = res.json<ProspectBatchResponse>();
    expect(batch.reserved).toBe(2);
    expect(batch.refused).toBe(2);
    expect(batch.results.map((r) => [r.placeId, r.ok])).toEqual([
      [C.id, true],
      [G.id, false],
      [H.id, false],
      [D.id, true],
    ]);
    expect(batch.results[1]).toMatchObject({ error: 'prospect_taken' });
    expect(batch.results[2]).toMatchObject({
      error: 'prospect_do_not_contact',
      message: 'A empresa pediu para não ser contatada.',
    });
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'prospect.reserved'), eq(auditLog.actorEmployeeId, sellerA.id)),
      );
    expect(audit.filter((row) => (row.metadata as { batch?: boolean }).batch)).toHaveLength(2);
    // Again: what is already the seller's stays, without a second audit entry.
    const again = (
      await call(sellerA, 'POST', '/prospecting/prospects/batch', { placeIds: [C.id] })
    ).json<ProspectBatchResponse>();
    expect(again.reserved).toBe(1);
    const after = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'prospect.reserved'), eq(auditLog.actorEmployeeId, sellerA.id)),
      );
    expect(after).toHaveLength(audit.length);
  });
});

describe('history and numbers', () => {
  it('a seller sees their own searches; a manager everyone’s; only what was typed', async () => {
    await search(sellerB, { segment: 'confeitarias', places: ['Ingá'] });
    const own = (await call(sellerA, 'GET', '/prospecting/history')).json<
      ProspectSearchHistoryItem[]
    >();
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((item) => item.mine)).toBe(true);
    expect(own[0]).toMatchObject({ segment: 'padarias', places: ['Ingá'], calls: 1 });
    const all = (await call(gerente, 'GET', '/prospecting/history')).json<
      ProspectSearchHistoryItem[]
    >();
    expect(all.some((item) => item.segment === 'confeitarias')).toBe(true);
    const text = JSON.stringify(all);
    for (const word of GOOGLE_WORDS) expect(text).not.toContain(word);
  });

  it('counts prospects by owner and status inside the scope', async () => {
    const own = (await call(sellerA, 'GET', '/prospecting/metrics')).json<ProspectingMetrics>();
    expect(own.owners.map((o) => o.employeeId)).toEqual([sellerA.id]);
    expect(own.byStatus.reservado).toBe(2);
    const all = (await call(gerente, 'GET', '/prospecting/metrics')).json<ProspectingMetrics>();
    const holding = all.owners.filter((o) => o.total > 0).map((o) => o.employeeId);
    expect(holding.sort()).toEqual([sellerA.id, sellerB.id].sort());
    // Who only spent calls (the timeout test's seller) is listed with them and no prospects.
    expect(all.owners.some((o) => o.total === 0 && o.callsThisMonth === 2)).toBe(true);
    expect(all.byStatus).toMatchObject({ reservado: 3, nao_contatar: 1 });
    expect(all.total).toBe(4);
    expect(all.conversionRate).toBe(0);
    expect(all.callsThisMonth).toBeGreaterThan(0);
  });
});

describe('export', () => {
  it('only who holds prospecting.export, and only our data', async () => {
    for (const session of [sellerA, board])
      expect((await call(session, 'GET', '/prospecting/prospects/export.csv')).statusCode).toBe(
        403,
      );
    const res = await call(gerente, 'GET', '/prospecting/prospects/export.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['x-rows']).toBe('4');
    for (const word of GOOGLE_WORDS) expect(res.body).not.toContain(word);
    expect(res.body).toContain(C.id);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'prospecting.exported'));
    expect(audit).toMatchObject({ actorEmployeeId: gerente.id, metadata: { rows: 4 } });
  });

  it('keeps a typed formula as text', () => {
    const csv = prospectsToCsv([
      {
        id: 'x',
        placeId: 'ChIJformula0001',
        status: 'descartado',
        ownerEmployeeId: null,
        ownerName: null,
        mine: false,
        reason: '=HYPERLINK("http://x")',
        notes: '+1',
        enrichment: {},
        leadId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(";'+1;");
  });
});

describe('approach suggestion', () => {
  it("drafts from the seller's words only, sends nothing, and is marked as the AI's", async () => {
    const [c] = await db.select().from(prospects).where(eq(prospects.placeId, C.id));
    approachArguments = JSON.stringify(approachAnswer);
    llmSeen.length = 0;
    const res = await call(sellerA, 'POST', `/prospecting/prospects/${c!.id}/approach`, {
      channel: 'ligacao',
      segment: 'padarias',
      context: 'Duas unidades, querem crescer',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProspectApproach>()).toEqual({
      origin: 'ia',
      channel: 'ligacao',
      opening: approachAnswer.abertura,
      points: approachAnswer.pontos,
      nextStep: approachAnswer.proximo_passo,
    });
    const sent = JSON.stringify(llmSeen);
    for (const word of [...GOOGLE_WORDS, C.id]) expect(sent).not.toContain(word);
    expect(sent).toContain('Duas unidades');
    expect(llmSeen[0]?.noDataCollection).toBe(true);
  });

  it('refuses WhatsApp, another seller’s prospect, a "do not contact", and without the AI', async () => {
    const [c] = await db.select().from(prospects).where(eq(prospects.placeId, C.id));
    const [h] = await db.select().from(prospects).where(eq(prospects.placeId, H.id));
    const url = (id: string) => `/prospecting/prospects/${id}/approach`;
    expect((await call(sellerA, 'POST', url(c!.id), { channel: 'whatsapp' })).statusCode).toBe(400);
    expect((await call(sellerB, 'POST', url(c!.id), { channel: 'email' })).statusCode).toBe(404);
    expect((await call(sellerB, 'POST', url(h!.id), { channel: 'email' })).statusCode).toBe(409);
    const noAi = await call(sellerA, 'POST', url(c!.id), { channel: 'email' }, bare);
    expect(noAi.statusCode).toBe(503);
    approachArguments = '{"abertura": ""}';
    expect((await call(sellerA, 'POST', url(c!.id), { channel: 'email' })).statusCode).toBe(502);
  });

  it(`stops at ${PROSPECT_APPROACH_DAILY_MAX} a day per person`, async () => {
    const seller = await loginAs(app, 'vendedor_formatacao');
    const prospect = (
      await call(seller, 'POST', '/prospecting/prospects', {
        placeId: fakePlace(90).id,
        action: 'reserve',
      })
    ).json<Prospect>();
    await db.insert(auditLog).values(
      Array.from({ length: PROSPECT_APPROACH_DAILY_MAX }, () => ({
        actorEmployeeId: seller.id,
        action: 'prospect.approach_suggested',
        entity: 'prospect',
        entityId: prospect.id,
      })),
    );
    const res = await call(seller, 'POST', `/prospecting/prospects/${prospect.id}/approach`, {
      channel: 'email',
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'approach_quota' });
  });
});

describe('the whole way: search → qualify → review → import → owner → activity', () => {
  it('ends in a Formatação lead with its owner, origin, follow-up and timeline', async () => {
    // 1-4. Search and qualify (score, flags) — A is complete and free.
    const answer = (await search(sellerA)).json<ProspectSearchResponse>();
    const a = answer.items.find((i) => i.placeId === A.id)!;
    expect(a.prospect).toBeNull();
    expect(a.icp.score).toBeGreaterThan(0);
    // 5. The seller reviewed and ticked it.
    const batch = (
      await call(sellerA, 'POST', '/prospecting/prospects/batch', { placeIds: [A.id] })
    ).json<ProspectBatchResponse>();
    const reserved = batch.results[0];
    if (!reserved?.ok) throw new Error('A should be reserved');
    const prospectId = reserved.prospect.id;
    expect(
      (
        await call(sellerA, 'POST', `/prospecting/prospects/${prospectId}/enrich`, {
          website: 'https://padaria-teste-41.example.com.br/',
        })
      ).statusCode,
    ).toBe(200);
    // 6-8. After the first contact: the lead, the owner, the origin, the return agreed.
    const followUpAt = '2027-03-10T13:00:00.000Z';
    const created = await call(sellerA, 'POST', `/prospecting/prospects/${prospectId}/lead`, {
      companyName: 'Empresa Teste Quarenta e Um',
      contactName: 'Contato Teste',
      phone: '21990009041',
      whatsappOptIn: false,
      notes: 'Pediu retorno em março',
      followUpAt,
    });
    expect(created.statusCode).toBe(201);
    const { leadId } = created.json<{ leadId: string }>();
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({
      source: 'google_places',
      pipeline: 'formatacao',
      ownerEmployeeId: sellerA.id,
      googlePlaceId: A.id,
      legalBasis: 'legitimate_interest',
      consentSource: 'prospeccao',
    });
    // 9. Traceable: the task for the owner, the timeline, the prospect, the audit.
    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, leadId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'follow_up',
      title: PROSPECT_FOLLOW_UP_TITLE,
      assigneeEmployeeId: sellerA.id,
    });
    expect(tasks[0]!.dueAt.toISOString()).toBe(followUpAt);
    const events = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId))).map(
      (e) => e.kind,
    );
    expect(events).toEqual(
      expect.arrayContaining(['lead.created_from_prospect', 'lead.task_created']),
    );
    const [prospect] = await db.select().from(prospects).where(eq(prospects.id, prospectId));
    expect(prospect).toMatchObject({ status: 'virou_lead', leadId });
    const [converted] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'prospect.converted'), eq(auditLog.entityId, prospectId)));
    expect(converted?.metadata).toMatchObject({ leadId, created: true, followUp: true });
    const metrics = (await call(sellerA, 'GET', '/prospecting/metrics')).json<ProspectingMetrics>();
    expect(metrics.byStatus.virou_lead).toBe(1);
    // Nothing of Google's anywhere it was written.
    const written = JSON.stringify([
      lead,
      tasks,
      await db.select().from(leadNotes).where(eq(leadNotes.leadId, leadId)),
      await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)),
      await db.select().from(prospects),
      await db.select().from(prospectCalls),
    ]);
    for (const word of ['Padaria Teste', 'Rua Fictícia', '(21) 99000-0041', 'maps.google.com'])
      expect(written).not.toContain(word);
  });

  it("another seller cannot import, suggest for, or see someone else's prospect", async () => {
    const [d] = await db.select().from(prospects).where(eq(prospects.placeId, D.id));
    const lead = await call(sellerB, 'POST', `/prospecting/prospects/${d!.id}/lead`, {
      companyName: 'Empresa Teste',
      contactName: 'Contato Teste',
      phone: '21990009044',
      whatsappOptIn: true,
    });
    expect(lead.statusCode).toBe(404);
    const listed = (await call(sellerB, 'GET', '/prospecting/prospects')).json<Prospect[]>();
    expect(listed.map((p) => p.id)).not.toContain(d!.id);
  });

  it('a follow-up that is not a date is refused before anything is written', async () => {
    const [d] = await db.select().from(prospects).where(eq(prospects.placeId, D.id));
    const res = await call(sellerA, 'POST', `/prospecting/prospects/${d!.id}/lead`, {
      companyName: 'Empresa Teste',
      contactName: 'Contato Teste',
      phone: '21990009044',
      whatsappOptIn: true,
      followUpAt: 'amanhã',
    });
    expect(res.statusCode).toBe(400);
    const [still] = await db.select().from(prospects).where(eq(prospects.id, d!.id));
    expect(still?.status).toBe('reservado');
  });
});
