import {
  DEFAULT_ICP_WEIGHTS,
  DEFAULT_PROSPECTING_QUOTA,
  DEFAULT_PROSPECTING_RETENTION,
  prospectingIcpSchema,
  prospectingQuotaSchema,
  prospectingRetentionSchema,
  type ProspectingSettings,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { prospectingSettings } from '../../db/schema/index.js';

/**
 * Prospecção's settings, one row per tenant: the ICP weights with the exclusion
 * list, the quota of calls to Google, and how long a reservation and the
 * enrichment are kept (retention). A missing row, or a part that no
 * longer passes the schema, reads as the defaults for that part.
 */

type Executor = Pick<Database, 'query'>;

export async function loadProspectingSettings(db: Executor): Promise<ProspectingSettings> {
  const row = await db.query.prospectingSettings.findFirst({
    where: eq(prospectingSettings.tenantId, WINGS_TENANT_ID),
  });
  const stored = (row?.settings ?? {}) as Record<string, unknown>;
  const icp = prospectingIcpSchema.safeParse(stored.icp);
  const quota = prospectingQuotaSchema.safeParse(stored.quota);
  const retention = prospectingRetentionSchema.safeParse(stored.retention);
  return {
    icp: icp.success ? icp.data : { weights: { ...DEFAULT_ICP_WEIGHTS }, excludedNames: [] },
    quota: quota.success ? quota.data : { ...DEFAULT_PROSPECTING_QUOTA },
    retention: retention.success ? retention.data : { ...DEFAULT_PROSPECTING_RETENTION },
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Saves one part (`icp`, `quota` or `retention`), leaving the others as they are. */
export async function saveProspectingPart<K extends 'icp' | 'quota' | 'retention'>(
  db: Database,
  key: K,
  value: ProspectingSettings[K],
  employeeId: string,
  at: Date,
): Promise<void> {
  const part = { [key]: value };
  await db
    .insert(prospectingSettings)
    .values({ settings: part, updatedBy: employeeId, updatedAt: at })
    .onConflictDoUpdate({
      target: prospectingSettings.tenantId,
      set: {
        settings: sql`${prospectingSettings.settings} || ${JSON.stringify(part)}::jsonb`,
        updatedBy: employeeId,
        updatedAt: at,
      },
    });
}
