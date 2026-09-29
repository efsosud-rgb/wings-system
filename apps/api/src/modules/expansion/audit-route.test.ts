import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let configured: FastifyInstance;
let unconfigured: FastifyInstance;
const methods: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A simulated RD: one contact converted today on a page that has no deal. */
const rdFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  methods.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/auth/token') return json({ access_token: 't' });
  if (url.pathname.endsWith('/contacts') && url.host === 'api.rd.services') {
    return json({
      contacts:
        url.searchParams.get('page') === '1'
          ? [{ uuid: 'u1', last_conversion_date: new Date().toISOString() }]
          : [],
    });
  }
  if (url.pathname.endsWith('/events')) {
    return json([
      {
        event_type: 'CONVERSION',
        event_timestamp: new Date().toISOString(),
        payload: {
          conversion_identifier: 'lp-teste',
          email: 'quem@example.com',
          name: 'Quem Quer',
        },
      },
    ]);
  }
  if (url.pathname === '/api/v1/contacts') return json({ contacts: [] });
  return json({}, 404);
};

function envWith(extra: Record<string, string>) {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
    ...extra,
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  unconfigured = await buildApp({ env: envWith({}), db });
  configured = await buildApp({
    env: envWith({
      RD_CRM_API_TOKEN: 'crm-token',
      RD_MKT_CLIENT_ID: 'id',
      RD_MKT_CLIENT_SECRET: 'secret',
      RD_MKT_REFRESH_TOKEN: 'refresh',
    }),
    db,
    rdFetch,
  });
});

afterAll(async () => {
  await unconfigured?.close();
  await configured?.close();
  await harness?.drop();
});

async function cookiesFor(app: FastifyInstance, role: 'admin_master' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

describe('GET /expansion/landing-audit', () => {
  it('is closed to a salesperson and to a call without a session', async () => {
    const cookies = await cookiesFor(configured, 'vendedor_expansao');
    expect(
      (await configured.inject({ method: 'GET', url: '/expansion/landing-audit', cookies }))
        .statusCode,
    ).toBe(403);
    expect(
      (await configured.inject({ method: 'GET', url: '/expansion/landing-audit' })).statusCode,
    ).toBe(401);
  });

  it('answers 503 when RD is not configured, never a fake result', async () => {
    const cookies = await cookiesFor(unconfigured, 'admin_master');
    const response = await unconfigured.inject({
      method: 'GET',
      url: '/expansion/landing-audit',
      cookies,
    });
    expect(response.statusCode).toBe(503);
  });

  it('starts the run with 202, then answers counts only, and reads RD with GET alone', async () => {
    const cookies = await cookiesFor(configured, 'admin_master');
    const first = await configured.inject({
      method: 'GET',
      url: '/expansion/landing-audit?days=30',
      cookies,
    });
    expect(first.statusCode).toBe(202);

    let body: { state: string; result?: { pages: { identifier: string; leaked: number }[] } } = {
      state: 'running',
    };
    for (let i = 0; i < 50 && body.state === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await configured.inject({
        method: 'GET',
        url: '/expansion/landing-audit?days=30',
        cookies,
      });
      body = again.json();
    }
    expect(body.state).toBe('done');
    expect(body.result!.pages).toEqual([
      expect.objectContaining({ identifier: 'lp-teste', leaked: 1 }),
    ]);

    const text = JSON.stringify(body);
    for (const secret of ['quem@example.com', 'Quem Quer']) expect(text).not.toContain(secret);
    // The only POST is the OAuth token refresh; every data call is a GET.
    expect(methods.filter((m) => !m.startsWith('GET'))).toEqual(['POST /auth/token']);
  });
});
