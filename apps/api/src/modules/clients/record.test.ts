import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Client,
  type ClientRecord,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, clientContacts, clientPartners } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  clientRegister,
  createEmployee,
  makeCpf,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const registryCalls: string[] = [];

/** BrasilAPI and ViaCEP as they answered on 2026-09-24, trimmed. */
async function registryFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  registryCalls.push(new URL(url).host);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('brasilapi.com.br/api/cnpj/v1/19131243000197')) {
    return json(200, {
      uf: 'SP',
      cep: '01311902',
      qsa: [
        {
          nome_socio: 'MARIA DE TESTE',
          qualificacao_socio: 'Presidente',
          cnpj_cpf_do_socio: '***112108**',
        },
      ],
      cnpj: '19131243000197',
      email: null,
      bairro: 'BELA VISTA',
      numero: '37',
      municipio: 'SAO PAULO',
      logradouro: 'PAULISTA 37',
      cnae_fiscal: 9430800,
      complemento: 'ANDAR 4',
      razao_social: 'OPEN KNOWLEDGE BRASIL',
      nome_fantasia: 'REDE PELO CONHECIMENTO LIVRE',
      capital_social: 1500.5,
      ddd_telefone_1: '1123851939',
      cnaes_secundarios: [
        { codigo: 6204000, descricao: 'Consultoria em tecnologia da informação' },
      ],
      natureza_juridica: 'Associação Privada',
      codigo_natureza_juridica: 3999,
      regime_tributario: [
        { ano: 2018, forma_de_tributacao: 'LUCRO PRESUMIDO' },
        { ano: 2024, forma_de_tributacao: 'IMUNE DE IRPJ' },
      ],
      opcao_pelo_simples: null,
      opcao_pelo_mei: null,
      cnae_fiscal_descricao: 'Atividades de associações de defesa de direitos sociais',
      data_inicio_atividade: '2013-10-03',
      descricao_situacao_cadastral: 'ATIVA',
      descricao_tipo_de_logradouro: 'AVENIDA',
    });
  }
  if (url.includes('brasilapi.com.br/api/cnpj/v1/'))
    return json(404, { message: 'CNPJ não encontrado' });
  if (url.includes('receitaws.com.br'))
    return json(200, { status: 'ERROR', message: 'CNPJ inválido' });
  // BrasilAPI's CEP is down in this test: ViaCEP answers.
  if (url.includes('brasilapi.com.br/api/cep/v2/')) return json(500, { message: 'erro' });
  if (url.includes('viacep.com.br/ws/01310100/json/')) {
    return json(200, {
      cep: '01310-100',
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      localidade: 'São Paulo',
      uf: 'SP',
    });
  }
  if (url.includes('viacep.com.br')) return json(200, { erro: 'true' });
  throw new Error(`unexpected fetch ${url}`);
}

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
    registryFetch: registryFetch as typeof fetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: RoleKey, sector: SectorSlug) {
  const employee = await createEmployee(db, { role, sector });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const trail = async (clientId: string) =>
  db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'client'), eq(auditLog.entityId, clientId)));

describe('the client record', () => {
  it('registers quickly with CNPJ and main contact, and refuses the same CNPJ twice', async () => {
    const marketing = await sessionFor('marketing', 'marketing');
    const created = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Sushi do Bairro', {
        cnpj: '19.131.243/0001-97',
        contact: { name: 'Ana Souza', email: 'ANA@SUSHI.COM.BR', whatsapp: '(11) 98888-7777' },
      }),
    });
    expect(created.statusCode).toBe(201);
    const client = created.json<{ client: Client }>().client;
    const contacts = await db
      .select()
      .from(clientContacts)
      .where(eq(clientContacts.clientId, client.id));
    expect(contacts).toEqual([
      expect.objectContaining({
        role: 'principal',
        name: 'Ana Souza',
        email: 'ana@sushi.com.br',
        whatsapp: '11988887777',
      }),
    ]);

    const twin = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Outro Nome', { cnpj: '19131243000197' }),
    });
    expect(twin.statusCode).toBe(409);
    expect(twin.json()).toMatchObject({ error: 'cnpj_taken' });
    const invalid = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Terceiro', { cnpj: '19131243000198' }),
    });
    expect(invalid.statusCode).toBe(400);

    const record = await app.inject({
      url: `/clients/${client.id}/record`,
      cookies: marketing.cookies,
    });
    expect(record.statusCode).toBe(200);
    const body = record.json<ClientRecord>();
    expect(body.company.cnpj).toBe('19131243000197');
    expect(body.completeness.percent).toBeGreaterThan(0);
    expect(body.completeness.percent).toBeLessThan(20);
    expect(body.access).toEqual({ canEdit: true, canSeeSensitive: false });
    // The quick registration is on the trail, without the CNPJ or the contact's data.
    const created_ = (await trail(client.id)).find((row) => row.action === 'client.created');
    expect(created_?.metadata).toMatchObject({ withCnpj: true, withContact: true });
    expect(JSON.stringify(created_?.metadata)).not.toMatch(/19131243|Ana|sushi\.com/);
  });

  it('keeps partners’ CPF, marital status and property regime from whoever lacks clients.sensitive', async () => {
    const marketing = await sessionFor('marketing', 'marketing');
    const legal = await sessionFor('formatacao_juridico', 'formatacao-juridico');
    const made = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Padaria Sensível'),
    });
    const clientId = made.json<{ client: Client }>().client.id;

    // Marketing may add a partner, but not their CPF or marital status.
    const refused = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/partners`,
      cookies: marketing.cookies,
      payload: { name: 'João Sócio', maritalStatus: 'casado' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'sensitive_forbidden' });

    const added = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/partners`,
      cookies: marketing.cookies,
      payload: { name: 'João Sócio', profession: 'Empresário', sharePercent: 60 },
    });
    expect(added.statusCode).toBe(201);
    const partnerId = added.json<ClientRecord>().partners[0]?.id as string;

    // Jurídico completes the qualification.
    const cpf = makeCpf();
    const completed = await app.inject({
      method: 'PUT',
      url: `/clients/${clientId}/partners/${partnerId}`,
      cookies: legal.cookies,
      payload: {
        name: 'João Sócio',
        profession: 'Empresário',
        sharePercent: 60,
        cpf,
        maritalStatus: 'casado',
        propertyRegime: 'comunhao_parcial',
      },
    });
    expect(completed.statusCode).toBe(200);
    const seenByLegal = completed.json<ClientRecord>().partners[0];
    expect(seenByLegal).toMatchObject({
      cpfOnFile: true,
      maritalStatus: 'casado',
      restricted: false,
    });
    expect(seenByLegal?.cpfMasked).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    expect(JSON.stringify(completed.json())).not.toContain(cpf);

    // Stored encrypted, never in the clear.
    const [row] = await db.select().from(clientPartners).where(eq(clientPartners.id, partnerId));
    expect(row?.cpfEncrypted).not.toContain(cpf);

    // Marketing sees that there is a CPF, and nothing of it; saving other fields keeps it.
    const seenByMarketing = await app.inject({
      url: `/clients/${clientId}/record`,
      cookies: marketing.cookies,
    });
    expect(seenByMarketing.json<ClientRecord>().partners[0]).toMatchObject({
      cpfOnFile: true,
      cpfMasked: null,
      maritalStatus: null,
      propertyRegime: null,
      restricted: true,
    });
    const edited = await app.inject({
      method: 'PUT',
      url: `/clients/${clientId}/partners/${partnerId}`,
      cookies: marketing.cookies,
      payload: { name: 'João Sócio', profession: 'Administrador', sharePercent: 60 },
    });
    expect(edited.statusCode).toBe(200);
    const [kept] = await db.select().from(clientPartners).where(eq(clientPartners.id, partnerId));
    expect(kept).toMatchObject({
      profession: 'Administrador',
      maritalStatus: 'casado',
      cpfIndex: row?.cpfIndex,
    });

    // Revealing is Jurídico's, and audited.
    const noReveal = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/reveal-cpf`,
      cookies: marketing.cookies,
      payload: { kind: 'partner', id: partnerId },
    });
    expect(noReveal.statusCode).toBe(403);
    const reveal = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/reveal-cpf`,
      cookies: legal.cookies,
      payload: { kind: 'partner', id: partnerId },
    });
    expect(reveal.json()).toEqual({ cpf });

    // The same CPF twice in one client is refused.
    const twin = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/partners`,
      cookies: legal.cookies,
      payload: { name: 'Outro', cpf },
    });
    expect(twin.statusCode).toBe(409);
    expect(twin.json()).toMatchObject({ error: 'cpf_taken' });

    // ...but the same person may be a partner of another client.
    const other = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Outra Empresa'),
    });
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/clients/${other.json<{ client: Client }>().client.id}/partners`,
      cookies: legal.cookies,
      payload: { name: 'João Sócio', cpf },
    });
    expect(elsewhere.statusCode).toBe(201);

    const actions = (await trail(clientId)).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'client.partner_created',
        'client.partner_updated',
        'client.cpf_revealed',
      ]),
    );
    const everything = JSON.stringify(await trail(clientId));
    expect(everything).not.toContain(cpf);
    expect(everything).not.toContain('João');
    expect(everything).not.toContain('casado');
  });

  it('saves every block, checks consultants and signers, and reports what is still missing', async () => {
    const admin = await sessionFor('admin_master', 'diretoria');
    const legalConsultant = await createEmployee(db, {
      role: 'formatacao_juridico',
      sector: 'formatacao-juridico',
    });
    const financeConsultant = await createEmployee(db, {
      role: 'formatacao_financeiro',
      sector: 'formatacao-financeiro',
    });
    const made = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: admin.cookies,
      payload: clientRegister('Açaí Completo', { company: { legalName: 'Razão Provisória Ltda' } }),
    });
    const clientId = made.json<{ client: Client }>().client.id;
    const put = (path: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PUT',
        url: `/clients/${clientId}/${path}`,
        cookies: admin.cookies,
        payload,
      });

    const company = await put('company', {
      legalName: 'Açaí Completo Ltda',
      tradeName: 'Açaí Completo',
      cnpj: '11.222.333/0001-81',
      openedOn: '2019-04-01',
      legalNature: '206-2 - Sociedade Empresária Limitada',
      taxRegime: 'simples_nacional',
      cnaeMain: '5611-2/03',
      shareCapitalCents: 10_000_000,
      address: {
        cep: '01310-100',
        street: 'Avenida Paulista',
        number: '1000',
        city: 'São Paulo',
        state: 'SP',
      },
      phone: '1133334444',
      email: 'contato@acai.com.br',
      social: { instagram: '@acaicompleto', facebook: '' },
    });
    expect(company.statusCode).toBe(200);
    const afterCompany = company.json<ClientRecord>();
    expect(afterCompany.company.social).toEqual({ instagram: '@acaicompleto' });
    expect(afterCompany.completeness.blocks.find((b) => b.block === 'empresa')).toMatchObject({
      missing: [],
    });

    // A consultant must be an active employee of that area.
    const wrongArea = await put('contracts', {
      contracts: [
        {
          service: 'Formatação de franquia',
          consultants: { 'formatacao-juridico': financeConsultant.id },
        },
      ],
    });
    expect(wrongArea.statusCode).toBe(400);
    const contracts = await put('contracts', {
      contracts: [
        {
          service: 'Formatação de franquia',
          number: 'W-2026-031',
          signedOn: '2026-09-01',
          valueCents: 4_500_000,
          paymentMethod: 'Boleto',
          installments: 10,
          startsOn: '2026-09-15',
          termMonths: 12,
          consultants: {
            'formatacao-juridico': legalConsultant.id,
            'formatacao-financeiro': financeConsultant.id,
          },
        },
      ],
    });
    expect(contracts.statusCode).toBe(200);
    const saved = contracts.json<ClientRecord>().contracts;
    expect(saved[0]?.consultants).toEqual({
      'formatacao-juridico': legalConsultant.id,
      'formatacao-financeiro': financeConsultant.id,
    });
    expect(
      contracts.json<ClientRecord>().consultantOptions['formatacao-juridico'].map((p) => p.id),
    ).toContain(legalConsultant.id);
    // Saving again with the id keeps the same contract.
    const again = await put('contracts', { contracts: [{ ...saved[0], termMonths: 18 }] });
    expect(again.json<ClientRecord>().contracts).toEqual([
      expect.objectContaining({ id: saved[0]?.id, termMonths: 18 }),
    ]);

    expect(
      (await put('business', { segment: 'Alimentação', ownUnits: 3, inpiStatus: 'depositada' }))
        .statusCode,
    ).toBe(200);
    const franchise = await put('franchise', {
      franchiseFeeCents: 3_500_000,
      royaltiesPercent: 5.5,
      adFundPercent: 2,
      unitModels: [{ name: 'Quiosque', initialInvestmentCents: 12_000_000 }],
    });
    expect(franchise.json<ClientRecord>().franchise).toMatchObject({
      royaltiesPercent: 5.5,
      unitModels: [expect.objectContaining({ name: 'Quiosque' })],
    });

    // Who signs must be a partner of this client.
    const stranger = await put('signature', {
      signerPartnerId: '00000000-0000-4000-8000-000000000999',
    });
    expect(stranger.statusCode).toBe(400);
    const partner = await app.inject({
      method: 'POST',
      url: `/clients/${clientId}/partners`,
      cookies: admin.cookies,
      payload: { name: 'Carla Sócia', sharePercent: 100, signsForCompany: true },
    });
    const partnerId = partner.json<ClientRecord>().partners[0]?.id;
    const witnessCpf = makeCpf();
    const signature = await put('signature', {
      signerPartnerId: partnerId,
      signatureType: 'eletronica_simples',
      forum: 'Comarca de São Paulo/SP',
      witnesses: [{ name: 'Testemunha Um', cpf: witnessCpf }],
    });
    expect(signature.statusCode).toBe(200);
    const witness = signature.json<ClientRecord>().signature.witnesses[0];
    expect(witness).toMatchObject({ cpfOnFile: true, name: 'Testemunha Um' });
    // Kept by id, the witness keeps its CPF.
    const kept = await put('signature', {
      signerPartnerId: partnerId,
      witnesses: [{ id: witness?.id, name: 'Testemunha Um' }],
    });
    expect(kept.json<ClientRecord>().signature.witnesses[0]).toMatchObject({
      id: witness?.id,
      cpfOnFile: true,
    });

    const contactsSaved = await put('contacts', {
      contacts: [
        {
          role: 'financeiro',
          name: 'Beto Financeiro',
          email: 'beto@acai.com.br',
          whatsapp: '11977776666',
        },
      ],
    });
    const record = contactsSaved.json<ClientRecord>();
    expect(record.completeness.percent).toBeGreaterThan(30);
    expect(record.completeness.percent).toBeLessThan(100);
    expect(record.completeness.blocks.find((b) => b.block === 'contatos')?.missing).toEqual([
      'Responsável principal (nome, e-mail e WhatsApp)',
      'Marketing (nome, e-mail e WhatsApp)',
    ]);
    expect(record.documentsFolderId).toEqual(expect.any(String));

    const actions = new Set((await trail(clientId)).map((entry) => entry.action));
    for (const action of [
      'client.company_updated',
      'client.contracts_updated',
      'client.business_updated',
      'client.franchise_updated',
      'client.signature_updated',
      'client.contacts_updated',
    ]) {
      expect(actions).toContain(action);
    }
    const company_ = (await trail(clientId)).find(
      (entry) => entry.action === 'client.company_updated',
    );
    expect(company_?.metadata).toMatchObject({
      fields: expect.arrayContaining(['legalName', 'cnpj']),
    });
    expect(JSON.stringify(company_?.metadata)).not.toContain('Açaí');
  });

  it('is read by Jurídico, not by a seller, and Wings Company has no record', async () => {
    const legal = await sessionFor('formatacao_juridico', 'formatacao-juridico');
    const seller = await sessionFor('vendedor_expansao', 'comercial');
    const list = await app.inject({ url: '/clients', cookies: legal.cookies });
    expect(list.statusCode).toBe(200);
    const someone = list
      .json<{ clients: Client[] }>()
      .clients.find((c) => c.id !== WINGS_CLIENT_ID) as Client;
    expect(
      (await app.inject({ url: `/clients/${someone.id}/record`, cookies: legal.cookies }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/clients/${someone.id}/record`, cookies: seller.cookies }))
        .statusCode,
    ).toBe(403);
    // Jurídico fills the record but does not register or rename clients.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/clients',
          cookies: legal.cookies,
          payload: clientRegister('Novo'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/clients/${WINGS_CLIENT_ID}/record`, cookies: legal.cookies }))
        .statusCode,
    ).toBe(409);
  });

  it('pre-fills from the CNPJ and the CEP, falls back between suppliers, and answers 404 and 400', async () => {
    const marketing = await sessionFor('marketing', 'marketing');
    const seller = await sessionFor('vendedor_expansao', 'comercial');
    const lookup = (path: string, payload: Record<string, unknown>, cookies = marketing.cookies) =>
      app.inject({ method: 'POST', url: `/clients/lookup/${path}`, cookies, payload });

    const found = await lookup('cnpj', { cnpj: '19.131.243/0001-97' });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      source: 'brasilapi',
      registrationStatus: 'ATIVA',
      company: {
        legalName: 'OPEN KNOWLEDGE BRASIL',
        legalNature: '399-9 - Associação Privada',
        cnaeMain: '9430-8/00 Atividades de associações de defesa de direitos sociais',
        taxRegime: 'imune_isenta',
        shareCapitalCents: 150050,
        openedOn: '2013-10-03',
        phone: '1123851939',
        address: { cep: '01311902', street: 'AVENIDA PAULISTA 37', state: 'SP' },
      },
      partners: [{ name: 'MARIA DE TESTE', role: 'Presidente' }],
    });
    expect(JSON.stringify(found.json())).not.toContain('112108');

    // Unknown to both suppliers.
    const missing = await lookup('cnpj', { cnpj: '11.222.333/0001-81' });
    expect(missing.statusCode).toBe(404);
    expect((await lookup('cnpj', { cnpj: '123' })).statusCode).toBe(400);

    const cep = await lookup('cep', { cep: '01310-100' });
    expect(cep.json()).toMatchObject({
      source: 'viacep',
      address: {
        cep: '01310100',
        street: 'Avenida Paulista',
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
      },
    });
    expect((await lookup('cep', { cep: '99999-999' })).statusCode).toBe(404);

    // Answers are cached: the same CNPJ does not reach the supplier again.
    const before = registryCalls.length;
    await lookup('cnpj', { cnpj: '19131243000197' });
    expect(registryCalls.length).toBe(before);

    expect((await lookup('cnpj', { cnpj: '19131243000197' }, seller.cookies)).statusCode).toBe(403);
  });
});
