import { describe, expect, it } from 'vitest';
import {
  CONSULTANT_AREAS,
  clientCompanySchema,
  clientCompleteness,
  clientPartnerInputSchema,
  type ClientCompletenessInput,
} from './client-record.js';
import { formatCnpj, isValidCnpj, normalizeCnpj } from './cnpj.js';
import { clientCreateSchema } from './clients.js';
import { can, type Actor } from './rbac/policy.js';
import { SECTORS, type SectorSlug } from './rbac/sectors.js';

describe('cnpj', () => {
  it('checks numeric CNPJs', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(isValidCnpj('00.000.000/0000-00')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
  });

  it('checks the alphanumeric CNPJs the Receita issues since July 2026', () => {
    // The Receita's own example (Nota Técnica do CNPJ alfanumérico).
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12abc34501de35')).toBe(true);
    expect(isValidCnpj('12.ABC.345/01DE-36')).toBe(false);
    expect(normalizeCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
  });
});

describe('consultant areas', () => {
  it('are exactly the sub-sectors of Formatação', () => {
    const formatacao = (Object.keys(SECTORS) as SectorSlug[]).filter(
      (slug) => SECTORS[slug].parent === 'formatacao',
    );
    expect([...CONSULTANT_AREAS].sort()).toEqual(formatacao.sort());
  });
});

describe('client record schemas', () => {
  it('normalizes the new register and refuses one without CNPJ, contact, relationship or profile', () => {
    const full = {
      name: ' Sushi ',
      cnpj: '11.222.333/0001-81',
      company: { legalName: 'Sushi Ltda', state: 'sp' },
      contact: { name: 'Ana', email: 'ANA@X.COM', whatsapp: '+55 (11) 98888-7777' },
      relationship: 'expansao',
      business: {
        segment: 'Alimentação',
        ownUnits: 1,
        revenueBand: null,
        franchisability: 'nao_avaliado',
        wingsFit: 'alta',
        profileSource: 'Reunião',
        profileDate: '2026-09-30',
      },
    };
    const parsed = clientCreateSchema.parse(full);
    expect(parsed).toMatchObject({
      name: 'Sushi',
      cnpj: '11222333000181',
      company: { legalName: 'Sushi Ltda', state: 'SP', tradeName: null },
      contact: { name: 'Ana', jobTitle: null, email: 'ana@x.com', whatsapp: '11988887777' },
      relationship: 'expansao',
    });
    expect(clientCreateSchema.safeParse({ name: 'Sushi' }).success).toBe(false);
    expect(clientCreateSchema.safeParse({ ...full, cnpj: '11.222.333/0001-80' }).success).toBe(
      false,
    );
    expect(clientCreateSchema.safeParse({ ...full, cnpj: null }).success).toBe(false);
    expect(
      clientCreateSchema.safeParse({ ...full, contact: { name: 'Ana', email: 'a@x.com' } }).success,
    ).toBe(false);
    expect(clientCreateSchema.safeParse({ ...full, relationship: 'outro' }).success).toBe(false);
    expect(
      clientCreateSchema.safeParse({ ...full, business: { ...full.business, profileSource: '' } })
        .success,
    ).toBe(false);
  });

  it('turns empty fields into null and keeps the sensitive ones undefined when not sent', () => {
    const company = clientCompanySchema.parse({ legalName: '  ', address: { cep: '01310-100' } });
    expect(company.legalName).toBeNull();
    expect(company.address.cep).toBe('01310100');
    expect(company.cnaeSecondary).toEqual([]);

    const partner = clientPartnerInputSchema.parse({ name: 'João' });
    expect(partner.cpf).toBeUndefined();
    expect(partner.maritalStatus).toBeUndefined();
    expect(clientPartnerInputSchema.parse({ name: 'João', cpf: '' }).cpf).toBeNull();
    expect(
      clientPartnerInputSchema.safeParse({ name: 'João', cpf: '111.111.111-11' }).success,
    ).toBe(false);
  });
});

describe('clientCompleteness', () => {
  const empty: ClientCompletenessInput = {
    company: clientCompanySchema.parse({}),
    partners: [],
    contacts: [],
    business: {
      segment: null,
      description: null,
      operatingYears: null,
      ownUnits: null,
      revenueBand: null,
      franchisability: null,
      wingsFit: null,
      profileSource: null,
      profileDate: null,
      averageTicketCents: null,
      employeesCount: null,
      inpiProcess: null,
      inpiClass: null,
      inpiStatus: null,
    },
    contracts: [],
    franchise: {
      franchiseFeeCents: null,
      royaltiesPercent: null,
      adFundPercent: null,
      initialInvestmentCents: null,
      franchiseeProfile: null,
      unitModels: [],
    },
    signature: {
      signerPartnerId: null,
      signingEmail: null,
      signingMobile: null,
      signatureType: null,
      forum: null,
      witnesses: [],
    },
    expansionArea: [],
  };

  it('is 0% for an empty record and counts each block', () => {
    const result = clientCompleteness(empty);
    expect(result.percent).toBe(0);
    expect(result.blocks.map((b) => b.block)).toEqual([
      'empresa',
      'socios',
      'contatos',
      'negocio',
      'contrato',
      'franquia',
      'assinatura',
    ]);
  });

  it('asks for the property regime only of a married partner, and for shares that add up', () => {
    const partner = {
      name: 'A',
      cpfOnFile: true,
      rg: '1',
      nationality: 'brasileira',
      profession: 'empresária',
      maritalStatus: 'casado' as const,
      propertyRegime: null,
      address: {
        cep: '01310100',
        street: 'R',
        number: '1',
        complement: null,
        district: null,
        city: 'SP',
        state: 'SP' as const,
      },
      email: 'a@a.com',
      mobile: '11999998888',
      sharePercent: 60,
      signsForCompany: true,
    };
    const socios = clientCompleteness({ ...empty, partners: [partner] }).blocks.find(
      (b) => b.block === 'socios',
    );
    expect(socios?.missing).toEqual(['Sócio 1: regime de bens', 'Participações somam 100%']);
    const single = clientCompleteness({
      ...empty,
      partners: [{ ...partner, maritalStatus: 'solteiro', sharePercent: 100 }],
    }).blocks.find((b) => b.block === 'socios');
    expect(single?.missing).toEqual([]);
  });

  it('gives Jurídico, Diretoria and Admin Master the sensitive fields, and Marketing only the record', () => {
    const actor = (role: Actor['role']): Actor => ({
      employeeId: 'e',
      role,
      sector: 'marketing',
      isSectorManager: false,
    });
    for (const role of ['formatacao_juridico', 'diretoria', 'admin_master'] as const) {
      expect(can(actor(role), 'clients.sensitive').allowed).toBe(true);
      expect(can(actor(role), 'clients.edit').allowed).toBe(true);
    }
    expect(can(actor('marketing'), 'clients.edit').allowed).toBe(true);
    expect(can(actor('marketing'), 'clients.sensitive').allowed).toBe(false);
    expect(can(actor('rh_dp'), 'clients.read').allowed).toBe(false);
    expect(can(actor('formatacao_juridico'), 'clients.manage').allowed).toBe(false);
  });
});
