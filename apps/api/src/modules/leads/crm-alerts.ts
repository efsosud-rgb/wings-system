import { endOfBusinessDay } from '@wings/shared';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { LEAD_ADMIN_ROLE_KEYS } from './access.js';
import { firstContactOverdueSql, LEADS_ID, trackedTaskSql } from './crm.js';
import {
  crmNotifications,
  crmStageLimits,
  employees,
  leadTasks,
  leads,
  roles,
} from '../../db/schema/index.js';

/**
 * Deadline and deviation alerts of the CRM, to the panel (no WhatsApp; the
 * e-mail copy is crm-notice-mail.ts): a first contact past its 1-business-hour
 * SLA, any other open task past its due time, a deal sitting in a stage beyond
 * its limit. The last two go to the deal's seller, the manager of the seller's
 * sector and Diretoria. A notice states the kind of problem and nothing about
 * the person: the panel links to the deal. One notice per condition and person
 * (`dedupe_key`), so a pass every five minutes never repeats it; a new due date
 * is a new condition. Detection only reads; the one write is the notice.
 *
 * The first contact climbs in two steps (Eric, 13/10/2026), one notice per deal,
 * stage and person, whatever happens to the due date afterwards:
 *   1. the 1 business hour passes with the deal still in the entry stage
 *      ("Sem contato", `firstContactOverdueSql`): the seller hears of it;
 *   2. it is still there at the end of that business day (18h): the managers of
 *      the seller's sector and Diretoria hear of it too (`first_contact_escalated`).
 */

export const DEFAULT_STAGE_STUCK_DAYS = 7;

export interface AlertConfig {
  stageStuckDays: number;
}

type Kind = 'task_overdue' | 'stage_stuck';
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
      title: leadTasks.title,
      dueAt: leadTasks.dueAt,
      leadId: leadTasks.leadId,
      owner: leads.ownerEmployeeId,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    // The first contact climbs in steps of its own (`firstContactCases`).
    .where(
      and(
        isNull(leadTasks.doneAt),
        lt(leadTasks.dueAt, now),
        isNull(leads.won),
        ne(leadTasks.kind, 'first_contact'),
        trackedTaskSql(),
      ),
    )
    .limit(MAX_FINDINGS);
  for (const task of overdue) {
    found.push({
      kind: 'task_overdue',
      leadId: task.leadId,
      // The lead's owner hears of it, never an assignee who is not the owner (the title may name people).
      ownerEmployeeId: task.owner,
      occurrence: task.dueAt.toISOString(),
      entityId: task.id,
      message: `Tarefa atrasada: ${task.title}`,
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
      // Only roles that see every lead: a seller flagged as sector manager still sees just their own.
      const managers = await db
        .select({ id: employees.id })
        .from(employees)
        .innerJoin(roles, eq(roles.id, employees.roleId))
        .where(
          and(
            eq(employees.sectorId, owner.sectorId),
            eq(employees.isSectorManager, true),
            eq(employees.status, 'active'),
            inArray(roles.key, LEAD_ADMIN_ROLE_KEYS),
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

const firstNameOf = (fullName: string | null) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

/** A deal past its first-contact deadline in the entry stage, with the earliest open deadline. */
interface FirstContactCase {
  leadId: string;
  ownerEmployeeId: string | null;
  stageId: string | null;
  stage: string | null;
  dueAt: Date;
}

async function firstContactCases(db: Database, now: Date): Promise<FirstContactCase[]> {
  const rows = await db
    .select({
      leadId: leads.id,
      ownerEmployeeId: leads.ownerEmployeeId,
      stageId: leads.stageId,
      stage: leads.stage,
      dueAt: sql<string>`(select to_char(min(lead_tasks.due_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        from lead_tasks
       where lead_tasks.lead_id = ${LEADS_ID} and lead_tasks.kind = 'first_contact' and lead_tasks.done_at is null)`,
    })
    .from(leads)
    .where(firstContactOverdueSql(now))
    .limit(MAX_FINDINGS);
  return rows.map((row) => ({ ...row, dueAt: new Date(row.dueAt) }));
}

/**
 * The notices of the first contact, in two steps. The seller is told as soon as the deadline passes; the
 * managers of the seller's sector and Diretoria only when the deal is still unattended at the end of that
 * business day. The key holds the deal and its stage, not the deadline: moving the deadline never tells
 * anyone twice. A person who already got the earlier per-task notice (keys `first_contact_overdue:…`) is not told again.
 */
async function firstContactRows(
  db: Database,
  now: Date,
): Promise<(typeof crmNotifications.$inferInsert)[]> {
  const cases = await firstContactCases(db, now);
  if (cases.length === 0) return [];
  const ownerIds = [
    ...new Set(cases.flatMap((c) => (c.ownerEmployeeId ? [c.ownerEmployeeId] : []))),
  ];
  const sellers = new Map(
    (ownerIds.length === 0
      ? []
      : await db
          .select({ id: employees.id, fullName: employees.fullName })
          .from(employees)
          .where(inArray(employees.id, ownerIds))
    ).map((row) => [row.id, firstNameOf(row.fullName)] as const),
  );
  const told = new Set(
    (
      await db
        .select({ leadId: crmNotifications.leadId, person: crmNotifications.recipientEmployeeId })
        .from(crmNotifications)
        .where(
          and(
            eq(crmNotifications.kind, 'first_contact_overdue'),
            sql`${crmNotifications.dedupeKey} like 'first_contact_overdue:%'`,
            inArray(
              crmNotifications.leadId,
              cases.map((c) => c.leadId),
            ),
          ),
        )
    ).map((row) => `${row.leadId}:${row.person}`),
  );
  const cache = new Map<string, string[]>();
  const rows: (typeof crmNotifications.$inferInsert)[] = [];
  for (const item of cases) {
    const cacheKey = item.ownerEmployeeId ?? '-';
    let who = cache.get(cacheKey);
    if (!who) {
      who = await recipientsOf(db, item.ownerEmployeeId);
      cache.set(cacheKey, who);
    }
    const add = (kind: string, tier: string, person: string, message: string) => {
      if (told.has(`${item.leadId}:${person}`)) return;
      rows.push({
        recipientEmployeeId: person,
        leadId: item.leadId,
        kind,
        message,
        dedupeKey: `first_contact:${tier}:${item.leadId}:${item.stageId ?? 'none'}:${person}`,
        // Both are also e-mailed when their own switch is on (crm-notice-mail.ts); off, the copy is marked skipped.
        emailState: 'pending',
      });
    };
    if (item.ownerEmployeeId && who.includes(item.ownerEmployeeId))
      add(
        'first_contact_overdue',
        'owner',
        item.ownerEmployeeId,
        'Primeiro contato atrasado: passou da 1 hora útil.',
      );
    if (now.getTime() < endOfBusinessDay(item.dueAt).getTime()) continue;
    const seller = sellers.get(item.ownerEmployeeId ?? '') || '';
    const message = `Primeiro contato sem registro até o fim do dia útil: a negociação segue em "${item.stage ?? 'Sem contato'}"${seller ? ` (vendedor: ${seller})` : ''}.`;
    for (const person of who)
      if (person !== item.ownerEmployeeId)
        add('first_contact_escalated', 'manager', person, message);
  }
  return rows;
}

export interface AlertsResult {
  written: number;
  /** How many of the written notices are the two steps of the first contact (counts only, for the log). */
  firstContact: { overdue: number; escalated: number };
}

/** One pass: writes a notice for every condition not yet noticed. Returns how many it wrote. */
export async function runCrmAlerts(
  db: Database,
  config: AlertConfig = { stageStuckDays: DEFAULT_STAGE_STUCK_DAYS },
  now = new Date(),
): Promise<AlertsResult> {
  const items = await findings(db, now, config);
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
        emailState: 'none',
      });
  }
  rows.push(...(await firstContactRows(db, now)));
  const result: AlertsResult = { written: 0, firstContact: { overdue: 0, escalated: 0 } };
  for (let i = 0; i < rows.length; i += 200) {
    const done = await db
      .insert(crmNotifications)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .returning({ kind: crmNotifications.kind });
    result.written += done.length;
    for (const row of done) {
      if (row.kind === 'first_contact_overdue') result.firstContact.overdue += 1;
      if (row.kind === 'first_contact_escalated') result.firstContact.escalated += 1;
    }
  }
  return result;
}

/**
 * The panel of one person: unread first, newest first. A scoped caller (a seller, `ownedOnly`) only
 * gets the notices that name a lead they own today, so a lead reassigned away, or one nobody owns,
 * disappears from their panel even if a notice was written while it was theirs.
 */
export async function notificationsOf(
  db: Database,
  employeeId: string,
  limit = 100,
  ownedOnly = false,
) {
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
    .leftJoin(leads, eq(leads.id, crmNotifications.leadId))
    .where(
      and(
        eq(crmNotifications.recipientEmployeeId, employeeId),
        ownedOnly
          ? or(isNull(crmNotifications.leadId), eq(leads.ownerEmployeeId, employeeId))
          : undefined,
      ),
    )
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

/** Where a new lead can arrive from for the arrival notices (not imports, not the RD mirror). */
const ARRIVAL_SOURCES = new Set([
  'meta_lead_ads',
  'tiktok_lead_ads',
  'google_lead_form',
  'rd_station',
  'site_form',
]);

/** Who hears of a lead with no owner: Admin Master, Diretoria and the commercial managers (sector manager of Comercial, or the sales manager role); active only. */
export async function managersAndBoard(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: employees.id })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(
      and(
        eq(employees.status, 'active'),
        // Only the roles that see every lead: a lead nobody owns is theirs alone to know.
        inArray(roles.key, LEAD_ADMIN_ROLE_KEYS),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * What runs right after an arrival notice is written: the app registers the
 * e-mail pass here (`sendPendingNoticeMails`), so the owner's e-mail leaves at
 * once instead of at the next cycle. Fire-and-forget; its failures are its own.
 */
let leadArrivedKick: (() => void) | null = null;
export function onLeadArrivedKick(kick: (() => void) | null): void {
  leadArrivedKick = kick;
}

/**
 * The notice of a new lead's arrival (Meta, RD landing, site form), written in
 * code so it does not depend on a rule set on the screen. With an owner (from
 * the rotation) the owner is told, with the first-contact deadline; with none,
 * Diretoria and the commercial managers are told at once that it has no owner.
 * Names nothing about the person. Best effort: a failure here never undoes the
 * lead, and one notice per lead and person (`dedupe_key`).
 */
export async function announceNewLead(
  db: Database,
  lead: { id: string; source: string; ownerEmployeeId: string | null },
): Promise<void> {
  if (!ARRIVAL_SOURCES.has(lead.source)) return;
  await announceLeadArrival(db, lead);
}

/**
 * The same notice with no look at the lead's source, for a caller that has
 * already decided this lead is an arrival (the RD follow-up gives the recent
 * deals it creates to the rotation). `rd_crm` stays out of `ARRIVAL_SOURCES`:
 * the notice is never written for an import that brings thousands of old deals.
 */
export async function announceLeadArrival(
  db: Database,
  lead: { id: string; ownerEmployeeId: string | null },
): Promise<void> {
  try {
    if (lead.ownerEmployeeId) {
      const task = await db.query.leadTasks.findFirst({
        where: and(
          eq(leadTasks.leadId, lead.id),
          eq(leadTasks.kind, 'first_contact'),
          isNull(leadTasks.doneAt),
        ),
        columns: { dueAt: true },
      });
      const due = task
        ? ` Primeiro contato até ${task.dueAt.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })} (1 hora útil).`
        : '';
      await db
        .insert(crmNotifications)
        .values({
          recipientEmployeeId: lead.ownerEmployeeId,
          leadId: lead.id,
          kind: 'new_lead',
          message: `Novo lead para você.${due}`,
          dedupeKey: `new_lead:${lead.id}:${lead.ownerEmployeeId}`,
          // The owner also gets it by e-mail (crm-notice-mail.ts): sent by the kick below or the next cycle.
          emailState: 'pending',
        })
        .onConflictDoNothing();
      leadArrivedKick?.();
      return;
    }
    const people = await managersAndBoard(db);
    if (people.length === 0) return;
    await db
      .insert(crmNotifications)
      .values(
        people.map((person) => ({
          recipientEmployeeId: person,
          leadId: lead.id,
          kind: 'lead_unassigned',
          message: 'Há um lead novo sem dono: o rodízio do funil está vazio. Atribua alguém.',
          dedupeKey: `lead_unassigned:${lead.id}:${person}`,
        })),
      )
      .onConflictDoNothing();
  } catch {
    // The lead is already saved; the overdue alert still catches a missed first contact.
  }
}

/** Old leads (see `STALE_ARRIVAL_HOURS`) a read of the platform brought, counted per owner (`null` = no owner). */
export type BackfillTally = Map<string | null, number>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One notice per owner for a whole read, instead of one per old lead: "N leads
 * antigos da Meta foram atribuídos a você". Old leads that found no owner
 * (empty rotation) become one notice to Diretoria with the count. Counts only,
 * nothing about a person. `readKey` (the read's start time) keeps a repeated
 * pass from writing the same notice twice. Best effort, like `announceNewLead`.
 */
export async function announceBackfill(
  db: Database,
  tally: BackfillTally,
  readAt: Date,
): Promise<void> {
  if (tally.size === 0) return;
  const readKey = readAt.getTime();
  try {
    const rows: (typeof crmNotifications.$inferInsert)[] = [];
    for (const [owner, count] of tally) {
      if (owner) {
        rows.push({
          recipientEmployeeId: owner,
          kind: 'backfill_assigned',
          message: `${plural(count, 'lead antigo da Meta foi atribuído', 'leads antigos da Meta foram atribuídos')} a você.`,
          dedupeKey: `backfill_assigned:${readKey}:${owner}`,
        });
        continue;
      }
      const board = await db
        .select({ id: employees.id })
        .from(employees)
        .innerJoin(roles, eq(roles.id, employees.roleId))
        .where(
          and(inArray(roles.key, ['admin_master', 'diretoria']), eq(employees.status, 'active')),
        );
      for (const person of board)
        rows.push({
          recipientEmployeeId: person.id,
          kind: 'backfill_unassigned',
          message: `${plural(count, 'lead antigo da Meta entrou sem dono', 'leads antigos da Meta entraram sem dono')}: o rodízio do funil está vazio.`,
          dedupeKey: `backfill_unassigned:${readKey}:${person.id}`,
        });
    }
    if (rows.length > 0) await db.insert(crmNotifications).values(rows).onConflictDoNothing();
  } catch {
    // The leads are already saved; this only tells people about them.
  }
}
