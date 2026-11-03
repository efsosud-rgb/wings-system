import {
  DEFAULT_ICP_WEIGHTS,
  icpScore,
  INSTAGRAM_DISCOVERY_REASONS as REASONS,
  instagramMetricsOf,
  SESSION_COOKIE,
  type InstagramDiscoveryResponse,
  type ProspectSearchResponse,
  type RoleKey,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  instagramBusinessSnapshots,
  instagramDiscoveryCalls,
  prospects,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { runInstagramHousekeeping } from '../prospect-ai/housekeeping.js';
import { fakePlace, fakePlacesApi } from './fake-places-api.js';

/**
 * Prospecção Instagram, parte 3 (docs/prospeccao/instagram.md §6, "Pronto quando" of Fase B):
 * the Google search with a scripted Places API and Business Discovery with a scripted Graph. No
 * test reaches the network; the clock is fixed. Made-up companies and @ only.
 */

const KEY = 'test-places-key-never-printed';
const TOKEN = 'test-ig-token-never-printed';
const ACCOUNT = '17841400000000001';
const T0 = new Date('2026-11-04T15:00:00.000Z');
const DAY = 86_400_000;
let clock = T0;

const IG = {
  business: 'hamburgueria.ig1',
  personal: 'hamburgueria.ig2',
  hiddenLikes: 'hamburgueria.ig3',
  refused: 'hamburgueria.ig4',
  limited: 'hamburgueria.ig5',
  saved: 'hamburgueria.site6',
  busy: 'hamburgueria.ig7',
};
const place = (n: number, site: string) =>
  fakePlace(n, { websiteUri: site, displayName: { text: `Hamburgueria Instagram ${n}` } });
const PLACES = [
  place(1, `https://www.instagram.com/${IG.business}/`),
  place(2, `https://instagram.com/${IG.personal}`),
  place(3, `https://www.instagram.com/${IG.hiddenLikes}/`),
  place(4, `https://www.instagram.com/${IG.refused}/`),
  place(5, 'https://www.instagram.com/p/AbCdEf123/'),
  place(6, 'https://hamburgueria-instagram-6.example.com.br/'),
  place(7, `https://www.instagram.com/${IG.busy}/`),
  place(8, `https://www.instagram.com/${IG.limited}/`),
];
const google = fakePlacesApi({
  key: KEY,
  searches: { 'hamburguerias em Icaraí': [PLACES] },
  places: PLACES,
});

// --- a scripted Graph ------------------------------------------------------------------------
const post = (daysAgo: number, likes: number | null, comments: number) => ({
  id: `1790000000${daysAgo}`,
  ...(likes === null ? {} : { like_count: likes }),
  comments_count: comments,
  timestamp: new Date(T0.getTime() - daysAgo * DAY).toISOString().replace('.000Z', '+0000'),
});
const business = (username: string, likes: number | null) => ({
  business_discovery: {
    username,
    // Never asked for; sent anyway to prove nothing of it is kept.
    name: 'Nome Fictício Que Não Se Guarda',
    biography: 'Bio fictícia (21) 99999-0000',
    followers_count: 12_000,
    media_count: 340,
    media: {
      data: [2, 5, 9, 14, 20, 27, 40, 55, 70, 90, 120, 150].map((d) => post(d, likes, 8)),
    },
    id: '17841400000000099',
  },
  id: ACCOUNT,
});
type Answer = { status?: number; body: unknown; headers?: Record<string, string> };
const graphError = (code: number, extra: Record<string, unknown> = {}): Answer => ({
  status: 400,
  body: { error: { message: 'Fake Graph error.', type: 'OAuthException', code, ...extra } },
});
const script: Record<string, Answer> = {
  [IG.business]: { body: business(IG.business, 150) },
  [IG.personal]: graphError(110),
  [IG.hiddenLikes]: { body: business(IG.hiddenLikes, null) },
  [IG.refused]: graphError(10),
  [IG.saved]: graphError(24),
  [IG.limited]: graphError(80002),
  [IG.busy]: {
    body: business(IG.busy, 150),
    headers: {
      'x-business-use-case-usage': JSON.stringify({
        [ACCOUNT]: [
          {
            type: 'instagram',
            call_count: 85,
            total_time: 10,
            total_cputime: 5,
            estimated_time_to_regain_access: 30,
          },
        ],
      }),
    },
  },
};
const graph: { url: string; auth: string | null; username: string }[] = [];
const graphFetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const fields = new URL(url).searchParams.get('fields') ?? '';
  const username = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1] ?? '';
  graph.push({ url, auth: new Headers(init?.headers).get('authorization'), username });
  const answer = script[username] ?? graphError(110);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status ?? 200,
    headers: { 'content-type': 'application/json', ...answer.headers },
  });
}) as typeof fetch;

// --- the app ---------------------------------------------------------------------------------
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let off: FastifyInstance;
type Session = { id: string; cookies: Record<string, string> };
let seller: Session;
let other: Session;
let expansao: Session;

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

const search = async (session: Session) => {
  const res = await call(session, 'POST', '/prospecting/search', {
    segment: 'hamburguerias',
    places: ['Icaraí'],
  });
  expect(res.statusCode).toBe(200);
  return res.json<ProspectSearchResponse>();
};
const refOf = (body: ProspectSearchResponse, n: number) =>
  body.items.find((i) => i.placeId === PLACES[n - 1]!.id)!.instagram;
const discover = (session: Session, items: { username: string; ticket: string }[]) =>
  call(session, 'POST', '/prospecting/instagram/discovery', { items });
const itemsOf = async (session: Session, items: { username: string; ticket: string }[]) => {
  const res = await discover(session, items);
  expect(res.statusCode).toBe(200);
  return res.json<InstagramDiscoveryResponse>();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const deps = {
    db,
    placesFetch: ((input: unknown, init?: RequestInit) =>
      google.fetch(input as string, init)) as typeof fetch,
    instagramDiscoveryFetch: graphFetch,
    now: () => clock,
  };
  app = await buildApp({ env: env({ INSTAGRAM_BUSINESS_DISCOVERY_ENABLED: 'true' }), ...deps });
  off = await buildApp({ env: env({}), ...deps });
  seller = await loginAs(app, 'vendedor_formatacao');
  other = await loginAs(app, 'vendedor_formatacao');
  expansao = await loginAs(app, 'vendedor_expansao');
  // What the company's own site showed, saved on a prospect of place 6 (Ajustes' enrichment).
  await db.insert(prospects).values({
    placeId: PLACES[5]!.id,
    status: 'reservado',
    ownerEmployeeId: seller.id,
    enrichment: {
      instagram: {
        value: `https://www.instagram.com/${IG.saved}/`,
        source: 'site da empresa',
        at: '2026-10-20T12:00:00.000Z',
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await off?.close();
  await harness?.drop();
});

describe('the switch and who reaches it', () => {
  it('off: the route answers 503, the status says so, and Meta is never called', async () => {
    const ref = refOf(await search(seller), 1)!;
    const status = await call(seller, 'GET', '/prospecting/status', undefined, off);
    expect(status.json()).toMatchObject({ instagramDiscovery: false });
    expect((await call(seller, 'GET', '/prospecting/status')).json()).toMatchObject({
      instagramDiscovery: true,
    });
    graph.length = 0;
    const res = await call(
      seller,
      'POST',
      '/prospecting/instagram/discovery',
      { items: [ref] },
      off,
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'instagram_discovery_off' });
    await settle();
    expect(graph).toHaveLength(0);
    expect(await db.select().from(instagramDiscoveryCalls)).toEqual([]);
  });

  it('the Vendedor Expansão gets 403', async () => {
    const res = await discover(expansao, [{ username: IG.business, ticket: 'x' }]);
    expect(res.statusCode).toBe(403);
  });
});

describe('the search says where the Instagram came from, and saves none of it', () => {
  it("its site first, then Google's site field; a post link is no profile", async () => {
    const body = await search(seller);
    expect(refOf(body, 1)).toMatchObject({
      username: IG.business,
      source: 'site no Google',
      at: null,
    });
    expect(refOf(body, 2)).toMatchObject({ username: IG.personal, source: 'site no Google' });
    expect(refOf(body, 5)).toBeNull();
    expect(refOf(body, 6)).toMatchObject({
      username: IG.saved,
      source: 'site da empresa',
      at: '2026-10-20T12:00:00.000Z',
    });
    // Without the Instagram numbers the score is Google's alone, 0 to 100.
    expect(body.items.every((i) => i.icp.possible === 9)).toBe(true);
    // Nothing of Google's @ is written: no prospect for place 1, no reading yet.
    const saved = await db.select().from(prospects);
    expect(saved.map((p) => p.placeId)).toEqual([PLACES[5]!.id]);
    expect(await db.select().from(instagramBusinessSnapshots)).toEqual([]);
  });

  it("a @ without this seller's ticket never goes to Meta (a commenter's, a forged one, another seller's)", async () => {
    const theirs = refOf(await search(other), 1)!;
    graph.length = 0;
    const answer = await itemsOf(seller, [
      { username: 'pessoa.que.comentou', ticket: 'x' },
      { username: IG.business, ticket: `${T0.getTime() + DAY}.forged` },
      theirs,
    ]);
    expect(answer.items.map((i) => i.reason)).toEqual([
      REASONS.notFromSearch,
      REASONS.notFromSearch,
      REASONS.notFromSearch,
    ]);
    await settle();
    expect(graph).toHaveLength(0);
    expect(await db.select().from(instagramDiscoveryCalls)).toEqual([]);
  });
});

describe('Business Discovery in the score', () => {
  it('a business account gives its numbers and the right score; the token stays in a header', async () => {
    const body = await search(seller);
    const item = body.items.find((i) => i.placeId === PLACES[0]!.id)!;
    graph.length = 0;
    const answer = await itemsOf(seller, [item.instagram!]);
    expect(graph).toHaveLength(1);
    const sent = graph[0]!;
    expect(sent.auth).toBe(`Bearer ${TOKEN}`);
    expect(sent.url).not.toContain(TOKEN);
    expect(decodeURIComponent(sent.url)).toContain(
      `${ACCOUNT}?fields=business_discovery.username(${IG.business}){username,followers_count,media_count,media.limit(12){like_count,comments_count,timestamp}}`,
    );
    const snapshot = answer.items[0]!.snapshot!;
    expect(snapshot).toMatchObject({
      status: 'encontrada',
      followers: 12_000,
      posts: 340,
      recentMediaRead: 12,
      avgLikesMilli: 150_000,
      avgCommentsMilli: 8_000,
      postsLast30d: 6,
      lastPostAt: new Date(T0.getTime() - 2 * DAY).toISOString(),
      source: 'meta_business_discovery',
      fetchedAt: T0.toISOString(),
    });
    // Google: 4.6 (+2), 320 reviews (+2), a site (+1) of 9; Instagram: all 8 of 8.
    const score = icpScore(
      { rating: 4.6, reviews: 320, hasWebsite: true, hasInstagram: false, multiUnit: false },
      DEFAULT_ICP_WEIGHTS,
      instagramMetricsOf(snapshot),
    );
    expect(score).toMatchObject({ earned: 13, possible: 17, score: 76, noData: [] });
  });

  it('a personal account (110, 24) is "—" with the reason, and the score stays Google\'s', async () => {
    const body = await search(seller);
    const answer = await itemsOf(seller, [refOf(body, 2)!, refOf(body, 6)!]);
    for (const item of answer.items) {
      expect(item.reason).toBe(REASONS.notBusiness);
      expect(item.snapshot?.status).toBe('nao_comercial');
      expect(instagramMetricsOf(item.snapshot)).toBeNull();
    }
    // Asked again, the answer comes from the cache with the same reason (not a bare "lendo…").
    graph.length = 0;
    const cached = await itemsOf(seller, [refOf(body, 2)!]);
    expect(graph).toHaveLength(0);
    expect(cached.items[0]).toMatchObject({
      reason: REASONS.notBusiness,
      snapshot: { status: 'nao_comercial' },
    });
  });

  it('hidden likes take out only the engagement criterion', async () => {
    const answer = await itemsOf(seller, [refOf(await search(seller), 3)!]);
    const snapshot = answer.items[0]!.snapshot!;
    expect(snapshot.avgLikesMilli).toBeNull();
    expect(snapshot.avgCommentsMilli).toBe(8_000);
    const score = icpScore(
      { rating: 4.6, reviews: 320, hasWebsite: true, hasInstagram: false, multiUnit: false },
      DEFAULT_ICP_WEIGHTS,
      instagramMetricsOf(snapshot),
    );
    expect(score.noData).toEqual(['Instagram: engajamento ≥ 1%']);
    expect(score.possible).toBe(9 + 6);
  });

  it('the same company in two searches makes one call; after the cache days, one more', async () => {
    graph.length = 0;
    const first = refOf(await search(seller), 1)!;
    const again = await itemsOf(seller, [first, first]);
    expect(again.items).toHaveLength(2);
    expect(again.items[0]!.snapshot?.fetchedAt).toBe(T0.toISOString());
    await itemsOf(other, [refOf(await search(other), 1)!]);
    expect(graph).toHaveLength(0);
    clock = new Date(T0.getTime() + 8 * DAY);
    try {
      await itemsOf(seller, [refOf(await search(seller), 1)!]);
      expect(graph).toHaveLength(1);
    } finally {
      clock = T0;
    }
  });

  it('nothing of the name, bio, site or place_id is kept, and the token is never logged', async () => {
    const columns = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'instagram_business_snapshots'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    for (const banned of [
      'name',
      'biography',
      'website',
      'place_id',
      'profile_picture_url',
      'caption',
    ])
      expect(names).not.toContain(banned);
    const dump = inspect(await db.select().from(instagramBusinessSnapshots), { depth: 4 });
    expect(dump).not.toContain('Nome Fictício');
    expect(dump).not.toContain('99999-0000');
    expect(dump).not.toContain(PLACES[0]!.id);

    const logged: string[] = [];
    const info = app.log.info.bind(app.log);
    const spy = vi.spyOn(app.log, 'info').mockImplementation(((...a: unknown[]) => {
      logged.push(inspect(a, { depth: 6 }));
      (info as (...b: unknown[]) => void)(...a);
    }) as typeof app.log.info);
    try {
      await db
        .delete(instagramBusinessSnapshots)
        .where(eq(instagramBusinessSnapshots.username, IG.business));
      await itemsOf(seller, [refOf(await search(seller), 1)!]);
    } finally {
      spy.mockRestore();
    }
    const log = logged.join('\n');
    expect(log).toContain('discovery');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(IG.business);
    expect(log).not.toContain('Bio fictícia');
  });

  it('a reading is deleted 30 days after it was made', async () => {
    expect((await db.select().from(instagramBusinessSnapshots)).length).toBeGreaterThan(0);
    const kept = await runInstagramHousekeeping(db, new Date(T0.getTime() + 29 * DAY));
    expect(kept).toMatchObject({ ran: true, snapshots: 0 });
    const gone = await runInstagramHousekeeping(db, new Date(T0.getTime() + 31 * DAY));
    expect(gone).toMatchObject({ ran: true });
    expect(await db.select().from(instagramBusinessSnapshots)).toEqual([]);
  });
});

describe("limits: the daily ceiling and Meta's hold", () => {
  it("a row of the daily ceiling is deleted 30 days after the call; today's stay counted", async () => {
    await db.insert(instagramDiscoveryCalls).values([
      { employeeId: other.id, createdAt: new Date(T0.getTime() - 31 * DAY) },
      { employeeId: other.id, createdAt: T0 },
    ]);
    const before = (await db.select().from(instagramDiscoveryCalls)).length;
    expect(await runInstagramHousekeeping(db, T0)).toMatchObject({ ran: true, calls: 1 });
    const left = await db.select().from(instagramDiscoveryCalls);
    expect(left).toHaveLength(before - 1);
    expect(left.every((row) => row.createdAt >= new Date(T0.getTime() - 30 * DAY))).toBe(true);
  });

  it('the 501st call of the day does not reach Meta', async () => {
    const ref = refOf(await search(seller), 1)!;
    const today = await db.select().from(instagramDiscoveryCalls);
    await db
      .insert(instagramDiscoveryCalls)
      .values(
        Array.from({ length: 500 - today.length }, () => ({ employeeId: other.id, createdAt: T0 })),
      );
    graph.length = 0;
    const answer = await itemsOf(seller, [ref]);
    expect(answer.items[0]!.reason).toBe(REASONS.dailyLimit);
    expect(answer.usage).toEqual({ today: 500, limit: 500 });
    await settle();
    expect(graph).toHaveLength(0);
    // The next day (São Paulo) the count starts again.
    clock = new Date(T0.getTime() + DAY);
    try {
      expect(
        (await itemsOf(seller, [refOf(await search(seller), 1)!])).items[0]!.reason,
      ).toBeNull();
    } finally {
      clock = T0;
    }
  });

  it('error 10 says "a Meta recusou" and holds every call; so does a limit error', async () => {
    clock = new Date(T0.getTime() + 2 * DAY);
    try {
      const body = await search(seller);
      graph.length = 0;
      // Place 1 is in the cache (read yesterday); place 3 is not, and waits.
      const answer = await itemsOf(seller, [refOf(body, 4)!, refOf(body, 3)!, refOf(body, 1)!]);
      expect(answer.items[0]!.reason).toBe(REASONS.refused);
      expect(answer.items[0]!.snapshot).toBeNull();
      expect(answer.items[1]!.reason).toMatch(/^a Meta recusou a consulta \(até \d\d:\d\d\)$/);
      expect(answer.items[2]!.snapshot?.status).toBe('encontrada');
      expect(answer.holdUntil).toBe(new Date(clock.getTime() + 60 * 60_000).toISOString());
      await settle();
      expect(graph.map((g) => g.username)).toEqual([IG.refused]);
      const [row] = await db
        .select()
        .from(instagramBusinessSnapshots)
        .where(eq(instagramBusinessSnapshots.username, IG.refused));
      expect(row).toMatchObject({ status: 'erro', errorCode: 10 });
      // After the hold the same @ goes to Meta again: a reading with an error is never cached.
      clock = new Date(clock.getTime() + 61 * 60_000);
      const later = await itemsOf(seller, [refOf(await search(seller), 4)!]);
      expect(later.items[0]!.reason).toBe(REASONS.refused);
      expect(graph.map((g) => g.username)).toEqual([IG.refused, IG.refused]);
    } finally {
      clock = T0;
    }
  });

  it('usage at 80% pauses the next calls for the time Meta gives, then they go again', async () => {
    clock = new Date(T0.getTime() + 4 * DAY);
    try {
      let body = await search(seller);
      graph.length = 0;
      const busy = await itemsOf(seller, [refOf(body, 7)!]);
      // The call that read 85% still brings its numbers; the next ones wait 30 minutes.
      expect(busy.items[0]!.snapshot?.status).toBe('encontrada');
      expect(busy.holdUntil).toBe(new Date(clock.getTime() + 30 * 60_000).toISOString());
      const held = await itemsOf(seller, [refOf(body, 8)!]);
      expect(held.items[0]!.reason).toMatch(/^Instagram em espera \(até \d\d:\d\d\)$/);
      await settle();
      expect(graph.map((g) => g.username)).toEqual([IG.busy]);
      // After the hold, the call goes; a limit error (80002) holds again, an hour by default.
      clock = new Date(clock.getTime() + 31 * 60_000);
      body = await search(seller);
      const limited = await itemsOf(seller, [refOf(body, 8)!]);
      expect(limited.items[0]!.reason).toBe(REASONS.waiting);
      expect(limited.holdUntil).toBe(new Date(clock.getTime() + 60 * 60_000).toISOString());
      expect(graph.map((g) => g.username)).toEqual([IG.busy, IG.limited]);
    } finally {
      clock = T0;
    }
  });
});
