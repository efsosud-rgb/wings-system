import { SOFIA_DEFAULT_SETTINGS, sofiaSettingsSchema, type SofiaSettings } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { sofiaSettings } from '../../db/schema/index.js';

/**
 * Sofia's settings: on/off, her texts and each funnel's questions. Read on
 * every turn (one row), so a change on the screen counts from the next
 * message. A stored value that no longer passes the schema (an older shape)
 * falls back to the defaults for that part, never to a broken script.
 */

export async function loadSofiaSettings(db: Database): Promise<SofiaSettings> {
  const row = await db.query.sofiaSettings.findFirst({
    where: eq(sofiaSettings.tenantId, WINGS_TENANT_ID),
  });
  if (!row) return SOFIA_DEFAULT_SETTINGS;
  const stored = (row.settings ?? {}) as Partial<SofiaSettings>;
  const parsed = sofiaSettingsSchema.safeParse({ ...stored, enabled: row.enabled });
  if (parsed.success) return parsed.data;
  const part = <K extends 'texts' | 'formatacao' | 'expansao'>(key: K): SofiaSettings[K] => {
    const one = sofiaSettingsSchema.shape[key].safeParse(stored[key]);
    return (one.success ? one.data : SOFIA_DEFAULT_SETTINGS[key]) as SofiaSettings[K];
  };
  return {
    enabled: row.enabled,
    texts: part('texts'),
    formatacao: part('formatacao'),
    expansao: part('expansao'),
  };
}

export async function saveSofiaSettings(
  db: Database,
  settings: SofiaSettings,
  employeeId: string | null,
  at: Date,
) {
  const { enabled, ...rest } = settings;
  await db
    .insert(sofiaSettings)
    .values({ enabled, settings: rest, updatedBy: employeeId, updatedAt: at })
    .onConflictDoUpdate({
      target: sofiaSettings.tenantId,
      set: { enabled, settings: rest, updatedBy: employeeId, updatedAt: at },
    });
}
