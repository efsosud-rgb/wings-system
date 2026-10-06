import { WINGS_CLIENT_ID, type LeadChecks } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { guardedLookup, isPublicAddress, probePublicUrl } from '../../lib/public-probe.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { checkLeadFields, createInstagramDiscovery, type LeadCheckDeps } from './field-checks.js';
import { upsertLead } from './service.js';

const KEY = 'chave-do-google-ads-de-teste-123';
const NOW = new Date('2026-10-06T15:00:00Z');
const quiet = () => {};
const log = {
  info: quiet,
  warn: quiet,
  error: quiet,
  debug: quiet,
  child: () => log,
} as unknown as FastifyBaseLogger;

let harness: TestDatabase;
let db: Database;
let open: FastifyInstance;
let closed: FastifyInstance;

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ...extra,
  });

const stubs: Partial<LeadCheckDeps> = {
  probe: async () => ({ kind: 'ok', status: 200 }),
  instagram: async () => ({ status: 'confere', reason: null, checkedAt: NOW.toISOString() }),
  cnpj: async () => ({
    ok: true,
    value: { source: 'brasilapi', registrationStatus: 'ATIVA', company: {}, partners: [] },
  }),
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  closed = await buildApp({ env: env(), db, now: () => NOW });
  // Built last: its stubbed checks are the ones configured for the process.
  open = await buildApp({
    env: env({ GOOGLE_ADS_LEADS_WEBHOOK_KEY: KEY }),
    db,
    now: () => NOW,
    leadChecks: stubs,
  });
}, 60_000);

afterAll(async () => {
  await open?.close();
  await closed?.close();
  await harness?.drop();
});

const googleBody = (over: Record<string, unknown> = {}) => ({
  lead_id: `lead-${Math.random().toString(36).slice(2)}`,
  api_version: '1.0',
  form_id: 123456,
  campaign_id: 987654,
  adgroup_id: 111,
  creative_id: 222,
  google_key: KEY,
  is_test: false,
  user_column_data: [
    { column_id: 'FULL_NAME', column_name: 'Full Name', string_value: 'Pessoa Exemplo' },
    { column_id: 'PHONE_NUMBER', column_name: 'User Phone', string_value: '+55 21 98888-7777' },
    { column_id: 'COMPANY_NAME', column_name: 'Company name', string_value: 'Empresa Exemplo' },
    {
      column_id: 'q1',
      column_name: 'Qual o @ do Instagram da empresa?',
      string_value: '@empresa.exemplo',
    },
    { column_id: 'q2', column_name: 'Site da empresa', string_value: 'empresa-exemplo.com.br' },
    { column_id: 'q3', column_name: 'Faturamento mensal', string_value: 'Até 50 mil' },
  ],
  ...over,
});

async function waitForChecks(leadId: string): Promise<LeadChecks> {
  for (let i = 0; i < 50; i++) {
    const [row] = await db
      .select({ checks: leads.fieldChecks })
      .from(leads)
      .where(eq(leads.id, leadId));
    const checks = row?.checks as LeadChecks | undefined;
    if (checks?.website && checks.website.status !== 'pendente') return checks;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('checks never ran');
}

describe('POST /integrations/google-ads/leads/webhook', () => {
  it('answers 503 while the key is not configured', async () => {
    const response = await closed.inject({
      method: 'POST',
      url: '/integrations/google-ads/leads/webhook',
      payload: googleBody(),
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 401 with a wrong key', async () => {
    const response = await open.inject({
      method: 'POST',
      url: '/integrations/google-ads/leads/webhook',
      payload: googleBody({ google_key: 'chave-errada-com-tamanho-ok' }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers 200 to Google's test data without making a lead", async () => {
    const before = await db.select({ id: leads.id }).from(leads);
    const response = await open.inject({
      method: 'POST',
      url: '/integrations/google-ads/leads/webhook',
      payload: googleBody({ is_test: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: 0, test: true });
    expect(await db.select({ id: leads.id }).from(leads)).toHaveLength(before.length);
  });

  it('makes the lead with the five fields in their own place, then checks them', async () => {
    const response = await open.inject({
      method: 'POST',
      url: '/integrations/google-ads/leads/webhook',
      payload: googleBody(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: 1 });
    const [row] = await db.select().from(leads).where(eq(leads.source, 'google_lead_form'));
    expect(row).toMatchObject({
      name: 'Pessoa Exemplo',
      phone: '5521988887777',
      instagram: 'empresa.exemplo',
      website: 'https://empresa-exemplo.com.br/',
      companyName: 'Empresa Exemplo',
      companyCnpj: null,
      channel: 'google_lead_form',
      formId: '123456',
      campaignId: '987654',
    });
    expect(row?.formAnswers).toMatchObject({ 'Faturamento mensal': 'Até 50 mil' });

    const checks = await waitForChecks(row!.id);
    expect(checks.whatsapp?.status).toBe('confere');
    expect(checks.website?.status).toBe('confere');
    expect(checks.instagram?.status).toBe('confere');
    expect(checks.cnpj).toMatchObject({
      status: 'nao_verificado',
      reason: 'O formulário não trouxe CNPJ',
    });
  });
});

describe('upsertLead and the form fields', () => {
  it('fills phone and fields from answers when the platform did not map them', async () => {
    const result = await upsertLead(db, {
      source: 'tiktok_lead_ads',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      name: null,
      email: 'pessoa.formulario@example.com',
      phone: null,
      formAnswers: {
        'Nome completo': 'Outra Pessoa',
        'WhatsApp com DDD': '(11) 97777-6666',
        'Nome da empresa': 'Loja Exemplo',
        Instagram: 'https://instagram.com/loja_exemplo/',
        CNPJ: '11.222.333/0001-81',
      },
      event: { kind: 'lead.received.tiktok_lead_ads' },
    });
    expect(result.lead).toMatchObject({
      name: 'Outra Pessoa',
      phone: '5511977776666',
      instagram: 'loja_exemplo',
      companyName: 'Loja Exemplo',
      companyCnpj: '11222333000181',
      website: null,
    });
  });
});

describe('upsertLead and the question texts', () => {
  it('takes "WhatsApp da empresa" as the WhatsApp and only a name question as the company', async () => {
    const result = await upsertLead(db, {
      source: 'meta_lead_ads',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      name: 'Pessoa Dois',
      email: 'pessoa.dois@example.com',
      phone: null,
      formAnswers: {
        'Melhor horário para contato': 'Manhã',
        'Quantos funcionários a empresa tem?': '10 a 50',
        'WhatsApp da empresa': '(11) 96666-5555',
        'Nome da sua empresa': 'Loja Dois',
      },
      event: { kind: 'lead.received.meta_lead_ads' },
    });
    expect(result.lead).toMatchObject({ phone: '5511966665555', companyName: 'Loja Dois' });
  });

  it('does not check what an import or the RD mirror brings (checked on "Conferir de novo")', async () => {
    const result = await upsertLead(db, {
      source: 'rd_crm',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      name: 'Pessoa Três',
      email: 'pessoa.tres@example.com',
      phone: '5521977776666',
      formAnswers: { 'Site da empresa': 'empresa-tres.com.br' },
      event: { kind: 'lead.received.rd_crm' },
    });
    expect(result.created).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [row] = await db
      .select({ checks: leads.fieldChecks })
      .from(leads)
      .where(eq(leads.id, result.lead.id));
    expect(row?.checks).toEqual({});
  });
});

describe('arrival checks', () => {
  const base: LeadCheckDeps = { probe: null, instagram: null, cnpj: null, now: () => NOW, log };

  it('says why when a check could not run', async () => {
    const checks = await checkLeadFields(
      {
        phone: '5521988887777',
        website: 'exemplo.com.br',
        instagram: 'exemplo',
        companyCnpj: '11222333000181',
      },
      base,
    );
    expect(checks.website?.reason).toBe('Conferência de site desligada neste ambiente');
    expect(checks.instagram?.reason).toBe(
      'A consulta ao Instagram não está configurada (conta da Wings)',
    );
    expect(checks.cnpj?.reason).toBe('Consulta à base pública desligada neste ambiente');
  });

  it('reads site and CNPJ answers', async () => {
    const lead = {
      phone: null,
      website: 'https://exemplo.com.br/',
      instagram: null,
      companyCnpj: '11222333000181',
    };
    const down = await checkLeadFields(lead, {
      ...base,
      probe: async () => ({ kind: 'http_error', status: 404 }),
      cnpj: async () => ({
        ok: true,
        value: { source: 'brasilapi', registrationStatus: 'BAIXADA', company: {}, partners: [] },
      }),
    });
    expect(down.website).toMatchObject({
      status: 'nao_confere',
      reason: 'O site respondeu com erro 404',
    });
    expect(down.cnpj).toMatchObject({
      status: 'nao_confere',
      reason: 'Situação na Receita: BAIXADA',
    });
    expect(down.whatsapp).toMatchObject({ status: 'nao_verificado' });

    const gone = await checkLeadFields(
      { ...lead, companyCnpj: '11222333000180' },
      { ...base, probe: async () => ({ kind: 'not_found' }) },
    );
    expect(gone.website?.reason).toBe('O domínio não existe');
    expect(gone.cnpj?.reason).toBe('Os dígitos verificadores do CNPJ não batem');
  });

  it('takes "não tenho" as an answer and a site that refuses robots as not verified', async () => {
    const none = await checkLeadFields(
      { phone: null, website: 'Não tenho', instagram: 'não tenho', companyCnpj: '-' },
      {
        ...base,
        probe: async () => {
          throw new Error('"não tenho" is never probed');
        },
      },
    );
    expect(none.website).toMatchObject({
      status: 'nao_verificado',
      reason: 'Respondeu que não tem site',
    });
    expect(none.instagram).toMatchObject({
      status: 'nao_verificado',
      reason: 'Respondeu que não tem Instagram',
    });
    expect(none.cnpj).toMatchObject({
      status: 'nao_verificado',
      reason: 'Respondeu que não tem CNPJ',
    });

    const refused = await checkLeadFields(
      { phone: null, website: 'https://exemplo.com.br/', instagram: null, companyCnpj: null },
      { ...base, probe: async () => ({ kind: 'http_error', status: 403 }) },
    );
    expect(refused.website).toMatchObject({
      status: 'nao_verificado',
      reason: 'O site recusou a conferência automática (erro 403)',
    });
  });

  it('asks Instagram with the token in a header and reads its answers', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const lookup = (fetchImpl: typeof fetch) =>
      createInstagramDiscovery({
        accountId: '17841400000000000',
        token: 'tok',
        fetch: fetchImpl,
        now: () => NOW,
        log,
      });

    expect(
      (await lookup(answer(200, { business_discovery: { username: 'exemplo' } }))('exemplo'))
        .status,
    ).toBe('confere');
    expect(seen[0]?.url).not.toContain('tok');
    expect(seen[0]?.auth).toBe('Bearer tok');
    expect((await lookup(answer(400, { error: { code: 110 } }))('exemplo')).reason).toBe(
      'Não achado como conta comercial: pode ser conta pessoal ou não existir',
    );
    expect((await lookup(answer(400, { error: { code: 190 } }))('exemplo')).reason).toBe(
      'A conta da Wings não está autorizada a consultar o Instagram',
    );
  });
});

describe('public probe (SSRF guard)', () => {
  it.each([
    ['8.8.8.8', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.5', false],
    ['192.168.1.10', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['::ffff:10.0.0.1', false],
    // The URL parser writes an IPv4 inside an IPv6 in hex: still judged as that IPv4.
    ['::ffff:a9fe:a9fe', false],
    ['::ffff:7f00:1', false],
    ['0:0:0:0:0:ffff:a00:1', false],
    ['::ffff:0:7f00:1', false],
    ['::7f00:1', false],
    ['::', false],
    ['2002:a9fe:a9fe::1', false],
    ['64:ff9b::a9fe:a9fe', false],
    ['fe80::1%eth0', false],
    ['fec0::1', false],
    ['ff02::1', false],
    ['::ffff:808:808', true],
    ['2606:4700::1111', true],
  ])('%s public? %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('refuses an IPv4 inside an IPv6 literal in any spelling (a redirect hop is parsed by URL)', async () => {
    for (const url of [
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::1]/',
    ]) {
      expect(new URL(url).hostname).not.toContain('.');
      expect(await probePublicUrl(url)).toEqual({ kind: 'blocked' });
    }
  });

  it('refuses our own network, odd ports and other schemes before any request', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://localhost/',
      'http://exemplo.com.br:8080/',
      'ftp://exemplo.com.br/',
      'http://user:pass@exemplo.com.br/',
    ]) {
      expect(await probePublicUrl(url)).toEqual({ kind: 'blocked' });
    }
  });

  it('refuses a name that resolves to a private address at connect time', async () => {
    const error = await new Promise<Error | null>((resolve) =>
      guardedLookup('localhost', {}, (err) => resolve(err)),
    );
    expect(error?.constructor.name).toBe('Blocked');
  });
});
