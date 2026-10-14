import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { whatsappSettings } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import { eq } from 'drizzle-orm';

/**
 * Whether the official WhatsApp number is live (Eric, 14/10). Until it is, the sellers see the
 * WhatsApp screen as "em breve" and do not start conversations there; the other levels are not
 * affected. A missing row is "not live".
 */
export async function officialNumberLive(db: Database): Promise<boolean> {
  const row = await db.query.whatsappSettings.findFirst({
    where: eq(whatsappSettings.tenantId, WINGS_TENANT_ID),
  });
  return row?.officialNumberLive ?? false;
}

/** Switches it, on the day the number is swapped: no deploy, one row. */
export async function setOfficialNumberLive(db: Database, live: boolean, employeeId: string) {
  await db
    .insert(whatsappSettings)
    .values({ tenantId: WINGS_TENANT_ID, officialNumberLive: live, updatedBy: employeeId })
    .onConflictDoUpdate({
      target: whatsappSettings.tenantId,
      set: { officialNumberLive: live, updatedBy: employeeId, updatedAt: new Date() },
    });
}
