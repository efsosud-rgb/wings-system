import {
  companyKey,
  parseCsv,
  SESSION_COOKIE,
  toCsv,
  WINGS_CLIENT_ID,
  type CrmBrand,
  type CrmCompany,
  type CrmContact,
  type CsvImportPreview,
  type CsvImportReport,
  type LeadActivity,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { clients, crmContacts, leadContacts, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, makeCnpj, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { parseMoneyCents, suggestMapping } from './csv.js';
import type { LoadedLead } from './service.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

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
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

type Role = 'admin_master' | 'gerente_comercial' | 'vendedor_expansao';
async function sessionFor(role: Role) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, email: employee.email, cookies: { [SESSION_COOKIE]: token } };
}

let manager: Awaited<ReturnType<typeof sessionFor>>;
let seller: Awaited<ReturnType<typeof sessionFor>>;
let admin: Awaited<ReturnType<typeof sessionFor>>;

const arrive = (input: {
  phone?: string;
  email?: string;
  name: string;
  owner?: string | null;
  company?: string;
}) =>
  upsertLead(db, {
    source: 'site_form',
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: input.owner ?? null,
    distribute: false,
    skipResearch: true,
    company: input.company ? { name: input.company } : null,
    event: { kind: 'lead.received.site_form' },
  });

describe('contacts and companies', () => {
  beforeAll(async () => {
    manager = await sessionFor('gerente_comercial');
    seller = await sessionFor('vendedor_expansao');
    admin = await sessionFor('admin_master');
  });

  it('companyKey ignores case, accents, punctuation and the legal suffix', () => {
    expect(companyKey('Casal do Churros LTDA.')).toBe('casal do churros');
    expect(companyKey('  Açaí da Vila - ME ')).toBe('acai da vila');
  });

  it('an arriving lead makes (or finds) its contact and its company, never twice', async () => {
    const first = await arrive({
      phone: '21999990001',
      email: 'ana@exemplo.com',
      name: 'Ana',
      company: 'Padaria Sol Ltda',
    });
    expect(first.created).toBe(true);
    const links = await db
      .select()
      .from(leadContacts)
      .where(eq(leadContacts.leadId, first.lead.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.primary).toBe(true);
    const contact = await db.query.crmContacts.findFirst({
      where: eq(crmContacts.id, links[0]!.contactId),
    });
    expect(contact?.phone).toBe('5521999990001');
    expect(contact?.email).toBe('ana@exemplo.com');
    expect(first.lead.companyId).not.toBeNull();

    // Same person by e-mail from another door: same lead, same contact, and the company found by name.
    const again = await arrive({
      email: 'ANA@exemplo.com',
      name: 'Ana Maria',
      company: 'padaria sol',
    });
    expect(again.created).toBe(false);
    expect(again.lead.id).toBe(first.lead.id);
    expect(again.lead.companyId).toBe(first.lead.companyId);
    expect(await db.$count(crmContacts)).toBe(1);
  });

  it('a seller sees only the contacts of their own leads; a manager sees all', async () => {
    await arrive({ phone: '21999990002', name: 'Bruno', owner: seller.employeeId });
    await arrive({ phone: '21999990003', name: 'Carla', owner: manager.employeeId });
    const mine = await app.inject({ method: 'GET', url: '/crm/contacts', cookies: seller.cookies });
    expect(mine.statusCode).toBe(200);
    const sellerList = mine.json<{ contacts: CrmContact[] }>().contacts;
    expect(sellerList.map((c) => c.name)).toEqual(['Bruno']);
    const all = await app.inject({
      method: 'GET',
      url: '/crm/contacts?q=carla',
      cookies: manager.cookies,
    });
    expect(all.json<{ contacts: CrmContact[] }>().contacts.map((c) => c.name)).toEqual(['Carla']);
    const other = sellerList.find((c) => c.name === 'Bruno')!;
    const carla = all.json<{ contacts: CrmContact[] }>().contacts[0]!;
    const forbidden = await app.inject({
      method: 'GET',
      url: `/crm/contacts/${carla.id}`,
      cookies: seller.cookies,
    });
    expect(forbidden.statusCode).toBe(404);
    const allowed = await app.inject({
      method: 'GET',
      url: `/crm/contacts/${other.id}`,
      cookies: seller.cookies,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ leads: unknown[] }>().leads).toHaveLength(1);
  });

  it('refuses a second contact with the same phone and offers the merge', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/crm/contacts',
      cookies: manager.cookies,
      payload: { name: 'Bruno outra vez', phone: '(21) 99999-0002' },
    });
    // Found, not created: the phone names the existing contact.
    expect(created.statusCode).toBe(200);
    expect(created.json<{ created: boolean }>().created).toBe(false);

    const other = await app.inject({
      method: 'POST',
      url: '/crm/contacts',
      cookies: manager.cookies,
      payload: { name: 'Bruno duplicado', email: 'bruno2@exemplo.com', companyName: 'Padaria Sol' },
    });
    expect(other.statusCode).toBe(201);
    const duplicate = other.json<{ contact: CrmContact }>().contact;
    expect(duplicate.companyName).toBe('Padaria Sol Ltda');
    const clash = await app.inject({
      method: 'PATCH',
      url: `/crm/contacts/${duplicate.id}`,
      cookies: manager.cookies,
      payload: { phone: '21999990002' },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<{ error: string }>().error).toBe('phone_taken');

    const bruno = created.json<{ contact: CrmContact }>().contact;
    const merged = await app.inject({
      method: 'POST',
      url: '/crm/contacts/merge',
      cookies: manager.cookies,
      payload: { fromId: duplicate.id, intoId: bruno.id },
    });
    expect(merged.statusCode).toBe(200);
    const kept = merged.json<{ contact: CrmContact }>().contact;
    expect(kept.email).toBe('bruno2@exemplo.com');
    expect(kept.companyName).toBe('Padaria Sol Ltda');
    // The retired row answers as the kept one.
    const old = await app.inject({
      method: 'GET',
      url: `/crm/contacts/${duplicate.id}`,
      cookies: manager.cookies,
    });
    expect(old.json<{ contact: CrmContact }>().contact.id).toBe(bruno.id);
    // A seller may not merge.
    const denied = await app.inject({
      method: 'POST',
      url: '/crm/contacts/merge',
      cookies: seller.cookies,
      payload: { fromId: duplicate.id, intoId: bruno.id },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('companies: found by CNPJ or name, merged, and turned into a client with one click', async () => {
    const cnpj = makeCnpj();
    const a = await app.inject({
      method: 'POST',
      url: '/crm/companies',
      cookies: manager.cookies,
      payload: { name: 'Açaí da Vila', cnpj, city: 'Niterói', state: 'rj' },
    });
    expect(a.statusCode).toBe(201);
    const byCnpj = await app.inject({
      method: 'POST',
      url: '/crm/companies',
      cookies: manager.cookies,
      payload: { name: 'Acai da Vila Comercio LTDA', cnpj },
    });
    expect(byCnpj.statusCode).toBe(200);
    expect(byCnpj.json<{ company: CrmCompany }>().company.id).toBe(
      a.json<{ company: CrmCompany }>().company.id,
    );
    const invalid = await app.inject({
      method: 'POST',
      url: '/crm/companies',
      cookies: manager.cookies,
      payload: { name: 'Outra', cnpj: '12345678000100' },
    });
    expect(invalid.statusCode).toBe(400);

    const b = await app.inject({
      method: 'POST',
      url: '/crm/companies',
      cookies: manager.cookies,
      payload: { name: 'Açaí da Vila Niterói', email: 'contato@acai.com' },
    });
    expect(b.statusCode).toBe(201);
    const merged = await app.inject({
      method: 'POST',
      url: '/crm/companies/merge',
      cookies: manager.cookies,
      payload: {
        fromId: b.json<{ company: CrmCompany }>().company.id,
        intoId: a.json<{ company: CrmCompany }>().company.id,
      },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json<{ company: CrmCompany }>().company.email).toBe('contato@acai.com');

    const companyId = a.json<{ company: CrmCompany }>().company.id;
    const sellerDenied = await app.inject({
      method: 'POST',
      url: `/crm/companies/${companyId}/client`,
      cookies: seller.cookies,
    });
    expect(sellerDenied.statusCode).toBe(403);
    const became = await app.inject({
      method: 'POST',
      url: `/crm/companies/${companyId}/client`,
      cookies: admin.cookies,
      payload: { relationship: 'formatacao' },
    });
    expect(became.statusCode).toBe(201);
    const { clientId } = became.json<{ clientId: string }>();
    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    expect(client?.name).toBe('Açaí da Vila');
    expect(client?.cnpj).toBe(cnpj);
    expect(client?.address).toMatchObject({ city: 'Niterói', state: 'RJ' });
    const twice = await app.inject({
      method: 'POST',
      url: `/crm/companies/${companyId}/client`,
      cookies: admin.cookies,
    });
    expect(twice.statusCode).toBe(200);
    expect(twice.json<{ created: boolean; clientId: string }>()).toMatchObject({
      created: false,
      clientId,
    });
  });

  it('the lead page lists its contacts; a second contact can be tied and untied', async () => {
    const lead = await arrive({ phone: '21999990010', name: 'Diego', owner: seller.employeeId });
    const tied = await app.inject({
      method: 'POST',
      url: `/leads/${lead.lead.id}/contacts`,
      cookies: seller.cookies,
      payload: {
        contact: { name: 'Sócia do Diego', email: 'socia@exemplo.com', jobTitle: 'Sócia' },
      },
    });
    expect(tied.statusCode).toBe(201);
    const loaded = tied.json<LoadedLead>();
    expect(loaded.lead.contacts).toHaveLength(2);
    expect(loaded.lead.contacts[0]?.name).toBe('Diego');
    expect(loaded.lead.contacts[0]?.primary).toBe(true);
    const second = loaded.lead.contacts[1]!;
    const untied = await app.inject({
      method: 'DELETE',
      url: `/leads/${lead.lead.id}/contacts/${second.id}`,
      cookies: seller.cookies,
    });
    expect(untied.statusCode).toBe(200);
    expect(untied.json<LoadedLead>().lead.contacts).toHaveLength(1);
  });
});

describe('activities, value and brand of interest', () => {
  let leadId: string;
  let brand: CrmBrand;

  beforeAll(async () => {
    const lead = await arrive({ phone: '21999990020', name: 'Elena', owner: seller.employeeId });
    leadId = lead.lead.id;
  });

  it('records a call and a meeting on the lead, by the seller, with the event on the timeline', async () => {
    const call = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/activities`,
      cookies: seller.cookies,
      payload: {
        kind: 'call',
        outcome: 'answered',
        durationSeconds: 240,
        note: 'Quer saber do investimento',
      },
    });
    expect(call.statusCode).toBe(201);
    expect(call.json<{ activity: LeadActivity }>().activity).toMatchObject({
      kind: 'call',
      outcome: 'answered',
      durationSeconds: 240,
    });
    const badLink = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/activities`,
      cookies: seller.cookies,
      payload: { kind: 'meeting', at: new Date().toISOString(), meetUrl: 'http://example.com' },
    });
    expect(badLink.statusCode).toBe(400);
    const meeting = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/activities`,
      cookies: seller.cookies,
      payload: {
        kind: 'meeting',
        at: new Date(Date.now() + 86_400_000).toISOString(),
        participants: 'Elena e o marido',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      },
    });
    expect(meeting.statusCode).toBe(201);
    const page = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      cookies: seller.cookies,
    });
    const loaded = page.json<LoadedLead>();
    expect(loaded.activities).toHaveLength(2);
    expect(loaded.activities[0]?.kind).toBe('meeting');
    expect(loaded.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['lead.call_logged', 'lead.meeting_logged']),
    );
    const event = loaded.events.find((e) => e.kind === 'lead.call_logged')!;
    expect(JSON.stringify(event.detail)).not.toContain('investimento');
    // Another seller's lead: 404.
    const other = await sessionFor('vendedor_expansao');
    const denied = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/activities`,
      cookies: other.cookies,
      payload: { kind: 'call', outcome: 'busy' },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('brands of interest: a manager keeps the list; a seller only reads the ones on sale', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/crm/brands',
      cookies: seller.cookies,
      payload: { name: 'Casal do Churros' },
    });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/crm/brands',
      cookies: manager.cookies,
      payload: { name: 'Casal do Churros' },
    });
    expect(created.statusCode).toBe(201);
    brand = created.json<{ brand: CrmBrand }>().brand;
    expect(brand.onSale).toBe(true);
    const paused = await app.inject({
      method: 'PATCH',
      url: `/crm/brands/${brand.clientId}`,
      cookies: manager.cookies,
      payload: { onSale: false },
    });
    expect(paused.json<{ brand: CrmBrand }>().brand.onSale).toBe(false);
    const forSeller = await app.inject({
      method: 'GET',
      url: '/crm/brands',
      cookies: seller.cookies,
    });
    expect(
      forSeller.json<{ brands: CrmBrand[] }>().brands.some((b) => b.clientId === brand.clientId),
    ).toBe(false);
    const forManager = await app.inject({
      method: 'GET',
      url: '/crm/brands?all=true',
      cookies: manager.cookies,
    });
    expect(
      forManager.json<{ brands: CrmBrand[] }>().brands.some((b) => b.clientId === brand.clientId),
    ).toBe(true);
    await app.inject({
      method: 'PATCH',
      url: `/crm/brands/${brand.clientId}`,
      cookies: manager.cookies,
      payload: { onSale: true },
    });
  });

  it('the deal: value, brand of interest (files the lead under the client) and company by name', async () => {
    const changed = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/deal`,
      cookies: seller.cookies,
      payload: { valueCents: 4500000, brandClientId: brand.clientId, companyName: 'Elena Doces' },
    });
    expect(changed.statusCode).toBe(200);
    const loaded = changed.json<LoadedLead>();
    expect(loaded.lead.valueCents).toBe(4500000);
    expect(loaded.lead.brand).toBe('Casal do Churros');
    expect(loaded.lead.origin.clientId).toBe(brand.clientId);
    expect(loaded.lead.origin.clientMapped).toBe(true);
    expect(loaded.lead.company?.name).toBe('Elena Doces');
    expect(loaded.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['lead.value_changed', 'lead.brand_changed', 'lead.company_changed']),
    );
    const listed = await app.inject({
      method: 'GET',
      url: `/leads?clientId=${brand.clientId}`,
      cookies: manager.cookies,
    });
    expect(listed.json<{ leads: { id: string }[] }>().leads.map((l) => l.id)).toContain(leadId);
    // A brand not on sale is refused.
    await app.inject({
      method: 'PATCH',
      url: `/crm/brands/${brand.clientId}`,
      cookies: manager.cookies,
      payload: { onSale: false },
    });
    const refused = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/deal`,
      cookies: seller.cookies,
      payload: { brandClientId: brand.clientId },
    });
    expect(refused.statusCode).toBe(400);
    await app.inject({
      method: 'PATCH',
      url: `/crm/brands/${brand.clientId}`,
      cookies: manager.cookies,
      payload: { onSale: true },
    });
  });
});

describe('CSV import and export', () => {
  it('parses spreadsheets the way Excel writes them', () => {
    expect(parseCsv('a;b\r\n"x;1";"he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x;1', 'he said "hi"'],
    ]);
    expect(parseCsv('﻿nome,email\nAna,ana@x.com')).toEqual([
      ['nome', 'email'],
      ['Ana', 'ana@x.com'],
    ]);
    expect(
      toCsv([
        ['a', 'b;c'],
        [null, 'q"q'],
      ]),
    ).toBe('a;"b;c"\r\n;"q""q"');
    expect(parseMoneyCents('R$ 1.234,56')).toBe(123456);
    expect(parseMoneyCents('1234.5')).toBe(123450);
    expect(parseMoneyCents('abc')).toBeNull();
    expect(
      suggestMapping(['Nome', 'E-mail', 'Celular', 'Empresa', 'Observação', 'Coluna X']),
    ).toEqual({
      Nome: 'name',
      'E-mail': 'email',
      Celular: 'phone',
      Empresa: 'company',
      Observação: 'note',
    });
  });

  const csv = [
    'Nome;E-mail;Telefone;Empresa;Marca;Valor;Etapa',
    'Fábio;fabio@exemplo.com;21 99999-0030;Fábio Lanches;Casal do Churros;R$ 50.000,00;Reunião',
    'Gabi;;21999990031;;;;',
    'Helena;helena@exemplo.com;;;Marca Inexistente;;',
    'Igor;igor@;;;;;',
    'Fábio de novo;fabio@exemplo.com;;;;;',
    'Elena;;21999990020;;;;',
  ].join('\n');

  it('previews: guesses the mapping, checks every row, counts repeats and the leads it would join', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/leads/import/preview',
      cookies: manager.cookies,
      payload: { csv },
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<CsvImportPreview>();
    expect(body.suggestedMapping).toMatchObject({
      Nome: 'name',
      'E-mail': 'email',
      Telefone: 'phone',
      Empresa: 'company',
      Marca: 'brand',
      Valor: 'value',
      Etapa: 'stage',
    });
    expect(body.rows).toBe(6);
    expect(body.invalid).toBe(1);
    expect(body.repeated).toBe(1);
    expect(body.existing).toBe(1);
    expect(body.sample.find((row) => row.line === 5)?.errors[0]).toMatch(/E-mail inválido/);
    expect(body.sample.find((row) => row.line === 7)?.matchesLeadId).not.toBeNull();
  });

  it('imports: creates, joins the existing, skips the bad rows and reports by line; the seller owns theirs', async () => {
    const before = await db.$count(leads);
    const run = await app.inject({
      method: 'POST',
      url: '/leads/import',
      cookies: seller.cookies,
      payload: {
        csv,
        mapping: {
          Nome: 'name',
          'E-mail': 'email',
          Telefone: 'phone',
          Empresa: 'company',
          Marca: 'brand',
          Valor: 'value',
          Etapa: 'stage',
        },
        pipeline: 'expansao',
      },
    });
    expect(run.statusCode).toBe(201);
    const report = run.json<CsvImportReport>();
    expect(report.created).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.skipped).toBe(3);
    expect(report.errors.map((e) => e.line).sort()).toEqual([4, 5, 6]);
    expect(await db.$count(leads)).toBe(before + 2);
    const fabio = await db.query.leads.findFirst({ where: eq(leads.email, 'fabio@exemplo.com') });
    expect(fabio).toMatchObject({
      source: 'csv_import',
      valueCents: 5000000,
      brand: 'Casal do Churros',
      stage: 'Reunião',
      ownerEmployeeId: seller.employeeId,
    });
    expect(fabio?.importBatchId).toBe(report.batchId);
    expect(fabio?.companyId).not.toBeNull();
    const links = await db.select().from(leadContacts).where(eq(leadContacts.leadId, fabio!.id));
    expect(links).toHaveLength(1);
    // The same file again: nothing new.
    const again = await app.inject({
      method: 'POST',
      url: '/leads/import',
      cookies: seller.cookies,
      payload: {
        csv,
        mapping: { Nome: 'name', 'E-mail': 'email', Telefone: 'phone', Marca: 'brand' },
      },
    });
    expect(again.json<CsvImportReport>().created).toBe(0);
    expect(await db.$count(leads)).toBe(before + 2);
  });

  it('exports the filtered list in the caller’s scope, as a BOM + ; CSV', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/leads/export.csv',
      cookies: seller.cookies,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toMatch(/text\/csv/);
    expect(mine.body.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(mine.body);
    expect(rows[0]?.[0]).toBe('Nome');
    expect(rows.slice(1).every((row) => row[10] === 'Funcionário de Teste')).toBe(true);
    // The entry date is the source's own, and the next column says whose clock it is.
    expect(rows[0]).toContain('Entrou em');
    const sourceColumn = rows[0]!.indexOf('Data vinda de');
    expect(rows.slice(1).every((row) => (row[sourceColumn] ?? '').length > 0)).toBe(true);
    const names = rows.slice(1).map((row) => row[0]);
    expect(names).toContain('Fábio');
    expect(names).not.toContain('Carla');
    const all = await app.inject({
      method: 'GET',
      url: '/leads/export.csv?pipeline=expansao',
      cookies: manager.cookies,
    });
    expect(
      parseCsv(all.body)
        .slice(1)
        .map((row) => row[0]),
    ).toContain('Carla');
    expect(Number(all.headers['x-rows'])).toBeGreaterThan(names.length);
  });
});
