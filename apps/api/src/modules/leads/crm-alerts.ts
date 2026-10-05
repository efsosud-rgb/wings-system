import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmNotifications,
  crmStageLimits,
  employees,
  leadTasks,
  leads,
  roles,
} from '../../db/schema/index.js';

/**
 * Deadline and deviation alerts of the CRM, to the panel only (no WhatsApp, no
 * e-mail yet): a first contact past its 1-business-hour SLA, any other open
 * task past its due time, a deal sitting in a stage beyond its limit. They go to
 * the deal's seller, the manager of the seller's sector and Diretoria. A
 * notice states the kind of problem and nothing about the person: the panel
 * links to the deal. One notice per condition and person (`dedupe_key`), so a
 * pass every five minutes never repeats it; a new due date is a new condition.
 * Detection only reads; the one write is the notice.
 */

export const DEFAULT_STAGE_STUCK_DAYS = 7;

export interface AlertConfig {
  stageStuckDays: number;
}

type Kind = 'first_contact_overdue' | 'task_overdue' | 'stage_stuck';
interface Finding {
  kind: Kind;
  leadId: string;
  ownerEmployeeId: string | null;
  /** Identifies this occurrence: the due time, or when the stage was entered. */
  occurrence: string;
  entityId: string;
  message: string;
}

const MAX_FINDINGS = 500;

async function findings(db: Database, now: Date, config: AlertConfig): Promise<Finding[]> {
  const found: Finding[] = [];
  const overdue = await db
    .select({
      id: leadTasks.id,
      kind: leadTasks.kind,
      title: leadTasks.title,
      dueAt: leadTasks.dueAt,
      leadId: leadTasks.leadId,
      assignee: leadTasks.assigneeEmployeeId,
      owner: leads.ownerEmployeeId,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(and(isNull(leadTasks.doneAt), lt(leadTasks.dueAt, now), isNull(leads.won)))
    .limit(MAX_FINDINGS);
  for (const task of overdue) {
    const first = task.kind === 'first_contact';
    found.push({
      kind: first ? 'first_contact_overdue' : 'task_overdue',
      leadId: task.leadId,
      ownerEmployeeId: task.assignee ?? task.owner,
      occurrence: task.dueAt.toISOString(),
      entityId: task.id,
      message: first
        ? 'Primeiro contato atrasado: passou da 1 hora útil.'
        : `Tarefa atrasada: ${task.title}`,
    });
  }
  const limits = new Map(
    (await db.select().from(crmStageLimits)).map((l) => [l.stageId, l.maxDays] as const),
  );
  const open = await db
    .select({
      id: leads.id,
      stageId: leads.stageId,
      stageChangedAt: leads.stageChangedAt,
      owner: leads.ownerEmployeeId,
      stage: leads.stage,
    })
    .from(leads)
    .where(
      and(
        isNull(leads.won),
        sql`${leads.stageId} is not null`,
        sql`${leads.stageChangedAt} is not null`,
      ),
    )
    .limit(5000);
  for (const lead of open) {
    const days = limits.get(lead.stageId!) ?? config.stageStuckDays;
    if (days <= 0) continue;
    const since = lead.stageChangedAt!;
    if (now.getTime() - since.getTime() < days * 86_400_000) continue;
    found.push({
      kind: 'stage_stuck',
      leadId: lead.id,
      ownerEmployeeId: lead.owner,
      occurrence: since.toISOString(),
      entityId: lead.id,
      message: `Parado há mais de ${days} dias na etapa ${lead.stage ?? ''}`.trim(),
    });
    if (found.length >= MAX_FINDINGS * 2) break;
  }
  return found;
}

/** Seller, the managers of the seller's sector, and everyone in Diretoria; active people only. */
async function recipientsOf(db: Database, ownerEmployeeId: string | null): Promise<string[]> {
  const people = new Set<string>();
  if (ownerEmployeeId) {
    const owner = await db.query.employees.findFirst({
      where: eq(employees.id, ownerEmployeeId),
      columns: { id: true, sectorId: true, status: true },
    });
    if (owner?.status === 'active') people.add(owner.id);
    if (owner?.sectorId) {
      const managers = await db
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.sectorId, owner.sectorId),
            eq(employees.isSectorManager, true),
            eq(employees.status, 'active'),
          ),
        );
      for (const m of managers) people.add(m.id);
    }
  }
  const board = await db
    .select({ id: employees.id })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(roles.key, 'diretoria'), eq(employees.status, 'active')));
  for (const d of board) people.add(d.id);
  return [...people];
}

/** One pass: writes a notice for every condition not yet noticed. Returns how many it wrote. */
export async function runCrmAlerts(
  db: Database,
  config: AlertConfig = { stageStuckDays: DEFAULT_STAGE_STUCK_DAYS },
  now = new Date(),
): Promise<{ written: number }> {
  const items = await findings(db, now, config);
  if (items.length === 0) return { written: 0 };
  const cache = new Map<string, string[]>();
  const rows: (typeof crmNotifications.$inferInsert)[] = [];
  for (const item of items) {
    const key = item.ownerEmployeeId ?? '-';
    let who = cache.get(key);
    if (!who) {
      who = await recipientsOf(db, item.ownerEmployeeId);
      cache.set(key, who);
    }
    for (const person of who)
      rows.push({
        recipientEmployeeId: person,
        leadId: item.leadId,
        kind: item.kind,
        message: item.message,
        dedupeKey: `${item.kind}:${item.entityId}:${item.occurrence}:${person}`,
      });
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const done = await db
      .insert(crmNotifications)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .returning({ id: crmNotifications.id });
    written += done.length;
  }
  return { written };
}

/** The panel of one person: unread first, newest first. */
export async function notificationsOf(db: Database, employeeId: string, limit = 100) {
  return db
    .select({
      id: crmNotifications.id,
      kind: crmNotifications.kind,
      message: crmNotifications.message,
      leadId: crmNotifications.leadId,
      createdAt: crmNotifications.createdAt,
      readAt: crmNotifications.readAt,
    })
    .from(crmNotifications)
    .where(eq(crmNotifications.recipientEmployeeId, employeeId))
    .orderBy(sql`${crmNotifications.readAt} is not null`, sql`${crmNotifications.createdAt} desc`)
    .limit(limit);
}

export async function markRead(db: Database, employeeId: string, ids: string[] | 'all') {
  const where =
    ids === 'all'
      ? and(eq(crmNotifications.recipientEmployeeId, employeeId), isNull(crmNotifications.readAt))
      : and(
          eq(crmNotifications.recipientEmployeeId, employeeId),
          inArray(crmNotifications.id, ids),
          isNull(crmNotifications.readAt),
        );
  const done = await db
    .update(crmNotifications)
    .set({ readAt: new Date() })
    .where(where)
    .returning({ id: crmNotifications.id });
  return done.length;
}
