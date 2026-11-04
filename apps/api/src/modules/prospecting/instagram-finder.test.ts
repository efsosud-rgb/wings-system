import {
  INSTAGRAM_FROM_META_GUESS,
  INSTAGRAM_FROM_WEB,
  PROSPECT_ENRICHMENT_SOURCE,
  SESSION_COOKIE,
  type InstagramFindResponse,
  type ProspectEnrichResponse,
  type ProspectSearchItem,
  type ProspectSearchResponse,
  type RoleKey,
} from '@wings/shared';
import { and, eq, gte } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  instagramBusinessSnapshots,
  instagramDiscoveryCalls,
  prospectInstagramLookups,
  prospects,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { PageTransport } from '../../lib/public-probe.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { startOfDaySaoPaulo } from '../prospect-ai/classifier.js';
import { runInstagramHousekeeping } from '../prospect-ai/housekeeping.js';
import { fakePlace, fakePlacesApi } from './fake-places-api.js';
import { reserveWebSearch } from './instagram-finder.js';

/**
 * t086: the Instagram finder. A scripted Places API, company sites, Graph and web search; no test
 * reaches the network and the clock is fixed. Made-up companies and @ only.
 */

const KEY = 'test-places-key-never-printed';
const TOKEN = 'test-ig-token-never-printed';
const BRAVE_KEY = 'test-brave-key-never-printed';
const ACCOUNT = '17841400000000001';
const T0 = new Date('2026-11-04T15:00:00.000Z');
const DAY = 86_400_000;

// --- the scripted world ---------------------------------------------------------------------------

const place = (n: number, name: string, site: string | null) =>
  fakePlace(n, {
    displayName: { text: name },
    ...(site ? { websiteUri: site } : { websiteUri: undefined }),
  });
const ALFA = place(1, 'Hamburgueria Alfa', 'https://alfa.example.com.br/');
const BETA = place(2, 'Hamburgueria Beta', 'https://beta.example.com.br/');
const GAMA = place(3, 'Hamburgueria Gama', 'https://gama.example/');
const DELTA = place(4, 'Padaria Delta', null);
const EPSILON = place(5, 'Mercado Épsilon', 'https://epsilon.example/');
const ZETA = place(6, 'Loja Zeta', null);
const ETA = place(7, 'Loja Eta', null);
const PLACES = [ALFA, BETA, GAMA, DELTA, EPSILON, ZETA, ETA];
const google = fakePlacesApi({
  key: KEY,
  searches: { 'hamburguerias em Icaraí': [PLACES] },
  places: PLACES,
});

/** Each company site's answers, consumed in order; a string is a page, 'timeout' is a request that hangs. */
const sites: Record<string, ('timeout' | string)[]> = {};
const asked: string[] = [];
const transport: PageTransport = async (url) => {
  asked.push(url.href);
  const queue = sites[url.href];
  const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
  if (next === 'timeout') throw new Error('timeout');
  if (next === undefined) return { status: 404, location: null, body: '' };
  return { status: 200, location: null, body: next };
};
const link = (path: string, label: string) => `<a href="${path}">${label}</a>`;
const resetSites = () => {
  for (const key of Object.keys(sites)) delete sites[key];
  asked.length = 0;
  // Alfa: the link is not on the home page but on the contact page.
  sites['https://alfa.example.com.br/'] = [`<html>${link('/contato', 'Contato')}</html>`];
  sites['https://alfa.example.com.br/contato'] = [
    '<a href="https://www.instagram.com/alfa.oficial/">Instagram</a>',
  ];
  // Beta: every first try hangs (robots.txt and the home page), the second answers.
  sites['https://beta.example.com.br/robots.txt'] = ['timeout', ''];
  sites['https://beta.example.com.br/'] = [
    'timeout',
    '<a href="https://instagram.com/beta.burger">Instagram</a>',
  ];
  // Gama and Épsilon never answer.
  sites['https://gama.example/robots.txt'] = ['timeout'];
  sites['https://epsilon.example/robots.txt'] = ['timeout'];
};

type Answer = { status?: number; body: unknown };
const business = (username: string) => ({
  business_discovery: { username, followers_count: 4200, media_count: 180, media: { data: [] } },
  id: ACCOUNT,
});
const notBusiness: Answer = {
  status: 400,
  body: { error: { message: 'Fake.', type: 'OAuthException', code: 110 } },
};
const graphScript: Record<string, Answer> = {
  'alfa.oficial': { body: business('alfa.oficial') },
  hamburgueriagama: { body: business('hamburgueriagama') },
  'padariadelta.niteroi': { body: business('padariadelta.niteroi') },
};
const graphAsked: string[] = [];
const graphFetch = (async (input: unknown) => {
  const fields = new URL(String(input)).searchParams.get('fields') ?? '';
  const username = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1] ?? '';
  graphAsked.push(username);
  const answer = graphScript[username] ?? notBusiness;
  return new Response(JSON.stringify(answer.body), {
    status: answer.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const braveAsked: { query: string; key: string | null }[] = [];
const braveAnswers: Record<string, { title: string; url: string }[]> = {
  'Padaria Delta Niterói instagram': [
    {
      title: 'Padaria do João (@padaria_do_joao)',
      url: 'https://www.instagram.com/padaria_do_joao/',
    },
    {
      title: 'Padaria Delta Niterói (@padariadelta.niteroi)',
      url: 'https://www.instagram.com/padariadelta.niteroi/',
    },
  ],
  'Mercado Épsilon Niterói instagram': [
    { title: 'Mercado do Zé', url: 'https://www.instagram.com/mercadodoze/' },
    { title: 'Outra loja', url: 'https://example.com.br/mercado' },
  ],
  'Loja Zeta Niterói instagram': [],
};
const braveFetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const query = url.searchParams.get('q') ?? '';
  braveAsked.push({ query, key: new Headers(init?.headers).get('x-subscription-token') });
  return Response.json({
    web: { results: (braveAnswers[query] ?? []).map((r) => ({ ...r, description: 'x' })) },
  });
}) as typeof fetch;

// --- the app ---------------------------------------------------------------------------------------
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let noWeb: FastifyInstance;
let metaOff: FastifyInstance;
type Session = { id: string; cookies: Record<string, string> };
let seller: Session;
let other: Session;

const env = (extra: Record<string, string>) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    GOOGLE_PLACES_API_KEY: KEY,
    INSTAGRAM_DISCOVERY_ACCOUNT_ID: ACCOUNT,
    INSTAGRAM_DISCOVERY_TOKEN: TOKEN,
    ...extra,
  });

async function loginAs(target: FastifyInstance, role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await target.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const call = (
  session: Session,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  target = app,
) =>
  target.inject({
    method,
    url,
    cookies: session.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

const search = async (session: Session, target = app) => {
  const res = await call(
    session,
    'POST',
    '/prospecting/search',
    {
      segment: 'hamburguerias',
      places: ['Icaraí'],
    },
    target,
  );
  expect(res.statusCode).toBe(200);
  return res.json<ProspectSearchResponse>();
};
const itemOf = (body: ProspectSearchResponse, company: { id: string }): ProspectSearchItem =>
  body.items.find((i) => i.placeId === company.id)!;
const find = (session: Session, tickets: string[], target = app) =>
  call(
    session,
    'POST',
    '/prospecting/instagram/find',
    { items: tickets.map((ticket) => ({ ticket })) },
    target,
  );
const lookupOf = async (company: { id: string }) =>
  (
    await db
      .select()
      .from(prospectInstagramLookups)
      .where(eq(prospectInstagramLookups.placeId, company.id))
  )[0];
const external = () => [asked.length, graphAsked.length, braveAsked.length];

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const deps = {
    db,
    placesFetch: ((input: unknown, init?: RequestInit) =>
      google.fetch(input as string, init)) as typeof fetch,
    instagramDiscoveryFetch: graphFetch,
    webSearchFetch: braveFetch,
    siteTransport: transport,
    now: () => T0,
  };
  const on = { INSTAGRAM_BUSINESS_DISCOVERY_ENABLED: 'true' };
  app = await buildApp({ env: env({ ...on, BRAVE_SEARCH_API_KEY: BRAVE_KEY }), ...deps });
  noWeb = await buildApp({ env: env(on), ...deps });
  metaOff = await buildApp({ env: env({ BRAVE_SEARCH_API_KEY: BRAVE_KEY }), ...deps });
  seller = await loginAs(app, 'vendedor_formatacao');
  other = await loginAs(app, 'vendedor_formatacao');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await noWeb?.close();
  await metaOff?.close();
  await harness?.drop();
});

describe('the three paths, in order', () => {
  let tickets: Record<string, string>;
  let answer: InstagramFindResponse;

  it('the search brings a ticket for each company without an @, and the paths find the rest', async () => {
    resetSites();
    const found = await search(seller);
    tickets = Object.fromEntries(PLACES.map((p) => [p.id, itemOf(found, p).instagramFind ?? '']));
    expect(Object.values(tickets).every((t) => t.length > 0)).toBe(true);
    expect(PLACES.every((p) => itemOf(found, p).instagram === null)).toBe(true);

    const res = await find(
      seller,
      [ALFA, BETA, GAMA, DELTA, EPSILON].map((p) => tickets[p.id]!),
    );
    expect(res.statusCode).toBe(200);
    answer = res.json<InstagramFindResponse>();
  });

  it('1) the site: the link on the contact page, and the retry after a timeout', () => {
    const alfa = answer.items.find((i) => i.placeId === ALFA.id)!;
    expect(alfa.instagram).toMatchObject({ username: 'alfa.oficial', source: 'site da empresa' });
    expect(alfa.instagram?.ticket).toBeTruthy();
    // robots.txt, home and the contact page; the profile was found, so no later path was tried.
    expect(asked.filter((u) => u.startsWith('https://alfa.'))).toEqual([
      'https://alfa.example.com.br/robots.txt',
      'https://alfa.example.com.br/',
      'https://alfa.example.com.br/contato',
    ]);
    expect(graphAsked).not.toContain('alfa.oficial');

    // Beta: robots.txt and the home page each timed out once and answered on the second try.
    const beta = answer.items.find((i) => i.placeId === BETA.id)!;
    expect(beta.instagram).toMatchObject({ username: 'beta.burger', source: 'site da empresa' });
    expect(asked.filter((u) => u === 'https://beta.example.com.br/')).toHaveLength(2);
    expect(asked.filter((u) => u === 'https://beta.example.com.br/robots.txt')).toHaveLength(2);
  });

  it('2) Meta: the @ the name suggests, kept only because Meta confirmed it; the timeout is told', async () => {
    const gama = answer.items.find((i) => i.placeId === GAMA.id)!;
    expect(gama.instagram).toMatchObject({
      username: 'hamburgueriagama',
      source: INSTAGRAM_FROM_META_GUESS,
    });
    // The domain's word was asked first and was not a business account.
    expect(graphAsked.filter((u) => ['gama', 'hamburgueriagama'].includes(u))).toEqual([
      'gama',
      'hamburgueriagama',
    ]);
    // The site never answered: 2 tries on robots.txt, so the home page was not even asked.
    expect(asked.filter((u) => u === 'https://gama.example/robots.txt')).toHaveLength(2);
    expect(asked).not.toContain('https://gama.example/');
    expect((await lookupOf(GAMA))?.outcome).toBe('found');
  });

  it('3) the web: name + city + "instagram", a profile that matches the name, confirmed in Meta', async () => {
    const delta = answer.items.find((i) => i.placeId === DELTA.id)!;
    expect(delta.instagram).toMatchObject({
      username: 'padariadelta.niteroi',
      source: INSTAGRAM_FROM_WEB,
    });
    expect(braveAsked.filter((b) => b.query.startsWith('Padaria Delta'))).toEqual([
      { query: 'Padaria Delta Niterói instagram', key: BRAVE_KEY },
    ]);
    // The first Meta try was the name run together; the web's profile was the second.
    expect(graphAsked.filter((u) => u.startsWith('padaria'))).toEqual([
      'padariadelta',
      'padariadelta.niteroi',
    ]);
    // The other profile of the results (someone else's bakery) was never sent to Meta.
    expect(graphAsked).not.toContain('padaria_do_joao');
  });

  it('no path resolved: "—" and the real reason of each; never an @ nobody confirmed', async () => {
    const epsilon = answer.items.find((i) => i.placeId === EPSILON.id)!;
    expect(epsilon.instagram).toBeNull();
    expect(epsilon.miss?.reasons).toHaveLength(3);
    expect(epsilon.miss?.reasons[0]).toMatch(
      /^Site: .*não respondeu em 12 segundos \(2 tentativas\)/,
    );
    expect(epsilon.miss?.reasons[1]).toMatch(/^Meta: conta não confirmada/);
    expect(epsilon.miss?.reasons[2]).toMatch(/^Web: nenhum perfil do Instagram .* bate com o nome/);
    expect(graphAsked).not.toContain('mercadodoze');
    // A site that timed out is tried again the next day, not in a week.
    const kept = await lookupOf(EPSILON);
    expect(kept).toMatchObject({ outcome: 'none', username: null });
    expect(kept!.expiresAt.getTime() - T0.getTime()).toBe(DAY);
  });

  it('is not repeated: the same companies again call neither the site, Meta nor the web', async () => {
    const before = external();
    const again = await find(
      seller,
      [ALFA, BETA, GAMA, DELTA, EPSILON].map((p) => tickets[p.id]!),
    );
    expect(again.statusCode).toBe(200);
    expect(
      again.json<InstagramFindResponse>().items.map((i) => i.instagram?.username ?? null),
    ).toEqual(['alfa.oficial', 'beta.burger', 'hamburgueriagama', 'padariadelta.niteroi', null]);
    expect(external()).toEqual(before);

    // The next search shows what was kept, with no ticket to ask again.
    const next = await search(seller);
    expect(itemOf(next, ALFA).instagram).toMatchObject({ username: 'alfa.oficial' });
    expect(itemOf(next, ALFA).instagramFind).toBeNull();
    expect(itemOf(next, EPSILON).instagramMiss?.reasons).toHaveLength(3);
    expect(itemOf(next, EPSILON).instagramFind).toBeNull();
    expect(itemOf(next, ZETA).instagramFind).toBeTruthy();
    expect(external()).toEqual(before);
  });

  it('records the count in the audit log, never a name or an @', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'prospect.instagram_find'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/alfa|beta|gama|delta/i);
  });
});

describe('what stops the finder', () => {
  it('a ticket of another seller refuses the whole request before anything is read or asked', async () => {
    resetSites();
    const mine = await search(seller);
    const zeta = itemOf(mine, ZETA).instagramFind!;
    const delta = itemOf(mine, DELTA).instagram; // already kept; any ticket will do for the check below
    expect(delta).toBeTruthy();
    const before = external();
    const refused = await find(other, [zeta]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'find_ticket_invalid' });
    const tampered = await find(seller, [zeta, `${zeta}x`]);
    expect(tampered.statusCode).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(external()).toEqual(before);
    expect(await lookupOf(ZETA)).toBeUndefined();
  });

  it('without the web key the last path says so; Meta found nothing: "—" kept for a week', async () => {
    resetSites();
    const zeta = itemOf(await search(seller, noWeb), ZETA).instagramFind!;
    const res = await find(seller, [zeta], noWeb);
    const item = res.json<InstagramFindResponse>().items[0]!;
    expect(item.instagram).toBeNull();
    expect(item.miss?.reasons).toEqual([
      'Site: o Google não informa o site da empresa.',
      'Meta: conta não confirmada (o @ provável não existe ou não é comercial).',
      'Web: a busca na web não está configurada neste ambiente.',
    ]);
    const kept = await lookupOf(ZETA);
    expect(kept!.expiresAt.getTime() - T0.getTime()).toBe(7 * DAY);
  });

  it('with Meta off a web profile that matches the name is kept as unconfirmed, and says so', async () => {
    resetSites();
    graphScript.lojazeta = notBusiness;
    braveAnswers['Loja Zeta Niterói instagram'] = [
      { title: 'Loja Zeta Niterói', url: 'https://www.instagram.com/loja.zeta.nit/' },
    ];
    await db.delete(prospectInstagramLookups).where(eq(prospectInstagramLookups.placeId, ZETA.id));
    const zeta = itemOf(await search(seller, metaOff), ZETA).instagramFind!;
    const before = graphAsked.length;
    const item = (await find(seller, [zeta], metaOff)).json<InstagramFindResponse>().items[0]!;
    expect(item.instagram).toMatchObject({
      username: 'loja.zeta.nit',
      source: 'busca na web, não confirmada na Meta',
    });
    expect(graphAsked.length).toBe(before);
  });

  it('the paid web search has a daily ceiling, reserved under a lock', async () => {
    // Audit rows carry the real clock; "before" counts the same São Paulo day as the code (lição 2).
    const day = new Date();
    const today = and(
      eq(auditLog.action, 'prospect.web_search'),
      gte(auditLog.at, startOfDaySaoPaulo(day)),
    );
    const spentBefore = (await db.select().from(auditLog).where(today)).length;
    const budget = { perDay: spentBefore + 2, dailyUsd: 100, usdPerQuery: 0.005 };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => reserveWebSearch(db, seller.id, budget, day)),
    );
    expect(results.filter((reason) => reason === null)).toHaveLength(2);
  });

  it('the Enriquecer gives the Meta guess the website of the ticket, never the one the screen typed', async () => {
    resetSites();
    // Eta has no site on Google, so its ticket says so; the screen types Eta's own site.
    const eta = itemOf(await search(seller), ETA).enrichTicket!;
    const [row] = await db
      .insert(prospects)
      .values({ placeId: ETA.id, status: 'reservado', ownerEmployeeId: seller.id })
      .returning();
    const before = graphAsked.length;
    await call(seller, 'POST', `/prospecting/prospects/${row!.id}/enrich`, {
      website: 'https://eta.example/',
      findTicket: eta,
    });
    // The cached lookup is shared by every seller: the typed site must not name the @ guessed.
    expect(graphAsked.slice(before)).not.toContain('eta');
    // Neither the lookup nor Meta's cache this click kept is news for the tests after it.
    await db.delete(prospectInstagramLookups).where(eq(prospectInstagramLookups.placeId, ETA.id));
    await db
      .delete(instagramBusinessSnapshots)
      .where(eq(instagramBusinessSnapshots.username, 'lojaeta'));
  });

  it('a refused Meta (permission) is a transient reason: tried again within hours, not a week', async () => {
    resetSites();
    graphScript.lojaeta = {
      status: 400,
      body: { error: { message: 'Fake.', type: 'OAuthException', code: 10 } },
    };
    // Its own app: the refusal holds Meta's calls for the process, and later tests use `app`.
    const eta = itemOf(await search(seller, noWeb), ETA).instagramFind!;
    const item = (await find(seller, [eta], noWeb)).json<InstagramFindResponse>().items[0]!;
    expect(item.instagram).toBeNull();
    expect(item.miss?.reasons[1]).toMatch(/^Meta: não deu para confirmar o @ provável/);
    const kept = await lookupOf(ETA);
    expect(kept!.expiresAt.getTime() - T0.getTime()).toBe(6 * 3_600_000);
  });

  it('the hourly housekeeping deletes lookups past their retry date, and only those', async () => {
    await db.insert(prospectInstagramLookups).values({
      placeId: 'expired-lookup',
      outcome: 'none',
      reasons: ['x'],
      checkedAt: new Date(T0.getTime() - 8 * DAY),
      expiresAt: new Date(T0.getTime() - DAY),
    });
    const run = await runInstagramHousekeeping(db, T0);
    expect(run).toMatchObject({ ran: true, lookups: 1 });
    expect(await lookupOf({ id: 'expired-lookup' })).toBeUndefined();
    expect(await lookupOf(ALFA)).toBeTruthy();
  });
});

describe('Enriquecer with the search ticket', () => {
  it('reads the site and, with no link there, finds the @ by the next paths and saves it with its source', async () => {
    resetSites();
    sites['https://epsilon.example/robots.txt'] = [''];
    sites['https://epsilon.example/'] = ['<html>sem redes</html>'];
    graphScript.epsilon = { body: business('epsilon') };
    // Meta said "not a business" for this @ in the earlier test, and that answer is cached.
    await db
      .delete(instagramBusinessSnapshots)
      .where(eq(instagramBusinessSnapshots.username, 'epsilon'));
    // From here the order is the screen's, nothing cleared between: search, find, search, click.
    await db
      .delete(prospectInstagramLookups)
      .where(eq(prospectInstagramLookups.placeId, EPSILON.id));
    const first = itemOf(await search(seller), EPSILON);
    expect(first.instagramFind).toBeTruthy();
    expect(first.enrichTicket).toBe(first.instagramFind);
    const metaBefore = graphAsked.length;
    const found = (await find(seller, [first.instagramFind!])).json<InstagramFindResponse>();
    expect(found.items[0]!.instagram?.username).toBe('epsilon');
    expect(graphAsked.length).toBeGreaterThan(metaBefore);
    const next = itemOf(await search(seller), EPSILON);
    expect(next.instagramFind).toBeNull();
    expect(next.instagram).toMatchObject({ username: 'epsilon' });
    const ticket = next.enrichTicket!;
    const metaAfterFind = graphAsked.length;
    const [row] = await db
      .insert(prospects)
      .values({ placeId: EPSILON.id, status: 'reservado', ownerEmployeeId: seller.id })
      .returning();
    const res = await call(seller, 'POST', `/prospecting/prospects/${row!.id}/enrich`, {
      website: 'https://epsilon.example/',
      findTicket: ticket,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProspectEnrichResponse>();
    expect(body.pagesRead).toBe(1);
    expect(body.prospect.enrichment.instagram).toMatchObject({
      value: 'https://www.instagram.com/epsilon/',
      source: INSTAGRAM_FROM_META_GUESS,
    });
    expect(body.instagramReasons).toBeUndefined();
    expect((await lookupOf(EPSILON))?.username).toBe('epsilon');
    expect(graphAsked.length).toBe(metaAfterFind);
    // The next search reads the saved @ back: it keeps the source it was saved with (the seller
    // still sees "palpite") and earns the score the same @ earned from the cache, never the
    // "has Instagram" point of a site that showed it.
    const later = itemOf(await search(seller), EPSILON);
    expect(later.instagram).toMatchObject({
      username: 'epsilon',
      source: INSTAGRAM_FROM_META_GUESS,
    });
    expect(later.icp.score).toBe(next.icp.score);
  });

  it('the same saved @ shown by the site keeps "site da empresa" and earns the Instagram point', async () => {
    const before = itemOf(await search(seller), EPSILON);
    expect(before.instagram?.source).toBe(INSTAGRAM_FROM_META_GUESS);
    await db
      .update(prospects)
      .set({
        enrichment: {
          instagram: {
            value: 'https://www.instagram.com/epsilon/',
            source: PROSPECT_ENRICHMENT_SOURCE,
            at: '2026-11-01T12:00:00.000Z',
          },
        },
      })
      .where(eq(prospects.placeId, EPSILON.id));
    const after = itemOf(await search(seller), EPSILON);
    expect(after.instagram).toMatchObject({
      username: 'epsilon',
      source: PROSPECT_ENRICHMENT_SOURCE,
    });
    expect(after.icp.score).toBeGreaterThan(before.icp.score);
  });

  it('without a ticket it behaves as before: the site only', async () => {
    resetSites();
    const [row] = await db
      .insert(prospects)
      .values({ placeId: ZETA.id, status: 'reservado', ownerEmployeeId: seller.id })
      .returning();
    const before = graphAsked.length;
    const res = await call(seller, 'POST', `/prospecting/prospects/${row!.id}/enrich`, {
      website: 'https://alfa.example.com.br/',
    });
    expect(res.json<ProspectEnrichResponse>().prospect.enrichment.instagram).toMatchObject({
      source: 'site da empresa',
    });
    expect(graphAsked.length).toBe(before);
    expect(await db.select().from(instagramDiscoveryCalls)).not.toHaveLength(0);
  });
});
