import {
  CONTACT_KEY_KINDS,
  IG_PRIVATE_REPLY_STATUSES,
  IG_WEBHOOK_KINDS,
  IG_WEBHOOK_STATUSES,
  PROSPECT_EVIDENCE_SOURCES,
  PROSPECT_OPPORTUNITY_STATES,
} from '@wings/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';

/**
 * The CHECKs of the Prospect AI and Instagram tables are the lists of `@wings/shared`: a value
 * added on one side only would be refused by the database, or accepted by the database and
 * rejected by the screen. Read from the migrated database, so a migration that drifts fails here.
 */

let harness: TestDatabase;
beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);
afterAll(async () => harness.drop());

async function checkValues(constraint: string): Promise<string[]> {
  const result = await harness.db.execute<{ def: string }>(
    sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${constraint}`,
  );
  const def = result.rows[0]?.def;
  if (!def) throw new Error(`no constraint ${constraint}`);
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
}

describe('CHECK = shared list', () => {
  it.each([
    ['ig_webhook_events_kind_check', IG_WEBHOOK_KINDS],
    ['ig_webhook_events_status_check', IG_WEBHOOK_STATUSES],
    ['ig_private_replies_status_check', IG_PRIVATE_REPLY_STATUSES],
    ['contact_opt_outs_key_kind_check', CONTACT_KEY_KINDS],
    ['prospect_evidence_source_check', PROSPECT_EVIDENCE_SOURCES],
    ['prospect_opportunities_state_check', PROSPECT_OPPORTUNITY_STATES],
  ] as const)('%s', async (constraint, list) => {
    expect(await checkValues(constraint)).toEqual([...list].sort());
  });
});
