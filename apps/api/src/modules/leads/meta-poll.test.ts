import { SESSION_COOKIE } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmNotifications,
  leadEvents,
  leads,
  metaLeadForms,
  metaLeadgenEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { createBrand } from './deal.js';
import { pollMetaLeadsLocked, testMetaConnection, type PollDeps } from './meta-poll.js';

/**
 * The periodic read of Lead Ads with only the access key. Everything here is
 * invented sample data in the shape the Graph API documents; nothing reaches
 * Meta or a real lead. The shape of `/me/accounts` and `/{page}/leadgen_forms`
 * for a system-user key is not yet verified live.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const calls: { path: string; filtering: string | null; auth: string | null }[] = [];
const accountsStatus = 200 as number;
let formsStatus = 200;

const FORMS = [
  { id: 'form-fmt', name: 'Formatação Wings - cadastro', status: 'ACTIVE' },
  { id: 'form-marca', name: 'Marca Exemplo Franquia 2026', status: 'ACTIVE' },
  { id: 'form-x', name: 'Formulário qualquer', status: 'ACTIVE' },
];
const LEADS: Record<string, string[]> = {
  'form-fmt': ['lead-1'],
  'form-marca': ['lead-2'],
  'form-x': ['lead-3', 'lead-4'],
};
const DETAILS: Record<string, { platform: string; phone: string; campaign: string }> = {
  'lead-1': { platform: 'fb', phone: '+5511933330001', campaign: 'camp-a' },
  'lead-2': { platform: 'ig', phone: '+5511933330002', campaign: 'camp-b' },
  'lead-3': { platform: 'fb', phone: '+5511933330003', campaign: 'camp-c' },
  'lead-4': { platform: 'ig', phone: '+5511933330004', campaign: 'camp-c' },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeGraph = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
  calls.push({ path: url.pathname, filtering: url.searchParams.get('filtering'), auth });
  // The key travels in a header, never in the address.
  expect(url.searchParams.has('access_token')).toBe(false);
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  if (parts.join('/') === 'me/accounts')
    return accountsStatus === 200
      ? json({ data: [{ id: 'page-1', name: 'Página Exemplo', access_token: 'page-token' }] })
      : json({ error: { message: 'x' } }, accountsStatus);
  if (parts[0] === 'page-1' && parts[1] === 'leadgen_forms')
    return formsStatus === 200 ? json({ data: FORMS }) : json({ error: {} }, formsStatus);
  if (parts[1] === 'leads')
    return json({
      data: (LEADS[parts[0]!] ?? []).map((id) => ({
        id,
        created_time: new Date().toISOString(),
        ad_id: `ad-${id}`,
        adset_id: `adset-${id}`,
        campaign_id: DETAILS[id]?.campaign,
      })),
    });
  const detail = DETAILS[parts[0]!];
  if (detail)
    return json({
      id: parts[0],
      created_time: new Date().toISOString(),
      field_data: [
        { name: 'full_name', values: ['Fulano de Teste'] },
        { name: 'email', values: [`${parts[0]}@example.test`] },
        { name: 'phone_number', values: [detail.phone] },
        { name: 'city', values: ['Campinas'] },
        { name: 'quanto_pretende_investir', values: ['Até 100 mil'] },
      ],
      campaign_id: detail.campaign,
      campaign_name: `Campanha ${detail.campaign}`,
      adset_id: `adset-${parts[0]}`,
      ad_id: `ad-${parts[0]}`,
      form_id: Object.entries(LEADS).find(([, ids]) => ids.includes(parts[0]!))?.[0],
      platform: detail.platform,
    });
  return json({ error: {} }, 404);
}) as typeof fetch;

const deps = (): PollDeps => ({
  db,
  accessToken: 'system-key',
  rdCrmToken: null,
  expansionOwnerId: null,
  rdCopyEnabled: false,
  graphFetch: fakeGraph,
  log: () => undefined,
});

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
      META_LEADS_ACCESS_TOKEN: 'system-key',
    }),
    db,
    platformFetch: fakeGraph,
  });
  await createBrand(db, { name: 'Marca Exemplo' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('Lead Ads read with only the key', () => {
  it('finds the pages and forms, brings the leads into the right funnels and flags the guess', async () => {
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const result = await pollMetaLeadsLocked(deps());
    if (result === 'locked') throw new Error('lock held');
    expect(result).toMatchObject({ pages: 1, forms: 3, listed: 4, queued: 4 });
    expect(Object.keys(result.failed)).toEqual([]);
    expect(result.processed?.done).toBe(4);

    const rows = await db.select().from(leads).where(eq(leads.source, 'meta_lead_ads'));
    const byExternal = new Map(rows.map((r) => [r.externalId, r]));
    expect(byExternal.get('lead-1')).toMatchObject({ pipeline: 'formatacao' });
    expect(byExternal.get('lead-2')).toMatchObject({
      pipeline: 'expansao',
      brand: 'Marca Exemplo',
    });
    expect(byExternal.get('lead-3')).toMatchObject({ pipeline: 'formatacao' });

    // Origin: platform, campaign, ad set, ad, and every answer of the form.
    const two = byExternal.get('lead-2')!;
    expect(two).toMatchObject({
      utmSource: 'meta:ig',
      adPlatform: 'meta',
      adCampaignExternalId: 'camp-b',
      adSetExternalId: 'adset-lead-2',
      adExternalId: 'ad-lead-2',
      formId: 'form-marca',
    });
    expect(two.formAnswers).toMatchObject({ quanto_pretende_investir: 'Até 100 mil' });
    expect(byExternal.get('lead-1')?.utmSource).toBe('meta:fb');

    // The form that told nothing is a guess: one event per new lead, one notice per form.
    const guessed = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.kind, 'lead.pipeline_guessed'));
    expect(guessed).toHaveLength(2);
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(
        and(
          eq(crmNotifications.recipientEmployeeId, board.id),
          eq(crmNotifications.kind, 'automation'),
        ),
      );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).not.toMatch(/Fulano|example|5511/);
  });

  it('never makes a lead twice, and later passes ask only for what is newer', async () => {
    const forms = calls.filter((c) => c.path.endsWith('/leads'));
    const firstAsk = Number(JSON.parse(forms[0]!.filtering!)[0].value);
    // 90 days back, give or take the minutes the test took.
    expect(Date.now() / 1000 - firstAsk).toBeGreaterThan(89 * 86400);
    calls.length = 0;

    const again = await pollMetaLeadsLocked(deps());
    if (again === 'locked') throw new Error('lock held');
    expect(again.queued).toBe(0);
    expect(again.alreadyKnown).toBe(4);
    expect(await db.select().from(leads).where(eq(leads.source, 'meta_lead_ads'))).toHaveLength(4);
    expect(await db.select().from(metaLeadgenEvents)).toHaveLength(4);

    const secondAsk = Number(
      JSON.parse(calls.find((c) => c.path.endsWith('/leads'))!.filtering!)[0].value,
    );
    expect(secondAsk).toBeGreaterThan(firstAsk + 80 * 86400);
    // A page's own key reads that page's forms; the system key reads the page list.
    expect(calls.find((c) => c.path.endsWith('/me/accounts'))?.auth).toBe('Bearer system-key');
    expect(calls.find((c) => c.path.endsWith('/leadgen_forms'))?.auth).toBe('Bearer page-token');
    const stored = await db.select().from(metaLeadForms);
    expect(stored.map((f) => f.name).sort()).toEqual(FORMS.map((f) => f.name).sort());
  });

  it('keeps going when one page or form fails and says which, by code only', async () => {
    formsStatus = 403;
    const result = await pollMetaLeadsLocked(deps());
    formsStatus = 200;
    if (result === 'locked') throw new Error('lock held');
    expect(result.failed).toEqual({ 'page:page-1': 'graph_403' });
    expect(result.forms).toBe(0);
  });

  it('tests the connection with totals only', async () => {
    const test = await testMetaConnection(deps());
    expect(test).toMatchObject({ pages: 1, forms: 3, leads: 4, truncated: false, failed: {} });
    expect(JSON.stringify(test)).not.toMatch(/Fulano|example\.test|5511|Formatação/);
  });

  it('serves the card: test and "Buscar agora" for who manages integrations, status for the rest', async () => {
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: admin.email, password: admin.password },
    });
    const cookies = {
      [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
    };
    const tested = await app.inject({ method: 'POST', url: '/crm/meta-leads/test', cookies });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ pages: 1, forms: 3, leads: 4 });
    const polled = await app.inject({ method: 'POST', url: '/crm/meta-leads/poll', cookies });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({ queued: 0, alreadyKnown: 4 });
    const status = await app.inject({ method: 'GET', url: '/crm/meta-leads/status', cookies });
    expect(status.json()).toMatchObject({
      polling: { enabled: true, everyMinutes: 5, forms: 3 },
    });

    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const sellerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: seller.email, password: seller.password },
    });
    const sellerCookies = {
      [SESSION_COOKIE]: sellerLogin.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/crm/meta-leads/poll',
      cookies: sellerCookies,
    });
    expect(denied.statusCode).toBe(403);
  });
});
