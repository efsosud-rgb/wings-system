import { randomBytes } from 'node:crypto';
import { LEAD_FORM_THANK_YOU_DEFAULT, SESSION_COOKIE, type SiteFormInfo } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { adAccounts, auditLog, leadSourceRules, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { MetaLeadFormReadiness, SiteFormPage } from './lead-form-routes.js';
import { fakeMetaApi } from './platform/fake-meta-api.js';

/**
 * The reads around the standard form (is the Page ready, which policy do its
 * forms use, which site pages take the form) and the one write path outside
 * the ads gate: a change to a site page's form, proposed by Marketing and
 * live only after Diretoria's click — never the proposer's own.
 */

const ACCOUNT = 'act_694058302567457';
const PAGE = '104567890123456';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let noPage: FastifyInstance;

const meta = fakeMetaApi({
  accountId: ACCOUNT,
  existingLeadForms: [
    {
      id: '901',
      name: 'Formatação',
      privacy_policy_url: 'https://wingscompany.com.br/privacidade/',
    },
    {
      id: '902',
      name: 'Expansão X',
      privacy_policy_url: 'https://wingscompany.com.br/privacidade/',
    },
    { id: '903', name: 'Antigo', privacy_policy_url: 'https://old.example/p' },
  ],
});
const metaNoPage = fakeMetaApi({ accountId: ACCOUNT, noPageToken: true });

const baseEnv = () => ({
  NODE_ENV: 'test',
  DATABASE_URL: harness.url,
  SESSION_SECRET: randomBytes(48).toString('base64'),
  CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
  CPF_INDEX_KEY: TEST_INDEX_KEY,
  APP_BASE_URL: 'https://staging.wingssystem.online',
  META_WRITE_TOKEN: 'token',
  META_WRITE_ACCOUNT_ID: ACCOUNT,
  TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
});

/** Turnstile that accepts the token "good". */
const captchaFetch = (async () =>
  new Response(JSON.stringify({ success: true, 'error-codes': [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({ env: loadEnv(baseEnv()), db, platformFetch: meta.impl, captchaFetch });
  noPage = await buildApp({ env: loadEnv(baseEnv()), db, platformFetch: metaNoPage.impl });
  await db.insert(adAccounts).values({ platform: 'meta', externalId: ACCOUNT, name: 'Fly High' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await noPage?.close();
  await harness?.drop();
});

async function cookiesFor(role: 'admin_master' | 'diretoria' | 'marketing', on = app) {
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
  return { cookies: { [SESSION_COOKIE]: token }, id: employee.id };
}

const spec = (overrides: Record<string, unknown> = {}) => ({
  qualifier: { question: 'Quantas unidades você tem hoje?', options: ['1', '2 a 5', 'Mais de 5'] },
  privacyPolicyUrl: 'https://wingscompany.com.br/privacidade/',
  thankYou: { ...LEAD_FORM_THANK_YOU_DEFAULT, buttonUrl: 'https://wingscompany.com.br/' },
  ...overrides,
});

async function sitePage(slug = `pagina-${randomBytes(3).toString('hex')}`) {
  const [row] = await db
    .insert(leadSourceRules)
    .values({
      kind: 'landing_page',
      pattern: slug,
      brand: 'Marca Teste',
      pipeline: 'expansao',
      siteFormEnabled: true,
    })
    .returning({ id: leadSourceRules.id });
  return { id: row?.id as string, slug };
}

describe('GET /ads/meta/lead-forms', () => {
  it('says the Page can be acted for and offers the policy its forms share', async () => {
    const { cookies } = await cookiesFor('marketing');
    const response = await app.inject({ url: `/ads/meta/lead-forms?pageId=${PAGE}`, cookies });
    expect(response.statusCode).toBe(200);
    const body = response.json<MetaLeadFormReadiness>();
    expect(body.access).toEqual({ pageId: PAGE, canManage: true, reason: null });
    expect(body.forms.map((form) => form.id)).toEqual(['901', '902', '903']);
    expect(body.privacyPolicyUrl).toBe('https://wingscompany.com.br/privacidade/');
    // Reads only; the Page token travelled in a header and never came back.
    expect(meta.writes()).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('page-');
  });

  it('says when the token cannot act for the Page (staging today), with no forms listed', async () => {
    const { cookies } = await cookiesFor('marketing', noPage);
    const response = await noPage.inject({ url: `/ads/meta/lead-forms?pageId=${PAGE}`, cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json<MetaLeadFormReadiness>()).toEqual({
      access: { pageId: PAGE, canManage: false, reason: 'no_page_token' },
      forms: [],
      privacyPolicyUrl: null,
    });
  });

  it('refuses a page id that is not one', async () => {
    const { cookies } = await cookiesFor('marketing');
    const response = await app.inject({ url: '/ads/meta/lead-forms?pageId=abc', cookies });
    expect(response.statusCode).toBe(400);
  });
});

describe('a site page’s form', () => {
  it('is proposed by Marketing, waits, and goes live only on Diretoria’s click', async () => {
    const page = await sitePage();
    const marketing = await cookiesFor('marketing');
    const proposed = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/propose`,
      cookies: marketing.cookies,
      payload: spec(),
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json<{ page: SiteFormPage }>().page).toMatchObject({
      slug: page.slug,
      path: `/lp/${page.slug}`,
      form: null,
      pending: { form: { qualifier: { options: ['1', '2 a 5', 'Mais de 5'] } } },
    });

    // The public page still shows the plain form.
    const before = await app.inject({ url: `/public/site-forms/${page.slug}` });
    expect(before.json<SiteFormInfo>().form).toBeNull();

    const board = await cookiesFor('diretoria');
    const approved = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/approve`,
      cookies: board.cookies,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ page: SiteFormPage }>().page).toMatchObject({
      form: { qualifier: { question: 'Quantas unidades você tem hoje?' } },
      pending: null,
    });
    expect(approved.json<{ page: SiteFormPage }>().page.approvedAt).toBeTruthy();

    const after = await app.inject({ url: `/public/site-forms/${page.slug}` });
    expect(after.json<SiteFormInfo>().form).toMatchObject({
      qualifier: { options: ['1', '2 a 5', 'Mais de 5'] },
      thankYou: { title: LEAD_FORM_THANK_YOU_DEFAULT.title },
    });

    const trail = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, page.id));
    expect(trail.map((row) => row.action).sort()).toEqual([
      'site_form.change_approved',
      'site_form.change_proposed',
    ]);
  });

  it('is never approved by whoever proposed it, and Marketing cannot approve at all', async () => {
    const page = await sitePage();
    const admin = await cookiesFor('admin_master');
    const proposed = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/propose`,
      cookies: admin.cookies,
      payload: spec(),
    });
    expect(proposed.statusCode).toBe(200);
    expect(
      (await db.query.leadSourceRules.findFirst({ where: eq(leadSourceRules.id, page.id) }))
        ?.siteFormPendingBy,
    ).toBe(admin.id);
    const self = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/approve`,
      cookies: admin.cookies,
    });
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ error: 'self_approval' });

    const marketing = await cookiesFor('marketing');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/approve`,
      cookies: marketing.cookies,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (await app.inject({ url: `/public/site-forms/${page.slug}` })).json<SiteFormInfo>().form,
    ).toBeNull();
  });

  it('a refused proposal leaves the page as it was; nothing pending cannot be approved', async () => {
    const page = await sitePage();
    const marketing = await cookiesFor('marketing');
    await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/propose`,
      cookies: marketing.cookies,
      payload: spec(),
    });
    const board = await cookiesFor('diretoria');
    const rejected = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/reject`,
      cookies: board.cookies,
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<{ page: SiteFormPage }>().page.pending).toBeNull();
    const nothing = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/approve`,
      cookies: board.cookies,
    });
    expect(nothing.statusCode).toBe(409);
  });

  it('refuses a form the shared schema refuses, and a page that does not take the form', async () => {
    const marketing = await cookiesFor('marketing');
    const page = await sitePage();
    const bad = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${page.id}/propose`,
      cookies: marketing.cookies,
      payload: spec({ qualifier: { question: 'Quantas?', options: ['1'] } }),
    });
    expect(bad.statusCode).toBe(400);

    const [plain] = await db
      .insert(leadSourceRules)
      .values({
        kind: 'landing_page',
        pattern: `sem-form-${randomBytes(3).toString('hex')}`,
        brand: 'Z',
      })
      .returning({ id: leadSourceRules.id });
    const missing = await app.inject({
      method: 'POST',
      url: `/ads/lead-forms/site-pages/${plain?.id}/propose`,
      cookies: marketing.cookies,
      payload: spec(),
    });
    expect(missing.statusCode).toBe(404);

    const list = await app.inject({
      url: '/ads/lead-forms/site-pages',
      cookies: marketing.cookies,
    });
    const pages = list.json<{ pages: SiteFormPage[] }>().pages;
    expect(pages.some((item) => item.id === page.id)).toBe(true);
    expect(pages.some((item) => item.id === plain?.id)).toBe(false);
  });

  it('keeps the multiple-choice answer with the form answers, only when it is one of the options', async () => {
    const page = await sitePage();
    await db
      .update(leadSourceRules)
      .set({ siteFormSpec: spec(), siteFormApprovedAt: new Date() })
      .where(eq(leadSourceRules.id, page.id));
    // A different phone each time: the same person sent twice is one lead.
    const submit = (qualifierAnswer: string, phone: string) =>
      app.inject({
        method: 'POST',
        url: `/public/site-forms/${page.slug}`,
        payload: {
          name: 'Ana Exemplo',
          email: `ana-${randomBytes(3).toString('hex')}@exemplo.com.br`,
          phone,
          consent: true,
          turnstileToken: 'good',
          qualifierAnswer,
        },
      });
    const ok = await submit('2 a 5', '21999990001');
    expect(ok.statusCode).toBe(200);
    const stray = await submit('qualquer coisa', '21999990002');
    expect(stray.statusCode).toBe(200);

    const rows = await db
      .select({ formAnswers: leads.formAnswers })
      .from(leads)
      .where(eq(leads.landingPage, page.slug));
    expect(rows.map((row) => row.formAnswers)).toEqual(
      expect.arrayContaining([{ 'Quantas unidades você tem hoje?': '2 a 5' }, null]),
    );
  });
});
