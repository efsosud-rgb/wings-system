import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type KairogenStatus } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import type { Database } from '../../../db/client.js';
import { auditLog, integrationConnections } from '../../../db/schema/index.js';
import { loadEnv } from '../../../env.js';
import { createSecretBox } from '../../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../../test/factories.js';
import { fakeKairogen } from './fake-kairogen.js';
import { callKairogen, creditsFrom, kairogenDepsOf } from './service.js';

/**
 * Connecting the system to Kairogen, against a simulated authorization server
 * and a simulated MCP server. Nothing here reaches Kairogen.
 */

const KEY = randomBytes(32).toString('base64');
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let fake = fakeKairogen();
/** Swappable, so each test gets a fresh Kairogen behind the same app. */
const transport = ((input: string | URL | Request, init?: RequestInit) =>
  fake.fetch(input, init)) as typeof fetch;

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
    ...extra,
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY }),
    db,
    kairogenFetch: transport,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  fake = fakeKairogen();
  await db.delete(integrationConnections);
});

async function sessionFor(role: 'admin_master' | 'marketing' | 'diretoria', on = app) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const login = await on.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const post = (url: string, cookies: Record<string, string>, payload?: unknown) =>
  app.inject({ method: 'POST', url, cookies, ...(payload ? { payload } : {}) });
const statusOf = (response: { json: <T>() => T }) =>
  response.json<{ status: KairogenStatus }>().status;
const stored = async () =>
  (
    await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, 'kairogen'))
  )[0];
/** Lets the next poll through without waiting the five seconds the server asked for. */
async function skipInterval() {
  const row = await stored();
  await db
    .update(integrationConnections)
    .set({ pending: { ...(row?.pending as object), nextPollAt: new Date(0).toISOString() } })
    .where(eq(integrationConnections.provider, 'kairogen'));
}

describe('connecting by device flow', () => {
  it('registers a client, shows the code to type, and connects once the person approved', async () => {
    const admin = await sessionFor('admin_master');
    const started = statusOf(await post('/integrations/kairogen/connect', admin.cookies));
    expect(started).toMatchObject({
      state: 'pending',
      pending: {
        flow: 'device',
        userCode: 'WING-5678',
        verificationUri: 'https://app.kairogen.ai/device',
        verificationUriComplete: 'https://app.kairogen.ai/device?user_code=WING-5678',
        intervalSeconds: 5,
      },
    });

    // The registration asked for a public client with both grants.
    const registration = fake.calls.find((call) => call.url.endsWith('/oauth/register'));
    expect(JSON.parse(registration?.body ?? '{}')).toMatchObject({
      client_name: 'Wings System',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://staging.wingssystem.online/api/integrations/kairogen/callback'],
      grant_types: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
    });

    // Asked again too soon, the server does not even call Kairogen.
    const tokenCalls = () => fake.calls.filter((call) => call.url.endsWith('/oauth/token')).length;
    expect(statusOf(await post('/integrations/kairogen/poll', admin.cookies)).state).toBe(
      'pending',
    );
    expect(tokenCalls()).toBe(0);

    await skipInterval();
    expect(statusOf(await post('/integrations/kairogen/poll', admin.cookies)).state).toBe(
      'pending',
    );
    expect(tokenCalls()).toBe(1);

    fake.decideDevice('approved');
    await skipInterval();
    const connected = statusOf(await post('/integrations/kairogen/poll', admin.cookies));
    expect(connected).toMatchObject({
      state: 'connected',
      pending: null,
      scopes: ['kairogen:read', 'kairogen:generate'],
      credits: { balance: 120 },
      protocolVersion: '2025-03-26',
    });
    // The eight tools, and not the ninth the server also offers.
    expect(connected.tools.map((tool) => tool.name)).toHaveLength(8);
    expect(connected.tools.map((tool) => tool.name)).not.toContain('something_else');

    const audit = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(eq(auditLog.actorEmployeeId, admin.employeeId), eq(auditLog.entity, 'integration')),
      );
    expect(audit.map((row) => row.action)).toEqual([
      'integrations.kairogen_connect_started',
      'integrations.kairogen_connected',
    ]);
  });

  it('slows down when told to, and gives up when the person says no', async () => {
    const admin = await sessionFor('admin_master');
    await post('/integrations/kairogen/connect', admin.cookies);
    fake.state.tokenScript = ['slow_down'];
    await skipInterval();
    expect(
      statusOf(await post('/integrations/kairogen/poll', admin.cookies)).pending,
    ).toMatchObject({
      intervalSeconds: 10,
    });

    fake.decideDevice('denied');
    await skipInterval();
    const denied = statusOf(await post('/integrations/kairogen/poll', admin.cookies));
    expect(denied).toMatchObject({
      state: 'disconnected',
      detail: 'A autorização foi negada no Kairogen.',
    });
  });

  it('says why when Kairogen refuses the registration, and uses a client id given by hand', async () => {
    fake = fakeKairogen({ refuseRegistration: true });
    const admin = await sessionFor('admin_master');
    const refused = await post('/integrations/kairogen/connect', admin.cookies);
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toMatchObject({ error: 'registration_refused' });

    fake = fakeKairogen({ refuseRegistration: true });
    const manual = await buildApp({
      env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY, KAIROGEN_CLIENT_ID: 'wings-by-hand' }),
      db,
      kairogenFetch: transport,
    });
    try {
      const session = await sessionFor('admin_master', manual);
      const response = await manual.inject({
        method: 'POST',
        url: '/integrations/kairogen/connect',
        cookies: session.cookies,
      });
      expect(response.statusCode).toBe(200);
      expect(fake.calls.some((call) => call.url.endsWith('/oauth/register'))).toBe(false);
      const device = fake.calls.find((call) => call.url.endsWith('/oauth/device_authorization'));
      expect(new URLSearchParams(device?.body).get('client_id')).toBe('wings-by-hand');
    } finally {
      await manual.close();
    }
  });
});

describe('connecting by authorization code with PKCE', () => {
  it('sends the browser to Kairogen and finishes when it comes back with the right state', async () => {
    fake = fakeKairogen({ refuseDeviceFlow: true });
    const admin = await sessionFor('admin_master');
    const device = await post('/integrations/kairogen/connect', admin.cookies);
    expect(device.json()).toMatchObject({ error: 'device_flow_refused' });

    const started = statusOf(
      await post('/integrations/kairogen/connect', admin.cookies, { flow: 'code' }),
    );
    const url = new URL(started.pending?.authorizationUrl ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://app.kairogen.ai/oauth/consent');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      code_challenge_method: 'S256',
      redirect_uri: 'https://staging.wingssystem.online/api/integrations/kairogen/callback',
      scope: 'kairogen:read kairogen:generate',
      resource: 'https://mcp.kairogen.ai',
    });

    const approved = fake.approveCode(url.toString());

    // Somebody else's answer, or an answer from another server, finishes nothing.
    const forged = await app.inject({
      url: `/integrations/kairogen/callback?code=${approved.code}&state=forged`,
      cookies: admin.cookies,
    });
    expect(forged.headers.location).toBe(
      'https://staging.wingssystem.online/administracao/integracoes?kairogen=erro',
    );
    expect((await stored())?.state).toBe('pending');
    const wrongIssuer = await app.inject({
      url: `/integrations/kairogen/callback?code=${approved.code}&state=${approved.state}&iss=https://evil.example`,
      cookies: admin.cookies,
    });
    expect(wrongIssuer.headers.location).toContain('kairogen=erro');

    const back = await app.inject({
      url: `/integrations/kairogen/callback?code=${approved.code}&state=${approved.state}&iss=https://api.kairogen.ai`,
      cookies: admin.cookies,
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(
      'https://staging.wingssystem.online/administracao/integracoes?kairogen=ok',
    );
    expect((await stored())?.state).toBe('connected');

    // The verifier that was sent hashes to the challenge that was shown: PKCE held.
    const exchange = fake.calls.find(
      (call) => new URLSearchParams(call.body).get('grant_type') === 'authorization_code',
    );
    expect(new URLSearchParams(exchange?.body).get('code_verifier')).toBeTruthy();
  });
});

async function connect() {
  const admin = await sessionFor('admin_master');
  await post('/integrations/kairogen/connect', admin.cookies);
  fake.decideDevice('approved');
  await skipInterval();
  await post('/integrations/kairogen/poll', admin.cookies);
  return admin;
}

describe('tokens at rest and in transit', () => {
  it('stores every credential encrypted, and hands none to the browser', async () => {
    const admin = await connect();
    const row = await stored();
    const [accessToken] = [...fake.state.accessTokens];
    const [refreshToken] = [...fake.state.refreshTokens];

    const everything = JSON.stringify(row);
    expect(everything).not.toContain(accessToken);
    expect(everything).not.toContain(refreshToken);
    const box = createSecretBox(KEY);
    expect(box.open(row?.accessTokenEnc ?? '')).toBe(accessToken);
    expect(box.open(row?.refreshTokenEnc ?? '')).toBe(refreshToken);
    // Another key opens nothing.
    expect(() =>
      createSecretBox(randomBytes(32).toString('base64')).open(row?.accessTokenEnc ?? ''),
    ).toThrow();

    const status = await app.inject({ url: '/integrations/kairogen', cookies: admin.cookies });
    expect(status.payload).not.toContain(accessToken);
    expect(status.payload).not.toContain(refreshToken);
    expect(status.payload).not.toMatch(/secretEnc|device_code|dc_/);
  });

  it('kept the device code encrypted while the authorization was pending', async () => {
    const admin = await sessionFor('admin_master');
    const started = await post('/integrations/kairogen/connect', admin.cookies);
    const [deviceCode] = [...fake.state.devices.keys()];
    expect(started.payload).not.toContain(deviceCode);
    expect(JSON.stringify(await stored())).not.toContain(deviceCode);
  });

  it('refuses a key that is one of the CPF keys', () => {
    expect(() => env({ INTEGRATIONS_ENCRYPTION_KEY: TEST_CPF_KEY })).toThrow(/CPF/);
  });
});

describe('keeping the connection alive', () => {
  it('refreshes a token about to expire, keeps the rotated refresh token, and carries on', async () => {
    fake = fakeKairogen({ expiresIn: 30, rotateRefreshTokens: true });
    await connect();
    const before = await stored();
    const deps = kairogenDepsOf({
      db,
      env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY }),
      kairogenFetch: transport,
    });
    if (!deps) throw new Error('expected deps');

    const result = await callKairogen(deps, 'get_credits');
    expect(creditsFrom(result, new Date()).balance).toBe(120);

    const refreshes = fake.calls.filter(
      (call) => new URLSearchParams(call.body).get('grant_type') === 'refresh_token',
    );
    expect(refreshes.length).toBeGreaterThan(0);
    const after = await stored();
    expect(after?.refreshTokenEnc).not.toBe(before?.refreshTokenEnc);
    expect(after?.state).toBe('connected');
  });

  it('answers a revoked access token with one refresh, for a tool that reads', async () => {
    await connect();
    const deps = kairogenDepsOf({
      db,
      env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY }),
      kairogenFetch: transport,
    });
    if (!deps) throw new Error('expected deps');
    fake.expireAccessTokens();
    expect(creditsFrom(await callKairogen(deps, 'get_credits'), new Date()).balance).toBe(120);
  });

  it('never repeats a call that spends credits, even to recover from a refused token', async () => {
    await connect();
    const deps = kairogenDepsOf({
      db,
      env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY }),
      kairogenFetch: transport,
    });
    if (!deps) throw new Error('expected deps');
    fake.expireAccessTokens();
    await expect(callKairogen(deps, 'generate_image', { prompt: 'x' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(fake.state.toolCalls.filter((call) => call.name === 'generate_image')).toHaveLength(0);
  });

  it('tries a read once more after Kairogen reports its own server error, and never a call that spends', async () => {
    await connect();
    const made = kairogenDepsOf({
      db,
      env: env({ INTEGRATIONS_ENCRYPTION_KEY: KEY }),
      kairogenFetch: transport,
    });
    if (!made) throw new Error('expected deps');
    const deps = { ...made, transientRetryMs: 5 };
    const internal =
      'Kairogen API error (500): [INTERNAL_ERROR] Erro interno do servidor. Tente novamente ou contate o suporte.';
    const estimate = { model: 'seedream-v4', plan_key: 'free', quantity: 1 };
    const calls = (name: string) =>
      fake.state.toolCalls.filter((call) => call.name === name).length;

    // Once: the second try answers.
    fake.state.toolErrorScript.push({ tool: 'estimate_cost', text: internal });
    const quoted = await callKairogen(deps, 'estimate_cost', estimate);
    expect((quoted.data as { credit_cost: number }).credit_cost).toBe(4);
    expect(calls('estimate_cost')).toBe(2);

    // Twice: reported as Kairogen being unavailable, not as a refusal of what we asked.
    fake.state.toolErrorScript.push(
      { tool: 'estimate_cost', text: internal },
      { tool: 'estimate_cost', text: internal },
    );
    await expect(callKairogen(deps, 'estimate_cost', estimate)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(calls('estimate_cost')).toBe(4);

    // A validation error is ours to fix: no second try.
    fake.state.toolErrorScript.push({
      tool: 'estimate_cost',
      text: 'Kairogen API error (400): [VALIDATION_ERROR] Erro ao calcular créditos.',
    });
    await expect(callKairogen(deps, 'estimate_cost', estimate)).rejects.toMatchObject({
      code: 'tool_error',
    });
    expect(calls('estimate_cost')).toBe(5);

    // A generation is sent once, whatever Kairogen says.
    fake.state.toolErrorScript.push({ tool: 'generate_image', text: internal });
    await expect(
      callKairogen(deps, 'generate_image', { model: 'seedream-v4', prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'tool_error' });
    expect(calls('generate_image')).toBe(1);
  });

  it('keeps the connection when Kairogen is only down, and asks to reconnect when it no longer renews', async () => {
    fake = fakeKairogen({ expiresIn: 30 });
    const admin = await connect();

    // Down: nothing is thrown away.
    const working = fake;
    fake = { ...working, fetch: (async () => new Response('', { status: 503 })) as typeof fetch };
    const down = statusOf(
      await app.inject({ url: '/integrations/kairogen', cookies: admin.cookies }),
    );
    expect(down).toMatchObject({
      state: 'connected',
      detail: 'Não foi possível ler o saldo agora.',
    });
    fake = working;

    fake.state.refreshTokens.clear();
    const status = statusOf(
      await app.inject({ url: '/integrations/kairogen', cookies: admin.cookies }),
    );
    expect(status).toMatchObject({
      state: 'needs_reconnect',
      detail: 'O Kairogen não renovou o acesso. Conecte de novo.',
      credits: null,
    });
  });
});

describe('disconnecting', () => {
  it('revokes the token at Kairogen, forgets it here and leaves a record', async () => {
    const admin = await connect();
    const [refreshToken] = [...fake.state.refreshTokens];
    const status = statusOf(await post('/integrations/kairogen/disconnect', admin.cookies));
    expect(status).toMatchObject({
      state: 'disconnected',
      tools: [],
      scopes: [],
      connectedAt: null,
    });
    expect(fake.state.revoked).toEqual([refreshToken]);

    const row = await stored();
    expect(row).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null });
    // The registered client stays: connecting again does not register another.
    expect(row?.clientId).toBeTruthy();

    const [last] = (
      await db.select().from(auditLog).where(eq(auditLog.actorEmployeeId, admin.employeeId))
    ).slice(-1);
    expect(last).toMatchObject({
      action: 'integrations.kairogen_disconnected',
      metadata: { revokedAtKairogen: true },
    });
  });
});

describe('who may connect', () => {
  it('only a holder of integrations.manage: Admin Master, not Diretoria, not Marketing', async () => {
    for (const role of ['diretoria', 'marketing'] as const) {
      const { cookies } = await sessionFor(role);
      expect((await app.inject({ url: '/integrations/kairogen', cookies })).statusCode).toBe(403);
      expect((await post('/integrations/kairogen/connect', cookies)).statusCode).toBe(403);
      expect((await post('/integrations/kairogen/disconnect', cookies)).statusCode).toBe(403);
      expect(
        (await app.inject({ url: '/integrations/kairogen/callback?code=x&state=y', cookies }))
          .statusCode,
      ).toBe(403);
    }
    expect((await app.inject({ url: '/integrations/kairogen' })).statusCode).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('says the environment is not ready when the encryption key is missing', async () => {
    const bare = await buildApp({ env: env(), db, kairogenFetch: transport });
    try {
      const { cookies } = await sessionFor('admin_master', bare);
      const status = await bare.inject({ url: '/integrations/kairogen', cookies });
      expect(statusOf(status).state).toBe('not_configured');
      const connect = await bare.inject({
        method: 'POST',
        url: '/integrations/kairogen/connect',
        cookies,
      });
      expect(connect.statusCode).toBe(503);
      expect(fake.calls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});

describe('reading the balance', () => {
  it('takes credits_remaining for the balance, and no other number in the answer', () => {
    const now = new Date();
    // The real shape, from the staging log of 2026-09-21.
    const answer = {
      credits_remaining: 94,
      stats: { posts: 0, creditsUsed: 1, totalGenerations: 1, followers: 0, _id: 'abc' },
    };
    expect(creditsFrom({ data: answer, text: '' }, now).balance).toBe(94);
    expect(creditsFrom({ data: { stats: answer.stats }, text: '' }, now).balance).toBeNull();
    // A number in a sentence is not a balance: "1 generation so far, 310 credits" is ambiguous.
    expect(creditsFrom({ data: null, text: 'You have 310 credits left' }, now)).toMatchObject({
      balance: null,
      raw: 'You have 310 credits left',
    });
    expect(creditsFrom({ data: null, text: 'unknown' }, now)).toMatchObject({
      balance: null,
      raw: 'unknown',
    });
  });
});
