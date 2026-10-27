import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { clients, leadSourceRules } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { deviceOf, loggedUtm, SITE_EVENT_LOG_MSG, siteEventLineOf } from './site-events.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const ORIGIN = 'https://fale.exemplo.com.br';
const PATH = '/public/site-forms/cenoritas/events';
const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.179 Mobile Safari/537.36 Instagram 334.0.0.42.95 Android';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const [client] = await db
    .insert(clients)
    .values({ name: 'Cenoritas', slug: 'cenoritas', number: 20 })
    .returning();
  await db.insert(leadSourceRules).values({
    kind: 'landing_page',
    pattern: 'cenoritas',
    clientId: client!.id,
    pipeline: 'expansao',
    siteFormEnabled: true,
  });
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      LANDING_ORIGINS: ORIGIN,
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

/** What the page's beacon sends: a JSON string as text/plain, from the page's origin. */
const beacon = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: PATH,
    headers: {
      origin: ORIGIN,
      'content-type': 'text/plain;charset=UTF-8',
      'user-agent': INSTAGRAM_ANDROID,
      ...headers,
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('site events (the page’s beacons)', () => {
  it('answers 204 with the page’s CORS and writes one log line: the event, the UTMs, the device; never the IP or the agent', async () => {
    const info = vi.spyOn(app.log, 'info');
    const response = await beacon({
      event: 'whatsapp_click',
      step: 'thanks',
      visit: 'a1b2c3d4e5f60718293a4b5c',
      // The ids Meta's url_tags put in the address of the Método 52s ad.
      utm_source: 'ig',
      utm_medium: 'paid',
      utm_campaign: '120252596733630076',
      utm_content: '120252596746630076',
      utm_term: '120252596743640076',
      utm_id: '120252596733630076',
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const lines = info.mock.calls
      .map((call) => call[0])
      .filter((line) => typeof line === 'object' && line !== null && 'msg' in line)
      .filter((line) => (line as { msg: unknown }).msg === SITE_EVENT_LOG_MSG);
    expect(lines).toEqual([
      {
        msg: SITE_EVENT_LOG_MSG,
        slug: 'cenoritas',
        event: 'whatsapp_click',
        step: 'thanks',
        visit: 'a1b2c3d4e5f60718293a4b5c',
        utm_source: 'ig',
        utm_medium: 'paid',
        utm_campaign: '120252596733630076',
        utm_content: '120252596746630076',
        utm_term: '120252596743640076',
        utm_id: '120252596733630076',
        device: 'phone',
        os: 'android',
        app: 'instagram',
      },
    ]);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('Mozilla');
    info.mockRestore();
  });

  it('takes a plain JSON body too, and a step-less event', async () => {
    const response = await beacon(
      { event: 'page_view', visit: 'a1b2c3d4e5f6' },
      { 'content-type': 'application/json' },
    );
    expect(response.statusCode).toBe(204);
  });

  it('refuses what is not on the list: an unknown event or step, an extra key, a visit id of another shape, a body that is not JSON', async () => {
    const info = vi.spyOn(app.log, 'info');
    const refused = await Promise.all([
      beacon({ event: 'scroll' }),
      beacon({ event: 'submit_error', step: 'typo' }),
      beacon({ event: 'page_view', name: 'Fulano' }),
      beacon({ event: 'page_view', email: 'fulano@exemplo.com' }),
      beacon({ event: 'page_view', visit: 'has-dashes-and-UPPER' }),
      beacon({ event: 'page_view', utm_source: 'x'.repeat(101) }),
      beacon('page_view'),
      beacon(''),
    ]);
    expect(refused.map((r) => r.statusCode)).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
    expect(refused.map((r) => r.json().error)).toEqual(Array(8).fill('invalid_request'));
    expect(
      info.mock.calls.filter((call) => (call[0] as { msg?: unknown })?.msg === SITE_EVENT_LOG_MSG),
    ).toHaveLength(0);
    info.mockRestore();
  });

  it('answers 404 for a page that does not exist or has no form, and refuses a body past 1 KB', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/public/site-forms/nao-existe/events',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { event: 'page_view' },
    });
    expect(missing.statusCode).toBe(404);
    const big = await beacon(JSON.stringify({ event: 'page_view', utm_source: 'x'.repeat(2000) }));
    expect(big.statusCode).toBe(413);
  });
});

describe('deviceOf', () => {
  it('tells the Instagram browser on an Android phone, Safari on an iPhone, a desktop browser and no agent', () => {
    expect(deviceOf(INSTAGRAM_ANDROID)).toEqual({ kind: 'phone', os: 'android', app: 'instagram' });
    expect(deviceOf(IPHONE_SAFARI)).toEqual({ kind: 'phone', os: 'ios', app: 'browser' });
    expect(deviceOf(DESKTOP_CHROME)).toEqual({ kind: 'desktop', os: 'other', app: 'browser' });
    expect(deviceOf(undefined)).toEqual({ kind: 'unknown', os: 'other', app: 'browser' });
    expect(
      deviceOf(
        'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ).kind,
    ).toBe('tablet');
    expect(
      deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) [FBAN/FBIOS;FBAV/450.0.0]')
        .app,
    ).toBe('facebook');
  });

  it('a UTM that looks like an e-mail or a phone is logged as null', () => {
    expect(loggedUtm('ig')).toBe('ig');
    expect(loggedUtm('video-2 | 01/10')).toBe('video-2 | 01/10');
    expect(loggedUtm('maria@exemplo.com')).toBeNull();
    expect(loggedUtm('11999990000')).toBeNull();
    expect(loggedUtm('5521999990000')).toBeNull();
    expect(loggedUtm('+55 (21) 99999-0000')).toBeNull();
    expect(loggedUtm('(21) 3333-4444')).toBeNull();
    expect(loggedUtm(undefined)).toBeNull();
    expect(
      siteEventLineOf('x', { event: 'page_view', utm_content: 'fulano@exemplo.com' }, undefined)
        .utm_content,
    ).toBeNull();
  });

  it('keeps the ad ids Meta sends as text, utm_term and utm_id included', () => {
    const line = siteEventLineOf(
      'fale-com-a-wings',
      {
        event: 'page_view',
        utm_source: 'ig',
        utm_medium: 'paid',
        utm_campaign: '120252596733630076',
        utm_content: '120252596746630076',
        utm_term: '120252596743640076',
        utm_id: '120252596733630076',
      },
      DESKTOP_CHROME,
    );
    expect(line).toMatchObject({
      utm_campaign: '120252596733630076',
      utm_content: '120252596746630076',
      utm_term: '120252596743640076',
      utm_id: '120252596733630076',
    });
    // Google's campaign id, 11 digits.
    expect(loggedUtm('24289782134')).toBe('24289782134');
  });

  it('the log line has the closed set of keys, nulls where the page sent nothing', () => {
    expect(siteEventLineOf('fale-com-a-wings', { event: 'form_view' }, DESKTOP_CHROME)).toEqual({
      msg: SITE_EVENT_LOG_MSG,
      slug: 'fale-com-a-wings',
      event: 'form_view',
      step: null,
      visit: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      utm_id: null,
      device: 'desktop',
      os: 'other',
      app: 'browser',
    });
  });
});
