import type { HolidaySet } from '@wings/shared';
import type { Database } from '../db/client.js';
import { holidays } from '../db/schema/index.js';

/**
 * The days off the CRM's working hours skip, from the Ponto's `holidays` table: every row,
 * national, state (RJ) and city (Rio) alike (Eric, 31/10/2026). Read once per calculation or
 * per pass, never once per hour added. The table has no tenant column: it is Wings' own
 * calendar, the one company whose sellers the CRM times. See docs/crm/prazos-horas-uteis.md.
 */
export async function loadHolidays(db: Pick<Database, 'select'>): Promise<HolidaySet> {
  // shortcut: the whole table (about 15 rows a year), filter by date once it grows past a few hundred.
  const rows = await db.select({ day: holidays.day }).from(holidays);
  return new Set(rows.map((row) => row.day));
}
