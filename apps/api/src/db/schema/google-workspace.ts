import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * One row per PERSON connected to Google Workspace (Agenda, Meet and Gmail),
 * unlike `integration_connections`, which is one row per service for the
 * whole system. The token is the person's own: the API acts on their calendar
 * and mailbox only, never on another's (docs/integracoes/google-workspace.md).
 *
 * Every credential column holds ciphertext from `secret-box.ts` under
 * INTEGRATIONS_ENCRYPTION_KEY: the access token, the refresh token and, while
 * an authorization is in progress, the PKCE verifier inside `pending`.
 * Nothing here is usable without that key, and nothing here is ever logged.
 */
export const googleWorkspaceConnections = pgTable(
  'google_workspace_connections',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    /** pending | connected | needs_reconnect */
    state: text('state').notNull().default('pending'),
    /** The Google account that consented, shown to its owner only. */
    googleEmail: text('google_email'),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    scopes: text('scopes').array().notNull().default([]),
    /** { state, verifierEnc, startedAt } while the browser is at Google's consent screen. */
    pending: jsonb('pending'),
    /** A code, never a provider message that could quote a credential. */
    lastError: text('last_error'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    /** Where the reading of the leads' replies stopped in this mailbox (Gmail's historyId); null before the first read. */
    gmailHistoryId: text('gmail_history_id'),
    gmailReadAt: timestamp('gmail_read_at', { withTimezone: true }),
    /** The last read's failure as a code (history_expired, gmail_403…), never Google's text. */
    gmailReadError: text('gmail_read_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('google_workspace_connections_employee_uq').on(table.employeeId),
    index('google_workspace_connections_state_idx').on(table.state),
  ],
);
