import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmNotifications,
  leadEvents,
  leadSourceRules,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { setDistribution } from './crm.js';
import { upsertLead } from './service.js';
import { ingestTikTokLeads, secretMatches, tiktokLeadOf, tiktokLeadsIn } from './tiktok-leads.js';

const SECRET = 'tiktok-secret-with-enough-length';
const NOW = new Date('2026-10-05T15:00:00Z');

// --- payload examples (invented people; shapes follow the two senders' documentation) ---------

/** TikTok's own webhook: ids, names and a list of questions. */
const tiktokNative = (over: Record<string, unknown> = {}) => ({
  lead_id: '7400000000000000001',
  form_id: 'form-franquia-1',
  form_name: 'Formatação de franquia',
  advertiser_id: '700001',
  campaign_id: 'camp-77',
  campaign_name: 'Formatação Outubro',
  adgroup_id: 'ag-5',
  adgroup_name: 'Conjunto A',
  ad_id: 'ad-9',
  ad_name: 'Anúncio B',
  create_time: '2026-10-05T14:55:00Z',
  user_info: [
    { question: 'Full Name', answer: 'Marina Costa' },
    { question: 'Email', answer: 'Marina@Example.com' },
    { question: 'Phone Number', answer: '+55 21 98888-7777' },
    { question: 'Cidade', answer: 'Niterói' },
    { question: 'Quanto pretende investir?', answer: 'Até 100 mil' },
  ],
  ...over,
});

/** What Zapier's TikTok Lead Generation trigger hands to Webhooks: flat, readable labels. */
const zapierFlat = (over: Record<string, string> = {}) => ({
  'Lead ID': '7400000000000000002',
  'Form ID': 'form-franquia-1',
  'Campaign Name': 'Formatação Outubro',
  'Campaign ID': 'camp-77',
  'Ad Name': 'Anúncio B',
  'Created Time': '2026-10-05 14:50:00',
  'Full Name': 'Rafael Dias',
  Email: 'rafael@example.com',
  'Phone Number': '11977776666',
  'Quanto pretende investir?': 'Acima de 200 mil',
  ...over,
});

describe('reading the two shapes', () => {
  it('reads TikTok’s native body: contact, origin, time and the other answers', () => {
    const lead = tiktokLeadOf(tiktokNative(), NOW);
    expect(lead).toMatchObject({
      leadId: '7400000000000000001',
      name: 'Marina Costa',
      email: 'Marina@Example.com',
      phone: '+55 21 98888-7777',
      city: 'Niterói',
      formId: 'form-franquia-1',
      formName: 'Formatação de franquia',
      campaignId: 'camp-77',
      adgroupId: 'ag-5',
      adId: 'ad-9',
    });
    expect(lead.createdTime?.toISOString()).toBe('2026-10-05T14:55:00.000Z');
    expect(lead.answers).toEqual({ 'Quanto pretende investir?': 'Até 100 mil' });
  });

  it('reads Zapier’s flat body', () => {
    const lead = tiktokLeadOf(zapierFlat(), NOW);
    expect(lead).toMatchObject({
      leadId: '7400000000000000002',
      name: 'Rafael Dias',
      email: 'rafael@example.com',
      phone: '11977776666',
      formId: 'form-franquia-1',
      campaignName: 'Formatação Outubro',
    });
    expect(lead.answers).toEqual({ 'Quanto pretende investir?': 'Acima de 200 mil' });
  });

  it('reads answers given as a map, as typed questions, and in envelopes and lists', () => {
    const typed = tiktokLeadOf(
      {
        lead_id: '1',
        questions: [
          { type: 'EMAIL', value: 'a@example.com' },
          { type: 'PHONE_NUMBER', value: '31999990000' },
          { type: 'FULL_NAME', value: 'Ana Souza' },
        ],
      },
      NOW,
    );
    expect(typed).toMatchObject({
      name: 'Ana Souza',
      email: 'a@example.com',
      phone: '31999990000',
    });
    expect(tiktokLeadOf({ lead_id: '2', user_info: { email: 'b@example.com' } }, NOW).email).toBe(
      'b@example.com',
    );
    // A bare `id` on an envelope is the event's, not the lead's.
    const wrapped = tiktokLeadsIn({ id: 'evt-1', event: 'lead', data: tiktokNative() }, NOW);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.leadId).toBe('7400000000000000001');
    expect(
      tiktokLeadsIn({ leads: [tiktokNative(), tiktokNative({ lead_id: 'x2' })] }, NOW),
    ).toHaveLength(2);
    expect(tiktokLeadsIn([zapierFlat()], NOW)).toHaveLength(1);
    expect(tiktokLeadsIn({ data: JSON.stringify(tiktokNative()) }, NOW)).toHaveLength(1);
    expect(tiktokLeadsIn({ hello: 'world' }, NOW)).toHaveLength(0);
  });

  it('cuts a time in the future back to now and reads seconds and milliseconds', () => {
    expect(
      tiktokLeadOf({ lead_id: '1', create_time: '2099-01-01T00:00:00Z' }, NOW).createdTime,
    ).toEqual(NOW);
    expect(
      tiktokLeadOf({ lead_id: '1', create_time: 1790000000 }, NOW).createdTime?.getFullYear(),
    ).toBe(2026);
    expect(
      tiktokLeadOf({ lead_id: '1', create_time: '1790000000000' }, NOW).createdTime?.getFullYear(),
    ).toBe(2026);
  });

  it('compares secrets without caring about length', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
  });
});

// --- the door and the funnel -------------------------------------------------------------------

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

const baseEnv = () => ({
  NODE_ENV: 'test',
  DATABASE_URL: harness.url,
  SESSION_SECRET: 'x'.repeat(48),
  CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
  CPF_INDEX_KEY: TEST_INDEX_KEY,
  APP_BASE_URL: 'http://localhost:5173',
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({ ...baseEnv(), TIKTOK_LEADS_WEBHOOK_SECRET: SECRET }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

const post = (
  payload: unknown,
  options: { secret?: string | null; query?: string; form?: boolean } = {},
) =>
  app.inject({
    method: 'POST',
    url: `/integrations/tiktok/leads/webhook${options.query ?? ''}`,
    headers: {
      ...(options.secret === null ? {} : { 'x-wings-webhook-secret': options.secret ?? SECRET }),
      ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    payload: options.form
      ? new URLSearchParams(payload as Record<string, string>).toString()
      : (payload as object),
  });

const leadOf = (externalId: string) =>
  db.query.leads.findFirst({ where: eq(leads.externalId, externalId) });

describe('POST /integrations/tiktok/leads/webhook', () => {
  it('refuses without the secret or with a wrong one, and answers 503 when none is configured', async () => {
    expect((await post(tiktokNative(), { secret: null })).statusCode).toBe(401);
    expect((await post(tiktokNative(), { secret: 'nope' })).statusCode).toBe(401);
    expect((await post(tiktokNative(), { secret: `${SECRET}x` })).statusCode).toBe(401);
    expect(await leadOf('7400000000000000001')).toBeUndefined();

    const bare = await buildApp({ env: loadEnv(baseEnv()), db });
    try {
      const response = await bare.inject({
        method: 'POST',
        url: '/integrations/tiktok/leads/webhook',
        headers: { 'x-wings-webhook-secret': SECRET },
        payload: tiktokNative(),
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('accepts the secret in the header, as a bearer token and in ?secret=', async () => {
    for (const [i, request] of [
      { secret: SECRET },
      { secret: null, query: `?secret=${SECRET}` },
    ].entries()) {
      const response = await post({ hello: i }, request);
      expect(response.statusCode).toBe(200);
    }
    const bearer = await app.inject({
      method: 'POST',
      url: '/integrations/tiktok/leads/webhook',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { nothing: true },
    });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json()).toMatchObject({ received: 0 });
  });

  it('creates the lead from TikTok’s native body under the form rule, with the whole origin and consent', async () => {
    await db.insert(leadSourceRules).values({
      kind: 'tiktok_form',
      pattern: 'form-franquia-1',
      clientId: WINGS_CLIENT_ID,
      pipeline: 'formatacao',
    });
    const response = await post(tiktokNative());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: 1, created: 1, merged: 0, failed: 0 });
    // The answer never carries a person.
    expect(response.body).not.toContain('Marina');

    const lead = await leadOf('7400000000000000001');
    expect(lead).toMatchObject({
      source: 'tiktok_lead_ads',
      channel: 'tiktok_lead_ads',
      name: 'Marina Costa',
      email: 'marina@example.com',
      phone: '5521988887777',
      pipeline: 'formatacao',
      clientMapped: true,
      formId: 'form-franquia-1',
      campaignId: 'camp-77',
      adPlatform: 'tiktok',
      adCampaignExternalId: 'camp-77',
      adSetExternalId: 'ag-5',
      adExternalId: 'ad-9',
      legalBasis: 'consent',
      consentSource: 'tiktok_lead_ads:form:form-franquia-1',
    });
    expect(lead?.formAnswers).toEqual({ 'Quanto pretende investir?': 'Até 100 mil' });
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id));
    expect(events.map((e) => e.kind)).toContain('lead.received.tiktok_lead_ads');
    // RD copy is off by default: nothing about RD in the timeline.
    expect(events.map((e) => e.kind)).not.toContain('rd.deal_created');
  });

  it('a re-sent delivery is the same lead; Zapier’s body for the same person merges instead of duplicating', async () => {
    const again = await post(tiktokNative());
    expect(again.json()).toMatchObject({ created: 0, merged: 1 });
    const zapier = await post(
      zapierFlat({ 'Lead ID': '7400000000000000099', 'Phone Number': '(21) 98888-7777' }),
      { form: true },
    );
    expect(zapier.statusCode).toBe(200);
    expect(zapier.json()).toMatchObject({ created: 0, merged: 1 });
    const rows = await db.select().from(leads).where(eq(leads.phone, '5521988887777'));
    expect(rows).toHaveLength(1);
  });

  it('reads Zapier’s form-encoded body and files a form with no rule in Formatação, telling Diretoria once', async () => {
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const response = await post(zapierFlat({ 'Form ID': 'form-sem-regra' }), { form: true });
    expect(response.json()).toMatchObject({ received: 1, created: 1 });
    const lead = await leadOf('7400000000000000002');
    expect(lead).toMatchObject({
      pipeline: 'formatacao',
      source: 'tiktok_lead_ads',
      name: 'Rafael Dias',
    });
    const guessed = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id));
    expect(guessed.map((e) => e.kind)).toContain('lead.pipeline_guessed');
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.recipientEmployeeId, board.id));
    expect(
      notices.filter((n) => n.dedupeKey?.startsWith('tiktok_form_unclassified:')),
    ).toHaveLength(1);
    // A second lead from the same form adds no second notice.
    await post(
      zapierFlat({
        'Form ID': 'form-sem-regra',
        'Lead ID': 'z3',
        'Phone Number': '11955554444',
        Email: 'outro@example.com',
      }),
      { form: true },
    );
    const after = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.recipientEmployeeId, board.id));
    expect(after.filter((n) => n.dedupeKey?.startsWith('tiktok_form_unclassified:'))).toHaveLength(
      1,
    );
  });

  it('skips a lead with no phone and no e-mail (200, so the sender does not retry) and refuses unreadable bodies', async () => {
    const response = await post({
      lead_id: 'no-contact',
      user_info: [{ question: 'Full Name', answer: 'Só Nome' }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: 1, skipped: 1, created: 0 });
    expect(await leadOf('no-contact')).toBeUndefined();

    const broken = await app.inject({
      method: 'POST',
      url: '/integrations/tiktok/leads/webhook',
      headers: {
        'x-wings-webhook-secret': SECRET,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '{not json and not a form',
    });
    expect(broken.statusCode).toBe(400);
  });

  it('gives a fresh lead to the rotation with the first-contact task and notice; an old one (backfill) only gets the owner and one counted notice', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await setDistribution(db, {
      pipeline: 'formatacao',
      members: [{ employeeId: seller.id, active: true }],
      actorEmployeeId: seller.id,
    });
    const fresh = await ingestTikTokLeads(
      { db, rdCrmToken: null, expansionOwnerId: null, rdCopyEnabled: false, log: () => undefined },
      [
        tiktokLeadOf(
          tiktokNative({
            lead_id: 'fresh-1',
            create_time: new Date().toISOString(),
            user_info: [{ question: 'Email', answer: 'fresh@example.com' }],
          }),
        ),
      ],
    );
    expect(fresh).toMatchObject({ created: 1 });
    const freshLead = await leadOf('fresh-1');
    expect(freshLead?.ownerEmployeeId).toBe(seller.id);
    expect(
      await db.select().from(leadTasks).where(eq(leadTasks.leadId, freshLead!.id)),
    ).toHaveLength(1);
    const freshNotices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.leadId, freshLead!.id));
    expect(freshNotices.map((n) => n.kind)).toContain('new_lead');

    const old = await ingestTikTokLeads(
      { db, rdCrmToken: null, expansionOwnerId: null, rdCopyEnabled: false, log: () => undefined },
      [
        tiktokLeadOf(
          tiktokNative({
            lead_id: 'old-1',
            create_time: '2026-10-01T10:00:00Z',
            user_info: [{ question: 'Email', answer: 'old1@example.com' }],
          }),
        ),
        tiktokLeadOf(
          tiktokNative({
            lead_id: 'old-2',
            create_time: '2026-10-01T11:00:00Z',
            user_info: [{ question: 'Email', answer: 'old2@example.com' }],
          }),
        ),
      ],
    );
    expect(old).toMatchObject({ created: 2 });
    for (const id of ['old-1', 'old-2']) {
      const lead = await leadOf(id);
      expect(lead?.ownerEmployeeId).toBe(seller.id);
      expect(await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead!.id))).toHaveLength(
        0,
      );
      const notices = await db
        .select()
        .from(crmNotifications)
        .where(eq(crmNotifications.leadId, lead!.id));
      expect(notices).toHaveLength(0);
    }
  });
});

// --- the copy to RD CRM, with its own switch --------------------------------------------------

describe('TikTok → RD CRM copy', () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const answers = new Map<string, unknown>([
    [
      'GET /deal_pipelines',
      [
        {
          id: 'pipe-fmt',
          name: 'Formatação',
          deal_stages: [{ id: 'st-sem', name: 'Sem contato' }],
        },
        {
          id: 'pipe-exp',
          name: 'Expansão',
          deal_stages: [{ id: 'st-novo', name: 'Novo Contato' }],
        },
      ],
    ],
    ['GET /custom_fields', { custom_fields: [{ _id: 'cf-obs', label: 'OBS' }] }],
    ['GET /deal_sources', { deal_sources: [{ _id: 'src-tt', name: 'TikTok Lead Ads' }] }],
    ['GET /campaigns', { campaigns: [] }],
    ['GET /contacts', { contacts: [] }],
    ['POST /deals', { _id: 'deal-tt-1' }],
  ]);
  const rdFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/api\/v1/, '');
    calls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = answers.get(`${init?.method ?? 'GET'} ${path}`);
    return new Response(JSON.stringify(body ?? {}), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const deps = (rdCopyEnabled: boolean) => ({
    db,
    rdCrmToken: 'rd-token',
    expansionOwnerId: null,
    rdCopyEnabled,
    rdFetch,
    log: () => undefined,
  });
  const lead = (id: string, email: string) =>
    tiktokLeadOf(
      tiktokNative({
        lead_id: id,
        form_id: 'form-franquia-1',
        create_time: new Date().toISOString(),
        user_info: [
          { question: 'Full Name', answer: 'Pedro Lima' },
          { question: 'Email', answer: email },
        ],
      }),
    );

  it('makes no call to RD while the switch is off', async () => {
    calls.length = 0;
    const result = await ingestTikTokLeads(deps(false), [lead('rd-off-1', 'rdoff@example.com')]);
    expect(result).toMatchObject({ created: 1, rdCreated: 0 });
    expect(calls).toHaveLength(0);
  });

  it('with the switch on, creates the deal in Sem contato with the TikTok origin in OBS and the TikTok source', async () => {
    calls.length = 0;
    const result = await ingestTikTokLeads(deps(true), [lead('rd-on-1', 'rdon@example.com')]);
    expect(result).toMatchObject({ created: 1, rdCreated: 1 });
    const created = calls.find((c) => c.method === 'POST' && c.path === '/deals');
    expect(created?.body).toMatchObject({
      deal: { deal_stage_id: 'st-sem' },
      deal_source: { _id: 'src-tt' },
    });
    const obs = (
      created?.body as {
        deal: { deal_custom_fields: { custom_field_id: string; value: string }[] };
      }
    ).deal.deal_custom_fields.find((f) => f.custom_field_id === 'cf-obs');
    expect(obs?.value).toContain('TikTok Lead Ads');
    expect(obs?.value).toContain('formulário=form-franquia-1');
    expect(obs?.value).not.toContain('Pedro');
    const row = await leadOf('rd-on-1');
    expect(row?.rdDealId).toBe('deal-tt-1');
    const kinds = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, row!.id))).map(
      (e) => [e.kind, e.detail],
    );
    expect(kinds).toContainEqual([
      'rd.deal_created',
      expect.objectContaining({ via: 'tiktok_lead_ads' }),
    ]);
  });

  it('never makes the deal twice: a re-delivery is a merge and does not call RD', async () => {
    calls.length = 0;
    const result = await ingestTikTokLeads(deps(true), [lead('rd-on-1', 'rdon@example.com')]);
    expect(result).toMatchObject({ created: 0, merged: 1, rdCreated: 0 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a POST whose answer is lost leaves the lead in the Funil and is not retried', async () => {
    const original = answers.get('POST /deals');
    answers.delete('POST /deals');
    calls.length = 0;
    const result = await ingestTikTokLeads(deps(true), [lead('rd-lost-1', 'rdlost@example.com')]);
    answers.set('POST /deals', original);
    expect(result).toMatchObject({ created: 1, rdCreated: 0, failed: 0 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect((await leadOf('rd-lost-1'))?.rdDealId).toBeNull();
  });
});

describe('arrival rules shared with Meta', () => {
  it('a TikTok lead is an arrival source: a person merged by phone keeps their first source', async () => {
    const first = await upsertLead(db, {
      source: 'meta_lead_ads',
      name: 'Carla Nunes',
      phone: '5531933332222',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'formatacao',
      skipResearch: true,
      event: { kind: 'lead.received.meta_lead_ads' },
    });
    const response = await post(
      tiktokNative({
        lead_id: 'merge-1',
        user_info: [{ question: 'Phone Number', answer: '(31) 93333-2222' }],
      }),
    );
    expect(response.json()).toMatchObject({ created: 0, merged: 1 });
    const row = await db.query.leads.findFirst({ where: eq(leads.id, first.lead.id) });
    expect(row?.source).toBe('meta_lead_ads');
  });
});

describe('GET /crm/sources', () => {
  it('shows the TikTok card: off without the secret, on with it, with the last entry and the 30-day count', async () => {
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: admin.email, password: admin.password },
    });
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
    const cookies = { [SESSION_COOKIE]: cookie!.value };
    const read = async (target: FastifyInstance, jar: Record<string, string>) =>
      (
        await target.inject({ method: 'GET', url: '/crm/sources', cookies: jar })
      ).json<{
        sources: { key: string; state: string; last30: number; lastAt: string | null }[];
      }>().sources.find((s) => s.key === 'tiktok');
    const card = await read(app, cookies);
    expect(card?.state).toBe('on');
    expect(card?.last30).toBeGreaterThan(0);
    expect(card?.lastAt).toBeTruthy();

    const bare = await buildApp({ env: loadEnv(baseEnv()), db });
    try {
      const bareLogin = await bare.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: admin.email, password: admin.password },
      });
      const bareCookie = bareLogin.cookies.find((c) => c.name === SESSION_COOKIE);
      const off = await read(bare, { [SESSION_COOKIE]: bareCookie!.value });
      expect(off?.state).toBe('off');
    } finally {
      await bare.close();
    }
  });
});
