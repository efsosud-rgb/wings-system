import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { runFormatacaoOnce } from './formatacao.js';

let harness: TestDatabase;
let db: Database;

type Way =
  'contact.deal_ids' | 'deal.contacts_id' | 'contact.create_with_deal' | 'deal.contacts_full';

/** A simulated RD Marketing + RD CRM whose behaviour each test sets. */
const world = {
  conversions: {} as Record<string, { identifier: string; at: string }>,
  /** Contacts RD CRM already knows, by e-mail. */
  crmContacts: {} as Record<string, { id: string; open?: boolean }>,
  /** Does RD keep the contact sent inside POST /deals? */
  keepsContactOnCreate: true,
  /** The one way of tying a contact to a deal that RD accepts (null: none does). */
  linkWorksVia: null as Way | null,
  deals: new Map<string, { contact: boolean; body?: Record<string, unknown> }>(),
  calls: [] as { method: string; path: string; body?: Record<string, unknown> }[],
  stageName: 'Sem contato',
  stageNameNow: () => world.stageName,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const rdFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  world.calls.push({ method, path: url.pathname, body });
  if (url.pathname === '/auth/token') return json({ access_token: 't' });
  if (url.host === 'api.rd.services') {
    if (url.pathname.endsWith('/events')) {
      const uuid = url.pathname.split('/')[3]!;
      const c = world.conversions[uuid]!;
      return json([
        {
          event_type: 'CONVERSION',
          event_timestamp: c.at,
          payload: {
            conversion_identifier: c.identifier,
            email: `${uuid}@example.com`,
            name: `Pessoa ${uuid}`,
            traffic_source:
              'encoded_' +
              Buffer.from(
                JSON.stringify({
                  current_session: {
                    value: 'https://wings.example/?utm_source=google&utm_campaign=Alta',
                  },
                }),
              ).toString('base64'),
          },
        },
      ]);
    }
    if (url.pathname.endsWith('/contacts')) {
      return json({
        contacts:
          url.searchParams.get('page') === '1'
            ? Object.entries(world.conversions).map(([uuid, c]) => ({
                uuid,
                last_conversion_date: c.at,
              }))
            : [],
      });
    }
    // GET /platform/contacts/:uuid
    const uuid = url.pathname.split('/')[3]!;
    return json({
      name: `Pessoa ${uuid}`,
      email: `${uuid}@example.com`,
      mobile_phone: '11999990000',
    });
  }
  const path = url.pathname.replace('/api/v1', '');
  const ok = (way: Way, dealId?: string) => {
    if (world.linkWorksVia !== way) return json({}, 422);
    if (dealId) world.deals.get(dealId)!.contact = true;
    return json({ id: 'x' });
  };
  if (method === 'GET' && path === '/deal_pipelines') {
    return json([
      {
        id: 'p-for',
        name: 'Formatação',
        deal_stages: [{ id: 's-for', name: world.stageNameNow() }],
      },
    ]);
  }
  if (method === 'GET' && path === '/custom_fields')
    return json({ custom_fields: [{ id: 'cf-obs', label: 'OBS' }] });
  if (method === 'GET' && path === '/deal_sources')
    return json({ deal_sources: [{ id: 'src', name: 'Contato pelo Site' }] });
  if (method === 'GET' && path === '/campaigns')
    return json({ campaigns: [{ id: 'camp', name: 'SITE WINGS // FORMATAÇÃO' }] });
  if (method === 'GET' && path === '/contacts') {
    const email = url.searchParams.get('email') ?? '';
    const known = world.crmContacts[email];
    return json({
      contacts: known
        ? [{ id: known.id, deals: known.open ? [{ id: 'd-old', win: null }] : [] }]
        : [],
    });
  }
  if (method === 'POST' && path === '/deals') {
    const id = `deal-${world.deals.size + 1}`;
    world.deals.set(id, { contact: world.keepsContactOnCreate, body });
    return json({ id });
  }
  if (method === 'GET' && path.startsWith('/deals/')) {
    const deal = world.deals.get(path.split('/')[2]!);
    return json({ contacts: deal?.contact ? [{}] : [], deal_source: {} });
  }
  if (method === 'PUT' && path.startsWith('/contacts/')) {
    const ids = ((body?.contact as { deal_ids?: string[] } | undefined)?.deal_ids ??
      []) as string[];
    const result = ok('contact.deal_ids');
    if (world.linkWorksVia === 'contact.deal_ids')
      for (const id of ids) world.deals.get(id)!.contact = true;
    return result;
  }
  if (method === 'PUT' && path.startsWith('/deals/')) {
    const dealId = path.split('/')[2]!;
    const contacts = (body?.contacts ?? []) as { _id?: string; name?: string }[];
    return contacts[0]?._id ? ok('deal.contacts_id', dealId) : ok('deal.contacts_full', dealId);
  }
  if (method === 'POST' && path === '/contacts') {
    const ids = ((body?.contact as { deal_ids?: string[] } | undefined)?.deal_ids ??
      []) as string[];
    const result = ok('contact.create_with_deal');
    if (world.linkWorksVia === 'contact.create_with_deal')
      for (const id of ids) world.deals.get(id)!.contact = true;
    return result;
  }
  if (method === 'POST' && path === '/tasks') return json({ id: 'task' });
  return json({}, 404);
};

const credentials = {
  rdCrmToken: 'crm',
  rdMarketing: { clientId: 'i', clientSecret: 's', refreshToken: 'r' },
};
const run = (dryRun: boolean) =>
  runFormatacaoOnce(db, credentials, { lookbackHours: 72, dryRun, fetchImpl: rdFetch, now });
const audits = (action: string) =>
  db.query.auditLog.findMany({
    where: eq(auditLog.action, action),
    orderBy: (t, { asc }) => [asc(t.at)],
  });
const dealPosts = () =>
  world.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/deals');
const writes = () => world.calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/token');

beforeEach(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  world.conversions = {
    u1: { identifier: 'lp-formatacao-whatsapp', at: ago(120) },
    u2: { identifier: 'wings-company-form-site', at: ago(180) },
    u3: { identifier: 'Formulário Simplificado. -02', at: ago(240) },
    u4: { identifier: 'lp-formatacao-whatsapp', at: ago(5) },
    u5: { identifier: 'lp-calcadao-do-frango', at: ago(100) },
  };
  world.crmContacts = { 'u2@example.com': { id: 'c2', open: true } };
  world.keepsContactOnCreate = true;
  world.linkWorksVia = null;
  world.deals = new Map();
  world.calls = [];
  world.stageName = 'Sem contato';
});
afterEach(async () => {
  await harness?.drop();
});

describe('the Formatação safety net', () => {
  it('a dry run counts and audits, and creates nothing', async () => {
    const pass = await run(true);
    expect(pass.result).toMatchObject({
      created: { formatacao: 2 },
      createdByIdentifier: { 'lp-formatacao-whatsapp': 1, 'Formulário Simplificado. -02': 1 },
      existingDeal: 1,
      settling: 1,
      failed: 0,
    });
    expect(dealPosts()).toHaveLength(0);
    const [row] = await audits('formatacao.intake_dry_run');
    expect(row?.metadata).toMatchObject({
      wouldCreate: 2,
      existingDeal: 1,
      settling: 1,
      dealIds: [],
    });
  });

  it('a real run makes the missing deals born with their contact, and never touches an open deal', async () => {
    const pass = await run(false);
    expect(pass.result?.createdDealIds).toHaveLength(2);
    expect(pass.result).toMatchObject({ linked: 0, orphanDealIds: [] });
    for (const post of dealPosts()) {
      expect(post.body?.deal).toMatchObject({ deal_stage_id: 's-for' });
      expect(post.body).toMatchObject({ campaign: { _id: 'camp' }, deal_source: { _id: 'src' } });
      expect(post.body?.contacts).toHaveLength(1);
    }
    expect(JSON.stringify(dealPosts().map((p) => p.body?.deal))).toContain(
      'conversão=lp-formatacao-whatsapp',
    );
    // Nothing but the two creations was written: the contact with an open deal was left alone.
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/deals',
      'POST /api/v1/deals',
    ]);
    expect(await audits('formatacao.intake_linked_ok')).toHaveLength(1);
    const [row] = await audits('formatacao.intake_run');
    expect(JSON.stringify(row?.metadata)).not.toContain('example.com');
  });

  it('a second pass makes nothing more: the ledger has decided them', async () => {
    await run(false);
    const before = dealPosts().length;
    const pass = await run(false);
    expect(dealPosts()).toHaveLength(before);
    expect(pass.result).toMatchObject({ alreadyDecided: 3, createdDealIds: [] });
  });

  it('ties a contact RD dropped on creation, by the way RD accepts, and reads the deal back', async () => {
    world.keepsContactOnCreate = false;
    world.crmContacts['u1@example.com'] = { id: 'c1' };
    world.crmContacts['u3@example.com'] = { id: 'c3' };
    world.linkWorksVia = 'contact.deal_ids';
    const pass = await run(false);
    expect(pass.result).toMatchObject({ linked: 2, orphanDealIds: [] });
    expect(pass.result?.linkAttempts).toMatchObject({ 'contact.deal_ids:200': 2 });
    // Every made deal now shows a contact when read back.
    expect([...world.deals.values()].every((deal) => deal.contact)).toBe(true);
    const put = world.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/contacts/c1');
    expect(put?.body).toEqual({ contact: { deal_ids: ['deal-1'] } });
    expect(await audits('formatacao.intake_halted')).toHaveLength(0);
  });

  it('when no way ties a contact it stops creating: it counts only, until a deal reads back with one', async () => {
    world.keepsContactOnCreate = false;
    const first = await run(false);
    expect(first.result?.orphanDealIds.length).toBeGreaterThan(0);
    expect((await audits('formatacao.intake_halted')).length).toBeGreaterThan(0);
    // New conversion arrives: the net is halted, so it only counts.
    world.conversions.u6 = { identifier: 'wings-company-form-site', at: ago(60) };
    world.crmContacts = {};
    const posts = dealPosts().length;
    const second = await run(false);
    expect(second.halted).toBe(true);
    expect(second.dryRun).toBe(true);
    expect(dealPosts()).toHaveLength(posts);
    const dry = await audits('formatacao.intake_dry_run');
    expect(dry.at(-1)?.metadata).toMatchObject({ haltedByOrphan: true, wouldCreate: 1 });

    // RD starts accepting one way: the repair ties the old orphans and the net resumes.
    world.linkWorksVia = 'deal.contacts_full';
    const third = await run(false);
    expect(third.repair?.linked).toBeGreaterThan(0);
    expect(third.halted).toBe(false);
    expect(dealPosts().length).toBeGreaterThan(posts);
    expect([...world.deals.values()].every((deal) => deal.contact)).toBe(true);
  });

  it('stops and audits, with the pipeline names, when the entry stage is not in Formatação', async () => {
    world.stageName = 'Outra etapa';
    const pass = await run(false);
    expect(pass).toMatchObject({ stageFound: false, result: null });
    expect(dealPosts()).toHaveLength(0);
    const [blocked] = await audits('formatacao.intake_blocked');
    expect(blocked?.metadata).toMatchObject({ pipelines: { Formatação: ['Outra etapa'] } });
  });
});
