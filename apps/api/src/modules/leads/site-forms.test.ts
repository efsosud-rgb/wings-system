import { SESSION_COOKIE } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, clients, jobs, leads, leadSourceRules } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
const apps: FastifyInstance[] = [];
let pageId: string;

const baseEnv = (harnessUrl: string, extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harnessUrl,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ...extra,
  });

/** Turnstile simulated: a token "good" passes, anything else is refused; every call is kept. */
function captcha() {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push(params);
    const success = params.get('response') === 'good';
    return new Response(
      JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** RD simulated: token, then the conversion; every request is kept (url and body). */
function rd() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (href.endsWith('/auth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (href.includes('/deal_sources')) {
      return new Response(
        JSON.stringify({
          deal_sources: [
            { _id: 's1', name: 'Site próprio' },
            { _id: 's2', name: 'Anúncio' },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ event_uuid: 'e1' }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function makeApp(
  extra: Record<string, string>,
  deps: Partial<Parameters<typeof buildApp>[0]> = {},
) {
  const app = await buildApp({ env: baseEnv(harness.url, extra), db, ...deps });
  apps.push(app);
  return app;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const [client] = await db
    .insert(clients)
    .values({ name: 'Cenoritas', slug: 'cenoritas', number: 20 })
    .returning();
  const [rule] = await db
    .insert(leadSourceRules)
    .values({
      kind: 'landing_page',
      pattern: 'cenoritas',
      clientId: client!.id,
      pipeline: 'expansao',
    })
    .returning();
  pageId = rule!.id;
}, 60_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await harness?.drop();
});

async function adminCookies(app: FastifyInstance) {
  const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

const form = (overrides: Record<string, unknown> = {}) => ({
  name: 'Pessoa Teste',
  email: 'pessoa.teste@example.com',
  phone: '(21) 99999-0001',
  consent: true,
  turnstileToken: 'good',
  website: '',
  page: 'https://staging.wingssystem.online/lp/cenoritas?utm_source=facebook&utm_medium=cpc',
  tracking: {
    utm_campaign: 'expansao_cenoritas_out26',
    utm_content: 'video-1',
    fbclid: 'fb.abc',
    campaign_id: '120200000000000001',
    adset_id: '120200000000000002',
    ad_id: '120200000000000003',
    referrer: 'https://www.instagram.com/',
  },
  ...overrides,
});

describe('site form (T5)', () => {
  it('is 404 until Landing pages turns the form on; then shows the brand and the public site key', async () => {
    const turnstile = captcha();
    const app = await makeApp(
      { TURNSTILE_SITE_KEY: '0x4AAAAAAA-site', TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret' },
      { captchaFetch: turnstile.fetchImpl },
    );
    expect(
      (await app.inject({ method: 'GET', url: '/public/site-forms/cenoritas' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/public/site-forms/cenoritas', payload: form() }))
        .statusCode,
    ).toBe(404);

    const admin = await adminCookies(app);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/crm/landing-pages/${pageId}`,
      cookies: admin,
      payload: { siteFormEnabled: true, dealSource: 'Site próprio' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().page).toMatchObject({
      siteFormEnabled: true,
      dealSource: 'Site próprio',
    });

    const info = await app.inject({ method: 'GET', url: '/public/site-forms/cenoritas' });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({
      slug: 'cenoritas',
      brand: 'Cenoritas',
      turnstileSiteKey: '0x4AAAAAAA-site',
    });
    expect(JSON.stringify(info.json())).not.toContain('secret');
  });

  it('answers 503 (never a fake success) while the Turnstile secret is not configured', async () => {
    const app = await makeApp({});
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('site_form_not_configured');
  });

  it('keeps nothing from a robot: honeypot filled, or Turnstile refused', async () => {
    const turnstile = captcha();
    const app = await makeApp(
      { TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret' },
      { captchaFetch: turnstile.fetchImpl },
    );
    const before = (await db.select().from(leads)).length;

    const honeypot = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ website: 'http://spam.example' }),
    });
    expect(honeypot.statusCode).toBe(200);
    expect(turnstile.calls).toHaveLength(0);

    const refused = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ turnstileToken: 'bad' }),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('captcha_refused');
    expect(turnstile.calls).toHaveLength(1);
    expect(turnstile.calls[0]?.get('secret')).toBe('0x4AAAAAAA-secret');

    expect((await db.select().from(leads)).length).toBe(before);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, pageId));
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['site_form.honeypot', 'site_form.captcha_refused']),
    );
    expect(JSON.stringify(audits.map((row) => row.metadata))).not.toContain('pessoa.teste');
  });

  it('files the lead in Expansão with the T4 attribution; nothing goes to RD while the forward is off', async () => {
    const turnstile = captcha();
    const rdApi = rd();
    const app = await makeApp(
      {
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        RD_MKT_CLIENT_ID: 'id',
        RD_MKT_CLIENT_SECRET: 'secret',
        RD_MKT_REFRESH_TOKEN: 'refresh',
      },
      { captchaFetch: turnstile.fetchImpl, rdFetch: rdApi.fetchImpl },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(rdApi.calls).toHaveLength(0);

    const [lead] = await db.select().from(leads).where(eq(leads.email, 'pessoa.teste@example.com'));
    expect(lead).toMatchObject({
      source: 'site_form',
      channel: 'landing_page',
      pipeline: 'expansao',
      clientMapped: true,
      landingPage: 'cenoritas',
      phone: '5521999990001',
      legalBasis: 'consent',
      consentSource: 'site_form:cenoritas',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'expansao_cenoritas_out26',
      utmContent: 'video-1',
      fbclid: 'fb.abc',
      adPlatform: 'meta',
      adCampaignExternalId: '120200000000000001',
      adSetExternalId: '120200000000000002',
      adExternalId: '120200000000000003',
      referrer: 'https://www.instagram.com/',
    });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, lead!.id));
    expect(audit?.metadata).toMatchObject({ source: 'site_form', rdForward: 'off' });
    // No paid research while SITE_FORM_RESEARCH_ENABLED is off (Eric, 01/10).
    expect(lead?.enrichmentState).toBe('none');
    expect(
      (await db.select().from(jobs).where(eq(jobs.type, 'enrich_lead'))).filter(
        (job) => (job.input as { leadId?: string }).leadId === lead!.id,
      ),
    ).toHaveLength(0);

    // The same person again is the same lead, and first touch is never overwritten.
    const again = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ tracking: { utm_campaign: 'outra' }, page: undefined }),
    });
    expect(again.statusCode).toBe(200);
    const same = await db.select().from(leads).where(eq(leads.email, 'pessoa.teste@example.com'));
    expect(same).toHaveLength(1);
    expect(same[0]?.utmCampaign).toBe('expansao_cenoritas_out26');
  });

  it('refuses a body without consent or with a phone without DDD, keeping nothing', async () => {
    const turnstile = captcha();
    const app = await makeApp(
      { TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret' },
      { captchaFetch: turnstile.fetchImpl },
    );
    const noConsent = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ consent: false, email: 'sem.consentimento@example.com' }),
    });
    expect(noConsent.statusCode).toBe(400);
    const shortPhone = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ phone: '9999', email: 'telefone.curto@example.com' }),
    });
    expect(shortPhone.statusCode).toBe(400);
    expect(turnstile.calls).toHaveLength(0);
  });

  it('with the forward on, sends one conversion to RD Marketing (identifier = slug, UTMs in traffic_*)', async () => {
    const turnstile = captcha();
    const rdApi = rd();
    const app = await makeApp(
      {
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        SITE_FORM_RD_FORWARD_ENABLED: 'true',
        RD_MKT_CLIENT_ID: 'id',
        RD_MKT_CLIENT_SECRET: 'secret',
        RD_MKT_REFRESH_TOKEN: 'refresh',
      },
      { captchaFetch: turnstile.fetchImpl, rdFetch: rdApi.fetchImpl },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ email: 'reenvio@example.com', phone: '21988887777' }),
    });
    expect(response.statusCode).toBe(200);
    const events = rdApi.calls.filter((call) => call.url.includes('/platform/events'));
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toMatchObject({
      event_type: 'CONVERSION',
      payload: {
        conversion_identifier: 'cenoritas',
        email: 'reenvio@example.com',
        mobile_phone: '+5521988887777',
        traffic_source: 'facebook',
        traffic_medium: 'cpc',
        traffic_campaign: 'expansao_cenoritas_out26',
      },
    });
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'reenvio@example.com'));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, lead!.id));
    expect(audit?.metadata).toMatchObject({ rdForward: 'sent' });
  });

  it('lists the RD CRM deal sources for the page\'s "Origem" (read only)', async () => {
    const rdApi = rd();
    const app = await makeApp({ RD_CRM_API_TOKEN: 'crm-token' }, { rdFetch: rdApi.fetchImpl });
    const admin = await adminCookies(app);
    const response = await app.inject({
      method: 'GET',
      url: '/crm/landing-pages/deal-sources',
      cookies: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sources).toEqual(['Anúncio', 'Site próprio']);
    expect(rdApi.calls.every((call) => call.body === null)).toBe(true);
  });

  it('queues the paid research only when SITE_FORM_RESEARCH_ENABLED is "true"', async () => {
    const turnstile = captcha();
    const app = await makeApp(
      { TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret', SITE_FORM_RESEARCH_ENABLED: 'true' },
      { captchaFetch: turnstile.fetchImpl },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({ email: 'pesquisa.ligada@example.com', phone: '(21) 99999-0042' }),
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.email, 'pesquisa.ligada@example.com'));
    expect(lead?.enrichmentState).toBe('pending');
  });
});
