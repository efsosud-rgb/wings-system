import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { crmNotifications, holidays, leadTasks } from '../../db/schema/index.js';
import { loadHolidays } from '../../lib/holidays.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { ensureFirstContactTask, ensureReturnTask, RETURN_TASK_TITLE } from './crm.js';
import { runCrmAlerts } from './crm-alerts.js';
import { upsertLead } from './service.js';

/**
 * Eric, 31/10/2026: the CRM's working hours skip the national, RJ state and Rio city holidays,
 * read from the Ponto's `holidays` table (filled for 2026 and 2027 by migration 0110). Fixed
 * clocks only: nothing here depends on the day the test runs.
 */
let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

// São Paulo (and Rio) are UTC-3 all year since 2019 (no DST).
const sp = (iso: string) => new Date(`${iso}-03:00`);

let phoneSeq = 0;
const arrive = (ownerEmployeeId: string | null) => {
  phoneSeq += 1;
  return upsertLead(db, {
    source: 'meta_lead_ads',
    name: 'Fulana de Teste',
    phone: `5521944${String(phoneSeq).padStart(6, '0')}`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: 'expansao',
    ownerEmployeeId,
    skipResearch: true,
    event: { kind: 'lead.received.meta_lead_ads' },
  });
};

describe('CRM deadlines skip holidays', () => {
  it('the migration loaded the official days of the three spheres, and no ponto facultativo', async () => {
    const days = await loadHolidays(db);
    const scopeOf = async (day: string) =>
      (await db.select({ scope: holidays.scope }).from(holidays).where(eq(holidays.day, day)))[0]
        ?.scope;
    expect(days.has('2026-11-02')).toBe(true); // Finados
    expect(await scopeOf('2026-11-02')).toBe('national');
    expect(await scopeOf('2026-04-23')).toBe('state'); // São Jorge
    expect(await scopeOf('2027-04-23')).toBe('state');
    expect(await scopeOf('2026-01-20')).toBe('city'); // São Sebastião
    expect(await scopeOf('2027-01-20')).toBe('city');
    // Pontos facultativos stay out: Carnaval Monday, Ash Wednesday.
    for (const day of ['2026-02-16', '2026-02-18', '2027-02-08', '2027-02-10'])
      expect(days.has(day), day).toBe(false);
  });

  it('a lead on Saturday 31/10/2026 at 10h is due Tuesday 03/11 at 10h (Monday is Finados)', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(null);
    const saturday = sp('2026-10-31T10:00:00');
    await ensureFirstContactTask(
      db,
      { id: born.lead.id, ownerEmployeeId: seller.id, enteredAt: saturday },
      null,
      saturday,
    );
    const task = await db.query.leadTasks.findFirst({
      where: and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.kind, 'first_contact')),
    });
    expect(task?.dueAt).toEqual(sp('2026-11-03T10:00:00'));
  });

  it('a return on the eve of a holiday at the end of the day waits for the next working day', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(null);
    // Thursday 19/11/2026 17h30; Friday 20/11 is Consciência Negra.
    expect(
      await ensureReturnTask(
        db,
        { id: born.lead.id, ownerEmployeeId: seller.id },
        sp('2026-11-19T17:30:00'),
      ),
    ).toBe('created');
    const task = await db.query.leadTasks.findFirst({
      where: and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.title, RETURN_TASK_TITLE)),
    });
    expect(task?.dueAt).toEqual(sp('2026-11-23T09:30:00'));
  });

  it('the managers hear of an unattended first contact at the close of the next working day, not on the holiday', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const born = await arrive(seller.id);
    // Due on Thursday's 18h close; Friday 20/11 is a holiday, so the business day it is judged by ends Monday 18h.
    await db
      .update(leadTasks)
      .set({ dueAt: sp('2026-11-19T18:00:00') })
      .where(and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.kind, 'first_contact')));
    const escalatedTo = async () =>
      (
        await db
          .select({ person: crmNotifications.recipientEmployeeId })
          .from(crmNotifications)
          .where(
            and(
              eq(crmNotifications.leadId, born.lead.id),
              eq(crmNotifications.kind, 'first_contact_escalated'),
              ne(crmNotifications.recipientEmployeeId, seller.id),
            ),
          )
      ).map((row) => row.person);

    await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-11-20T18:30:00'));
    expect(await escalatedTo()).toEqual([]);
    await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-11-23T17:59:00'));
    expect(await escalatedTo()).toEqual([]);
    await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-11-23T18:00:00'));
    expect(await escalatedTo()).toContain(manager.id);
  });
});
