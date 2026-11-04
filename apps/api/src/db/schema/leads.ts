import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { clientId, clients } from './clients.js';
import { employees } from './employees.js';
import { jobs } from './jobs.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * Funil Sofia, part 1 (docs/leads/intake.md). A lead is a person who reached
 * out: through a landing page (RD Station), a tracked WhatsApp link, a Meta
 * Lead Ads form, or a person typing one in. Name, e-mail and phone are
 * personal data: they are never written to a log, an audit row or a job's
 * error, and the worker refers to a lead only by id.
 */
export const leads = pgTable(
  'leads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientId(),
    /** False when no source rule named the client: filed under Wings Company until someone adds one. */
    clientMapped: boolean('client_mapped').notNull().default(true),
    name: text('name'),
    /** Lower-cased. */
    email: text('email'),
    /** Digits only, 55 + DDD + number. */
    phone: text('phone'),
    /** Part 1 knows only `new`; the SDR handoff (part 2) adds the rest. */
    status: text('status').notNull().default('new'),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id),
    /** rd_station | whatsapp_link | meta_lead_ads | manual */
    source: text('source').notNull(),
    /** A LeadChannel, or null when nothing said. */
    channel: text('channel'),
    landingPage: text('landing_page'),
    campaignId: text('campaign_id'),
    campaignName: text('campaign_name'),
    formId: text('form_id'),
    trackingLinkId: uuid('tracking_link_id'),
    /** RD's lead uuid or Meta's leadgen id, unique per source so a retried webhook is the same lead. */
    externalId: text('external_id'),
    /** The first WhatsApp message, for the SDR to read; nothing is derived from it but the code. */
    firstMessage: text('first_message'),
    whatsappProfileName: text('whatsapp_profile_name'),
    whatsappPhotoUrl: text('whatsapp_photo_url'),
    /** City the person gave (a form field), as typed. */
    city: text('city'),
    /**
     * The other answers of a form (Meta Lead Ads, WhatsApp Flow): question ->
     * answer, without the contact fields. Personal data: shown on the lead
     * only, never in an event, an audit row or a log.
     */
    formAnswers: jsonb('form_answers'),
    /**
     * The fields every lead form asks, in their own place (docs/leads/formularios.md):
     * mapped from the answers by the text of the question. Kept as typed when it
     * could not be normalised; the check says why.
     */
    instagram: text('instagram'),
    website: text('website'),
    companyName: text('company_name'),
    /** Digits only (or the new alphanumeric form), when the form asked for it. */
    companyCnpj: text('company_cnpj'),
    /** LeadChecks: confere / não confere / não verificado per field, with the reason. */
    fieldChecks: jsonb('field_checks').notNull().default({}),
    /** LGPD: a LeadLegalBasis, when it was given and where (docs/leads/intake.md). */
    legalBasis: text('legal_basis'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    consentSource: text('consent_source'),
    consentText: text('consent_text'),
    /** none | pending | running | done | failed; the worker writes the rest. */
    enrichmentState: text('enrichment_state').notNull().default('none'),
    enrichmentJobId: uuid('enrichment_job_id').references(() => jobs.id),
    enrichmentSummary: text('enrichment_summary'),
    enrichmentScore: integer('enrichment_score'),
    enrichmentCriteria: jsonb('enrichment_criteria').notNull().default([]),
    enrichmentLinks: jsonb('enrichment_links').notNull().default([]),
    enrichmentFacts: jsonb('enrichment_facts'),
    enrichmentError: text('enrichment_error'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    /** A LeadPipeline (expansao | formatacao), from the source rule or the RD CRM funnel; null when nothing said. */
    pipeline: text('pipeline'),
    /** The brand's name as the rule or RD named it, kept even before the brand is registered as a client. */
    brand: text('brand'),
    /** The company the deal is with (`crm_companies`); no FK, a merge re-points it. */
    companyId: uuid('company_id'),
    /** Estimated value of the deal, in cents; null while nobody said. */
    valueCents: bigint('value_cents', { mode: 'number' }),
    /** The day the seller expects to close the deal (a calendar date, no time); null while nobody said. */
    expectedCloseAt: date('expected_close_at'),
    /**
     * CRM Vendas phase 1 (docs/crm/fase1-complemento-funil.md): while RD CRM
     * is where the team works, the stage is read from it and only mirrored
     * here. Labels and ids, never text about the person.
     */
    rdDealId: text('rd_deal_id'),
    rdContactId: text('rd_contact_id'),
    /** RD CRM user id of the deal's owner; `rd_user_map` turns it into an employee. */
    rdOwnerId: text('rd_owner_id'),
    rdPipeline: text('rd_pipeline'),
    stage: text('stage'),
    /** 1-based position of the stage in its RD pipeline. */
    stageOrder: integer('stage_order'),
    stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }),
    /** The Wings stage (`crm_stages`); `stage`/`stage_order` are kept in step with it. */
    stageId: uuid('stage_id'),
    /**
     * Who runs this lead's stage, owner and outcome: `rd` while nobody touched
     * it in the Wings System (the hourly follow-up mirrors RD), `wings` from the
     * first change made here (RD is then only a copy and never overwrites).
     */
    managedBy: text('managed_by').notNull().default('wings'),
    /** true won, false lost, null open. */
    won: boolean('won'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    /** When the deal first left its first stage, from RD's `deal_stage_histories`. */
    firstContactAt: timestamp('first_contact_at', { withTimezone: true }),
    /** When the stage columns were last read from RD CRM. */
    rdSyncedAt: timestamp('rd_synced_at', { withTimezone: true }),
    /** First-touch attribution, as the conversion carried it (spec §1.4); never overwritten. */
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    gclid: text('gclid'),
    fbclid: text('fbclid'),
    gbraid: text('gbraid'),
    wbraid: text('wbraid'),
    /** meta | google | null */
    adPlatform: text('ad_platform'),
    adCampaignExternalId: text('ad_campaign_external_id'),
    adSetExternalId: text('ad_set_external_id'),
    adExternalId: text('ad_external_id'),
    referrer: text('referrer'),
    /** Where RD says the visit came from ("Tráfego Direto", "Busca Paga | Google"…): the conversion's or the deal's origin. */
    trafficSource: text('traffic_source'),
    /** The form that converted: RD's `conversion_identifier`, or the site form's page. */
    conversionIdentifier: text('conversion_identifier'),
    /** The import run that created this lead (`leads-import-rd`), so one run can be undone alone. */
    importBatchId: text('import_batch_id'),
    /** The Google Maps place a Prospecção lead came from: only the id, the rest is read live. */
    googlePlaceId: text('google_place_id'),
    /**
     * The deal's AI summary (ficha do cliente, Etapa 4): `{ text, generatedAt,
     * model, basedOn: { events, answers } }`, made only from the timeline and
     * the form answers, never from a phone, an e-mail or a document. Null
     * until somebody asks for one; re-made on request.
     */
    aiSummary: jsonb('ai_summary'),
    /**
     * When the person really entered, by the source's own clock (Meta's `created_time`, the RD
     * deal's creation, the RD Marketing conversion, the moment a site form was sent). The CRM
     * shows, sorts and filters by this. `created_at` stays the row's own time and is not changed.
     */
    /**
     * A likely robot sign-up (`LEAD_SUSPECT_REASONS`): the reasons and when the
     * system marked it. A person who clears it leaves the reasons for history.
     */
    suspectReasons: text('suspect_reasons').array(),
    suspectAt: timestamp('suspect_at', { withTimezone: true }),
    suspectClearedAt: timestamp('suspect_cleared_at', { withTimezone: true }),
    suspectClearedBy: uuid('suspect_cleared_by').references(() => employees.id),
    /**
     * The Instagram check of a site-form lead (`check_instagram` job, docs/leads/instagram.md).
     * `status`: confere | nao_encontrado | nao_bate | pendente | erro; `source`: meta | busca |
     * nenhuma. `detail` has the reason, how each step went, followers and posts (Meta) and the
     * cost; never the profile's text. `verdict` is the machine's (suspeito | falso); the seller's
     * correction sits apart in `instagramManual*`, and the lists read both through
     * `effectiveInstagramVerdict`. Never shown to the person who filled the form.
     */
    instagramCheckStatus: text('instagram_check_status'),
    instagramCheckSource: text('instagram_check_source'),
    instagramCheckedAt: timestamp('instagram_checked_at', { withTimezone: true }),
    instagramCheckDetail: jsonb('instagram_check_detail'),
    instagramVerdict: text('instagram_verdict'),
    instagramManual: text('instagram_manual'),
    instagramManualAt: timestamp('instagram_manual_at', { withTimezone: true }),
    instagramManualBy: uuid('instagram_manual_by').references(() => employees.id),
    /** `instagramVerdict` with the seller's correction applied: what the filter and the stats read. */
    instagramVerdictEffective: text('instagram_verdict_effective'),
    /**
     * Six characters that tie the first WhatsApp message (`<code> <ref>`) to the lead a site form
     * made. Overwritten by a new submission of the same lead; unique among the leads that hold one.
     */
    formRef: text('form_ref'),
    /** When `formRef` was issued: a message may use it for 7 days. */
    formRefAt: timestamp('form_ref_at', { withTimezone: true }),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Whose clock `entered_at` is (`LEAD_ENTERED_SOURCES` in packages/shared). 'received' means
     * the source brought no date and `entered_at` is when the system received the lead.
     */
    enteredAtSource: text('entered_at_source').notNull().default('received'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leads_source_external_uq').on(table.source, table.externalId),
    uniqueIndex('leads_rd_deal_uq').on(table.rdDealId),
    uniqueIndex('leads_form_ref_uq')
      .on(table.formRef)
      .where(sql`${table.formRef} is not null`),
    index('leads_instagram_verdict_idx')
      .on(table.instagramVerdictEffective)
      .where(sql`${table.instagramVerdictEffective} is not null`),
    index('leads_pipeline_stage_idx').on(table.pipeline, table.stage),
    index('leads_stage_id_idx').on(table.stageId),
    index('leads_import_batch_idx').on(table.importBatchId),
    index('leads_phone_idx').on(table.tenantId, table.phone),
    index('leads_email_idx').on(table.tenantId, table.email),
    index('leads_client_created_idx').on(table.clientId, table.createdAt),
    index('leads_owner_idx').on(table.ownerEmployeeId),
    index('leads_company_idx').on(table.companyId),
    index('leads_created_idx').on(table.createdAt),
    index('leads_entered_idx').on(table.enteredAt),
    index('leads_google_place_idx').on(table.tenantId, table.googlePlaceId),
  ],
);

/**
 * Append-only timeline of a lead: received from where, tagged by which code,
 * research started and finished. `detail` is context (ids, counts, step
 * names), never a name, e-mail or phone.
 */
export const leadEvents = pgTable(
  'lead_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    detail: jsonb('detail').notNull().default({}),
  },
  (table) => [index('lead_events_lead_idx').on(table.leadId, table.at)],
);

/**
 * Append-only trail of the edits to a lead's contact data made on the ficha (t089): who, when, field
 * and the value before and after. Personal data, so it is read only through the lead's own route
 * (`GET /leads/:id/contact-changes`, in the caller's scope) and has no GRANT to `wings_ro` and no
 * view: no report, BI or staging query reads it. The timeline event carries field names only.
 */
export const leadContactChanges = pgTable(
  'lead_contact_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** A LeadContactField: name | phone | email | instagram | website. */
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lead_contact_changes_lead_idx').on(table.leadId, table.at),
    check(
      'lead_contact_changes_field_check',
      sql`${table.field} in ('name', 'phone', 'email', 'instagram', 'website')`,
    ),
  ],
);

/**
 * The one "não me contate" register (docs/crm/nao-me-contate.md, Eric 29/10). One row per channel
 * and key (`lead` id, phone, e-mail, Instagram user, place_id, CNPJ), the value in the form
 * `normalizeContactKey` gives it. Never updated but to revoke; `contactBlock` reads it together
 * with the older sources (`wa_contacts.opt_out_at`, prospect `nao_contatar`), which stay as they are.
 */
export const contactOptOuts = pgTable(
  'contact_opt_outs',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** A ContactChannel: all | whatsapp | phone | email | instagram. */
    channel: text('channel').notNull(),
    /** A ContactKeyKind: lead | phone | email | instagram_user | place_id | cnpj. */
    keyKind: text('key_kind').notNull(),
    keyValue: text('key_value').notNull(),
    reason: text('reason'),
    /** A ContactOptOutOrigin: crm | whatsapp_palavra | prospeccao | instagram | importacao. */
    origin: text('origin').notNull(),
    /** Null when the system recorded it (a SAIR on WhatsApp). */
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => employees.id),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('contact_opt_outs_active_uq')
      .on(table.tenantId, table.channel, table.keyKind, table.keyValue)
      .where(sql`${table.revokedAt} is null`),
    check(
      'contact_opt_outs_channel_check',
      sql`${table.channel} in ('all', 'whatsapp', 'phone', 'email', 'instagram')`,
    ),
    check(
      'contact_opt_outs_key_kind_check',
      sql`${table.keyKind} in ('lead', 'phone', 'email', 'instagram_user', 'place_id', 'cnpj')`,
    ),
    check(
      'contact_opt_outs_origin_check',
      sql`${table.origin} in ('crm', 'whatsapp_palavra', 'prospeccao', 'instagram', 'importacao')`,
    ),
  ],
);

/**
 * Landing page / Meta form / Meta campaign -> client and funnel. Kept by
 * whoever holds `clients.manage` (Formatação → Clientes) or, for the
 * brands' landing pages, `integrations.manage` (Integrações → Entrada de
 * leads de Expansão): one list for both, since CRM phase 1. A rule may name a
 * brand that is not yet a client (`client_id` null, `brand` set): its leads
 * are filed under Wings Company, unmapped, with the brand and funnel kept. A
 * conversion that matches no rule still becomes a lead, the same way.
 */
export const leadSourceRules = pgTable(
  'lead_source_rules',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** landing_page | meta_form | meta_campaign | tiktok_form | tiktok_campaign */
    kind: text('kind').notNull(),
    /** Normalised: lower-case, no scheme, no trailing slash. */
    pattern: text('pattern').notNull(),
    /** Null while the brand is not registered as a client; `brand` then names it. */
    clientId: uuid('client_id').references(() => clients.id),
    /** A LeadPipeline, or null for a rule that only names the client. */
    pipeline: text('pipeline'),
    brand: text('brand'),
    active: boolean('active').notNull().default(true),
    /** The page's public address, when known (a landing page generated in CRM Vendas → Landing pages). */
    url: text('url'),
    /** Archived: it stops mapping conversions; history and reports keep it. `active` is false with it. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => employees.id),
    /** The page takes the Wings System's own form (T5, `/lp/<slug>`); off until someone turns it on. */
    siteFormEnabled: boolean('site_form_enabled').notNull().default(false),
    /** RD CRM deal source for the deals made from this page's new conversions; null keeps the default. */
    dealSource: text('deal_source'),
    /**
     * The Expansão intake makes RD CRM deals from this page's conversions. Off
     * for a page whose deals RD's own automation may already make (a duplicate
     * risk), until a person decides (Eric, 01/10).
     */
    rdDealIntake: boolean('rd_deal_intake').notNull().default(true),
    /**
     * The day the page was switched off in RD Station. Unlike archiving, the
     * rule stays active, so late conversions and old leads of the page still
     * map to its brand and funnel.
     */
    rdUnpublishedOn: date('rd_unpublished_on', { mode: 'string' }),
    /**
     * The site page's form (`/lp/<slug>`), as the shared `LeadForm` without
     * the funnel: the optional multiple-choice question, the thank-you text
     * and the policy link. Null means the page's plain form. What is live is
     * `site_form_spec`; a change proposed by the campaign builder waits in
     * `site_form_spec_pending` until Diretoria approves it (Eric, 2026-10-06:
     * nothing on the site changes without a preview and their approval).
     */
    siteFormSpec: jsonb('site_form_spec'),
    siteFormSpecPending: jsonb('site_form_spec_pending'),
    siteFormPendingBy: uuid('site_form_pending_by').references(() => employees.id),
    siteFormPendingAt: timestamp('site_form_pending_at', { withTimezone: true }),
    siteFormApprovedBy: uuid('site_form_approved_by').references(() => employees.id),
    siteFormApprovedAt: timestamp('site_form_approved_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lead_source_rules_kind_pattern_uq').on(table.tenantId, table.kind, table.pattern),
    check(
      'lead_source_rules_client_or_brand',
      sql`${table.clientId} is not null or ${table.brand} is not null`,
    ),
  ],
);

/**
 * RD CRM user -> employee, so a deal's owner shows as a person of ours.
 * Edited in Administração; an RD user with no employee shows as "—". Names
 * here are RD users (our own staff), never leads.
 */
export const rdUserMap = pgTable('rd_user_map', {
  tenantId: tenantId(),
  rdUserId: text('rd_user_id').primaryKey(),
  rdName: text('rd_name').notNull(),
  rdActive: boolean('rd_active').notNull().default(true),
  /**
   * Left the company (Eric, 01/10): their deals count as "dono inativo" even
   * while RD still has the user active. Nothing is reassigned.
   */
  departedAt: timestamp('departed_at', { withTimezone: true }),
  employeeId: uuid('employee_id').references(() => employees.id),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One wa.me link per client and channel: `wa.me/<Wings number>?text=<code>`.
 * The code is what an inbound message starts with; the number is recorded so
 * a link printed in a bio stays explainable after the number changes.
 */
export const leadTrackingLinks = pgTable(
  'lead_tracking_links',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    /** A LeadLinkChannel. */
    channel: text('channel').notNull(),
    code: text('code').notNull(),
    phone: text('phone').notNull(),
    hits: integer('hits').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lead_tracking_links_code_uq').on(table.code),
    index('lead_tracking_links_client_idx').on(table.clientId),
  ],
);

/**
 * Append-only: every enrichment step of every lead, with what it cost in
 * micro-dollars. The daily ceiling (ENRICH_DAILY_USD) is a sum over this
 * table, taken under a lock before each paid call; the row is written before
 * the call is made, and the call is made once.
 */
export const leadEnrichmentLedger = pgTable(
  'lead_enrichment_ledger',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for a spend that belongs to no lead: the Prospecção Instagram finder's paid search (t090). */
    leadId: uuid('lead_id').references(() => leads.id),
    jobId: uuid('job_id').references(() => jobs.id),
    /** zapi_profile | ddd | email_domain | web_search | brasilapi_cnpj */
    step: text('step').notNull(),
    /** started | done | failed | skipped | refused */
    status: text('status').notNull(),
    usdMicro: integer('usd_micro').notNull().default(0),
    /** Counts and codes only; never a query string, a name or a snippet. */
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lead_enrichment_ledger_created_idx').on(table.createdAt),
    index('lead_enrichment_ledger_lead_idx').on(table.leadId, table.createdAt),
  ],
);
