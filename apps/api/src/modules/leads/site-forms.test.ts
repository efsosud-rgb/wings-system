import { SESSION_COOKIE, WINGS_CLIENT_ID, type SiteFormInfo } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  crmDistributionMembers,
  crmNotifications,
  jobs,
  leadEvents,
  leads,
  leadSourceRules,
  leadTasks,
  leadTrackingLinks,
  leadTriageQueue,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { FALE_COM_A_WINGS } from '../../db/seed.js';
import { answerPipelineOf, instagramHandleOf } from './site-forms.js';
import { configureLeadTriage, type TriageTarget } from './triage-schedule.js';

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
      instagram: null,
      // The plain form until Diretoria approves a standard one for the page.
      form: null,
      pipeline: 'expansao',
      // No tag until its id is set: the pixel is explicit, Google Ads is the conversion id.
      tracking: { metaPixelId: null, googleAdsConversion: null },
      // No Wings number in this environment: no link.
      whatsappUrl: null,
    });
    expect(JSON.stringify(info.json())).not.toContain('secret');
  });

  it('a Formatação page: five questions, no e-mail, the funnel and the tags the environment names', async () => {
    const turnstile = captcha();
    const app = await makeApp(
      {
        TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        SITE_FORM_META_PIXEL_ENABLED: 'true',
        SITE_FORM_GOOGLE_ADS_CONVERSION: 'AW-123456789/AbCdEfGhIj',
        // The forward would need an e-mail: with none it is skipped, never a fake call.
        SITE_FORM_RD_FORWARD_ENABLED: 'true',
        RD_MKT_CLIENT_ID: 'id',
        RD_MKT_CLIENT_SECRET: 'secret',
        RD_MKT_REFRESH_TOKEN: 'refresh',
      },
      { captchaFetch: turnstile.fetchImpl, rdFetch: rd().fetchImpl },
    );
    // A Formatação page is Wings Company's own (the seeded client), as Landing pages creates it.
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'formatacao',
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
      siteFormEnabled: true,
    });
    const info = await app.inject({ method: 'GET', url: '/public/site-forms/formatacao' });
    expect(info.json()).toMatchObject({
      brand: 'Wings Company',
      pipeline: 'formatacao',
      tracking: {
        metaPixelId: '1116678872845520',
        googleAdsConversion: 'AW-123456789/AbCdEfGhIj',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/formatacao',
      payload: form({
        email: undefined,
        phone: '(21) 99999-0077',
        companyName: 'Padaria Teste',
        instagram: '@padaria.teste',
        siteUrl: 'padaria-teste.com.br',
      }),
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521999990077'));
    expect(lead).toMatchObject({
      source: 'site_form',
      enteredAtSource: 'form_submitted',
      pipeline: 'formatacao',
      email: null,
      companyName: 'Padaria Teste',
      instagram: 'padaria.teste',
      website: 'https://padaria-teste.com.br/',
      consentText:
        'Autorizo a Wings Company a entrar em contato comigo sobre a formatação da minha empresa em franquia, por telefone e WhatsApp.',
    });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, lead!.id));
    expect(audit?.metadata).toMatchObject({ rdForward: 'no_email', pipeline: 'formatacao' });
  });

  it('refuses a Google Ads conversion id that is not AW-<id>/<label>', () => {
    expect(() => baseEnv(harness.url, { SITE_FORM_GOOGLE_ADS_CONVERSION: 'AW-1' })).toThrow();
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
    // No Wings number in this environment: no link.
    expect(response.json()).toEqual({ ok: true, whatsappUrl: null });
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

  it("answers the brand's tracked Site link on the Wings WhatsApp (T6), never the brand's own number", async () => {
    const turnstile = captcha();
    const app = await makeApp(
      { TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret', WINGS_WHATSAPP_NUMBER: '5521999470288' },
      { captchaFetch: turnstile.fetchImpl },
    );
    const send = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/public/site-forms/cenoritas',
        payload: form({ email: `whats.${n}@example.com`, phone: `(21) 99999-01${n}` }),
      });
    const [page] = await db.select().from(leadSourceRules).where(eq(leadSourceRules.id, pageId));
    const clientId = page!.clientId!;
    await db
      .update(clients)
      .set({ whatsapp: '21972055989', social: { instagram: '@cenoritas.gourmet' } })
      .where(eq(clients.id, clientId));
    const info = await app.inject({ method: 'GET', url: '/public/site-forms/cenoritas' });
    expect(info.json()).toMatchObject({ instagram: '@cenoritas.gourmet' });
    expect(info.body).not.toContain('21972055989');

    // No Site link yet: nothing is created by a public request.
    expect((await send(10)).json()).toEqual({ ok: true, whatsappUrl: null });
    expect(
      await db.select().from(leadTrackingLinks).where(eq(leadTrackingLinks.clientId, clientId)),
    ).toEqual([]);

    await db.insert(leadTrackingLinks).values([
      { clientId, channel: 'site', code: 'SITE22', phone: '5521999470288' },
      { clientId, channel: 'instagram', code: 'INSTA2', phone: '5521999470288' },
      // Made for a number that is no longer Wings': never handed out.
      {
        clientId,
        channel: 'site',
        code: 'OLD222',
        phone: '5521972055989',
        createdAt: new Date(Date.now() + 60_000),
      },
    ]);
    const answer = (await send(11)).json<{ ok: true; whatsappUrl: string }>();
    // The link's code, then the form's own ref (6 characters), then the brand's line.
    const url = new URL(answer.whatsappUrl);
    expect(url.origin + url.pathname).toBe('https://wa.me/5521999470288');
    expect(url.searchParams.get('text')).toMatch(
      /^SITE22 [A-HJ-NP-Z2-9]{6} Olá! Quero saber sobre a franquia Cenoritas\.$/,
    );
  });

  it("picks the answer's funnel: an option naming none keeps the page's, Expansão only with a brand", () => {
    const page = { pipeline: 'formatacao' as const, brand: null };
    const brand = { pipeline: 'formatacao' as const, brand: 'Cenoritas' };
    const bare = { pipeline: null, brand: null };
    const code = (pipeline?: 'expansao' | 'consultoria' | null) => ({
      value: 'x',
      option: 'X',
      ...(pipeline === undefined ? {} : { pipeline }),
    });
    expect(answerPipelineOf(null, page)).toBe('formatacao');
    expect(answerPipelineOf(code(), page)).toBe('formatacao');
    // "Ainda não sei" (pipeline: null, as the rules seeded before 26/10 still say) stays with the page.
    expect(answerPipelineOf(code(null), page)).toBe('formatacao');
    expect(answerPipelineOf(code(null), bare)).toBeNull();
    expect(answerPipelineOf(code('consultoria'), page)).toBe('consultoria');
    expect(answerPipelineOf(code('expansao'), page)).toBe('formatacao');
    expect(answerPipelineOf(code('expansao'), brand)).toBe('expansao');
  });

  it('reads the Instagram handle however the record keeps it', () => {
    expect(instagramHandleOf('@amarjonbiojoias')).toBe('@amarjonbiojoias');
    expect(instagramHandleOf('https://www.instagram.com/iguaripasseioshopping/?hl=pt')).toBe(
      '@iguaripasseioshopping',
    );
    expect(instagramHandleOf('cenoritas.gourmet')).toBe('@cenoritas.gourmet');
    expect(instagramHandleOf('<script>')).toBeNull();
    expect(instagramHandleOf(null)).toBeNull();
  });
});

describe('"Fale com a Wings" (the page the seed makes)', () => {
  const SLUG = 'fale-com-a-wings';
  const QUESTION = 'O que você procura?';
  const keys = { TURNSTILE_SITE_KEY: '0x4AAAAAAA-site', TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret' };
  /** Everything the page makes required, filled; each test changes one thing. */
  const fale = (overrides: Record<string, unknown> = {}) =>
    form({
      email: 'fale.teste@example.com',
      phone: '(21) 98888-0001',
      companyName: 'Empresa Exemplo',
      instagram: '@Empresa.Exemplo',
      qualifierAnswer: 'formatacao',
      page: 'https://fale.wingscompany.com.br/?utm_source=google',
      tracking: { utm_campaign: 'fale_out26' },
      ...overrides,
    });
  const post = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/public/site-forms/${SLUG}`, payload });
  const receivedEvent = async (leadId: string) =>
    (
      await db
        .select()
        .from(leadEvents)
        .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, 'lead.received.site_form')))
    )[0];

  it('shows the required fields and the option codes, never the funnel each one leads to', async () => {
    const app = await makeApp(keys);
    const info = await app.inject({ method: 'GET', url: `/public/site-forms/${SLUG}` });
    expect(info.statusCode).toBe(200);
    const body = info.json<SiteFormInfo>();
    expect(body).toMatchObject({
      slug: SLUG,
      brand: 'Wings Company',
      pipeline: 'formatacao',
      whatsappUrl: null,
      form: {
        qualifier: { question: QUESTION },
        requiredFields: ['qualifierAnswer'],
        privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
        thankYou: { buttonText: 'Chamar no WhatsApp' },
      },
    });
    expect(body.form?.qualifierValues).toEqual([
      { value: 'formatacao', option: 'Transformar meu negócio em franquia' },
      { value: 'expansao', option: 'Expandir minha rede de franquias' },
      { value: 'consultoria', option: 'Consultoria para o meu negócio' },
      { value: 'nao-sei', option: 'Ainda não sei' },
    ]);
  });

  it("answers Wings' own Site link on the current number before the form, too", async () => {
    const app = await makeApp({ ...keys, WINGS_WHATSAPP_NUMBER: '5521999470288' });
    await db.insert(leadTrackingLinks).values([
      { clientId: WINGS_CLIENT_ID, channel: 'site', code: 'FALE22', phone: '5521999470288' },
      { clientId: WINGS_CLIENT_ID, channel: 'instagram', code: 'FALE33', phone: '5521999470288' },
    ]);
    const info = await app.inject({ method: 'GET', url: `/public/site-forms/${SLUG}` });
    // Wings itself: a sentence a person would send, the code in brackets at the end.
    const url = new URL(info.json<SiteFormInfo>().whatsappUrl!);
    expect(url.origin + url.pathname).toBe('https://wa.me/5521999470288');
    expect(url.searchParams.get('text')).toBe(
      'Olá! Vim pelo site da Wings e quero saber como formatar a minha franquia. (FALE22)',
    );
  });

  it('refuses what the page requires and the form left out, before the captcha', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const cases: [Record<string, unknown>, string][] = [
      [{ qualifierAnswer: undefined }, `Escolha uma opção em "${QUESTION}".`],
      // Neither a code nor an option's text.
      [{ qualifierAnswer: 'nao_sei' }, `Escolha uma opção em "${QUESTION}".`],
      [{ qualifierAnswer: 'Ainda nao sei' }, `Escolha uma opção em "${QUESTION}".`],
    ];
    for (const [overrides, message] of cases) {
      const response = await post(app, fale(overrides));
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request', message });
    }
    expect(turnstile.calls).toHaveLength(0);
    expect(await db.select().from(leads).where(eq(leads.landingPage, SLUG))).toEqual([]);
  });

  it('the short page (22/10): name, WhatsApp and the answer alone make the lead', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(
      app,
      fale({
        email: undefined,
        companyName: undefined,
        instagram: undefined,
        phone: '(21) 98888-0007',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(turnstile.calls).toHaveLength(1);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521988880007'));
    expect(lead).toMatchObject({
      source: 'site_form',
      landingPage: SLUG,
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
      email: null,
      instagram: null,
      companyName: null,
      formAnswers: { [QUESTION]: 'Transformar meu negócio em franquia' },
      consentText: FALE_COM_A_WINGS.spec.consentText,
    });
    const event = await receivedEvent(lead!.id);
    expect(event?.detail).toMatchObject({ qualifier: 'formatacao', pipeline: 'formatacao' });
  });

  it('the diagnosis page (27/10): keeps the revenue band as its text, beside the answer', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(
      app,
      fale({ email: undefined, phone: '(21) 98888-0011', monthlyRevenue: '100k-300k' }),
    );
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521988880011'));
    expect(lead?.formAnswers).toEqual({
      [QUESTION]: 'Transformar meu negócio em franquia',
      'Faturamento mensal da empresa': 'De R$ 100 mil a R$ 300 mil',
    });
  });

  it('refuses a revenue band that is not one of the options, before the captcha', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(app, fale({ monthlyRevenue: 'Até R$ 50 mil' }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request',
      message: 'Escolha uma opção em "Faturamento mensal da empresa".',
    });
    expect(turnstile.calls).toHaveLength(0);
  });

  it('keeps the username, the option text and the code; Formatação for the page', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(
      app,
      fale({ instagram: 'https://www.instagram.com/Empresa.Exemplo/?hl=pt' }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, whatsappUrl: null });
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'fale.teste@example.com'));
    expect(lead).toMatchObject({
      source: 'site_form',
      landingPage: SLUG,
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
      instagram: 'empresa.exemplo',
      companyName: 'Empresa Exemplo',
      formAnswers: { [QUESTION]: 'Transformar meu negócio em franquia' },
      // The line the page itself shows, word for word; not the funnel's.
      consentText: FALE_COM_A_WINGS.spec.consentText,
      legalBasis: 'consent',
      consentSource: `site_form:${SLUG}`,
    });
    const event = await receivedEvent(lead!.id);
    expect(event?.detail).toMatchObject({ qualifier: 'formatacao', pipeline: 'formatacao' });
  });

  it("shows the page's own consent line, the one the lead keeps", async () => {
    const app = await makeApp(keys);
    const info = await app.inject({ method: 'GET', url: `/public/site-forms/${SLUG}` });
    expect(info.json<SiteFormInfo>().form?.consentText).toBe(
      'Li a Política de Privacidade e autorizo a Wings a falar comigo por WhatsApp e e-mail sobre este pedido.',
    );
  });

  it("the option's text names the same code (what the /lp page sends)", async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(
      app,
      fale({
        email: 'texto.opcao@example.com',
        phone: '(21) 98888-0010',
        qualifierAnswer: 'Consultoria para o meu negócio',
      }),
    );
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'texto.opcao@example.com'));
    expect(lead?.formAnswers).toEqual({ [QUESTION]: 'Consultoria para o meu negócio' });
    const event = await receivedEvent(lead!.id);
    expect(event?.detail).toMatchObject({ qualifier: 'consultoria', pipeline: 'formatacao' });
  });

  it('"Expandir minha rede" names no funnel of its own: the page\'s Formatação', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await post(
      app,
      fale({
        email: 'rede.teste@example.com',
        phone: '(21) 98888-0002',
        qualifierAnswer: 'expansao',
      }),
    );
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'rede.teste@example.com'));
    expect(lead).toMatchObject({
      pipeline: 'formatacao',
      formAnswers: { [QUESTION]: 'Expandir minha rede de franquias' },
    });
  });

  it('"Ainda não sei" from the Formatação page with the triage on (lead 775262e5, 23/10): Formatação by the rotation, never the Jev', async () => {
    // The rule as staging and production still hold it: "nao-sei" with pipeline: null (seeded before 26/10).
    await db
      .update(leadSourceRules)
      .set({
        siteFormSpec: {
          ...FALE_COM_A_WINGS.spec,
          qualifierValues: FALE_COM_A_WINGS.spec.qualifierValues.map((entry) =>
            entry.value === 'nao-sei' ? { ...entry, pipeline: null } : entry,
          ),
        },
      })
      .where(eq(leadSourceRules.pattern, SLUG));
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await db
      .insert(crmDistributionMembers)
      .values({ pipeline: 'formatacao', employeeId: seller.id, active: true });
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const scheduled: TriageTarget[] = [];
    configureLeadTriage((target) => scheduled.push(target));
    try {
      const response = await post(
        app,
        fale({
          email: 'nao.sei@example.com',
          phone: '(21) 98888-0003',
          qualifierAnswer: 'nao-sei',
          page: 'https://fale.wingscompany.com.br/?utm_source=ig&utm_medium=paid&utm_campaign=formatacao_video_metodo_out26',
          tracking: { utm_campaign: 'formatacao_video_metodo_out26', fbclid: 'fb.xyz' },
        }),
      );
      expect(response.statusCode).toBe(200);
    } finally {
      configureLeadTriage(null);
    }
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'nao.sei@example.com'));
    expect(lead).toMatchObject({
      pipeline: 'formatacao',
      ownerEmployeeId: seller.id,
      adPlatform: 'meta',
      formAnswers: { [QUESTION]: 'Ainda não sei' },
    });
    expect(lead?.stageId).not.toBeNull();
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, lead!.id) }),
    ).toMatchObject({ kind: 'first_contact', assigneeEmployeeId: seller.id });
    expect(
      (await db.select().from(crmNotifications).where(eq(crmNotifications.leadId, lead!.id))).map(
        (n) => [n.kind, n.recipientEmployeeId],
      ),
    ).toEqual([['new_lead', seller.id]]);
    const event = await receivedEvent(lead!.id);
    expect(event?.detail).toMatchObject({ qualifier: 'nao-sei', pipeline: 'formatacao' });
    // The Jev was never asked: no queue row, nothing scheduled.
    expect(scheduled).toEqual([]);
    expect(
      await db.query.leadTriageQueue.findFirst({ where: eq(leadTriageQueue.leadId, lead!.id) }),
    ).toBeUndefined();
  });

  it('a code naming Expansão sends the lead there only from a page tied to a brand', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const [cenoritas] = await db.select().from(clients).where(eq(clients.slug, 'cenoritas'));
    const expansionSpec = {
      qualifier: { question: QUESTION, options: ['Formatar', 'Expandir'] },
      qualifierValues: [
        { value: 'formatar', option: 'Formatar' },
        { value: 'expandir', option: 'Expandir', pipeline: 'expansao' },
      ],
      privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
      thankYou: {
        title: 'Obrigado',
        body: 'Falamos em breve.',
        buttonText: 'Site',
        buttonUrl: 'https://wingscompany.com.br/',
      },
    };
    await db.insert(leadSourceRules).values([
      {
        kind: 'landing_page',
        pattern: 'fale-teste-sem-marca',
        clientId: WINGS_CLIENT_ID,
        pipeline: 'formatacao',
        siteFormEnabled: true,
        siteFormSpec: expansionSpec,
      },
      {
        kind: 'landing_page',
        pattern: 'fale-teste-com-marca',
        clientId: cenoritas!.id,
        pipeline: 'formatacao',
        siteFormEnabled: true,
        siteFormSpec: expansionSpec,
      },
    ]);
    const send = (slug: string, phone: string) =>
      app.inject({
        method: 'POST',
        url: `/public/site-forms/${slug}`,
        payload: form({ email: undefined, phone, qualifierAnswer: 'expandir' }),
      });
    expect((await send('fale-teste-sem-marca', '(21) 98888-0012')).statusCode).toBe(200);
    expect((await send('fale-teste-com-marca', '(21) 98888-0013')).statusCode).toBe(200);
    const [noBrand] = await db.select().from(leads).where(eq(leads.phone, '5521988880012'));
    const [withBrand] = await db.select().from(leads).where(eq(leads.phone, '5521988880013'));
    // Wings Company names no franchise: Expansão would not know which one.
    expect(noBrand).toMatchObject({ pipeline: 'formatacao', clientId: WINGS_CLIENT_ID });
    expect(withBrand).toMatchObject({ pipeline: 'expansao', clientId: cenoritas!.id });
  });

  it('a code that names a funnel sends the lead there', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'fale-teste-funil',
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
      siteFormEnabled: true,
      siteFormSpec: {
        qualifier: { question: QUESTION, options: ['Formatar', 'Consultoria'] },
        qualifierValues: [
          { value: 'formatar', option: 'Formatar' },
          { value: 'consultoria', option: 'Consultoria', pipeline: 'consultoria' },
        ],
        privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
        thankYou: {
          title: 'Obrigado',
          body: 'Falamos em breve.',
          buttonText: 'Site',
          buttonUrl: 'https://wingscompany.com.br/',
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/fale-teste-funil',
      // Nothing required on this page: no e-mail is fine.
      payload: form({
        email: undefined,
        phone: '(21) 98888-0004',
        qualifierAnswer: 'consultoria',
      }),
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5521988880004'));
    expect(lead).toMatchObject({
      pipeline: 'consultoria',
      formAnswers: { [QUESTION]: 'Consultoria' },
    });
  });

  it('the honeypot and the captcha work as on every page', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    // A robot gets the success answer even with the required fields missing; nothing kept.
    const honeypot = await post(app, fale({ email: undefined, website: 'http://spam.example' }));
    expect(honeypot.statusCode).toBe(200);
    expect(honeypot.json()).toEqual({ ok: true, whatsappUrl: null });
    expect(turnstile.calls).toHaveLength(0);
    const refused = await post(
      app,
      fale({ email: 'robo.teste@example.com', phone: '(21) 98888-0005', turnstileToken: 'bad' }),
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('captcha_refused');
    expect(turnstile.calls).toHaveLength(1);
    expect(await db.select().from(leads).where(eq(leads.email, 'robo.teste@example.com'))).toEqual(
      [],
    );
  });

  it('a page that does not require the Instagram keeps it as before', async () => {
    const turnstile = captcha();
    const app = await makeApp(keys, { captchaFetch: turnstile.fetchImpl });
    const response = await app.inject({
      method: 'POST',
      url: '/public/site-forms/cenoritas',
      payload: form({
        email: 'insta.livre@example.com',
        phone: '(21) 98888-0006',
        instagram: 'não tenho',
      }),
    });
    expect(response.statusCode).toBe(200);
    const [lead] = await db.select().from(leads).where(eq(leads.email, 'insta.livre@example.com'));
    expect(lead?.instagram).toBe('não tenho');
  });
});
