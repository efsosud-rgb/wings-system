import { createHmac } from 'node:crypto';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Lead,
  type LeadListItem,
  type LeadTrackingLink,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  expansionIntakeLedger,
  jobs,
  leadEvents,
  leadSourceRules,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  clientRegister,
  createEmployee,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';

const RD_SECRET = 'rd-secret-with-enough-length-1';
const ZAPI_SECRET = 'zapi-secret-with-enough-length';
const META_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'meta-verify-token-long-enough';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
/** What the fake Graph API answers, per leadgen id. */
const graphAnswers = new Map<string, { status: number; body: unknown }>();
const graphCalls: string[] = [];

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
      RD_STATION_WEBHOOK_SECRET: RD_SECRET,
      ZAPI_WEBHOOK_SECRET: ZAPI_SECRET,
      META_APP_SECRET: META_SECRET,
      META_LEADGEN_VERIFY_TOKEN: VERIFY_TOKEN,
      META_LEADS_ACCESS_TOKEN: 'fake-leads-token',
      WINGS_WHATSAPP_NUMBER: '5511999990000',
    }),
    db,
    platformFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      graphCalls.push(url.pathname);
      // The token travels in a header, never in the query string.
      expect(url.searchParams.has('access_token')).toBe(false);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(
        'Bearer fake-leads-token',
      );
      const leadgenId = url.pathname.split('/').pop() ?? '';
      const answer = graphAnswers.get(leadgenId) ?? {
        status: 404,
        body: { error: { message: 'unknown' } },
      };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(
  role: 'admin_master' | 'marketing' | 'vendedor_expansao' | 'gerente_comercial',
) {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'marketing' ? 'marketing' : role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function createClient(cookies: Record<string, string>, name: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/clients',
    cookies,
    payload: clientRegister(name),
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ client: { id: string; name: string } }>().client;
}

const pendingJobs = () => db.select().from(jobs).where(eq(jobs.type, 'enrich_lead'));

describe('source rules, tracked links and the expansion area (Formatação → Clientes)', () => {
  it('keeps a rule per landing page, refuses a duplicate and removes it again', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Sushi do Bairro');

    const created = await app.inject({
      method: 'POST',
      url: '/leads/source-rules',
      cookies,
      payload: {
        kind: 'landing_page',
        pattern: 'https://Franquia.WingsCompany.com.br/Sushi-do-Bairro/',
        clientId: client.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json<{ rule: { id: string; pattern: string; clientName: string } }>().rule;
    // Stored normalised: the whole address, lower-case, no scheme or trailing slash.
    expect(rule.pattern).toBe('franquia.wingscompany.com.br/sushi-do-bairro');
    expect(rule.clientName).toBe('Sushi do Bairro');

    const again = await app.inject({
      method: 'POST',
      url: '/leads/source-rules',
      cookies,
      payload: {
        kind: 'landing_page',
        pattern: 'franquia.wingscompany.com.br/sushi-do-bairro',
        clientId: client.id,
      },
    });
    expect(again.statusCode).toBe(409);

    const listed = await app.inject({ method: 'GET', url: '/leads/source-rules', cookies });
    expect(listed.json<{ rules: { id: string }[] }>().rules.map((r) => r.id)).toContain(rule.id);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/leads/source-rules/${rule.id}`,
      cookies,
    });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: '/leads/source-rules', cookies });
    expect(gone.json<{ rules: { id: string }[] }>().rules.map((r) => r.id)).not.toContain(rule.id);
  });

  it('generates a wa.me link per channel with a six-character code, and a seller cannot', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Padaria Aurora');
    const created = await app.inject({
      method: 'POST',
      url: `/clients/${client.id}/tracking-links`,
      cookies,
      payload: { channel: 'instagram' },
    });
    expect(created.statusCode).toBe(201);
    const link = created.json<{ link: LeadTrackingLink }>().link;
    expect(link.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(link.url).toBe(`https://wa.me/5511999990000?text=${link.code}`);
    expect(link.channel).toBe('instagram');
    expect(link.hits).toBe(0);

    const listed = await app.inject({
      method: 'GET',
      url: `/clients/${client.id}/tracking-links`,
      cookies,
    });
    expect(listed.json<{ links: LeadTrackingLink[]; phoneConfigured: boolean }>()).toMatchObject({
      links: [expect.objectContaining({ id: link.id })],
      phoneConfigured: true,
    });

    const seller = await sessionFor('vendedor_expansao');
    const refused = await app.inject({
      method: 'POST',
      url: `/clients/${client.id}/tracking-links`,
      cookies: seller.cookies,
      payload: { channel: 'site' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('keeps the expansion area as states and cities, refusing an entry it cannot check', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Açaí Norte');
    const saved = await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}/expansion-area`,
      cookies,
      payload: { expansionArea: ['SP', 'Campinas/SP', 'Belém - PA'] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ client: { expansionArea: unknown } }>().client.expansionArea).toEqual([
      { uf: 'SP', city: null },
      { uf: 'SP', city: 'Campinas' },
      { uf: 'PA', city: 'Belém' },
    ]);
    const bad = await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}/expansion-area`,
      cookies,
      payload: { expansionArea: ['Campinas'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ message: string }>().message).toContain('"Campinas"');
    // The register carries it from now on.
    const listed = await app.inject({ method: 'GET', url: '/clients', cookies });
    const row = listed
      .json<{ clients: { id: string; expansionArea: unknown[] }[] }>()
      .clients.find((c) => c.id === client.id);
    expect(row?.expansionArea).toHaveLength(3);
  });
});

describe('POST /integrations/rd-station/webhook', () => {
  it('refuses without the secret and answers 503 when none is configured', async () => {
    const noSecret = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      payload: { leads: [] },
    });
    expect(noSecret.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook?secret=nope',
      payload: { leads: [] },
    });
    expect(wrong.statusCode).toBe(401);

    const bare = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: 'x'.repeat(48),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
      }),
      db,
    });
    try {
      const unconfigured = await bare.inject({
        method: 'POST',
        url: '/integrations/rd-station/webhook',
        headers: { 'x-wings-webhook-secret': RD_SECRET },
        payload: { leads: [] },
      });
      expect(unconfigured.statusCode).toBe(503);
      const meta = await bare.inject({
        method: 'GET',
        url: '/integrations/meta/leadgen/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
      });
      expect(meta.statusCode).toBe(503);
      const zapi = await bare.inject({
        method: 'POST',
        url: '/integrations/zapi/webhook',
        payload: {},
      });
      expect(zapi.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('creates the lead under the client the landing page maps to, with consent recorded, and queues its research', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Burger Prime');
    await app.inject({
      method: 'POST',
      url: '/leads/source-rules',
      cookies,
      payload: { kind: 'landing_page', pattern: 'burger-prime', clientId: client.id },
    });
    const before = (await pendingJobs()).length;

    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      headers: { 'x-wings-webhook-secret': RD_SECRET },
      payload: {
        event_type: 'WEBHOOK.CONVERTED',
        event_timestamp: '2026-09-23T14:00:00Z',
        leads: [
          {
            uuid: 'rd-uuid-1',
            name: 'Ana Souza',
            email: 'ANA@Example.com',
            mobile_phone: '(19) 99999-8888',
            legal_bases: [{ category: 'communications', type: 'consent', status: 'granted' }],
            last_conversion: {
              content: {
                conversion_identifier: 'lp-burger-prime',
                url: 'https://franquia.wingscompany.com.br/burger-prime?utm_source=instagram',
                created_at: '2026-09-23T13:59:00Z',
              },
            },
          },
        ],
      },
    });
    expect(delivered.statusCode).toBe(200);
    const answer = delivered.json<{
      received: number;
      leads: { leadId: string; created: boolean; clientMapped: boolean }[];
    }>();
    expect(answer.received).toBe(1);
    expect(answer.leads[0]).toMatchObject({ created: true, clientMapped: true });

    const leadId = answer.leads[0]?.leadId as string;
    // Marketing keeps the rules but does not read leads: that is the sales team's.
    expect((await app.inject({ method: 'GET', url: `/leads/${leadId}`, cookies })).statusCode).toBe(
      403,
    );
    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      cookies: (await sessionFor('gerente_comercial')).cookies,
    });
    expect(detail.statusCode).toBe(200);
    const lead = detail.json<{ lead: Lead; events: { kind: string }[] }>().lead;
    expect(lead).toMatchObject({
      name: 'Ana Souza',
      email: 'ana@example.com',
      phone: '5519999998888',
      origin: {
        clientId: client.id,
        clientName: 'Burger Prime',
        clientMapped: true,
        source: 'rd_station',
        channel: 'landing_page',
        landingPage: 'https://franquia.wingscompany.com.br/burger-prime?utm_source=instagram',
        externalId: 'rd-uuid-1',
      },
      consent: {
        legalBasis: 'consent',
        consentedAt: '2026-09-23T13:59:00.000Z',
        source: 'rd_station:lp-burger-prime',
      },
      research: { state: 'pending' },
    });
    expect((await pendingJobs()).length).toBe(before + 1);
    const job = (await pendingJobs()).find(
      (row) => (row.input as { leadId: string }).leadId === leadId,
    );
    expect(job?.state).toBe('pending');

    // The same conversion delivered again is the same lead, and no second job.
    const again = await app.inject({
      method: 'POST',
      url: `/integrations/rd-station/webhook?secret=${RD_SECRET}`,
      payload: { leads: [{ uuid: 'rd-uuid-1', email: 'ana@example.com', name: 'Ana Souza' }] },
    });
    expect(again.json<{ leads: { leadId: string; created: boolean }[] }>().leads[0]).toMatchObject({
      leadId,
      created: false,
    });
    expect((await pendingJobs()).length).toBe(before + 1);

    // The audit trail has the id and the source, never the person.
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, leadId));
    expect(audits.map((row) => row.action)).toEqual(['lead.received', 'lead.merged']);
    expect(JSON.stringify(audits.map((row) => row.metadata))).not.toContain('Ana');
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId));
    expect(JSON.stringify(events.map((row) => row.detail))).not.toMatch(/Ana|example\.com|99999/);
  });

  it('records the UTMs and click ids the conversion carried, and the funnel and brand the rule says', async () => {
    const trafficSource = `encoded_${Buffer.from(
      JSON.stringify({
        current_session: {
          value:
            'https://franquia.wingscompany.com.br/marca-t4?utm_source=instagram&utm_medium=cpc&utm_campaign=exp_marca_t4&fbclid=IwZX&adset_id=120211112222',
        },
      }),
    ).toString('base64')}`;
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'lp-marca-t4',
      clientId: null,
      pipeline: 'expansao',
      brand: 'Marca T4',
    });
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      headers: { 'x-wings-webhook-secret': RD_SECRET },
      payload: {
        leads: [
          {
            uuid: 'rd-uuid-t4',
            email: 'carla@example.com',
            last_conversion: {
              content: {
                conversion_identifier: 'lp-marca-t4',
                utm_content: 'video_a',
                traffic_source: trafficSource,
              },
            },
          },
        ],
      },
    });
    expect(delivered.statusCode).toBe(200);
    const row = await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-t4') });
    expect(row).toMatchObject({
      pipeline: 'expansao',
      brand: 'Marca T4',
      utmSource: 'instagram',
      utmMedium: 'cpc',
      utmCampaign: 'exp_marca_t4',
      utmContent: 'video_a',
      fbclid: 'IwZX',
      adPlatform: 'meta',
      adSetExternalId: '120211112222',
    });
  });

  it('links the RD deal the intake already made when the delivery comes after it', async () => {
    await db.insert(expansionIntakeLedger).values({
      conversionKey: 'rd-uuid-late|lp-late|2026-09-30T12:00:00.000Z',
      target: 'expansao',
      outcome: 'created',
      rdDealId: 'rd-deal-late-1',
    });
    await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      headers: { 'x-wings-webhook-secret': RD_SECRET },
      payload: {
        leads: [
          {
            uuid: 'rd-uuid-late',
            email: 'davi@example.com',
            last_conversion: { content: { conversion_identifier: 'lp-late' } },
          },
        ],
      },
    });
    const row = await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-late') });
    expect(row).toMatchObject({ rdDealId: 'rd-deal-late-1', pipeline: 'expansao' });
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, row!.id));
    expect(events.map((event) => event.kind)).toContain('rd.deal_linked');
  });

  it('files a conversion no rule maps under Wings Company, flagged as unmapped', async () => {
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/rd-station/webhook',
      headers: { 'x-wings-webhook-secret': RD_SECRET },
      payload: {
        leads: [
          {
            uuid: 'rd-uuid-2',
            email: 'bruno@example.com',
            last_conversion: { content: { url: 'https://lp.desconhecida.com.br/x' } },
          },
        ],
      },
    });
    expect(delivered.json<{ leads: { clientMapped: boolean }[] }>().leads[0]?.clientMapped).toBe(
      false,
    );
    const row = await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-2') });
    expect(row).toMatchObject({ clientId: WINGS_CLIENT_ID, clientMapped: false });
  });
});

describe('POST /integrations/zapi/webhook', () => {
  async function linkFor(name: string, channel = 'linktree') {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, name);
    const created = await app.inject({
      method: 'POST',
      url: `/clients/${client.id}/tracking-links`,
      cookies,
      payload: { channel },
    });
    return { client, link: created.json<{ link: LeadTrackingLink }>().link, cookies };
  }

  it('tags the sender with the client and channel of the code the message starts with', async () => {
    const { client, link, cookies } = await linkFor('Pizza Nova');
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/zapi/webhook',
      headers: { 'x-wings-webhook-secret': ZAPI_SECRET },
      payload: {
        type: 'ReceivedCallback',
        phone: '5541988887777',
        fromMe: false,
        isGroup: false,
        momment: 1790000000000,
        senderName: 'Carla Lima',
        senderPhoto: 'https://pps.whatsapp.net/x.jpg',
        text: { message: `${link.code.toLowerCase()} Olá! Quero saber mais da franquia` },
      },
    });
    expect(delivered.statusCode).toBe(200);
    const answer = delivered.json<{ leadId: string; created: boolean; channel: string }>();
    expect(answer).toMatchObject({ created: true, channel: 'linktree' });

    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${answer.leadId}`,
      cookies: (await sessionFor('gerente_comercial')).cookies,
    });
    const lead = detail.json<{ lead: Lead }>().lead;
    expect(lead).toMatchObject({
      name: 'Carla Lima',
      phone: '5541988887777',
      firstMessage: `${link.code.toLowerCase()} Olá! Quero saber mais da franquia`,
      whatsapp: { profileName: 'Carla Lima', photoUrl: 'https://pps.whatsapp.net/x.jpg' },
      origin: {
        clientId: client.id,
        source: 'whatsapp_link',
        channel: 'linktree',
        trackingCode: link.code,
      },
      consent: { legalBasis: 'pre_contract', source: `whatsapp:linktree:${link.code}` },
    });

    const links = await app.inject({
      method: 'GET',
      url: `/clients/${client.id}/tracking-links`,
      cookies,
    });
    expect(links.json<{ links: LeadTrackingLink[] }>().links[0]).toMatchObject({ hits: 1 });
  });

  it('ignores our own messages, groups, messages without a code and unknown codes', async () => {
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/integrations/zapi/webhook',
        headers: { 'x-wings-webhook-secret': ZAPI_SECRET },
        payload,
      });
    expect(
      (await send({ phone: '5541988880001', fromMe: true, text: { message: 'ABCDEF oi' } })).json(),
    ).toEqual({ ignored: 'not_inbound' });
    expect(
      (
        await send({ phone: '5541988880001', isGroup: true, text: { message: 'ABCDEF oi' } })
      ).json(),
    ).toEqual({ ignored: 'not_inbound' });
    expect(
      (await send({ phone: '5541988880001', text: { message: 'Olá, tudo bem?' } })).json(),
    ).toEqual({ ignored: 'no_code' });
    expect((await send({ phone: '5541988880001', text: { message: 'ZZZZZ9 oi' } })).json()).toEqual(
      { ignored: 'unknown_code' },
    );
    expect((await send({ text: { message: 'ABCDEF oi' } })).json()).toEqual({
      ignored: 'no_phone',
    });
    expect((await send({ phone: '5541988880001', text: { message: 'ABCDEF' } })).statusCode).toBe(
      200,
    );
  });
});

describe('Meta Lead Ads webhook', () => {
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', META_SECRET).update(body).digest('hex')}`;

  it('answers the subscription handshake only for our verify token', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/integrations/meta/leadgen/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await app.inject({
      method: 'GET',
      url: '/integrations/meta/leadgen/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('refuses a body whose signature does not match', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const unsigned = await app.inject({
      method: 'POST',
      url: '/integrations/meta/leadgen/webhook',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'POST',
      url: '/integrations/meta/leadgen/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('{"other":1}') },
      payload: body,
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('reads the form answers from the Graph API and files the lead under the form rule, with the campaign', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Café Central');
    await app.inject({
      method: 'POST',
      url: '/leads/source-rules',
      cookies,
      payload: { kind: 'meta_form', pattern: '777001', clientId: client.id },
    });
    graphAnswers.set('900001', {
      status: 200,
      body: {
        id: '900001',
        created_time: '2026-09-23T15:00:00+0000',
        field_data: [
          { name: 'full_name', values: ['Diego Alves'] },
          { name: 'email', values: ['diego@example.com'] },
          { name: 'phone_number', values: ['+5531977776666'] },
          { name: 'city', values: ['Belo Horizonte'] },
        ],
        campaign_id: '120001',
        campaign_name: 'Expansão MG',
        ad_name: 'Anúncio 1',
        form_id: '777001',
        platform: 'ig',
      },
    });
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: '555',
          time: 1790000000,
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: '900001',
                form_id: '777001',
                page_id: '555',
                ad_id: '1',
                adgroup_id: '2',
                created_time: 1790000000,
              },
            },
          ],
        },
      ],
    });
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/meta/leadgen/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(delivered.statusCode).toBe(200);
    const answer = delivered.json<{
      leads: { leadId: string; created: boolean; fetched: boolean }[];
    }>();
    expect(answer.leads[0]).toMatchObject({ created: true, fetched: true });
    expect(graphCalls.at(-1)).toBe('/v23.0/900001');

    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${answer.leads[0]?.leadId}`,
      cookies: (await sessionFor('admin_master')).cookies,
    });
    expect(detail.json<{ lead: Lead }>().lead).toMatchObject({
      name: 'Diego Alves',
      email: 'diego@example.com',
      phone: '5531977776666',
      origin: {
        clientId: client.id,
        clientMapped: true,
        source: 'meta_lead_ads',
        channel: 'meta_lead_ads',
        campaignId: '120001',
        campaignName: 'Expansão MG',
        formId: '777001',
        externalId: '900001',
      },
      consent: {
        legalBasis: 'consent',
        consentedAt: '2026-09-23T15:00:00.000Z',
        source: 'meta_lead_ads:form:777001',
      },
    });
  });

  it('still records the lead when the Graph API cannot be read, saying so on its timeline', async () => {
    graphAnswers.set('900002', { status: 400, body: { error: { message: 'no permission' } } });
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: '555',
          changes: [
            {
              field: 'leadgen',
              value: { leadgen_id: '900002', form_id: '777999', page_id: '555' },
            },
          ],
        },
      ],
    });
    const delivered = await app.inject({
      method: 'POST',
      url: '/integrations/meta/leadgen/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    const answer = delivered.json<{ leads: { leadId: string; fetched: boolean }[] }>();
    expect(answer.leads[0]?.fetched).toBe(false);
    const events = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.leadId, answer.leads[0]?.leadId as string));
    expect(events.find((e) => e.kind === 'lead.received.meta_lead_ads')?.detail).toMatchObject({
      fetched: false,
      fetchError: 'graph_400',
    });
  });
});

describe('the Funil routes', () => {
  it('lists what the caller may see: everything for a manager, only their own for a seller', async () => {
    const manager = await sessionFor('gerente_comercial');
    const seller = await sessionFor('vendedor_expansao');

    const mine = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies: seller.cookies,
      payload: {
        name: 'Lead do Vendedor',
        phone: '11 96543-2109',
        legalBasis: 'consent',
        consentText: 'Autorizou por telefone em 23/09.',
      },
    });
    expect(mine.statusCode).toBe(201);
    const created = mine.json<{ lead: Lead }>().lead;
    expect(created).toMatchObject({
      ownerEmployeeId: seller.employeeId,
      origin: { source: 'manual', clientId: WINGS_CLIENT_ID, clientMapped: false },
      consent: {
        legalBasis: 'consent',
        source: 'manual',
        text: 'Autorizou por telefone em 23/09.',
      },
      research: { state: 'pending' },
    });

    const sellerList = await app.inject({ method: 'GET', url: '/leads', cookies: seller.cookies });
    const sellerIds = sellerList.json<{ leads: LeadListItem[] }>().leads.map((lead) => lead.id);
    expect(sellerIds).toEqual([created.id]);

    const managerList = await app.inject({
      method: 'GET',
      url: '/leads',
      cookies: manager.cookies,
    });
    const managerIds = managerList.json<{ leads: LeadListItem[] }>().leads.map((lead) => lead.id);
    expect(managerIds).toContain(created.id);
    expect(managerIds.length).toBeGreaterThan(1);

    // A lead the seller does not own is not there for them, by id either.
    const other = managerIds.find((id) => id !== created.id) as string;
    expect(
      (await app.inject({ method: 'GET', url: `/leads/${other}`, cookies: seller.cookies }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/leads/${other}`, cookies: manager.cookies }))
        .statusCode,
    ).toBe(200);

    // Search by name, by e-mail and by phone digits.
    const byName = await app.inject({
      method: 'GET',
      url: '/leads?q=vendedor',
      cookies: manager.cookies,
    });
    expect(byName.json<{ leads: LeadListItem[] }>().leads.map((l) => l.id)).toEqual([created.id]);
    const byPhone = await app.inject({
      method: 'GET',
      url: '/leads?q=96543-2109',
      cookies: manager.cookies,
    });
    expect(byPhone.json<{ leads: LeadListItem[] }>().leads.map((l) => l.id)).toEqual([created.id]);
  });

  it('needs an e-mail or a phone, and a legal basis with where it was given', async () => {
    const { cookies } = await sessionFor('gerente_comercial');
    const nothing = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: { name: 'Sem contato', legalBasis: 'consent', consentText: 'Reunião presencial' },
    });
    expect(nothing.statusCode).toBe(400);
    const noBasis = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: { name: 'Sem base', phone: '11988887777' },
    });
    expect(noBasis.statusCode).toBe(400);
  });

  it('queues the research again on request, but not while one is already waiting', async () => {
    const { cookies, employeeId } = await sessionFor('gerente_comercial');
    const created = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: {
        name: 'Pesquisa de Novo',
        email: 'denovo@example.com',
        legalBasis: 'consent',
        consentText: 'Formulário no evento',
      },
    });
    const lead = created.json<{ lead: Lead }>().lead;
    const busy = await app.inject({ method: 'POST', url: `/leads/${lead.id}/research`, cookies });
    expect(busy.statusCode).toBe(409);

    // The worker finished (or failed): a person may ask again.
    await db
      .update(leads)
      .set({ enrichmentState: 'failed', enrichmentError: 'x' })
      .where(eq(leads.id, lead.id));
    const again = await app.inject({ method: 'POST', url: `/leads/${lead.id}/research`, cookies });
    expect(again.statusCode).toBe(202);
    expect(again.json<{ lead: Lead }>().lead.research).toMatchObject({
      state: 'pending',
      error: null,
    });
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, lead.id));
    expect(audits.map((row) => row.action)).toContain('lead.research_requested');
    expect(audits.find((row) => row.action === 'lead.research_requested')?.actorEmployeeId).toBe(
      employeeId,
    );
  });

  it('merges a manual entry into the lead that already has that phone and fills its gaps only', async () => {
    const { cookies } = await sessionFor('gerente_comercial');
    const first = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: {
        name: 'Primeira Vez',
        phone: '21 97777-6666',
        legalBasis: 'consent',
        consentText: 'Feira de franquias',
      },
    });
    const lead = first.json<{ lead: Lead }>().lead;
    const second = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: {
        name: 'Outro Nome',
        phone: '(21) 97777-6666',
        email: 'primeira@example.com',
        legalBasis: 'pre_contract',
        consentText: 'Ligou de volta',
      },
    });
    expect(second.statusCode).toBe(200);
    const merged = second.json<{ lead: Lead; created: boolean }>();
    expect(merged.created).toBe(false);
    expect(merged.lead).toMatchObject({
      id: lead.id,
      name: 'Primeira Vez',
      email: 'primeira@example.com',
      consent: { legalBasis: 'consent' },
    });
    const wings = await db.query.clients.findFirst({ where: eq(clients.id, WINGS_CLIENT_ID) });
    expect(wings?.name).toBe('Wings Company');
  });
});
