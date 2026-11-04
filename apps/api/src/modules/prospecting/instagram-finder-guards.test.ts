import {
  SESSION_COOKIE,
  type InstagramFindResponse,
  type ProspectEnrichResponse,
  type ProspectSearchItem,
  type ProspectSearchResponse,
} from '@wings/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  leadEnrichmentLedger,
  prospectInstagramLookups,
  prospects,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { PageTransport } from '../../lib/public-probe.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import { startOfDaySaoPaulo } from '../prospect-ai/classifier.js';
import { fakePlace, fakePlacesApi } from './fake-places-api.js';
import { reserveWebSearch } from './instagram-finder.js';

/**
 * t090: the guards of the Instagram finder the review found without a test, and the paid search in
 * the enrichment's ledger. Each test fails when its guard is taken out (mutation checked, see the
 * report). A scripted Places API, Graph, web search and sites; made-up companies and @ only.
 */

const KEY = 'test-places-key-never-printed';
const ACCOUNT = '17841400000000001';
const T0 = new Date('2026-11-04T15:00:00.000Z');

const place = (n: number, name: string, site: string | null) =>
  fakePlace(n, {
    displayName: { text: name },
    ...(site ? { websiteUri: site } : { websiteUri: undefined }),
  });
// A delivery app's page, a section of a company's site, a company that asked not to be contacted,
// a company whose own @ Meta confirms, and a company with a prospect row (Eta).
const LANCHE = place(
  1,
  'Lanchonete Teste',
  'https://www.rappi.com.br/restaurantes/lanchonete-teste',
);
const SUB = place(2, 'Marca Sub', 'https://loja.marcasub.com.br/');
const SEM_CONTATO = place(3, 'Bar Sem Contato', 'https://barsemcontato.example/');
const OMEGA = place(4, 'Cafe Omega', null);
const ETA = place(5, 'Loja Eta', null);
const PLACES = [LANCHE, SUB, SEM_CONTATO, OMEGA, ETA];
const google = fakePlacesApi({
  key: KEY,
  searches: { 'lanchonetes em Icaraí': [PLACES] },
  places: PLACES,
});

const asked: string[] = [];
const transport: PageTransport = async (url) => {
  asked.push(url.href);
  return { status: 404, location: null, body: '' };
};
// Confirmed business accounts: the platform's, a section's, a company that opted out, and Omega's.
const business = (username: string) => ({
  business_discovery: { username, followers_count: 9_000_000, media_count: 5, media: { data: [] } },
  id: ACCOUNT,
});
const accounts = new Set(['rappi', 'loja', 'pedido', 'cafeomega', 'barsemcontato']);
const graphAsked: string[] = [];
const graphFetch = (async (input: unknown) => {
  const fields = new URL(String(input)).searchParams.get('fields') ?? '';
  const username = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1] ?? '';
  graphAsked.push(username);
  const body = accounts.has(username)
    ? business(username)
    : { error: { message: 'Fake.', type: 'OAuthException', code: 110 } };
  return new Response(JSON.stringify(body), {
    status: accounts.has(username) ? 200 : 400,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
const braveAsked: string[] = [];
const braveFetch = (async (input: unknown) => {
  braveAsked.push(new URL(String(input)).searchParams.get('q') ?? '');
  return Response.json({ web: { results: [] } });
}) as typeof fetch;
const external = () => [asked.length, graphAsked.length, braveAsked.length];

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let cookies: Record<string, string>;
let sellerId: string;

const search = async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/prospecting/search',
    cookies,
    payload: { segment: 'lanchonetes', places: ['Icaraí'] },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<ProspectSearchResponse>();
  return (company: { id: string }): ProspectSearchItem =>
    body.items.find((item) => item.placeId === company.id)!;
};
const lookupOf = async (company: { id: string }) =>
  (
    await db
      .select()
      .from(prospectInstagramLookups)
      .where(eq(prospectInstagramLookups.placeId, company.id))
  )[0];
const searchRows = () =>
  db.select().from(leadEnrichmentLedger).where(eq(leadEnrichmentLedger.step, 'web_search'));

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      GOOGLE_PLACES_API_KEY: KEY,
      INSTAGRAM_DISCOVERY_ACCOUNT_ID: ACCOUNT,
      INSTAGRAM_DISCOVERY_TOKEN: 'test-ig-token-never-printed',
      INSTAGRAM_BUSINESS_DISCOVERY_ENABLED: 'true',
      BRAVE_SEARCH_API_KEY: 'test-brave-key-never-printed',
    }),
    db,
    placesFetch: ((input: unknown, init?: RequestInit) =>
      google.fetch(input as string, init)) as typeof fetch,
    instagramDiscoveryFetch: graphFetch,
    webSearchFetch: braveFetch,
    siteTransport: transport,
    now: () => T0,
  });
  const employee = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  cookies = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  sellerId = employee.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('what the finder never does', () => {
  it("a delivery app or a subdomain gives no @ to try: the platform's own account is never asked", async () => {
    const item = await search();
    const tickets = [LANCHE, SUB].map((company) => item(company).instagramFind!);
    expect(tickets.every((ticket) => ticket?.length > 0)).toBe(true);
    const res = await app.inject({
      method: 'POST',
      url: '/prospecting/instagram/find',
      cookies,
      payload: { items: tickets.map((ticket) => ({ ticket })) },
    });
    const answer = res.json<InstagramFindResponse>();
    // Meta would confirm "rappi", "loja" and "pedido" as business accounts; only the names are asked.
    expect(answer.items.map((found) => found.instagram)).toEqual([null, null]);
    expect([...graphAsked].sort()).toEqual(['lanchoneteteste', 'marcasub']);
    // The app's own page is not read at all, and its reason says why.
    expect(asked.some((href) => href.includes('rappi'))).toBe(false);
    expect(answer.items[0]!.miss?.reasons[0]).toMatch(/app de entrega, marketplace/);
    // No @ for the app, so no followers of the app in the score either.
    const again = await search();
    expect(again(LANCHE).instagram).toBeNull();
    expect(again(SUB).instagram).toBeNull();
  });

  it('a company that asked not to be contacted gets no ticket and is never read, asked or searched', async () => {
    await recordContactOptOut(db, {
      placeId: SEM_CONTATO.id,
      channels: ['all'],
      origin: 'crm',
      reason: 'Pediu',
      createdBy: null,
    });
    const before = external();
    const item = (await search())(SEM_CONTATO);
    expect(item.tags.some((tag) => tag.kind === 'do_not_contact')).toBe(true);
    expect(item.instagramFind).toBeNull();
    expect(item.enrichTicket).toBeNull();
    // After the refusal, wait a little and see that nothing left (lição 4).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(external()).toEqual(before);
    expect(await lookupOf(SEM_CONTATO)).toBeUndefined();
  });

  it('the ticket of one company does not work in the Enriquecer of another', async () => {
    const omega = (await search())(OMEGA).enrichTicket!;
    expect(omega.length).toBeGreaterThan(0);
    const [row] = await db
      .insert(prospects)
      .values({ placeId: ETA.id, status: 'reservado', ownerEmployeeId: sellerId })
      .returning();
    const before = graphAsked.length;
    const res = await app.inject({
      method: 'POST',
      url: `/prospecting/prospects/${row!.id}/enrich`,
      cookies,
      payload: { website: 'https://eta.example/', findTicket: omega },
    });
    expect(res.statusCode).toBe(200);
    // Omega's @ is a confirmed business account, and still it is not saved on Eta.
    expect(res.json<ProspectEnrichResponse>().prospect.enrichment.instagram).toBeUndefined();
    expect(graphAsked.length).toBe(before);
    expect(await lookupOf(OMEGA)).toBeUndefined();
  });
});

describe('the paid search and the enrichment ledger', () => {
  it('counts in the same ledger and stops at the same dollar ceiling, with no lead', async () => {
    const day = new Date();
    const enrichSpent = async () => {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${leadEnrichmentLedger.usdMicro}), 0)::bigint` })
        .from(leadEnrichmentLedger)
        .where(
          and(
            gte(leadEnrichmentLedger.createdAt, startOfDaySaoPaulo(day)),
            sql`${leadEnrichmentLedger.step} <> 'ai_research' and ${leadEnrichmentLedger.step} not like 'ig\\_%'`,
          ),
        );
      return Number(row!.total);
    };
    // A paid step of the worker counts; the research and the Instagram check have ceilings of their
    // own, and so does a step that only starts with "ig" (`igx_profile` is no Instagram check).
    await db.insert(leadEnrichmentLedger).values([
      { step: 'zapi_profile', status: 'done', usdMicro: 4000 },
      { step: 'ai_research', status: 'done', usdMicro: 5_000_000 },
      { step: 'ig_meta', status: 'done', usdMicro: 5_000_000 },
      { step: 'igx_profile', status: 'done', usdMicro: 5_000_000 },
    ]);
    const spent = await enrichSpent();
    const before = (await searchRows()).length;
    // Room for exactly one search (US$ 0.005) over what the day already spent.
    const budget = { perDay: 10_000, dailyUsd: (spent + 5000) / 1_000_000, usdPerQuery: 0.005 };
    expect(await reserveWebSearch(db, sellerId, budget, day)).toBeNull();
    expect(await reserveWebSearch(db, sellerId, budget, day)).toBe(
      'Web: teto de gasto do dia da busca paga atingido.',
    );
    const rows = (await searchRows()).slice(before);
    expect(rows.map((row) => [row.status, row.usdMicro, row.leadId])).toEqual([
      ['started', 5000, null],
      ['refused', 0, null],
    ]);
    expect(rows[0]!.detail).toMatchObject({ purpose: 'instagram_finder' });
    expect(await enrichSpent()).toBe(spent + 5000);
  });

  it('the 100 searches a day still hold, whatever the dollars', async () => {
    const day = new Date();
    // The searches the tests above already recorded today count: the ceiling sits just above them,
    // so exactly one more is reserved with the dollars wide open (lição 7: the guard is the count).
    const [today] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'prospect.web_search'), gte(auditLog.at, startOfDaySaoPaulo(day))),
      );
    const budget = { perDay: today!.total + 1, dailyUsd: 100, usdPerQuery: 0.005 };
    const reasons = await Promise.all(
      [1, 2, 3].map(() => reserveWebSearch(db, sellerId, budget, day)),
    );
    expect(reasons.filter((reason) => reason === null)).toHaveLength(1);
    expect(reasons.filter(Boolean)).toEqual([
      'Web: limite de buscas na web do dia.',
      'Web: limite de buscas na web do dia.',
    ]);
  });

  it('a ceiling below one search refuses on the route and the Brave is never called', async () => {
    // ENRICH_DAILY_USD 0.001 against a US$ 0.005 search: the refusal must end the path (lição 4),
    // and a route that ignores it spends the buyer's dollars without a test noticing.
    const tight = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: 'x'.repeat(48),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: 'http://localhost:5173',
        GOOGLE_PLACES_API_KEY: KEY,
        BRAVE_SEARCH_API_KEY: 'test-brave-key-never-printed',
        ENRICH_DAILY_USD: '0.001',
      }),
      db,
      placesFetch: ((input: unknown, init?: RequestInit) =>
        google.fetch(input as string, init)) as typeof fetch,
      webSearchFetch: braveFetch,
      siteTransport: transport,
      now: () => T0,
    });
    try {
      const before = braveAsked.length;
      const res = await tight.inject({
        method: 'POST',
        url: '/prospecting/search',
        cookies,
        payload: { segment: 'lanchonetes', places: ['Icaraí'] },
      });
      const item = res
        .json<ProspectSearchResponse>()
        .items.find((entry) => entry.placeId === OMEGA.id)!;
      const find = await tight.inject({
        method: 'POST',
        url: '/prospecting/instagram/find',
        cookies,
        payload: { items: [{ ticket: item.instagramFind }] },
      });
      expect(find.statusCode).toBe(200);
      const answer = find.json<InstagramFindResponse>().items[0]!;
      expect(answer.instagram).toBeNull();
      expect(answer.miss?.reasons.at(-1)).toMatch(/teto de gasto do dia da busca paga/);
      // After the refusal, wait a little and see that nothing reached Brave (lição 4).
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(braveAsked.slice(before)).toEqual([]);
    } finally {
      await tight.close();
    }
  });
});
