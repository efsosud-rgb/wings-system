import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';
import { waConversations } from './whatsapp.js';

/**
 * Sofia, the virtual SDR (docs/whatsapp/sofia.md). Her conversation state
 * lives on `wa_conversations`; here are her settings and the ledger of her
 * AI calls.
 */

/**
 * One row per tenant: on/off, her texts and the questions of each funnel
 * (a SofiaSettings). Missing = the defaults, switched off.
 */
export const sofiaSettings = pgTable('sofia_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  enabled: boolean('enabled').notNull().default(false),
  /** SofiaSettings without `enabled`: texts, formatacao, expansao. */
  settings: jsonb('settings').notNull(),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per AI call Sofia makes (SOFIA_DAILY_USD): reserved before the
 * call under a lock, then the real cost. A call that threw keeps its
 * reservation as its cost (it may have been billed). Ids, codes, token counts
 * and amounts only: never the conversation's text.
 */
export const sofiaAiRuns = pgTable(
  'sofia_ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').references(() => waConversations.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** Names of the tools the call offered the model. Null on rows from before they were recorded. */
    tools: text('tools').array(),
    /** What the provider counted; null while the call runs, if it threw, and on older rows. */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
    /** ok | invalid | failed | timeout */
    outcome: text('outcome'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('sofia_ai_runs_started_idx').on(table.startedAt)],
);
