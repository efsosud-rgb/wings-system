import {
  LEAD_PIPELINES,
  LEAD_TASK_KINDS,
  OFFICE_FEED_DAYS,
  OFFICE_FEED_LIMIT,
  OFFICE_PRESENCE_MINUTES,
  isSectorSlug,
  officeClock,
  officeDayStart,
  officeDisplayNames,
  officeZoneOf,
  type LeadPipeline,
  type LeadTaskKind,
  type OfficeAgent,
  type OfficeEvent,
  type OfficeKpi,
  type OfficeMonitor,
  type OfficePerson,
  type OfficeSnapshot,
} from '@wings/shared';
import { LEAD_TASK_KIND_LABELS } from '@wings/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { trackedTaskSql } from '../leads/crm.js';
import {
  agentConversations,
  agentMessages,
  agentProposals,
  employees,
  leadEvents,
  leadStageHistory,
  leadTasks,
  leads,
  roles,
  sectors,
  sessions,
} from '../../db/schema/index.js';

/**
 * The virtual office's snapshot (Laboratório → Escritório virtual).
 *
 * Read only, and only what the floor needs: first names, sectors, counts,
 * stage names, task kinds and timestamps. Never a lead's name, contact or
 * free text (task titles, notes, agent messages). `office.read` is held at
 * `all` by the Admin Master alone; granting it at a narrower scope would
 * need these queries scoped first.
 */

/** Bounds for the in-memory grouping; the office has tens of people, not thousands. */
const MAX_OPEN_ROWS = 5000;

const asPipeline = (value: string | null): LeadPipeline | null =>
  value && (LEAD_PIPELINES as readonly string[]).includes(value) ? (value as LeadPipeline) : null;

const asTaskKind = (value: string): LeadTaskKind =>
  (LEAD_TASK_KINDS as readonly string[]).includes(value) ? (value as LeadTaskKind) : 'other';

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export async function officeSnapshot(db: Database, now: Date): Promise<OfficeSnapshot> {
  const dayStart = officeDayStart(now);
  const feedSince = new Date(now.getTime() - OFFICE_FEED_DAYS * 86_400_000);
  const presentSince = new Date(now.getTime() - OFFICE_PRESENCE_MINUTES * 60_000);

  const staff = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      sector: sectors.slug,
      roleName: roles.name,
      isSectorManager: employees.isSectorManager,
    })
    .from(employees)
    .innerJoin(sectors, eq(sectors.id, employees.sectorId))
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(eq(employees.status, 'active'))
    .orderBy(employees.fullName);
  const names = officeDisplayNames(staff);
  const staffIds = staff.map((s) => s.id);

  const seen = staffIds.length
    ? await db
        .select({ employeeId: sessions.employeeId, lastSeenAt: max(sessions.lastSeenAt) })
        .from(sessions)
        .where(and(inArray(sessions.employeeId, staffIds), isNull(sessions.revokedAt)))
        .groupBy(sessions.employeeId)
    : [];
  const live = staffIds.length
    ? await db
        .select({ employeeId: sessions.employeeId })
        .from(sessions)
        .where(
          and(
            inArray(sessions.employeeId, staffIds),
            isNull(sessions.revokedAt),
            gte(sessions.expiresAt, now),
            gte(sessions.lastSeenAt, presentSince),
          ),
        )
        .groupBy(sessions.employeeId)
    : [];
  const lastSeen = new Map(seen.map((s) => [s.employeeId, s.lastSeenAt]));
  const presentIds = new Set(live.map((s) => s.employeeId));

  // Open tasks of open deals, each on the desk of its assignee (else the deal's owner).
  const openTasks = await db
    .select({
      id: leadTasks.id,
      leadId: leadTasks.leadId,
      kind: leadTasks.kind,
      dueAt: leadTasks.dueAt,
      assignee: leadTasks.assigneeEmployeeId,
      owner: leads.ownerEmployeeId,
      pipeline: leads.pipeline,
      stage: leads.stage,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(and(isNull(leadTasks.doneAt), isNull(leads.won), trackedTaskSql()))
    .orderBy(leadTasks.dueAt)
    .limit(MAX_OPEN_ROWS);

  const openDeals = await db
    .select({
      id: leads.id,
      owner: leads.ownerEmployeeId,
      pipeline: leads.pipeline,
      stage: leads.stage,
      movedAt: sql<Date | null>`coalesce(${leads.stageChangedAt}, ${leads.updatedAt})`.mapWith(
        (value: string | Date | null) => (value ? new Date(value) : null),
      ),
    })
    .from(leads)
    .where(and(isNull(leads.won), isNotNull(leads.ownerEmployeeId)))
    .orderBy(desc(sql`coalesce(${leads.stageChangedAt}, ${leads.updatedAt})`))
    .limit(MAX_OPEN_ROWS);

  const tasksBy = new Map<string, typeof openTasks>();
  for (const task of openTasks) {
    const holder = task.assignee ?? task.owner;
    if (!holder) continue;
    const list = tasksBy.get(holder) ?? [];
    list.push(task);
    tasksBy.set(holder, list);
  }
  const dealsBy = new Map<string, typeof openDeals>();
  for (const deal of openDeals) {
    if (!deal.owner) continue;
    const list = dealsBy.get(deal.owner) ?? [];
    list.push(deal);
    dealsBy.set(deal.owner, list);
  }

  const people: OfficePerson[] = [];
  for (const member of staff) {
    if (!isSectorSlug(member.sector)) continue;
    const tasks = tasksBy.get(member.id) ?? [];
    const deals = dealsBy.get(member.id) ?? [];
    const next = tasks[0];
    const latest = deals[0];
    let monitor: OfficeMonitor;
    if (next) {
      monitor = {
        kind: 'task',
        taskId: next.id,
        leadId: next.leadId,
        taskKind: asTaskKind(next.kind),
        dueAt: next.dueAt.toISOString(),
        overdue: next.dueAt.getTime() < now.getTime(),
        pipeline: asPipeline(next.pipeline),
        stage: next.stage,
      };
    } else if (latest) {
      monitor = {
        kind: 'deal',
        leadId: latest.id,
        pipeline: asPipeline(latest.pipeline),
        stage: latest.stage,
        movedAt: iso(latest.movedAt),
      };
    } else {
      monitor = { kind: 'none', reason: 'Sem tarefa aberta nem negociação em andamento no CRM' };
    }
    people.push({
      id: member.id,
      displayName: names.get(member.id) ?? '—',
      sector: member.sector,
      zone: officeZoneOf(member.sector),
      roleName: member.roleName,
      isSectorManager: member.isSectorManager,
      present: presentIds.has(member.id),
      lastSeenAt: iso(lastSeen.get(member.id)),
      openDeals: deals.length,
      openTasks: tasks.length,
      overdueTasks: tasks.filter((t) => t.dueAt.getTime() < now.getTime()).length,
      monitor,
    });
  }

  const events = await feed(db, feedSince);
  const kpis = await indicators(db, now, dayStart, presentIds.size);
  const agents = await agentDesks(db);
  const clock = officeClock(now);

  return {
    generatedAt: now.toISOString(),
    hour: clock.hour,
    minute: clock.minute,
    people,
    agents,
    events,
    kpis,
  };
}

/** What happened in the CRM, newest first: arrivals, moves, wins, losses, finished tasks, new owners. */
async function feed(db: Database, since: Date): Promise<OfficeEvent[]> {
  const created = await db
    .select({
      id: leads.id,
      at: leads.createdAt,
      owner: leads.ownerEmployeeId,
      pipeline: leads.pipeline,
    })
    .from(leads)
    .where(gte(leads.createdAt, since))
    .orderBy(desc(leads.createdAt))
    .limit(OFFICE_FEED_LIMIT);

  const moves = await db
    .select({
      id: leadStageHistory.id,
      at: leadStageHistory.at,
      leadId: leadStageHistory.leadId,
      toStage: leadStageHistory.toStage,
      won: leadStageHistory.won,
      actor: leadStageHistory.actorEmployeeId,
      owner: leads.ownerEmployeeId,
      pipeline: leads.pipeline,
    })
    .from(leadStageHistory)
    .innerJoin(leads, eq(leads.id, leadStageHistory.leadId))
    .where(gte(leadStageHistory.at, since))
    .orderBy(desc(leadStageHistory.at))
    .limit(OFFICE_FEED_LIMIT);

  const done = await db
    .select({
      id: leadTasks.id,
      at: leadTasks.doneAt,
      leadId: leadTasks.leadId,
      kind: leadTasks.kind,
      doneBy: leadTasks.doneBy,
      assignee: leadTasks.assigneeEmployeeId,
      pipeline: leads.pipeline,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(gte(leadTasks.doneAt, since))
    .orderBy(desc(leadTasks.doneAt))
    .limit(OFFICE_FEED_LIMIT);

  const owners = await db
    .select({
      id: leadEvents.id,
      at: leadEvents.at,
      leadId: leadEvents.leadId,
      owner: leads.ownerEmployeeId,
      pipeline: leads.pipeline,
    })
    .from(leadEvents)
    .innerJoin(leads, eq(leads.id, leadEvents.leadId))
    .where(and(eq(leadEvents.kind, 'lead.owner_changed'), gte(leadEvents.at, since)))
    .orderBy(desc(leadEvents.at))
    .limit(OFFICE_FEED_LIMIT);

  const events: OfficeEvent[] = [
    ...created.map((row): OfficeEvent => ({
      id: `lead:${row.id}`,
      kind: 'lead_created',
      at: row.at.toISOString(),
      employeeId: row.owner,
      leadId: row.id,
      taskId: null,
      pipeline: asPipeline(row.pipeline),
      detail: null,
    })),
    ...moves.map((row): OfficeEvent => ({
      id: `move:${row.id}`,
      kind: row.won === true ? 'deal_won' : row.won === false ? 'deal_lost' : 'stage_moved',
      at: row.at.toISOString(),
      employeeId: row.actor ?? row.owner,
      leadId: row.leadId,
      taskId: null,
      pipeline: asPipeline(row.pipeline),
      detail: row.toStage,
    })),
    ...done.map((row): OfficeEvent => ({
      id: `task:${row.id}`,
      kind: 'task_done',
      at: (row.at as Date).toISOString(),
      employeeId: row.doneBy ?? row.assignee,
      leadId: row.leadId,
      taskId: row.id,
      pipeline: asPipeline(row.pipeline),
      detail: LEAD_TASK_KIND_LABELS[asTaskKind(row.kind)],
    })),
    ...owners.map((row): OfficeEvent => ({
      id: `owner:${row.id}`,
      kind: 'owner_changed',
      at: row.at.toISOString(),
      employeeId: row.owner,
      leadId: row.leadId,
      taskId: null,
      pipeline: asPipeline(row.pipeline),
      detail: null,
    })),
  ];
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, OFFICE_FEED_LIMIT);
}

async function indicators(
  db: Database,
  now: Date,
  dayStart: Date,
  present: number,
): Promise<OfficeKpi[]> {
  const [leadsToday] = await db
    .select({ n: count() })
    .from(leads)
    .where(gte(leads.createdAt, dayStart));
  const [wonToday] = await db
    .select({ n: count() })
    .from(leads)
    .where(and(eq(leads.won, true), gte(leads.closedAt, dayStart)));
  const [doneToday] = await db
    .select({ n: count() })
    .from(leadTasks)
    .where(gte(leadTasks.doneAt, dayStart));
  const [overdue] = await db
    .select({ n: count() })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(
      and(isNull(leadTasks.doneAt), lt(leadTasks.dueAt, now), isNull(leads.won), trackedTaskSql()),
    );

  const kpi = (key: OfficeKpi['key'], label: string, value: number | undefined): OfficeKpi => ({
    key,
    label,
    value: value ?? null,
    reason: value === undefined ? 'Sem resposta do banco' : null,
  });
  return [
    kpi('leads_today', 'Leads novos hoje', leadsToday?.n),
    kpi('won_today', 'Vendas ganhas hoje', wonToday?.n),
    kpi('tasks_done_today', 'Tarefas concluídas hoje', doneToday?.n),
    kpi('tasks_overdue', 'Tarefas atrasadas', overdue?.n),
    kpi('present_now', 'Pessoas no sistema agora', present),
  ];
}

/**
 * The AI agents' desks. Each shows only the time of its last recorded action:
 * Sofia's moves in the funnel, the other two agents' last replies. Their
 * conversations are never read here.
 */
async function agentDesks(db: Database): Promise<OfficeAgent[]> {
  const [sofia] = await db
    .select({ at: leadStageHistory.at, toStage: leadStageHistory.toStage })
    .from(leadStageHistory)
    .where(eq(leadStageHistory.source, 'sofia'))
    .orderBy(desc(leadStageHistory.at))
    .limit(1);

  const lastReply = async (scope: 'traffic' | 'media') => {
    const [row] = await db
      .select({ at: max(agentMessages.createdAt) })
      .from(agentMessages)
      .innerJoin(agentConversations, eq(agentConversations.id, agentMessages.conversationId))
      .where(and(eq(agentConversations.scope, scope), eq(agentMessages.role, 'assistant')));
    return row?.at ?? null;
  };
  const openProposals = async (
    kinds: ('campaign' | 'change' | 'generation' | 'timeline_edit')[],
  ) => {
    const [row] = await db
      .select({ n: count() })
      .from(agentProposals)
      .where(and(eq(agentProposals.status, 'open'), inArray(agentProposals.kind, kinds)));
    return row?.n ?? 0;
  };

  const traffic = await lastReply('traffic');
  const media = await lastReply('media');

  return [
    {
      key: 'sofia',
      name: 'Sofia (SDR)',
      zone: 'comercial',
      lastActivityAt: iso(sofia?.at),
      lastActivity: sofia ? `Moveu uma negociação para ${sofia.toStage ?? '—'}` : null,
      reason: sofia ? null : 'Nenhuma ação da Sofia registrada no CRM do Wings ainda',
      openProposals: null,
    },
    {
      key: 'trafego',
      name: 'Agente de tráfego',
      zone: 'marketing',
      lastActivityAt: iso(traffic),
      lastActivity: traffic ? 'Respondeu numa conversa' : null,
      reason: traffic ? null : 'Nenhuma conversa com o agente de tráfego registrada',
      openProposals: await openProposals(['campaign', 'change']),
    },
    {
      key: 'edicao',
      name: 'Agente de edição',
      zone: 'marketing',
      lastActivityAt: iso(media),
      lastActivity: media ? 'Respondeu numa conversa' : null,
      reason: media ? null : 'Nenhuma conversa com o agente de edição registrada',
      openProposals: await openProposals(['generation', 'timeline_edit']),
    },
  ];
}
