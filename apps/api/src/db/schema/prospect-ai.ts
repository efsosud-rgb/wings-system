import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * Wings Prospect AI (spec PA, PR #54, annex 1), only the tables Prospecção Instagram's parte 2
 * uses (docs/prospeccao/instagram.md §2). The lists in the CHECKs are the ones in
 * `@wings/shared` (`prospect-ai.ts`); `prospect-ai-schema.test.ts` keeps them equal.
 */

/** One row per tenant: `{ instagram }`. Missing row or part = the defaults. */
export const prospectAiSettings = pgTable('prospect_ai_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  settings: jsonb('settings').notNull(),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One paste the seller confirmed (parte 2). Counts and the public link of a company's post only:
 * the pasted text is never written anywhere.
 */
export const igPasteBatches = pgTable(
  'ig_paste_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    postUrl: text('post_url').notNull(),
    /** The competitor's or the brand's @ (a company), lower case, without the arroba. */
    postOwnerUsername: text('post_owner_username'),
    chars: integer('chars').notNull(),
    linesTotal: integer('lines_total').notNull(),
    commentsFound: integer('comments_found').notNull(),
    linesIgnored: integer('lines_ignored').notNull(),
    linesUnrecognized: integer('lines_unrecognized').notNull(),
    alreadyKnown: integer('already_known').notNull(),
    formatDetected: text('format_detected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ig_paste_batches_creator_idx').on(table.tenantId, table.createdBy, table.createdAt),
    check(
      'ig_paste_batches_post_url_check',
      sql`${table.postUrl} like 'https://www.instagram.com/%' and position('?' in ${table.postUrl}) = 0`,
    ),
    check(
      'ig_paste_batches_format_check',
      sql`${table.formatDetected} is null or ${table.formatDetected} in ('web_computador', 'web_celular', 'manual', 'misto')`,
    ),
  ],
);

/**
 * The proof of an opportunity: a comment. Append-only; retention deletes the whole row. The
 * excerpt is masked (no phone, e-mail, link or other @) and at most 280 characters.
 */
export const prospectEvidence = pgTable(
  'prospect_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    source: text('source').notNull(),
    /** Parte 2: sha256 of the post link, the @ and the normalized text (a repeat is dropped). */
    externalId: text('external_id').notNull(),
    url: text('url'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    occurredAtPrecision: text('occurred_at_precision').notNull().default('exata'),
    excerpt: text('excerpt'),
    authorIgsid: text('author_igsid'),
    authorUsername: text('author_username'),
    mediaId: text('media_id'),
    adId: text('ad_id'),
    legalBasis: text('legal_basis').notNull(),
    /** Deleted after this unless it became a lead (null then: the lead's own retention rules). */
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    recordedBy: uuid('recorded_by').references(() => employees.id),
    /** The opportunity it proves; its deletion takes the evidence with it. */
    opportunityId: uuid('opportunity_id').references((): AnyPgColumn => prospectOpportunities.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('prospect_evidence_external_uq').on(table.tenantId, table.source, table.externalId),
    index('prospect_evidence_igsid_idx').on(table.tenantId, table.authorIgsid),
    index('prospect_evidence_username_idx').on(table.tenantId, table.authorUsername),
    index('prospect_evidence_opportunity_idx').on(table.opportunityId),
    index('prospect_evidence_retention_idx').on(table.retentionUntil),
    check(
      'prospect_evidence_source_check',
      sql`${table.source} in ('instagram_comment', 'instagram_dm', 'instagram_ad_comment', 'instagram_ad_referral', 'instagram_mention', 'competitor_radar', 'instagram_colagem')`,
    ),
    check(
      'prospect_evidence_precision_check',
      sql`${table.occurredAtPrecision} in ('exata', 'aproximada')`,
    ),
    check('prospect_evidence_excerpt_check', sql`char_length(${table.excerpt}) <= 280`),
    check(
      'prospect_evidence_legal_basis_check',
      sql`${table.legalBasis} in ('consent', 'pre_contract', 'legitimate_interest')`,
    ),
  ],
);

/** The queue: one opportunity per person being worked, opened by one evidence. */
export const prospectOpportunities = pgTable(
  'prospect_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references((): AnyPgColumn => prospectEvidence.id),
    source: text('source').notNull(),
    state: text('state').notNull().default('nova'),
    category: text('category'),
    secondaryCategories: text('secondary_categories').array().notNull().default([]),
    intent: text('intent'),
    buySignal: text('buy_signal'),
    priority: smallint('priority'),
    confidence: smallint('confidence'),
    justification: text('justification'),
    classificationId: uuid('classification_id').references(
      (): AnyPgColumn => prospectClassifications.id,
      { onDelete: 'set null' },
    ),
    needsReviewReason: text('needs_review_reason'),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id),
    respondBy: timestamp('respond_by', { withTimezone: true }),
    /** Parte 2: when the seller clicked "Abordei". */
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    // No action, not set null: an approved prospect must keep its lead (the approved CHECK), so a
    // lead tied to one is not deleted, as with prospects.lead_id of the Google search.
    leadId: uuid('lead_id').references(() => leads.id),
    duplicateOfOpportunityId: uuid('duplicate_of_opportunity_id').references(
      (): AnyPgColumn => prospectOpportunities.id,
      { onDelete: 'set null' },
    ),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    pasteBatchId: uuid('paste_batch_id').references(() => igPasteBatches.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('prospect_opportunities_evidence_uq').on(table.evidenceId),
    index('prospect_opportunities_queue_idx').on(table.tenantId, table.state, table.respondBy),
    index('prospect_opportunities_owner_idx').on(
      table.tenantId,
      table.ownerEmployeeId,
      table.state,
    ),
    index('prospect_opportunities_source_idx').on(table.tenantId, table.source, table.createdAt),
    index('prospect_opportunities_lead_idx').on(table.leadId),
    index('prospect_opportunities_batch_idx').on(table.pasteBatchId),
    check(
      'prospect_opportunities_source_check',
      sql`${table.source} in ('instagram_comment', 'instagram_dm', 'instagram_ad_comment', 'instagram_ad_referral', 'instagram_mention', 'competitor_radar', 'instagram_colagem')`,
    ),
    check(
      'prospect_opportunities_state_check',
      sql`${table.state} in ('nova', 'em_revisao', 'abordada', 'aprovada', 'rejeitada', 'duplicada', 'prazo_vencido')`,
    ),
    check(
      'prospect_opportunities_intent_check',
      sql`${table.intent} is null or ${table.intent} in ('interesse_declarado', 'necessidade_provavel', 'conteudo_educativo', 'comentario_casual', 'outro_assunto', 'informacao_insuficiente')`,
    ),
    check(
      'prospect_opportunities_signal_check',
      sql`${table.buySignal} is null or ${table.buySignal} in ('quer_comprar', 'pediu_preco', 'duvida', 'elogio', 'reclamacao', 'spam')`,
    ),
    check(
      'prospect_opportunities_review_check',
      sql`${table.needsReviewReason} is null or ${table.needsReviewReason} in ('confianca_baixa', 'revisao_obrigatoria', 'servico_nao_vendido', 'sem_ia', 'teto_ia', 'ia_invalida', 'registro_manual', 'duvida')`,
    ),
    check(
      'prospect_opportunities_secondary_check',
      sql`cardinality(${table.secondaryCategories}) <= 3`,
    ),
    check('prospect_opportunities_priority_check', sql`${table.priority} between 0 and 100`),
    check('prospect_opportunities_confidence_check', sql`${table.confidence} between 0 and 100`),
    check(
      'prospect_opportunities_justification_check',
      sql`char_length(${table.justification}) <= 200`,
    ),
    check('prospect_opportunities_reason_check', sql`char_length(${table.decisionReason}) <= 300`),
    check(
      'prospect_opportunities_approved_check',
      sql`${table.state} <> 'aprovada' or ${table.leadId} is not null`,
    ),
    check(
      'prospect_opportunities_duplicate_check',
      sql`${table.state} <> 'duplicada' or ${table.leadId} is not null or ${table.duplicateOfOpportunityId} is not null`,
    ),
    check(
      'prospect_opportunities_decided_check',
      sql`${table.state} not in ('aprovada', 'rejeitada', 'duplicada') or ${table.decidedAt} is not null`,
    ),
  ],
);

/** Every classification (rule, AI or person), append-only; the opportunity points to the current. */
export const prospectClassifications = pgTable(
  'prospect_classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references((): AnyPgColumn => prospectOpportunities.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    category: text('category'),
    secondaryCategories: text('secondary_categories').array().notNull().default([]),
    intent: text('intent'),
    buySignal: text('buy_signal'),
    confidence: smallint('confidence'),
    justification: text('justification'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    runId: uuid('run_id').references(() => prospectClassifierRuns.id),
    verdict: text('verdict'),
    verdictFields: text('verdict_fields').array(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('prospect_classifications_opportunity_idx').on(table.opportunityId, table.createdAt),
    index('prospect_classifications_method_idx').on(table.tenantId, table.method, table.createdAt),
    check(
      'prospect_classifications_method_check',
      sql`${table.method} in ('palavra_chave', 'regra', 'ia', 'ia_lote', 'ia_sombra', 'humano')`,
    ),
    check(
      'prospect_classifications_signal_check',
      sql`${table.buySignal} is null or ${table.buySignal} in ('quer_comprar', 'pediu_preco', 'duvida', 'elogio', 'reclamacao', 'spam')`,
    ),
    check(
      'prospect_classifications_verdict_check',
      sql`${table.verdict} is null or ${table.verdict} in ('certo', 'errado')`,
    ),
    check(
      'prospect_classifications_justification_check',
      sql`char_length(${table.justification}) <= 200`,
    ),
  ],
);

/**
 * The classifier's cache: the hash of the masked text and the validated output, never the text.
 * The output holds the justifying phrase (a piece of the masked text): short retention.
 */
export const prospectClassifierCache = pgTable(
  'prospect_classifier_cache',
  {
    tenantId: tenantId(),
    keyHash: text('key_hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.keyHash] }),
    index('prospect_classifier_cache_created_idx').on(table.createdAt),
  ],
);

/** One paid call to the model, reserved under a lock before it goes (no personal data). */
export const prospectClassifierRuns = pgTable(
  'prospect_classifier_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** The batch's comments' hashes joined and hashed again: links to the cache, not the text. */
    keyHash: text('key_hash').notNull(),
    shadow: boolean('shadow').notNull().default(false),
    /** How many comments went in the call (20 at most in a batch). */
    items: smallint('items').notNull().default(1),
    reservedMicroUsd: integer('reserved_micro_usd').notNull(),
    costMicroUsd: integer('cost_micro_usd'),
    costSource: text('cost_source'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    outcome: text('outcome').notNull().default('pending'),
  },
  (table) => [
    index('prospect_classifier_runs_at_idx').on(table.tenantId, table.at),
    check(
      'prospect_classifier_runs_cost_source_check',
      sql`${table.costSource} is null or ${table.costSource} in ('provider', 'estimate')`,
    ),
    check(
      'prospect_classifier_runs_outcome_check',
      sql`${table.outcome} in ('pending', 'ok', 'invalid', 'failed', 'timeout')`,
    ),
  ],
);
