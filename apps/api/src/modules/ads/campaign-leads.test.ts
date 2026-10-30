import { SESSION_COOKIE, type CampaignLeadsResponse, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAds,
  adCampaignDrafts,
  adCampaigns,
  adSets,
  auditLog,
  campaignLeads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { attribute, syncCampaignLeads, utmsOfTrafficSource } from './campaign-leads-sync.js';
import { ensureAdAccount } from './metrics.js';

/**
 * Leads das Campanhas: attribution from the conversion's UTMs or RD's
 * source, test deals kept out, a salesperson limited to their own leads, and
 * a reveal that is audited and never leaves the scope.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const NOW = new Date('2026-09-28T20:00:00.000Z');
const PHONE = '+55 (21) 99876-5432';
const emails: Record<string, string> = {};

const traffic = (url: string) =>
  `encoded_${Buffer.from(
    JSON.stringify({
      first_session: { value: url, extra_params: {} },
      current_session: { value: url, extra_params: {} },
    }),
  ).toString('base64')}`;

function fakeRd(deals: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/api/v1/deal_pipelines') {
      return json([
        {
          name: 'Formatação',
          deal_stages: [
            { id: 's1', name: 'Sem contato' },
            { id: 's2', name: 'Tentando contato' },
            { id: 's3', name: 'Identificação de interesse' },
          ],
        },
        { name: 'Expansão', deal_stages: [{ id: 'e1', name: 'Novo Contato' }] },
        { name: 'Negócios perdidos - Formatação', deal_stages: [{ id: 'p1', name: 'Arquivo' }] },
      ]);
    }
    if (url.pathname === '/api/v1/deals') return json({ deals, has_more: false });
    if (url.pathname === '/api/v1/activities') {
      return json({
        activities:
          url.searchParams.get('deal_id') === 'd2'
            ? [{ created_at: '2026-09-28T15:03:00.000-03:00' }]
            : [],
      });
    }
    if (url.pathname === '/api/v1/tasks') return json({ tasks: [] });
    if (url.pathname === '/auth/token') return json({ access_token: 'mkt-token' });
    if (url.pathname.startsWith('/platform/contacts/email:')) {
      const email = decodeURIComponent(url.pathname.split('email:')[1] ?? '');
      return email === 'lead.um@exemplo.com' ? json({ uuid: 'u1' }) : json({}, 404);
    }
    if (url.pathname === '/platform/contacts/u1/events') {
      return json([
        {
          event_timestamp: '2026-09-28T13:59:00.000-03:00',
          payload: {
            traffic_source: traffic(
              'https://wingscompany.com.br/formatacao?utm_source=facebook&utm_medium=paid_social&utm_campaign=formatacao_jimmyogro_set26&utm_content=ad-1',
            ),
          },
        },
      ]);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function sessionFor(role: RoleKey, key?: string) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : role === 'diretoria' ? 'diretoria' : 'comercial',
  });
  if (key) emails[key] = employee.email;
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let gerente: Awaited<ReturnType<typeof sessionFor>>;
let sellerA: Awaited<ReturnType<typeof sessionFor>>;
let sellerB: Awaited<ReturnType<typeof sessionFor>>;
let rdCalls: string[] = [];

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
    }),
    db,
    now: () => NOW,
  });

  gerente = await sessionFor('gerente_comercial');
  sellerA = await sessionFor('vendedor_formatacao', 'a');
  sellerB = await sessionFor('vendedor_formatacao', 'b');

  // Two campaigns delivering: Meta (with the draft's UTM and one ad) and Google.
  const meta = await ensureAdAccount(db, { platform: 'meta', externalId: 'act_1', name: 'Meta' });
  const google = await ensureAdAccount(db, {
    platform: 'google',
    externalId: '123',
    name: 'Google',
  });
  const [metaCampaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: meta,
      externalId: 'c-meta',
      name: 'META | Formatação | 28Set',
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
    })
    .returning();
  await db.insert(adCampaigns).values({
    adAccountId: google,
    externalId: 'c-google',
    name: 'SEARCH | Formatação',
    status: 'ACTIVE',
    deliveryStatus: 'SERVING',
  });
  await db.insert(adCampaigns).values({
    adAccountId: meta,
    externalId: 'c-old',
    name: 'Meta antiga',
    status: 'PAUSED',
    deliveryStatus: 'CAMPAIGN_PAUSED',
  });
  await db.insert(adCampaignDrafts).values({
    adAccountId: meta,
    name: 'rascunho',
    objective: 'OUTCOME_LEADS',
    dailyBudgetCents: 24_000,
    startDate: '2026-09-28',
    endDate: '2026-10-02',
    payload: { utms: { utm_campaign: 'formatacao_jimmyogro_set26' } },
    campaignId: metaCampaign!.id,
  });
  const [jimmySet] = await db
    .insert(adSets)
    .values({
      campaignId: metaCampaign!.id,
      externalId: 'as-1',
      name: 'Conjunto Jimmy',
      status: 'ACTIVE',
    })
    .returning();
  await db.insert(adAds).values({
    adAccountId: meta,
    campaignId: metaCampaign!.id,
    adSetId: jimmySet!.id,
    externalId: 'ad-1',
    name: 'Vídeo Jimmy',
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
  });

  const deal = (fields: Record<string, unknown>) => ({
    win: null,
    rating: 1,
    amount_total: 0,
    deal_stage: { id: 's1' },
    contacts: [],
    ...fields,
  });
  const { fetchImpl, calls } = fakeRd([
    deal({
      id: 'd1',
      name: 'Lead Um',
      created_at: '2026-09-28T14:00:00.000-03:00',
      deal_source: { name: 'Busca Paga | Facebook' },
      campaign: { name: 'Meta - Formatação' },
      rating: 5,
      user: { id: 'rd-a', name: 'Vendedora A', email: emails.a },
      contacts: [
        { name: 'Lead Um', emails: [{ email: 'Lead.Um@exemplo.com' }], phones: [{ phone: PHONE }] },
      ],
      organization: { name: 'Padaria Um', organization_segments: [{ name: 'Alimentação' }] },
    }),
    deal({
      id: 'd2',
      name: 'Lead Dois',
      created_at: '2026-09-28T15:00:00.000-03:00',
      deal_stage: { id: 's2' },
      deal_source: { name: 'Busca Paga | Google' },
      user: { id: 'rd-b', name: 'Vendedor B', email: emails.b },
      contacts: [{ name: 'Lead Dois', phones: [{ phone: '21 3333-4444' }] }],
    }),
    deal({
      id: 'd3',
      name: 'Diagnóstico',
      created_at: '2026-09-28T10:40:00.000-03:00',
      win: false,
      deal_source: { name: 'Busca Paga | Facebook' },
      deal_lost_reason: { name: 'Teste (diagnóstico Wings System)' },
      contacts: [{ name: 'Teste' }],
    }),
    deal({
      id: 'd4',
      name: 'Orgânico',
      created_at: '2026-09-28T16:00:00.000-03:00',
      deal_source: { name: 'Site' },
      contacts: [{ name: 'Orgânico' }],
    }),
    deal({
      id: 'd5',
      name: 'Expansão',
      created_at: '2026-09-28T16:00:00.000-03:00',
      deal_stage: { id: 'e1' },
      deal_source: { name: 'Busca Paga | Facebook' },
    }),
    deal({
      id: 'd6',
      name: 'Antes',
      created_at: '2026-09-27T23:59:00.000-03:00',
      deal_source: { name: 'Busca Paga | Facebook' },
    }),
  ]);
  const result = await syncCampaignLeads(db, {
    rdCrmToken: 'crm-token',
    rdMarketing: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
    box: createSecretBox(TEST_CPF_KEY),
    fetchImpl,
    now: NOW,
  });
  rdCalls = calls;
  expect(result).toMatchObject({ deals: 4, tests: 1, attributed: 2, unattributed: 1 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

const list = async (cookies: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/campaign-leads', cookies });

describe('reading RD Marketing', () => {
  it('decodes the UTMs of a conversion', () => {
    expect(
      utmsOfTrafficSource(
        traffic('https://x.com/?utm_source=google&utm_campaign=abc&utm_content=lead'),
      ),
    ).toEqual({ source: 'google', medium: null, campaign: 'abc', content: 'lead' });
    expect(
      utmsOfTrafficSource(
        traffic('utm_source=facebook&utm_medium=cpc&utm_campaign=formatacao_set26'),
      ),
    ).toEqual({ source: 'facebook', medium: 'cpc', campaign: 'formatacao_set26', content: null });
    expect(utmsOfTrafficSource(traffic('?utm_source=instagram&utm_content=video-2'))).toEqual({
      source: 'instagram',
      medium: null,
      campaign: null,
      content: 'video-2',
    });
    expect(utmsOfTrafficSource(traffic('(direct)'))).toBeNull();
    expect(utmsOfTrafficSource('encoded_não-é-base64')).toBeNull();
    expect(utmsOfTrafficSource(traffic('https://x.com/'))).toBeNull();
  });

  it("reads the platforms' standard: Meta's short source names and the numeric ids", () => {
    // What Meta fills in META_URL_TAGS, as RD keeps it (a query without URL).
    const meta = utmsOfTrafficSource(
      traffic(
        'utm_source=ig&utm_medium=cpc&utm_campaign=120230596004630670&utm_content=120230596004640670&utm_term=120230596004620670',
      ),
    );
    expect(meta).toEqual({
      source: 'instagram',
      medium: 'cpc',
      campaign: '120230596004630670',
      content: '120230596004640670',
    });
    expect(
      ['fb', 'msg', 'an'].map(
        (source) => utmsOfTrafficSource(traffic(`utm_source=${source}&utm_campaign=1`))?.source,
      ),
    ).toEqual(['facebook', 'messenger', 'audience_network']);

    // The ids are the platforms' own, so they meet the mirrored campaign and ad.
    const active = [
      {
        id: 'c-meta',
        platform: 'meta' as const,
        keys: ['120230596004630670', 'meta | formatacao'],
        ads: [{ id: 'a-meta', keys: ['120230596004640670', 'meta | formatacao — v1'] }],
      },
      {
        id: 'c-google',
        platform: 'google' as const,
        keys: ['23479672774', 'search | formatacao'],
        ads: [{ id: 'a-google', keys: ['771234567890', 'anuncio'] }],
      },
    ];
    expect(attribute({ utms: meta, sourceLabel: null, campaignLabel: null }, active)).toEqual({
      platform: 'meta',
      campaignId: 'c-meta',
      adId: 'a-meta',
      attribution: 'utm',
      reason: null,
    });
    // Google's account suffix: {campaignid} and {creative} (the ad's id).
    const google = utmsOfTrafficSource(
      traffic(
        'https://x.com/?utm_source=google&utm_medium=cpc&utm_campaign=23479672774&utm_content=771234567890&utm_term=franquia',
      ),
    );
    expect(
      attribute({ utms: google, sourceLabel: null, campaignLabel: null }, active),
    ).toMatchObject({
      platform: 'google',
      campaignId: 'c-google',
      adId: 'a-google',
      attribution: 'utm',
    });
  });

  it('asks RD Marketing once per lead with an e-mail, and never for a test deal', () => {
    expect(rdCalls.filter((path) => path.startsWith('/platform/contacts/email:'))).toHaveLength(1);
  });
});

describe('the list', () => {
  it('shows every attributed lead to the Gerente Comercial, with campaign, ad and masked contacts', async () => {
    const response = await list(gerente.cookies);
    expect(response.statusCode).toBe(200);
    const body = response.json<CampaignLeadsResponse>();
    expect(body.scope).toBe('all');
    expect(body.leads.map((lead) => lead.name)).toEqual(['Lead Dois', 'Lead Um']);
    const one = body.leads.find((lead) => lead.name === 'Lead Um')!;
    expect(one).toMatchObject({
      campaignName: 'META | Formatação | 28Set',
      adSetName: 'Conjunto Jimmy',
      adName: 'Vídeo Jimmy',
      attribution: 'utm',
      company: 'Padaria Um',
      segment: 'Alimentação',
      temperature: 'quente',
      owner: 'Vendedora A',
      phoneMasked: '(21) ••••-••32',
      emailMasked: 'l•••@e•••.com',
    });
    expect(JSON.stringify(body)).not.toContain('99876');
    expect(JSON.stringify(body)).not.toContain('lead.um@');
    const two = body.leads.find((lead) => lead.name === 'Lead Dois')!;
    expect(two).toMatchObject({
      campaignName: 'SEARCH | Formatação',
      attribution: 'rd_origin',
      firstContactMinutes: 3,
      firstContactSource: 'activity',
    });
  });

  it('sums the top without the test deal, and says why a lead is not attributed', async () => {
    const { summary } = (await list(gerente.cookies)).json<CampaignLeadsResponse>();
    expect(summary).toMatchObject({
      total: 2,
      today: 2,
      tests: 1,
      contactedPercent: 50,
      averageFirstContactMinutes: 3,
      unattributed: [{ reason: 'not_paid', count: 1 }],
      unattributedPercent: 33,
      smallSample: true,
    });
  });

  it('shows a Vendedor Formatação only the leads RD assigns to them', async () => {
    const a = (await list(sellerA.cookies)).json<CampaignLeadsResponse>();
    expect(a.scope).toBe('own');
    expect(a.leads.map((lead) => lead.name)).toEqual(['Lead Um']);
    const b = (await list(sellerB.cookies)).json<CampaignLeadsResponse>();
    expect(b.leads.map((lead) => lead.name)).toEqual(['Lead Dois']);
  });

  it('keeps Vendedor Expansão and Marketing out', async () => {
    for (const role of ['vendedor_expansao', 'marketing'] as const) {
      const { cookies } = await sessionFor(role);
      expect((await list(cookies)).statusCode).toBe(403);
    }
  });
});

describe('revealing a contact', () => {
  it('gives the phone to its owner and writes who, which lead and which field to the audit log', async () => {
    const lead = await db.query.campaignLeads.findFirst({
      where: eq(campaignLeads.rdDealId, 'd1'),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/campaign-leads/${lead!.id}/reveal`,
      cookies: sellerA.cookies,
      payload: { field: 'phone' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: PHONE });
    const audit = await db.query.auditLog.findMany({ where: eq(auditLog.entityId, lead!.id) });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'campaign_lead.revealed',
        actorEmployeeId: sellerA.employeeId,
        metadata: { field: 'phone' },
      }),
    ]);
    expect(JSON.stringify(audit.map((row) => row.metadata))).not.toContain('99876');
  });

  it("answers 404 for another salesperson's lead and for a test deal", async () => {
    const other = await db.query.campaignLeads.findFirst({
      where: eq(campaignLeads.rdDealId, 'd2'),
    });
    const test = await db.query.campaignLeads.findFirst({
      where: eq(campaignLeads.rdDealId, 'd3'),
    });
    for (const [id, cookies] of [
      [other!.id, sellerA.cookies],
      [test!.id, gerente.cookies],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/campaign-leads/${id}/reveal`,
        cookies,
        payload: { field: 'phone' },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('stores the e-mail and phone only sealed', async () => {
    const rows = await db.select().from(campaignLeads);
    expect(JSON.stringify(rows)).not.toContain('99876');
    expect(JSON.stringify(rows)).not.toContain('lead.um@exemplo.com');
  });
});
