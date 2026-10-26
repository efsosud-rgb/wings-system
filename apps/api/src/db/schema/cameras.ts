import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * Câmeras (docs/cameras.md): the devices (a camera that counts by itself, or a
 * local analysis box) that send 15-minute batches of counts. Only the SHA-256
 * of each device's token is kept; the token itself is shown once, at
 * registration. Names, units and areas live in `dw.dim_dispositivo` and its
 * dimensions (migration 0098); no image ever reaches the server.
 */
export const cameraDevices = pgTable('camera_devices', {
  tenantId: uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  /** A test device: its batches are kept apart (`fonte = teste`) and never reach the panel. */
  test: boolean('test').notNull().default(false),
  createdBy: uuid('created_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastBatchAt: timestamp('last_batch_at', { withTimezone: true }),
});
