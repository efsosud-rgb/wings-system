import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../env.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../test/factories.js';
import {
  isLandingOriginList,
  LANDING_ORIGINS_RULE,
  landingCorsOf,
  landingOriginsOf,
  originOf,
} from './landing-cors.js';

const LANDING = 'https://fale.wingscompany.com.br';
const OTHER = 'https://outro-site.example';

describe('LANDING_ORIGINS', () => {
  it('reads exact origins separated by commas or spaces', () => {
    expect([
      ...landingOriginsOf(`${LANDING}, http://localhost:5174  https://lp.example.com`),
    ]).toEqual([LANDING, 'http://localhost:5174', 'https://lp.example.com']);
    expect(landingOriginsOf(undefined).size).toBe(0);
    expect(originOf('https://FALE.wingscompany.com.br')).toBe(LANDING);
  });

  it('refuses an entry that is not an origin', () => {
    for (const bad of [
      `${LANDING}/pagina`,
      `${LANDING}/?x=1`,
      `${LANDING}#a`,
      'fale.wingscompany.com.br',
      'ftp://fale.wingscompany.com.br',
      '*',
      // http only on this machine
      'http://fale.wingscompany.com.br',
      'http://localhost.example.com',
      'http://127.0.0.2:5174',
      'http://10.0.0.1',
    ]) {
      expect(originOf(bad), bad).toBeNull();
      expect(isLandingOriginList(`${LANDING},${bad}`), bad).toBe(false);
    }
    expect(isLandingOriginList(`${LANDING} http://localhost:5174`)).toBe(true);
    expect(originOf('http://127.0.0.1:20000')).toBe('http://127.0.0.1:20000');
    expect(originOf('http://[::1]:5174')).toBe('http://[::1]:5174');
    expect(originOf('http://LOCALHOST')).toBe('http://localhost');
  });
});

describe('landingCorsOf', () => {
  const allowed = new Set([LANDING]);
  const of = (method: string, path: string, origin?: string) =>
    landingCorsOf({ method, path, origin, allowed });

  it('opens /public/* to a listed origin, preflight included', () => {
    expect(of('GET', '/public/site-forms/:slug', LANDING)).toEqual({
      kind: 'allow',
      headers: { 'Access-Control-Allow-Origin': LANDING, Vary: 'Origin' },
    });
    expect(of('OPTIONS', '/public/site-forms/fale-com-a-wings', LANDING)).toMatchObject({
      kind: 'preflight',
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
      },
    });
  });

  it('refuses a foreign preflight and leaves everything else as it was', () => {
    expect(of('OPTIONS', '/public/site-forms/x', OTHER)).toEqual({ kind: 'refuse' });
    expect(of('POST', '/public/site-forms/:slug', OTHER)).toEqual({ kind: 'none' });
    expect(of('POST', '/auth/login', LANDING)).toEqual({ kind: 'none' });
    expect(of('OPTIONS', '/auth/login', LANDING)).toEqual({ kind: 'none' });
    expect(of('GET', '/public/site-forms/:slug')).toEqual({ kind: 'none' });
    expect(of('GET', '/publicx/site-forms', LANDING)).toEqual({ kind: 'none' });
  });
});

describe('the API env', () => {
  const env = (extra: Record<string, string>) =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.invalid/db',
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      ...extra,
    });

  it('takes a list of origins and an https base with no path', () => {
    expect(env({ LANDING_ORIGINS: `${LANDING},http://localhost:5174` }).LANDING_ORIGINS).toBe(
      `${LANDING},http://localhost:5174`,
    );
    expect(env({ LANDING_PAGE_BASE_URL: 'https://lpfranquias.wingscompany.com.br' })).toMatchObject(
      { LANDING_PAGE_BASE_URL: 'https://lpfranquias.wingscompany.com.br' },
    );
    expect(env({ LANDING_ORIGINS: '', LANDING_PAGE_BASE_URL: '' })).toMatchObject({
      LANDING_ORIGINS: undefined,
      LANDING_PAGE_BASE_URL: undefined,
    });
  });

  it('refuses a path, a non-origin or http', () => {
    expect(() => env({ LANDING_ORIGINS: `${LANDING}/lp` })).toThrow(/LANDING_ORIGINS/);
    // http outside this machine, and the message says what is accepted
    const http = () => env({ LANDING_ORIGINS: `${LANDING} http://fale.wingscompany.com.br` });
    expect(http).toThrow(/LANDING_ORIGINS/);
    expect(http).toThrow(LANDING_ORIGINS_RULE);
    expect(LANDING_ORIGINS_RULE).toBe(
      'must be https:// origins (scheme and host, no path) separated by commas or spaces; http:// only for localhost, 127.0.0.1 or [::1]',
    );
    expect(env({ LANDING_ORIGINS: 'http://127.0.0.1:20000 http://[::1]:5174' })).toMatchObject({
      LANDING_ORIGINS: 'http://127.0.0.1:20000 http://[::1]:5174',
    });
    expect(() => env({ LANDING_PAGE_BASE_URL: 'http://lpfranquias.wingscompany.com.br' })).toThrow(
      /LANDING_PAGE_BASE_URL/,
    );
    expect(() =>
      env({ LANDING_PAGE_BASE_URL: 'https://lpfranquias.wingscompany.com.br/lp' }),
    ).toThrow(/LANDING_PAGE_BASE_URL/);
  });
});

describe('CORS on the running app', () => {
  let harness: TestDatabase;
  const apps: FastifyInstance[] = [];

  /** Turnstile simulated: only the token "good" passes. */
  const captchaFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const success = new URLSearchParams(String(init?.body ?? '')).get('response') === 'good';
    return new Response(JSON.stringify({ success }), { status: 200 });
  }) as typeof fetch;

  async function makeApp(extra: Record<string, string> = {}) {
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: 'x'.repeat(48),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        LANDING_ORIGINS: `${LANDING} http://localhost:5174`,
        ...extra,
      }),
      db: harness.db,
      captchaFetch,
    });
    apps.push(app);
    return app;
  }

  const body = {
    name: 'Pessoa Teste',
    email: 'cors.teste@example.com',
    phone: '(21) 97777-0001',
    companyName: 'Empresa Exemplo',
    instagram: '@empresa.exemplo',
    qualifierAnswer: 'formatacao',
    consent: true,
    turnstileToken: 'good',
    website: '',
  };
  const url = '/public/site-forms/fale-com-a-wings';
  const noCredentials = (headers: Record<string, unknown>) =>
    expect(headers['access-control-allow-credentials']).toBeUndefined();

  beforeAll(async () => {
    harness = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await harness?.drop();
  });

  it('answers the preflight of a listed origin with 204 and the allowed methods', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: LANDING,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': LANDING,
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    noCredentials(response.headers);
  });

  it('reads and sends the form from a listed origin, with the CORS headers on the answer', async () => {
    const app = await makeApp();
    const read = await app.inject({ method: 'GET', url, headers: { origin: LANDING } });
    expect(read.statusCode).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBe(LANDING);
    expect(read.headers.vary).toContain('Origin');
    noCredentials(read.headers);

    const sent = await app.inject({
      method: 'POST',
      url,
      headers: { origin: LANDING },
      payload: body,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ ok: true });
    expect(sent.headers['access-control-allow-origin']).toBe(LANDING);
    noCredentials(sent.headers);

    // An error answer carries them too, so the page can read the message.
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers: { origin: 'http://localhost:5174' },
      payload: { ...body, email: undefined },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('keeps refusing an origin not listed', async () => {
    const app = await makeApp();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin: OTHER, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.json().error).toBe('bad_origin');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const sent = await app.inject({
      method: 'POST',
      url,
      headers: { origin: OTHER },
      payload: body,
    });
    expect(sent.statusCode).toBe(403);
    expect(sent.json().error).toBe('bad_origin');

    const read = await app.inject({ method: 'GET', url, headers: { origin: OTHER } });
    expect(read.statusCode).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('opens nothing outside /public/*, even to a listed origin', async () => {
    const app = await makeApp();
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: LANDING },
      payload: { email: 'ninguem@example.com', password: 'x'.repeat(12) },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe('bad_origin');
    expect(login.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: LANDING, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).not.toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('without LANDING_ORIGINS, a landing POST is refused as before', async () => {
    const app = await makeApp({ LANDING_ORIGINS: '' });
    const sent = await app.inject({
      method: 'POST',
      url,
      headers: { origin: LANDING },
      payload: body,
    });
    expect(sent.statusCode).toBe(403);
    expect(sent.json().error).toBe('bad_origin');
  });
});
