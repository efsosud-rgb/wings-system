import { LEAD_PIPELINE_LABELS, type LeadPipeline } from './leads.js';
import { LEAD_TASK_KIND_LABELS, type LeadTaskKind } from './crm.js';
import { SECTORS, type SectorSlug } from './rbac/sectors.js';

/**
 * Escritório virtual (laboratório): the company as a 3D office, fed only by
 * real rows. A desk exists for each active employee; what its monitor shows
 * is that person's next open CRM task or, failing that, their most recently
 * moved open deal. The feed is what happened in the CRM. Nothing here is
 * invented: a missing value travels as `null` with a reason the screen shows
 * beside a "—".
 *
 * No personal data leaves the API for this screen: employees by first name
 * only, leads never by name (a deal is its funnel and stage), tasks by kind,
 * never by their free-text title.
 */

export const OFFICE_TIME_ZONE = 'America/Sao_Paulo';

/** How many feed entries the API sends; the screen shows them newest first. */
export const OFFICE_FEED_LIMIT = 40;

/** Feed window: older events are not "what is happening in the office". */
export const OFFICE_FEED_DAYS = 7;

/**
 * A session counts as "at the desk" while it is alive and was used in the
 * last few minutes (the idle limit of a session is 30 minutes).
 */
export const OFFICE_PRESENCE_MINUTES = 15;

/** Rooms of the office, in the order they are laid out on the floor. */
export const OFFICE_ZONES = [
  'diretoria',
  'comercial',
  'marketing',
  'formatacao-juridico',
  'formatacao-financeiro',
  'formatacao-processos-projetos',
  'formatacao-contabil-tributario',
  'formatacao-logistica',
  'formatacao-ti',
] as const satisfies readonly SectorSlug[];
export type OfficeZone = (typeof OFFICE_ZONES)[number];

/** Employees of the Formatação parent sector itself sit in Processos e Projetos' room. */
export function officeZoneOf(sector: SectorSlug): OfficeZone {
  return sector === 'formatacao' ? 'formatacao-processos-projetos' : sector;
}

export function officeZoneLabel(zone: OfficeZone): string {
  const sector = SECTORS[zone];
  return sector.parent === 'formatacao' ? `Formatação · ${sector.name}` : sector.name;
}

/** What a desk's monitor shows. */
export type OfficeMonitor =
  | {
      kind: 'task';
      taskId: string;
      leadId: string;
      taskKind: LeadTaskKind;
      dueAt: string;
      overdue: boolean;
      pipeline: LeadPipeline | null;
      stage: string | null;
    }
  | {
      kind: 'deal';
      leadId: string;
      pipeline: LeadPipeline | null;
      stage: string | null;
      movedAt: string | null;
    }
  | { kind: 'none'; reason: string };

export interface OfficePerson {
  id: string;
  /** First name; a second word is added only when two people share it. */
  displayName: string;
  sector: SectorSlug;
  zone: OfficeZone;
  roleName: string;
  isSectorManager: boolean;
  /** A live session used in the last OFFICE_PRESENCE_MINUTES minutes. */
  present: boolean;
  lastSeenAt: string | null;
  openDeals: number;
  openTasks: number;
  overdueTasks: number;
  monitor: OfficeMonitor;
}

export type OfficeAgentKey = 'sofia' | 'trafego' | 'edicao';

export interface OfficeAgent {
  key: OfficeAgentKey;
  name: string;
  zone: OfficeZone;
  /** The last thing on record for this agent, or null with the reason. */
  lastActivityAt: string | null;
  lastActivity: string | null;
  reason: string | null;
  /** Proposals still waiting for a person (traffic and editing agents). */
  openProposals: number | null;
}

export type OfficeEventKind =
  'lead_created' | 'stage_moved' | 'deal_won' | 'deal_lost' | 'task_done' | 'owner_changed';

export interface OfficeEvent {
  id: string;
  kind: OfficeEventKind;
  at: string;
  /** Who it belongs to on the floor (actor, else the deal owner); null = nobody's desk. */
  employeeId: string | null;
  leadId: string;
  taskId: string | null;
  pipeline: LeadPipeline | null;
  /** Stage reached, for moves; kind of task, for tasks. Never a lead's name. */
  detail: string | null;
}

export interface OfficeKpi {
  key: 'leads_today' | 'won_today' | 'tasks_done_today' | 'tasks_overdue' | 'present_now';
  label: string;
  value: number | null;
  reason: string | null;
}

export interface OfficeSnapshot {
  generatedAt: string;
  /** Hour 0–23 in OFFICE_TIME_ZONE when the snapshot was made. */
  hour: number;
  minute: number;
  people: OfficePerson[];
  agents: OfficeAgent[];
  events: OfficeEvent[];
  kpis: OfficeKpi[];
}

/** First names, disambiguated by the next word only when needed. */
export function officeDisplayNames(
  people: { id: string; fullName: string }[],
): Map<string, string> {
  const words = people.map((p) => ({ id: p.id, parts: p.fullName.trim().split(/\s+/) }));
  const firstCount = new Map<string, number>();
  for (const w of words) {
    const key = (w.parts[0] ?? '').toLowerCase();
    firstCount.set(key, (firstCount.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const w of words) {
    const first = w.parts[0] ?? '—';
    const shared = (firstCount.get(first.toLowerCase()) ?? 0) > 1;
    names.set(w.id, shared && w.parts[1] ? `${first} ${w.parts[1].charAt(0)}.` : first);
  }
  return names;
}

/** Hour and minute in Rio de Janeiro (same zone as São Paulo). */
export function officeClock(at: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: OFFICE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: value('hour'), minute: value('minute') };
}

/** Midnight of the day `at` falls on in Rio, as an instant. */
export function officeDayStart(at: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OFFICE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = (n('hour') * 3600 + n('minute') * 60 + n('second')) * 1000 + at.getMilliseconds();
  return new Date(at.getTime() - elapsed);
}

export type OfficeLight = 'manha' | 'dia' | 'por_do_sol' | 'noite';

export const OFFICE_LIGHT_LABELS: Record<OfficeLight, string> = {
  manha: 'Manhã',
  dia: 'Dia',
  por_do_sol: 'Pôr do sol',
  noite: 'Noite',
};

/**
 * The light by the hour in Rio. Weather (rain) has no source in the system
 * yet, so it is not drawn.
 */
export function officeLightAt(hour: number, minute = 0): OfficeLight {
  const t = hour + minute / 60;
  if (t >= 6 && t < 9) return 'manha';
  if (t >= 9 && t < 17) return 'dia';
  if (t >= 17 && t < 19) return 'por_do_sol';
  return 'noite';
}

export function officeEventText(event: OfficeEvent): string {
  const pipeline = event.pipeline ? LEAD_PIPELINE_LABELS[event.pipeline] : null;
  const funnel = pipeline ? ` · ${pipeline}` : '';
  switch (event.kind) {
    case 'lead_created':
      return `Lead novo${funnel}`;
    case 'stage_moved':
      return `Negociação avançou para ${event.detail ?? '—'}${funnel}`;
    case 'deal_won':
      return `Venda ganha${funnel}`;
    case 'deal_lost':
      return `Negociação perdida${funnel}`;
    case 'task_done':
      return `Tarefa concluída: ${event.detail ?? '—'}${funnel}`;
    case 'owner_changed':
      return `Negociação com novo dono${funnel}`;
  }
}

export function officeMonitorText(monitor: OfficeMonitor): string {
  switch (monitor.kind) {
    case 'task':
      return `${LEAD_TASK_KIND_LABELS[monitor.taskKind] ?? 'Tarefa'}${monitor.overdue ? ' · atrasada' : ''}`;
    case 'deal':
      return monitor.stage ?? 'Negociação';
    case 'none':
      return '—';
  }
}

/** Where a click on the floor leads: the deal, whose page lists its tasks too. */
export function officeLinkOf(leadId: string): string {
  return `/crm-vendas/negociacoes/${leadId}`;
}
