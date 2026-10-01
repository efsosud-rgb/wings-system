import { WINGS_CLIENT_ID } from '@wings/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * Who a piece of work is for. Minimal on purpose: id, name, slug, active.
 * Wings Company is a row too, with a fixed id the migration inserts, so every
 * `client_id` elsewhere can be NOT NULL and default to "for us".
 */
export const clients = pgTable(
  'clients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .default(WINGS_TENANT_ID)
      .references(() => tenants.id),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    active: boolean('active').notNull().default(true),
    /** ExpansionEntry[]: where the client is looking for franchisees (docs/leads/intake.md). */
    expansionArea: jsonb('expansion_area').notNull().default([]),
    /** `NN` of `Clientes/<NN. Nome>`. Null only for Wings Company. */
    number: integer('number'),
    // --- the full record, block 1 (Empresa); see `clientCompanySchema` ---
    legalName: text('legal_name'),
    tradeName: text('trade_name'),
    /** 14 characters, digits or (since 2026) letters and digits; unique per tenant. */
    cnpj: text('cnpj'),
    stateRegistration: text('state_registration'),
    municipalRegistration: text('municipal_registration'),
    openedOn: date('opened_on'),
    legalNature: text('legal_nature'),
    taxRegime: text('tax_regime'),
    cnaeMain: text('cnae_main'),
    cnaeSecondary: jsonb('cnae_secondary').$type<string[]>().notNull().default([]),
    shareCapitalCents: bigint('share_capital_cents', { mode: 'number' }),
    /** `ClientAddress`. */
    address: jsonb('address').$type<Record<string, string | null>>().notNull().default({}),
    phone: text('phone'),
    email: text('email'),
    website: text('website'),
    /** The brand's WhatsApp, 10 or 11 digits with the DDD: what its tracked links open (T6). */
    whatsapp: text('whatsapp'),
    /** Why there is no WhatsApp; shown in place of a link. */
    whatsappNote: text('whatsapp_note'),
    /** Handle or address per network: `{ instagram: '@padaria' }`. */
    social: jsonb('social').$type<Record<string, string>>().notNull().default({}),
    /** A ClientRelationship (formatacao | expansao | ambos); null on records made before it was asked. */
    relationship: text('relationship'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('clients_tenant_slug_idx').on(table.tenantId, table.slug),
    uniqueIndex('clients_tenant_number_idx').on(table.tenantId, table.number),
    uniqueIndex('clients_tenant_cnpj_idx')
      .on(table.tenantId, table.cnpj)
      .where(sql`${table.cnpj} is not null`),
  ],
);

const clientRef = () =>
  uuid('client_id')
    .notNull()
    .references((): AnyPgColumn => clients.id, { onDelete: 'cascade' });

/**
 * Block 2: the partners and legal representatives. The same person may be a
 * partner of several clients, so the CPF is unique within a client only. The
 * CPF is stored like an employee's (AES-256-GCM + HMAC blind index).
 */
export const clientPartners = pgTable(
  'client_partners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientRef(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    cpfEncrypted: text('cpf_encrypted'),
    cpfIndex: text('cpf_index'),
    rg: text('rg'),
    rgIssuer: text('rg_issuer'),
    nationality: text('nationality'),
    profession: text('profession'),
    maritalStatus: text('marital_status'),
    propertyRegime: text('property_regime'),
    address: jsonb('address').$type<Record<string, string | null>>().notNull().default({}),
    email: text('email'),
    mobile: text('mobile'),
    sharePercent: numeric('share_percent', { precision: 5, scale: 2, mode: 'number' }),
    signsForCompany: boolean('signs_for_company').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    index('client_partners_client_idx').on(table.clientId),
    uniqueIndex('client_partners_client_cpf_idx')
      .on(table.clientId, table.cpfIndex)
      .where(sql`${table.cpfIndex} is not null`),
  ],
);

/** Block 3: one contact per role (principal, financeiro, marketing). */
export const clientContacts = pgTable(
  'client_contacts',
  {
    clientId: clientRef(),
    role: text('role').notNull(),
    name: text('name').notNull(),
    jobTitle: text('job_title'),
    email: text('email'),
    whatsapp: text('whatsapp'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.role] })],
);

/** Block 4: the business as it is today. One row per client, made on first save. */
export const clientBusiness = pgTable('client_business', {
  clientId: clientRef().primaryKey(),
  segment: text('segment'),
  description: text('description'),
  operatingYears: integer('operating_years'),
  ownUnits: integer('own_units'),
  revenueBand: text('revenue_band'),
  averageTicketCents: bigint('average_ticket_cents', { mode: 'number' }),
  employeesCount: integer('employees_count'),
  inpiProcess: text('inpi_process'),
  inpiClass: text('inpi_class'),
  inpiStatus: text('inpi_status'),
  /** CRM plan §3.1 (Manus): a FitLevel each, and where and when the profile was told. */
  franchisability: text('franchisability'),
  wingsFit: text('wings_fit'),
  profileSource: text('profile_source'),
  profileDate: date('profile_date'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Block 5: the contracts with Wings. */
export const clientContracts = pgTable(
  'client_contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientRef(),
    position: integer('position').notNull(),
    service: text('service').notNull(),
    number: text('number'),
    signedOn: date('signed_on'),
    valueCents: bigint('value_cents', { mode: 'number' }),
    paymentMethod: text('payment_method'),
    installments: integer('installments'),
    startsOn: date('starts_on'),
    termMonths: integer('term_months'),
    /** The CRM lead the client came from. Not a foreign key: a lead may be erased under LGPD. */
    leadId: uuid('lead_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [index('client_contracts_client_idx').on(table.clientId)],
);

/** The consultant of each Formatação area on a contract: one employee per area. */
export const clientContractConsultants = pgTable(
  'client_contract_consultants',
  {
    contractId: uuid('contract_id')
      .notNull()
      .references(() => clientContracts.id, { onDelete: 'cascade' }),
    /** A sub-sector of `formatacao` (`CONSULTANT_AREAS`). */
    area: text('area').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
  },
  (table) => [primaryKey({ columns: [table.contractId, table.area] })],
);

/** Block 6: the franchise being planned, which the COF is drawn from. */
export const clientFranchisePlans = pgTable('client_franchise_plans', {
  clientId: clientRef().primaryKey(),
  franchiseFeeCents: bigint('franchise_fee_cents', { mode: 'number' }),
  royaltiesPercent: numeric('royalties_percent', { precision: 5, scale: 2, mode: 'number' }),
  adFundPercent: numeric('ad_fund_percent', { precision: 5, scale: 2, mode: 'number' }),
  initialInvestmentCents: bigint('initial_investment_cents', { mode: 'number' }),
  franchiseeProfile: text('franchisee_profile'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientUnitModels = pgTable(
  'client_unit_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientRef(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    initialInvestmentCents: bigint('initial_investment_cents', { mode: 'number' }),
    franchiseFeeCents: bigint('franchise_fee_cents', { mode: 'number' }),
    areaM2: integer('area_m2'),
  },
  (table) => [index('client_unit_models_client_idx').on(table.clientId)],
);

/** Block 7: how the client's documents get signed (the signing itself is the Documenso wave). */
export const clientSignatures = pgTable('client_signatures', {
  clientId: clientRef().primaryKey(),
  signerPartnerId: uuid('signer_partner_id').references(() => clientPartners.id, {
    onDelete: 'set null',
  }),
  signingEmail: text('signing_email'),
  signingMobile: text('signing_mobile'),
  signatureType: text('signature_type'),
  forum: text('forum'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Witnesses of the client's contracts; their CPF is kept like a partner's. */
export const clientWitnesses = pgTable(
  'client_witnesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientRef(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    cpfEncrypted: text('cpf_encrypted'),
    cpfIndex: text('cpf_index'),
    email: text('email'),
  },
  (table) => [index('client_witnesses_client_idx').on(table.clientId)],
);

/** `client_id`, defaulting to Wings Company. */
export const clientId = () =>
  uuid('client_id')
    .notNull()
    .default(WINGS_CLIENT_ID)
    .references(() => clients.id);
