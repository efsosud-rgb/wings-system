import {
  DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
  instagramProspectingSettingsSchema,
  type InstagramProspectingSettings,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { prospectAiSettings } from '../../db/schema/index.js';

type Executor = Pick<Database, 'query'>;

/** `prospect_ai_settings.settings.instagram`; a missing row or an invalid part reads as the defaults. */
export async function loadInstagramSettings(db: Executor): Promise<InstagramProspectingSettings> {
  const row = await db.query.prospectAiSettings.findFirst({
    where: eq(prospectAiSettings.tenantId, WINGS_TENANT_ID),
  });
  const parsed = instagramProspectingSettingsSchema.safeParse(
    (row?.settings as Record<string, unknown> | undefined)?.instagram,
  );
  return parsed.success ? parsed.data : structuredClone(DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS);
}

/** Saves the Instagram part, leaving any other part of the row as it is. */
export async function saveInstagramSettings(
  db: Database,
  value: InstagramProspectingSettings,
  employeeId: string,
  at: Date,
): Promise<void> {
  const part = { instagram: value };
  await db
    .insert(prospectAiSettings)
    .values({ settings: part, updatedBy: employeeId, updatedAt: at })
    .onConflictDoUpdate({
      target: prospectAiSettings.tenantId,
      set: {
        settings: sql`${prospectAiSettings.settings} || ${JSON.stringify(part)}::jsonb`,
        updatedBy: employeeId,
        updatedAt: at,
      },
    });
}
