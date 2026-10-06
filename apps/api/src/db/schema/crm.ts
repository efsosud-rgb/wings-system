import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { clients } from './clients.js';
import { driveFiles } from './drive.js';
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * CRM Vendas, the Funil as the place of work (Fase 1 of
 * /root/relatorios/plano-crm-sofia-2026-10-05.md). The Wings System is the
 * official CRM since 05/10/2026; RD CRM gets a copy while the transition
 * lasts. Nothing here holds a name, an e-mail or a phone: that stays in
 * `leads`; notes are the one free text, and they belong to the lead's page.
 */

/**
 * The stages of a funnel, one list per pipeline. The defaults are RD CRM's
 * own stages, learned from the deals the import and the hourly follow-up read
 * (`ensureStage`); a manager renames, reorders, adds or retires them in
 * Administração → CRM. `rd_stage_id` keeps the copy to RD possible.
 */
export const crmStages = pgTable(
  'crm_stages',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** A LeadPipeline. */
    pipeline: text('pipeline').notNull(),
    name: text('name').notNull(),
    /** 1-based; unique among the active stages of a pipeline in practice, re-numbered on every reorder. */
    position: integer('position').notNull(),
    active: boolean('active').notNull().default(true),
    rdStageId: text('rd_stage_id'),
    /** Sofia's entry stage (Fase 4): a lead there is hers until she hands it over. */
    sofiaEntry: boolean('sofia_entry').notNull().default(false),
    /** Chance (0–100) a deal here closes; weights the column's value on the board. */
    probability: integer('probability').notNull().default(10),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_stages_pipeline_name_uq').on(table.tenantId, table.pipeline, table.name),
    index('crm_stages_pipeline_position_idx').on(table.pipeline, table.position),
  ],
);

/**
 * Append-only: every change of stage or outcome of a lead, by whom and from
 * where (a person in the Wings System, the RD mirror, the importer, Sofia).
 * Stage names are copied so the history reads the same after a rename.
 */
export const leadStageHistory = pgTable(
  'lead_stage_history',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    fromStageId: uuid('from_stage_id').references(() => crmStages.id),
    toStageId: uuid('to_stage_id').references(() => crmStages.id),
    fromStage: text('from_stage'),
    toStage: text('to_stage'),
    /** Outcome after the change: true won, false lost, null open. */
    won: boolean('won'),
    lostReason: text('lost_reason'),
    /** A LeadChangeSource: wings | rd | import | sofia. */
    source: text('source').notNull(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
  },
  (table) => [index('lead_stage_history_lead_idx').on(table.leadId, table.at)],
);

/** Append-only notes a person writes on a lead. The one free text of the CRM; shown only on the lead's page. */
export const leadNotes = pgTable(
  'lead_notes',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    authorEmployeeId: uuid('author_employee_id').references(() => employees.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('lead_notes_lead_idx').on(table.leadId, table.createdAt)],
);

/**
 * Follow-up tasks on a lead. `auto` ones are made by the system (the
 * first-contact SLA when a lead gets an owner); done ones keep who and when.
 */
export const leadTasks = pgTable(
  'lead_tasks',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** A LeadTaskKind. */
    kind: text('kind').notNull().default('follow_up'),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    assigneeEmployeeId: uuid('assignee_employee_id').references(() => employees.id),
    auto: boolean('auto').notNull().default(false),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => employees.id),
  },
  (table) => [
    index('lead_tasks_lead_idx').on(table.leadId, table.dueAt),
    index('lead_tasks_assignee_due_idx').on(table.assigneeEmployeeId, table.doneAt, table.dueAt),
  ],
);

/**
 * A Drive file attached to a deal (ficha do cliente, 06/10/2026). The bytes,
 * the name and who may open it stay the Drive's: this row only says "this
 * file belongs to this deal". Removing the row leaves the file in the Drive.
 */
export const leadFiles = pgTable(
  'lead_files',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    driveFileId: uuid('drive_file_id')
      .notNull()
      .references(() => driveFiles.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lead_files_lead_file_uq').on(table.leadId, table.driveFileId),
    index('lead_files_lead_idx').on(table.leadId, table.createdAt),
  ],
);

/**
 * The rotation of a funnel: who takes the next lead that arrives with no
 * owner. Round-robin by `last_assigned_at` (the member who waited longest);
 * a paused member keeps their leads and takes no new one. Seeded from
 * `rd_user_map` (our RD users linked to employees), never from invented names.
 */
export const crmDistributionMembers = pgTable(
  'crm_distribution_members',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** A LeadPipeline. */
    pipeline: text('pipeline').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    active: boolean('active').notNull().default(true),
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => employees.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_distribution_members_uq').on(table.tenantId, table.pipeline, table.employeeId),
  ],
);

// --- contacts and companies (CRM núcleo, 05/10/2026) ------------------------------------

/**
 * The companies the deals are with: one row per company, found again by CNPJ
 * or by its normalised name (`name_key`), so an import or a second lead never
 * makes a twin. A won Expansão/Formatação deal turns the company into a
 * client of the Formatação register with one click (`client_id` then points
 * at it). A merged duplicate stays as a row with `merged_into_id`, so an old
 * link still resolves.
 */
export const crmCompanies = pgTable(
  'crm_companies',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** `companyKey(name)`: accent- and case-blind, no punctuation. */
    nameKey: text('name_key').notNull(),
    /** 14 characters, digits (or letters and digits since 2026); unique among the live rows. */
    cnpj: text('cnpj'),
    /** Digits only, 55 + DDD + number. */
    phone: text('phone'),
    /** Lower-cased. */
    email: text('email'),
    website: text('website'),
    city: text('city'),
    state: text('state'),
    segment: text('segment'),
    clientId: uuid('client_id').references(() => clients.id),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => crmCompanies.id),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_companies_cnpj_uq')
      .on(table.tenantId, table.cnpj)
      .where(sql`${table.cnpj} is not null and ${table.mergedIntoId} is null`),
    uniqueIndex('crm_companies_name_key_uq')
      .on(table.tenantId, table.nameKey)
      .where(sql`${table.mergedIntoId} is null`),
    index('crm_companies_client_idx').on(table.clientId),
  ],
);

/**
 * The people: one row per person, found again by e-mail or by phone, so the
 * same person arriving twice (two forms, an import) is one contact with two
 * leads. Personal data: shown on its own page and on the lead, never in a
 * log, an event or an audit row.
 */
export const crmContacts = pgTable(
  'crm_contacts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    /** Lower-cased. */
    email: text('email'),
    /** Digits only, 55 + DDD + number. */
    phone: text('phone'),
    jobTitle: text('job_title'),
    companyId: uuid('company_id').references(() => crmCompanies.id),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => crmContacts.id),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_contacts_email_uq')
      .on(table.tenantId, table.email)
      .where(sql`${table.email} is not null and ${table.mergedIntoId} is null`),
    uniqueIndex('crm_contacts_phone_uq')
      .on(table.tenantId, table.phone)
      .where(sql`${table.phone} is not null and ${table.mergedIntoId} is null`),
    index('crm_contacts_company_idx').on(table.companyId),
  ],
);

/** A lead has one or more contacts; the first one is the deal's main person. */
export const leadContacts = pgTable(
  'lead_contacts',
  {
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => crmContacts.id),
    primary: boolean('primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.leadId, table.contactId] }),
    index('lead_contacts_contact_idx').on(table.contactId),
  ],
);

/**
 * Append-only: the calls and meetings a person records on a lead. A call has
 * an outcome and a duration; a meeting has participants and the Meet link
 * when there is one. The note is the one free text, for the lead's page.
 */
export const leadActivities = pgTable(
  'lead_activities',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** A LeadActivityKind: call | meeting. */
    kind: text('kind').notNull(),
    /** When the call happened or the meeting is (was) held. */
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** A LeadCallOutcome, calls only. */
    outcome: text('outcome'),
    durationSeconds: integer('duration_seconds'),
    /** Meetings only: who was there, as typed. */
    participants: text('participants'),
    meetUrl: text('meet_url'),
    note: text('note'),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('lead_activities_lead_idx').on(table.leadId, table.at)],
);

/** A person's saved filter set on a funnel: a tab of Negociações next to "Todas" and "Minhas". */
export const crmSavedViews = pgTable(
  'crm_saved_views',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    pipeline: text('pipeline').notNull(),
    name: text('name').notNull(),
    /** The list query's fields, strings only. */
    filters: jsonb('filters').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('crm_saved_views_employee_idx').on(table.employeeId, table.pipeline)],
);
