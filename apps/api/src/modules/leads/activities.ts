import type {
  LeadActivity,
  LeadActivityCreateInput,
  LeadActivityKind,
  LeadCallOutcome,
} from '@wings/shared';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees, leadActivities, leadEvents } from '../../db/schema/index.js';
import type { Executor } from './crm.js';

/**
 * Calls and meetings a person records on a lead (CRM núcleo). Append-only,
 * like notes: a wrong record is corrected by a new one. The timeline event
 * carries kind, outcome and duration; the note stays on the lead's page.
 */

export async function addActivity(
  db: Database,
  input: { leadId: string; actorEmployeeId: string | null } & LeadActivityCreateInput,
): Promise<LeadActivity> {
  return db.transaction(async (tx) => {
    const at = input.at ? new Date(input.at) : new Date();
    const [row] = await tx
      .insert(leadActivities)
      .values({
        leadId: input.leadId,
        kind: input.kind,
        at,
        outcome: input.kind === 'call' ? input.outcome : null,
        durationSeconds: input.kind === 'call' ? (input.durationSeconds ?? null) : null,
        participants: input.kind === 'meeting' ? (input.participants ?? null) : null,
        meetUrl: input.kind === 'meeting' ? (input.meetUrl ?? null) : null,
        note: input.note ?? null,
        actorEmployeeId: input.actorEmployeeId,
      })
      .returning();
    if (!row) throw new Error('activity insert returned no row');
    await tx.insert(leadEvents).values({
      leadId: input.leadId,
      kind: input.kind === 'call' ? 'lead.call_logged' : 'lead.meeting_logged',
      actorEmployeeId: input.actorEmployeeId,
      detail: {
        activityId: row.id,
        at: at.toISOString(),
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
        hasMeetUrl: row.meetUrl !== null,
        hasNote: row.note !== null,
      },
    });
    const actor = input.actorEmployeeId
      ? await tx.query.employees.findFirst({
          where: eq(employees.id, input.actorEmployeeId),
          columns: { fullName: true },
        })
      : null;
    return toActivity(row, actor?.fullName ?? null);
  });
}

type ActivityRow = typeof leadActivities.$inferSelect;

const toActivity = (row: ActivityRow, actorName: string | null): LeadActivity => ({
  id: row.id,
  kind: row.kind as LeadActivityKind,
  at: row.at.toISOString(),
  outcome: (row.outcome as LeadCallOutcome | null) ?? null,
  durationSeconds: row.durationSeconds,
  participants: row.participants,
  meetUrl: row.meetUrl,
  note: row.note,
  actorName,
  createdAt: row.createdAt.toISOString(),
});

export async function activitiesOf(db: Executor, leadId: string): Promise<LeadActivity[]> {
  const rows = await db
    .select({ row: leadActivities, actorName: employees.fullName })
    .from(leadActivities)
    .leftJoin(employees, eq(employees.id, leadActivities.actorEmployeeId))
    .where(eq(leadActivities.leadId, leadId))
    .orderBy(desc(leadActivities.at))
    .limit(200);
  return rows.map((item) => toActivity(item.row, item.actorName));
}
