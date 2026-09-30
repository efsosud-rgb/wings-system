import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { runFormatacaoOnce } from './formatacao.js';

let harness: TestDatabase;
let db: Database;
const calls: {
  method: string;
  path: string;
  body?: { deal?: Record<string, unknown>; [k: string]: unknown };
}[] = [];
let stageName = 'Sem contato';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const now = new Date('2026-09-30T13:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const conversions: Record<string, { identifier: string; at: string }> = {
  u1: { identifier: 'lp-formatacao-whatsapp', at: ago(120) },
  u2: { identifier: 'wings-company-form-site', at: ago(180) },
  u3: { identifier: 'Formulário Simplificado. -02', at: ago(240) },
  u4: { identifier: 'lp-formatacao-whatsapp', at: ago(5) },
  u5: { identifier: 'lp-calcadao-do-frango', at: ago(100) },
};

const rdFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  calls.push({
    method,
    path: url.pathname,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (url.pathname === '/auth/token') return json({ access_token: 't' });
  if (url.host === 'api.rd.services') {
    if (url.pathname.endsWith('/contacts')) {
      return json({
        contacts:
          url.searchParams.get('page') === '1'
            ? Object.keys(conversions).map((uuid) => ({
                uuid,
                last_conversion_date: conversions[uuid]!.at,
              }))
            : [],
      });
    }
    const uuid = url.pathname.split('/')[3]!;
    const c = conversions[uuid]!;
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
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/v1/deal_pipelines':
      return json([
        { id: 'p-for', name: 'Formatação', deal_stages: [{ id: 's-for-nc', name: stageName }] },
      ]);
    case 'GET /api/v1/custom_fields':
      return json({ custom_fields: [{ id: 'cf-obs', label: 'OBS' }] });
    case 'GET /api/v1/deal_sources':
      return json({ deal_sources: [{ id: 'src-site', name: 'Contato pelo Site' }] });
    case 'GET /api/v1/campaigns':
      return json({ campaigns: [{ id: 'camp-for', name: 'SITE WINGS // FORMATAÇÃO' }] });
    case 'GET /api/v1/contacts':
      // u2 already has an open deal in RD CRM; nobody else is a contact.
      return url.searchParams.get('email') === 'u2@example.com'
        ? json({ contacts: [{ id: 'c2', deals: [{ id: 'd-open', win: null }] }] })
        : json({ contacts: [] });
    case 'POST /api/v1/deals':
      return json({
        id: `deal-${calls.filter((x) => x.method === 'POST' && x.path === '/api/v1/deals').length}`,
      });
    default:
      if (method === 'GET' && url.pathname.startsWith('/api/v1/deals/')) {
        return json({ contacts: [{}], deal_source: {} });
      }
      return json({}, 404);
  }
};

const credentials = {
  rdCrmToken: 'crm',
  rdMarketing: { clientId: 'i', clientSecret: 's', refreshToken: 'r' },
};
const dealPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/deals');
const audits = (action: string) =>
  db.query.auditLog.findMany({
    where: eq(auditLog.action, action),
    orderBy: (t, { asc }) => [asc(t.at)],
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
});
afterAll(async () => {
  await harness?.drop();
});

describe('the Formatação safety net', () => {
  it('a dry run counts and audits, and creates nothing', async () => {
    const pass = await runFormatacaoOnce(db, credentials, {
      lookbackHours: 72,
      dryRun: true,
      fetchImpl: rdFetch,
      now,
    });
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

  it('a real run makes the missing deals in Formatação / Sem contato with the origin, never touching an open deal', async () => {
    const pass = await runFormatacaoOnce(db, credentials, {
      lookbackHours: 72,
      dryRun: false,
      fetchImpl: rdFetch,
      now,
    });
    expect(pass.result?.createdDealIds).toHaveLength(2);
    const posts = dealPosts();
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.body?.deal).toMatchObject({ deal_stage_id: 's-for-nc' });
      expect(post.body?.deal?.user_id).toBeUndefined();
      expect(post.body).toMatchObject({
        campaign: { _id: 'camp-for' },
        deal_source: { _id: 'src-site' },
      });
      expect(JSON.stringify(post.body?.deal?.deal_custom_fields)).toMatch(
        /conversão=.*utm|source=google/s,
      );
    }
    expect(JSON.stringify(posts.map((p) => p.body?.deal?.deal_custom_fields))).toContain(
      'conversão=lp-formatacao-whatsapp',
    );
    // Nothing was written to the contact who already had an open deal: no PUT/PATCH/DELETE at all.
    expect(calls.filter((c) => ['PUT', 'PATCH', 'DELETE'].includes(c.method))).toHaveLength(0);
    const [row] = await audits('formatacao.intake_run');
    expect(row?.metadata).toMatchObject({ created: 2, dealIds: pass.result?.createdDealIds });
    expect(JSON.stringify(row?.metadata)).not.toContain('example.com');
  });

  it('a second pass makes nothing more: the ledger has decided them', async () => {
    const before = dealPosts().length;
    const pass = await runFormatacaoOnce(db, credentials, {
      lookbackHours: 72,
      dryRun: false,
      fetchImpl: rdFetch,
      now,
    });
    expect(dealPosts()).toHaveLength(before);
    expect(pass.result).toMatchObject({ alreadyDecided: 3, createdDealIds: [] });
  });

  it('stops and audits when the Sem contato stage is not in Formatação', async () => {
    stageName = 'Outra etapa';
    const before = dealPosts().length;
    const pass = await runFormatacaoOnce(db, credentials, {
      lookbackHours: 72,
      dryRun: false,
      fetchImpl: rdFetch,
      now,
    });
    stageName = 'Sem contato';
    expect(pass).toMatchObject({ stageFound: false, result: null });
    expect(dealPosts()).toHaveLength(before);
    const [blocked] = await audits('formatacao.intake_blocked');
    expect(blocked?.metadata).toMatchObject({ pipelines: { Formatação: ['Outra etapa'] } });
  });
});
