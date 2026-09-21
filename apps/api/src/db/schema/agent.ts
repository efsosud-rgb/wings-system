import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { adChangeRequests, tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * The conversation with the traffic agent.
 *
 * Conversations belong to one employee and are never shared: what somebody
 * asked the agent is theirs. Messages are append-only — a reply that was cut
 * short stays as it was, with a notice, and the next one is a new row.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

export const agentConversations = pgTable(
  'agent_conversations',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    /** The first words of the first message. Never a name or a number. */
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_conversations_employee_idx').on(table.employeeId, table.updatedAt)],
);

export const agentMessageRoleEnum = pgEnum('agent_message_role', ['user', 'assistant']);

export const agentMessages = pgTable(
  'agent_messages',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id, { onDelete: 'cascade' }),
    /** Denormalised from the conversation: the daily ceiling sums by employee. */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    role: agentMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    /**
     * Assistant only: every tool the model called for this reply, in order,
     * with the arguments it sent and what it was handed back. This is the
     * record of what the agent looked at before it said what it said.
     */
    toolCalls: jsonb('tool_calls').notNull().default([]),
    /** Set when the reply was cut short (daily ceiling, provider failure). */
    notice: text('notice'),
    /**
     * Assistant only: one entry per call to the model — why it stopped
     * (`stop`, `tool_calls`, `length`…), tokens and how many tools it asked
     * for. Numbers and enum values only, so it can be read when a reply goes
     * wrong without reading anybody's conversation.
     */
    diagnostics: jsonb('diagnostics').notNull().default({}),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Millionths of a US dollar: the provider's figure when it gives one. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    /** 'provider' when OpenRouter reported the cost, 'estimate' otherwise. */
    costSource: text('cost_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_messages_conversation_idx').on(table.conversationId, table.createdAt),
    index('agent_messages_employee_day_idx').on(table.employeeId, table.createdAt),
  ],
);

export const agentProposalKindEnum = pgEnum('agent_proposal_kind', ['campaign', 'change']);
export const agentProposalStatusEnum = pgEnum('agent_proposal_status', [
  'open',
  'applied',
  'requested',
  'refused',
]);

/**
 * Something the agent proposed. A row here is a card on a screen and nothing
 * else: it reserves no budget and reaches no platform. `changeRequestId` is
 * set only after a person clicked "Criar pedido" and the budget guard said yes.
 */
export const agentProposals = pgTable(
  'agent_proposals',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => agentMessages.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    kind: agentProposalKindEnum('kind').notNull(),
    /** Validated against the shared schema before it is stored. */
    payload: jsonb('payload').notNull(),
    status: agentProposalStatusEnum('status').notNull().default('open'),
    /** Who clicked, and when. Null while the card is only a card. */
    actedBy: uuid('acted_by').references(() => employees.id),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    changeRequestId: uuid('change_request_id').references(() => adChangeRequests.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_proposals_conversation_idx').on(table.conversationId)],
);
