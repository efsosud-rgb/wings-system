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
  crmDistributionMembers,
  expansionIntakeLedger,
  jobs,
  leadContacts,
  leadEvents,
  leadSourceRules,
  leadTasks,
  leadTrackingLinks,
  leads,
  metaLeadgenEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  processMetaLeadgenEvents,
  purgeMetaLeadgenPayloads,
  reprocessMetaLeadgenEvent,
} from './meta-intake.js';
import { upsertLead } from './service.js';
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
      const segments = url.pathname.split('/');
      // `/{form_id}/leads` lists a form; `/{leadgen_id}` reads one lead.
      const leadgenId =
        segments.at(-1) === 'leads' ? `form:${segments.at(-2)}` : (segments.at(-1) ?? '');
      if (leadgenId.startsWith('form:')) {
        expect(url.searchParams.get('filtering')).toContain('time_created');
        expect(url.searchParams.has('fields')).toBe(true);
      }
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
    expect(link.url).toBe(
      `https://wa.me/5511999990000?text=${encodeURIComponent(`${link.code} Olá! Quero saber sobre a franquia Padaria Aurora.`)}`,
    );
    expect(link.current).toBe(true);
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

  it("opens the Wings WhatsApp for a brand, never the brand's own number, with the brand in the text", async () => {
    const { cookies } = await sessionFor('marketing');
    const brand = await createClient(cookies, 'Cenoritas Teste');
    // The brand's own WhatsApp is a contact on the record only.
    await db.update(clients).set({ whatsapp: '21972055989' }).where(eq(clients.id, brand.id));
    const created = await app.inject({
      method: 'POST',
      url: `/clients/${brand.id}/tracking-links`,
      cookies,
      payload: { channel: 'site' },
    });
    expect(created.statusCode).toBe(201);
    const link = created.json<{ link: LeadTrackingLink }>().link;
    expect(link.phone).toBe('5511999990000');
    expect(link.url).toBe(
      `https://wa.me/5511999990000?text=${encodeURIComponent(`${link.code} Olá! Quero saber sobre a franquia Cenoritas Teste.`)}`,
    );
    expect(link.url).not.toContain('21972055989');
    expect(link.current).toBe(true);

    // A link made for an older Wings number is flagged.
    await db
      .update(leadTrackingLinks)
      .set({ phone: '5511900000000' })
      .where(eq(leadTrackingLinks.id, link.id));
    const listed = await app.inject({
      method: 'GET',
      url: `/clients/${brand.id}/tracking-links`,
      cookies,
    });
    expect(listed.json<{ links: LeadTrackingLink[] }>().links[0]).toMatchObject({
      current: false,
    });
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

  it('takes the CONTACT event the RD screen webhook sends: the form identifier picks the funnel', async () => {
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'lp-formatacao-contato',
      clientId: null,
      pipeline: 'formatacao',
      brand: 'Marca Formatacao',
    });
    const event = {
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_timestamp: '2026-10-07T09:26:40.000-03:00',
      event_identifier: 'lp-formatacao-contato',
      timestamp: '2026-10-07T12:26:41.000Z',
      contact: {
        uuid: 'rd-uuid-contact-1',
        email: 'Eva@Example.com',
        name: 'Eva Lima',
        personal_phone: '(11) 97777-6666',
        tags: ['lp'],
        legal_bases: [{ category: 'communications', type: 'consent', status: 'granted' }],
        funnel: { name: 'Default', lifecycle_stage: 'Lead', opportunity: false },
      },
    };
    const delivered = await app.inject({
      method: 'POST',
      url: `/integrations/rd-station/webhook?secret=${RD_SECRET}`,
      payload: event,
    });
    expect(delivered.statusCode).toBe(200);
    const answer = delivered.json<{ received: number; leads: { created: boolean }[] }>();
    expect(answer.received).toBe(1);
    expect(answer.leads[0]?.created).toBe(true);
    const row = await db.query.leads.findFirst({
      where: eq(leads.externalId, 'rd-uuid-contact-1'),
    });
    expect(row).toMatchObject({
      source: 'rd_station',
      email: 'eva@example.com',
      phone: '5511977776666',
      pipeline: 'formatacao',
      consentSource: 'rd_station:lp-formatacao-contato',
      enteredAtSource: 'rd_conversion',
    });
    // The date of the conversion RD reports (event_timestamp, 09:26:40 in Brasília).
    expect(row!.enteredAt.toISOString()).toBe('2026-10-07T12:26:40.000Z');

    // The same event again is the same lead.
    const again = await app.inject({
      method: 'POST',
      url: `/integrations/rd-station/webhook?secret=${RD_SECRET}`,
      payload: event,
    });
    expect(again.json<{ leads: { created: boolean }[] }>().leads[0]?.created).toBe(false);

    // An opportunity event of the same shape is not a conversion: answered 200 and ignored, said so.
    const other = await app.inject({
      method: 'POST',
      url: `/integrations/rd-station/webhook?secret=${RD_SECRET}`,
      payload: {
        ...event,
        event_type: 'WEBHOOK.MARKED_OPPORTUNITY',
        contact: { ...event.contact, uuid: 'rd-uuid-contact-2', email: 'fabio@example.com' },
      },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ received: 0, ignored: 'no_conversion' });
    expect(
      await db.query.leads.findFirst({ where: eq(leads.externalId, 'rd-uuid-contact-2') }),
    ).toBeUndefined();
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

  /** Meta's published example of a leadgen change (ids only; the answers come from the Graph API). */
  const leadgenBody = (value: Record<string, unknown>) =>
    JSON.stringify({
      object: 'page',
      entry: [{ id: '555', time: 1790000000, changes: [{ field: 'leadgen', value }] }],
    });
  const deliver = (body: string) =>
    app.inject({
      method: 'POST',
      url: '/integrations/meta/leadgen/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
  /** What RD CRM's fake answers, per path; set by each test that turns the copy on. */
  const rdAnswers = new Map<string, { status: number; body: unknown }>();
  const rdCalls: { method: string; path: string; body: unknown }[] = [];
  const rdFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    // The token travels in the query string for RD CRM; the fake never records it.
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const key = `${init?.method ?? 'GET'} ${path}${url.searchParams.has('email') ? '?email' : url.searchParams.has('phone') ? '?phone' : ''}`;
    rdCalls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const answer = rdAnswers.get(key) ??
      rdAnswers.get(`${init?.method ?? 'GET'} ${path}`) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const rdMapAnswers = () => {
    rdAnswers.set('GET /deal_pipelines', {
      status: 200,
      body: [
        {
          id: 'pipe-exp',
          name: 'Expansão',
          deal_stages: [
            { id: 'st-novo', name: 'Novo Contato' },
            { id: 'st-2', name: 'Contato' },
          ],
        },
        {
          id: 'pipe-fmt',
          name: 'Formatação',
          deal_stages: [{ id: 'st-sem', name: 'Sem contato' }],
        },
      ],
    });
    rdAnswers.set('GET /custom_fields', {
      status: 200,
      body: {
        custom_fields: [
          { _id: 'cf-marca', label: 'Nome da Marca' },
          { _id: 'cf-obs', label: 'OBS' },
        ],
      },
    });
    rdAnswers.set('GET /deal_sources', {
      status: 200,
      body: {
        deal_sources: [
          { _id: 'src-la', name: 'Facebook Lead Ads' },
          { _id: 'src-site', name: 'Contato pelo Site' },
        ],
      },
    });
    rdAnswers.set('GET /campaigns', {
      status: 200,
      body: { campaigns: [{ _id: 'camp-1', name: 'Expansão MG' }] },
    });
  };
  const runQueue = (options: { rd?: boolean } = {}) =>
    processMetaLeadgenEvents({
      db,
      accessToken: 'fake-leads-token',
      rdCrmToken: options.rd ? 'rd-token' : null,
      expansionOwnerId: 'rd-user-fernando',
      rdCopyEnabled: true,
      graphFetch: app.wings.platformFetch,
      rdFetch,
      log: () => undefined,
    });
  const eventOf = (leadgenId: string) =>
    db.query.metaLeadgenEvents.findFirst({ where: eq(metaLeadgenEvents.leadgenId, leadgenId) });

  it('stores the event, answers at once, and the queue reads the answers, files the lead under the form rule with the whole origin', async () => {
    const { cookies } = await sessionFor('marketing');
    const client = await createClient(cookies, 'Café Central');
    await app.inject({
      method: 'POST',
      url: '/leads/source-rules',
      cookies,
      payload: { kind: 'meta_form', pattern: '777001', clientId: client.id, pipeline: 'expansao' },
    });
    // Shape of the Graph API's lead object, from Meta's reference (field_data + ad fields).
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
          { name: 'capital_disponivel', values: ['R$ 300 mil'] },
        ],
        campaign_id: '120001',
        campaign_name: 'Expansão MG',
        adset_id: '130001',
        adset_name: 'Conjunto BH',
        ad_id: '140001',
        ad_name: 'Anúncio 1',
        form_id: '777001',
        platform: 'ig',
        is_organic: false,
      },
    });
    const body = leadgenBody({
      leadgen_id: '900001',
      form_id: '777001',
      page_id: '555',
      ad_id: '140001',
      adgroup_id: '130001',
      created_time: 1790000000,
    });
    const delivered = await deliver(body);
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json()).toEqual({ received: 1, queued: 1 });
    // Nothing read from the Graph API yet: the webhook only stores.
    expect(graphCalls.filter((path) => path.endsWith('/900001'))).toHaveLength(0);
    expect(await eventOf('900001')).toMatchObject({
      status: 'pending',
      attempts: 0,
      formId: '777001',
    });

    const run = await runQueue();
    expect(run).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(graphCalls.at(-1)).toBe('/v23.0/900001');
    const event = await eventOf('900001');
    expect(event).toMatchObject({
      status: 'done',
      leadCreated: true,
      rdOutcome: 'disabled',
      rdDealId: null,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${event?.leadId}`,
      cookies: (await sessionFor('admin_master')).cookies,
    });
    expect(detail.json<{ lead: Lead }>().lead).toMatchObject({
      name: 'Diego Alves',
      email: 'diego@example.com',
      phone: '5531977776666',
      pipeline: 'expansao',
      // Lands in the funnel's entry stage of the Wings System, RD or no RD.
      crm: null,
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
    const row = await db.query.leads.findFirst({ where: eq(leads.id, event?.leadId as string) });
    expect(row).toMatchObject({
      stage: 'Novo Contato',
      stageOrder: 1,
      managedBy: 'wings',
      adPlatform: 'meta',
      adCampaignExternalId: '120001',
      adSetExternalId: '130001',
      adExternalId: '140001',
      utmSource: 'meta:ig',
      city: 'Belo Horizonte',
      formAnswers: { capital_disponivel: 'R$ 300 mil' },
    });
    // The timeline carries ids and counts, never an answer.
    const events = await db
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.leadId, row?.id as string));
    const received = events.find((e) => e.kind === 'lead.received.meta_lead_ads');
    expect(received?.detail).toMatchObject({
      formId: '777001',
      adsetId: '130001',
      platform: 'ig',
      answers: 1,
    });
    expect(JSON.stringify(received?.detail)).not.toContain('300 mil');
  });

  it('is a no-op for a re-sent leadgen id and merges a form whose phone the Funil already has', async () => {
    const body = leadgenBody({ leadgen_id: '900001', form_id: '777001', page_id: '555' });
    const again = await deliver(body);
    expect(again.json()).toEqual({ received: 1, queued: 0 });
    expect(
      await db.select().from(metaLeadgenEvents).where(eq(metaLeadgenEvents.leadgenId, '900001')),
    ).toHaveLength(1);

    // Same person, another form (another leadgen id): one lead, two arrivals.
    graphAnswers.set('900003', {
      status: 200,
      body: {
        id: '900003',
        created_time: '2026-09-24T10:00:00+0000',
        field_data: [
          { name: 'full_name', values: ['Diego A.'] },
          { name: 'phone_number', values: ['31 97777-6666'] },
        ],
        form_id: '777002',
      },
    });
    await deliver(leadgenBody({ leadgen_id: '900003', form_id: '777002', page_id: '555' }));
    await runQueue();
    const event = await eventOf('900003');
    expect(event?.leadCreated).toBe(false);
    const first = await eventOf('900001');
    expect(event?.leadId).toBe(first?.leadId);
  });

  it('retries a Graph API outage, gives up on a permanent refusal, and never makes a lead it cannot call or write to', async () => {
    graphAnswers.set('900002', { status: 500, body: { error: { message: 'down' } } });
    await deliver(leadgenBody({ leadgen_id: '900002', form_id: '777999', page_id: '555' }));
    let run = await runQueue();
    expect(run).toMatchObject({ processed: 1, retried: 1, failed: 0 });
    let event = await eventOf('900002');
    expect(event).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'graph_500',
      leadId: null,
    });
    expect(event?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: a second pass leaves it alone.
    expect((await runQueue()).processed).toBe(0);

    graphAnswers.set('900002', { status: 400, body: { error: { message: 'no permission' } } });
    await db
      .update(metaLeadgenEvents)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(metaLeadgenEvents.leadgenId, '900002'));
    run = await runQueue();
    expect(run).toMatchObject({ processed: 1, failed: 1 });
    event = await eventOf('900002');
    expect(event).toMatchObject({ status: 'failed', lastError: 'graph_400', leadId: null });

    graphAnswers.set('900004', {
      status: 200,
      body: { id: '900004', field_data: [{ name: 'full_name', values: ['Só Nome'] }] },
    });
    await deliver(leadgenBody({ leadgen_id: '900004', form_id: '777999', page_id: '555' }));
    await runQueue();
    expect(await eventOf('900004')).toMatchObject({
      status: 'failed',
      lastError: 'no_contact_data',
      leadId: null,
    });
    const orphan = await db.select().from(leads).where(eq(leads.externalId, '900004'));
    expect(orphan).toHaveLength(0);
  });

  it('copies a Formatação form lead to RD CRM in "Sem contato" with the origin in OBS, and links an open deal instead of making a second one', async () => {
    rdMapAnswers();
    rdAnswers.set('GET /contacts', { status: 200, body: { contacts: [] } });
    rdAnswers.set('POST /deals', { status: 200, body: { _id: 'deal-new-1' } });
    graphAnswers.set('900010', {
      status: 200,
      body: {
        id: '900010',
        created_time: '2026-10-05T12:00:00+0000',
        field_data: [
          { name: 'full_name', values: ['Marina Costa'] },
          { name: 'email', values: ['marina@example.com'] },
          { name: 'phone_number', values: ['+5521988887777'] },
        ],
        campaign_id: '120009',
        campaign_name: 'Formatação Outubro',
        adset_name: 'Conjunto A',
        ad_name: 'Anúncio B',
        form_id: '1538007113903398',
        platform: 'fb',
      },
    });
    await deliver(
      leadgenBody({ leadgen_id: '900010', form_id: '1538007113903398', page_id: '555' }),
    );
    const run = await runQueue({ rd: true });
    expect(run).toMatchObject({ processed: 1, done: 1, rdCreated: 1 });
    const event = await eventOf('900010');
    expect(event).toMatchObject({ status: 'done', rdOutcome: 'created', rdDealId: 'deal-new-1' });
    const post = rdCalls.find((call) => call.method === 'POST' && call.path === '/deals');
    expect(post?.body).toMatchObject({
      deal: { name: 'Marina Costa', deal_stage_id: 'st-sem' },
      contacts: [{ name: 'Marina Costa', emails: [{ email: 'marina@example.com' }] }],
      deal_source: { _id: 'src-la' },
    });
    const obs = (
      post?.body as { deal: { deal_custom_fields: { custom_field_id: string; value: string }[] } }
    ).deal.deal_custom_fields.find((f) => f.custom_field_id === 'cf-obs');
    expect(obs?.value).toContain('formulário=1538007113903398');
    expect(obs?.value).toContain('campanha=Formatação Outubro');
    expect(obs?.value).not.toContain('Marina');
    // Formatação deals carry no owner (the seeded form rule is Wings / formatacao).
    expect((post?.body as { deal: Record<string, unknown> }).deal.user_id).toBeUndefined();
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, event?.leadId as string) });
    expect(lead).toMatchObject({
      rdDealId: 'deal-new-1',
      pipeline: 'formatacao',
      rdPipeline: 'Formatação',
    });

    // The contact already has an open deal: linked, no POST.
    rdCalls.length = 0;
    rdAnswers.set('GET /contacts', {
      status: 200,
      body: { contacts: [{ _id: 'c-1', deals: [{ _id: 'deal-open-9', win: null }] }] },
    });
    graphAnswers.set('900011', {
      status: 200,
      body: {
        id: '900011',
        field_data: [
          { name: 'full_name', values: ['Paulo Reis'] },
          { name: 'email', values: ['paulo@example.com'] },
        ],
        form_id: '1538007113903398',
      },
    });
    await deliver(
      leadgenBody({ leadgen_id: '900011', form_id: '1538007113903398', page_id: '555' }),
    );
    await runQueue({ rd: true });
    expect(await eventOf('900011')).toMatchObject({
      rdOutcome: 'existing_deal',
      rdDealId: 'deal-open-9',
    });
    expect(rdCalls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('opens a deal of its own for a form whose phone belongs to a lost deal nobody works, and reprocesses one the old rule only attached', async () => {
    // A seller in the Formatação rotation, so the new deal gets an owner.
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await db
      .insert(crmDistributionMembers)
      .values({ pipeline: 'formatacao', employeeId: seller.id, active: true });
    // The person's old deal: an RD mirror, lost, with neither owner nor stage (the 08/10 case).
    const old = await upsertLead(db, {
      source: 'rd_crm',
      name: 'Teste Antigo',
      phone: '+5561977770001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      importBatchId: 'rd-crm-test',
      skipResearch: true,
      event: { kind: 'lead.imported.rd_crm' },
    });
    await db
      .update(leads)
      .set({
        won: false,
        closedAt: new Date('2025-03-01T12:00:00Z'),
        lostReason: 'sem retorno',
        rdDealId: 'deal-lost-1',
      })
      .where(eq(leads.id, old.lead.id));
    expect(old.lead.ownerEmployeeId).toBeNull();
    expect(old.lead.stageId).toBeNull();
    const untouchedEnteredAt = old.lead.enteredAt;

    rdMapAnswers();
    rdCalls.length = 0;
    rdAnswers.set('GET /contacts', {
      status: 200,
      body: { contacts: [{ _id: 'c-old', deals: [{ _id: 'deal-lost-1', win: false }] }] },
    });
    rdAnswers.set('POST /deals', { status: 200, body: { _id: 'deal-new-2' } });
    graphAnswers.set('900040', {
      status: 200,
      body: {
        id: '900040',
        created_time: '2026-10-08T04:18:53+0000',
        field_data: [
          { name: 'full_name', values: ['Teste Antigo'] },
          { name: 'phone_number', values: ['+5561977770001'] },
          { name: 'faturamento', values: ['até 100 mil'] },
        ],
        campaign_id: '120252401895850076',
        campaign_name: 'Form 5 perguntas',
        ad_id: '120252401896000076',
        form_id: '1538007113903398',
        platform: 'ig',
      },
    });
    await deliver(
      leadgenBody({ leadgen_id: '900040', form_id: '1538007113903398', page_id: '555' }),
    );
    const run = await runQueue({ rd: true });
    expect(run).toMatchObject({ processed: 1, done: 1, rdCreated: 1 });
    const event = await eventOf('900040');
    expect(event).toMatchObject({
      status: 'done',
      leadCreated: true,
      rdOutcome: 'created',
      rdDealId: 'deal-new-2',
    });
    expect(event?.leadId).not.toBe(old.lead.id);
    const fresh = await db.query.leads.findFirst({ where: eq(leads.id, event?.leadId as string) });
    // Its own row: the form's arrival time and ad ids, and the new RD deal
    // (Leads das Campanhas attributes by these, and drops entered_at before 28/09).
    expect(fresh).toMatchObject({
      pipeline: 'formatacao',
      stage: 'Sem contato',
      ownerEmployeeId: seller.id,
      managedBy: 'wings',
      rdDealId: 'deal-new-2',
      adPlatform: 'meta',
      adCampaignExternalId: '120252401895850076',
      adExternalId: '120252401896000076',
      enteredAt: new Date('2026-10-08T04:18:53Z'),
      enteredAtSource: 'meta_created_time',
      formAnswers: { faturamento: 'até 100 mil' },
    });
    expect(fresh?.enteredAt?.getTime()).not.toBe(untouchedEnteredAt.getTime());
    // The old deal is as it was; the two are tied on both timelines.
    const untouched = await db.query.leads.findFirst({ where: eq(leads.id, old.lead.id) });
    expect(untouched).toMatchObject({ rdDealId: 'deal-lost-1', ownerEmployeeId: null, won: false });
    const freshEvents = await db.select().from(leadEvents).where(eq(leadEvents.leadId, fresh!.id));
    expect(freshEvents.find((e) => e.kind === 'lead.received.meta_lead_ads')?.detail).toMatchObject(
      { matched: 'reopened', reopenedFrom: old.lead.id },
    );
    const oldEvents = await db.select().from(leadEvents).where(eq(leadEvents.leadId, old.lead.id));
    expect(oldEvents.find((e) => e.kind === 'lead.reopened_as')?.detail).toMatchObject({
      newLeadId: fresh!.id,
      reason: 'closed',
    });
    // One person, one contact: both leads point at it.
    const links = await db
      .select({ leadId: leadContacts.leadId, contactId: leadContacts.contactId })
      .from(leadContacts);
    const oldLink = links.find((l) => l.leadId === old.lead.id);
    const freshLink = links.find((l) => l.leadId === fresh!.id);
    expect(oldLink?.contactId).toBeDefined();
    expect(freshLink?.contactId).toBe(oldLink?.contactId);
    // Fresh enough for the first-contact task (created_time is within a day of the fake clock? no: it is old) —
    // the queue treats an old form as a backfill: owner yes, task no.
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, fresh!.id) }),
    ).toBeUndefined();

    // An open lead with an owner still only gets the form attached (today's rule).
    graphAnswers.set('900041', {
      status: 200,
      body: {
        id: '900041',
        created_time: '2026-10-08T05:00:00+0000',
        field_data: [{ name: 'phone_number', values: ['+5561977770001'] }],
        form_id: '1538007113903398',
      },
    });
    await deliver(
      leadgenBody({ leadgen_id: '900041', form_id: '1538007113903398', page_id: '555' }),
    );
    await runQueue({ rd: true });
    const attached = await eventOf('900041');
    expect(attached).toMatchObject({ leadCreated: false, leadId: fresh!.id, rdOutcome: 'existing_deal' });

    // The reprocess command: that attached event, once its lead is lost and dropped by its owner.
    await db
      .update(leads)
      .set({ won: false, closedAt: new Date('2026-10-09T12:00:00Z'), ownerEmployeeId: null, stageId: null, stage: null })
      .where(eq(leads.id, fresh!.id));
    const deps = {
      db,
      accessToken: 'fake-leads-token',
      rdCrmToken: 'rd-token',
      expansionOwnerId: null,
      rdCopyEnabled: true,
      graphFetch: app.wings.platformFetch,
      rdFetch,
      log: () => undefined,
    };
    const estado = await reprocessMetaLeadgenEvent(deps, '900041', 'estado');
    expect(estado).toMatchObject({
      refusal: null,
      plan: null,
      attachedTo: { id: fresh!.id, closed: true, workable: false },
    });
    rdAnswers.set('GET /contacts', {
      status: 200,
      body: { contacts: [{ _id: 'c-old', deals: [{ _id: 'deal-new-2', win: false }] }] },
    });
    rdAnswers.set('POST /deals', { status: 200, body: { _id: 'deal-new-3' } });
    rdCalls.length = 0;
    const leadsBefore = (await db.select({ id: leads.id }).from(leads)).length;
    const simulado = await reprocessMetaLeadgenEvent(deps, '900041', 'simular');
    expect(simulado.plan).toMatchObject({
      opensNewLead: true,
      pipeline: 'formatacao',
      entryStage: 'Sem contato',
      rd: 'would_create',
    });
    expect(simulado.result).toBeNull();
    expect((await db.select({ id: leads.id }).from(leads)).length).toBe(leadsBefore);
    expect(await eventOf('900041')).toMatchObject({ leadCreated: false, leadId: fresh!.id });
    expect(rdCalls.some((call) => call.method === 'POST')).toBe(false);

    const aplicado = await reprocessMetaLeadgenEvent(deps, '900041', 'aplicar');
    expect(aplicado.result).toMatchObject({
      owner: expect.any(String),
      stage: 'Sem contato',
      task: true,
      rdOutcome: 'created',
      rdDealId: 'deal-new-3',
    });
    const reopened = await eventOf('900041');
    expect(reopened).toMatchObject({ status: 'done', leadCreated: true, rdDealId: 'deal-new-3' });
    expect(reopened?.leadId).not.toBe(fresh!.id);
    const third = await db.query.leads.findFirst({ where: eq(leads.id, reopened?.leadId as string) });
    expect(third).toMatchObject({ pipeline: 'formatacao', stage: 'Sem contato', ownerEmployeeId: seller.id });
    // Old form, but asked for by hand: the seller gets the task anyway.
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, third!.id) }),
    ).toMatchObject({ kind: 'first_contact' });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'lead.meta_reprocessed'));
    expect(audit.at(-1)?.metadata).toMatchObject({ previousLeadId: fresh!.id, newLeadId: third!.id });
    // Run again: nothing to reopen.
    expect((await reprocessMetaLeadgenEvent(deps, '900041', 'estado')).refusal).toContain('criou o próprio lead');
  });

  it('puts the lead in the Wings System even when RD CRM is down, and copies it on a later try', async () => {
    rdAnswers.clear();
    rdAnswers.set('GET /deal_pipelines', { status: 500, body: {} });
    graphAnswers.set('900020', {
      status: 200,
      body: {
        id: '900020',
        field_data: [
          { name: 'full_name', values: ['Rita Lima'] },
          { name: 'phone_number', values: ['+5511955554444'] },
        ],
        form_id: '1538007113903398',
        platform: 'fb',
      },
    });
    await deliver(
      leadgenBody({ leadgen_id: '900020', form_id: '1538007113903398', page_id: '555' }),
    );
    let run = await runQueue({ rd: true });
    expect(run).toMatchObject({ processed: 1, retried: 1, done: 0 });
    let event = await eventOf('900020');
    expect(event).toMatchObject({ status: 'pending', lastError: 'rd_failed', rdOutcome: 'failed' });
    expect(event?.leadId).toBeTruthy();
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, event?.leadId as string) });
    expect(lead).toMatchObject({ pipeline: 'formatacao', stage: 'Sem contato', rdDealId: null });

    // RD is back: the retry copies without reading the Graph API again.
    const graphBefore = graphCalls.filter((path) => path.endsWith('/900020')).length;
    rdMapAnswers();
    rdAnswers.set('GET /contacts', { status: 200, body: { contacts: [] } });
    rdAnswers.set('POST /deals', { status: 200, body: { _id: 'deal-late-1' } });
    await db
      .update(metaLeadgenEvents)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(metaLeadgenEvents.leadgenId, '900020'));
    run = await runQueue({ rd: true });
    expect(run).toMatchObject({ processed: 1, done: 1, rdCreated: 1 });
    event = await eventOf('900020');
    expect(event).toMatchObject({ status: 'done', rdOutcome: 'created', rdDealId: 'deal-late-1' });
    expect(graphCalls.filter((path) => path.endsWith('/900020')).length).toBe(graphBefore);
    const post = rdCalls.filter((call) => call.method === 'POST' && call.path === '/deals').at(-1);
    expect(post?.body).toMatchObject({ deal: { deal_stage_id: 'st-sem' } });
  });

  it('"Buscar leads da Meta" lists the last 90 days of every form with a rule and queues only what is new', async () => {
    const admin = await sessionFor('admin_master');
    graphAnswers.set('form:1538007113903398', {
      status: 200,
      body: {
        data: [
          { id: '900010', created_time: '2026-10-01T10:00:00+0000' },
          { id: '900030', created_time: '2026-10-02T10:00:00+0000', ad_id: '140030' },
        ],
        paging: { cursors: { before: 'a', after: 'b' } },
      },
    });
    graphAnswers.set('form:777001', { status: 200, body: { data: [] } });
    graphAnswers.set('form:777002', { status: 400, body: { error: { message: 'no form' } } });
    const marketing = await sessionFor('marketing');
    // A seller may not start a sync.
    const seller = await sessionFor('vendedor_expansao');
    const refused = await app.inject({
      method: 'POST',
      url: '/crm/meta-leads/sync',
      cookies: seller.cookies,
    });
    expect(refused.statusCode).toBe(403);
    void marketing;

    const sync = await app.inject({
      method: 'POST',
      url: '/crm/meta-leads/sync',
      cookies: admin.cookies,
    });
    expect(sync.statusCode).toBe(202);
    const totals = sync.json<{
      forms: number;
      listed: number;
      queued: number;
      alreadyKnown: number;
      failed: Record<string, string>;
    }>();
    expect(totals).toMatchObject({ listed: 2, queued: 1, alreadyKnown: 1 });
    expect(totals.forms).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(totals)).not.toContain('@');
    expect(await eventOf('900030')).toMatchObject({
      status: 'pending',
      formId: '1538007113903398',
      adId: '140030',
    });

    const status = await app.inject({
      method: 'GET',
      url: '/crm/meta-leads/status',
      cookies: admin.cookies,
    });
    expect(status.json()).toMatchObject({ pending: expect.any(Number), done: expect.any(Number) });
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'meta_leads.sync_requested'));
    expect(audit).toHaveLength(1);
  });

  it('drops the raw payload after 90 days and keeps the row', async () => {
    await db
      .update(metaLeadgenEvents)
      .set({ receivedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(metaLeadgenEvents.leadgenId, '900001'));
    const { purged } = await purgeMetaLeadgenPayloads(db);
    expect(purged).toBe(1);
    const event = await eventOf('900001');
    expect(event?.payload).toBeNull();
    expect(event?.status).toBe('done');
    expect((await purgeMetaLeadgenPayloads(db)).purged).toBe(0);
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
    // "Criar negociação" (05/10): no LGPD fields on the modal; a deal typed in is legitimate interest.
    const noBasis = await app.inject({
      method: 'POST',
      url: '/leads',
      cookies,
      payload: { name: 'Sem base', phone: '11988887777' },
    });
    expect(noBasis.statusCode).toBe(201);
    expect(noBasis.json<{ lead: Lead }>().lead.consent.legalBasis).toBe('legitimate_interest');
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
