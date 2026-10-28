import {
  PROSPECT_ENRICHMENT_KEYS,
  PROSPECT_STATUS_LABELS,
  toCsv,
  type Actor,
  type Prospect,
  type ProspectingMetrics,
  type ProspectingOwnerMetrics,
  type ProspectSearchHistoryItem,
  type ProspectStatus,
} from '@wings/shared';
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { employees, prospectCalls, prospects } from '../../db/schema/index.js';
import { periodStarts } from '../media/providers/quota.js';
import { isProspectingManager, listProspects } from './service.js';

/**
 * Prospecção's history, numbers and export (docs/crm/prospeccao.md), all from our own tables: what
 * the seller typed (`prospect_calls`) and what they did (`prospects`). Nothing of Google's is here,
 * because nothing of Google's is stored. A seller sees their own; a manager (all) everyone's.
 */

/** The past searches, newest first: segment and places as typed, the calls they spent. */
export async function searchHistory(
  db: Database,
  actor: Actor,
  limit = 50,
): Promise<ProspectSearchHistoryItem[]> {
  const conditions: SQL[] = [
    eq(prospectCalls.tenantId, WINGS_TENANT_ID),
    eq(prospectCalls.kind, 'search'),
  ];
  if (!isProspectingManager(actor)) conditions.push(eq(prospectCalls.employeeId, actor.employeeId));
  const rows = await db
    .select({ call: prospectCalls, employeeName: employees.fullName })
    .from(prospectCalls)
    .leftJoin(employees, eq(employees.id, prospectCalls.employeeId))
    .where(and(...conditions))
    .orderBy(desc(prospectCalls.createdAt))
    .limit(limit);
  return rows.map(({ call, employeeName }) => ({
    id: call.id,
    at: call.createdAt.toISOString(),
    employeeName,
    mine: call.employeeId === actor.employeeId,
    segment: call.queryText,
    places: call.locations,
    calls: call.count,
  }));
}

/** Prospects by owner and status, and each person's calls to Google this month (São Paulo's). */
export async function prospectingMetrics(
  db: Database,
  actor: Actor,
  now: Date,
): Promise<ProspectingMetrics> {
  const manager = isProspectingManager(actor);
  const counted = sql<number>`count(*)::int`;
  const statusRows = await db
    .select({
      owner: prospects.ownerEmployeeId,
      name: employees.fullName,
      status: prospects.status,
      count: counted,
    })
    .from(prospects)
    .leftJoin(employees, eq(employees.id, prospects.ownerEmployeeId))
    .where(
      and(
        eq(prospects.tenantId, WINGS_TENANT_ID),
        manager ? undefined : eq(prospects.ownerEmployeeId, actor.employeeId),
      ),
    )
    .groupBy(prospects.ownerEmployeeId, employees.fullName, prospects.status);
  const callRows = await db
    .select({
      employeeId: prospectCalls.employeeId,
      name: employees.fullName,
      calls: sql<number>`coalesce(sum(${prospectCalls.count}), 0)::int`,
    })
    .from(prospectCalls)
    .leftJoin(employees, eq(employees.id, prospectCalls.employeeId))
    .where(
      and(
        eq(prospectCalls.tenantId, WINGS_TENANT_ID),
        gte(prospectCalls.createdAt, periodStarts(now).month),
        manager ? undefined : eq(prospectCalls.employeeId, actor.employeeId),
      ),
    )
    .groupBy(prospectCalls.employeeId, employees.fullName);

  const owners = new Map<string, ProspectingOwnerMetrics>();
  const ownerOf = (id: string | null, name: string | null) => {
    const key = id ?? '';
    let entry = owners.get(key);
    if (!entry) {
      entry = { employeeId: id, name, byStatus: {}, total: 0, callsThisMonth: 0 };
      owners.set(key, entry);
    }
    return entry;
  };
  const byStatus: Partial<Record<ProspectStatus, number>> = {};
  let total = 0;
  for (const row of statusRows) {
    const entry = ownerOf(row.owner, row.name);
    const status = row.status as ProspectStatus;
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + row.count;
    entry.total += row.count;
    byStatus[status] = (byStatus[status] ?? 0) + row.count;
    total += row.count;
  }
  let callsThisMonth = 0;
  for (const row of callRows) {
    ownerOf(row.employeeId, row.name).callsThisMonth += row.calls;
    callsThisMonth += row.calls;
  }
  return {
    owners: [...owners.values()].sort(
      (a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? ''),
    ),
    byStatus,
    total,
    conversionRate: total === 0 ? null : (byStatus.virou_lead ?? 0) / total,
    callsThisMonth,
  };
}

/** The most rows one export carries. */
export const PROSPECT_EXPORT_MAX_ROWS = 5000;

export const PROSPECT_EXPORT_HEADERS = [
  'Situação',
  'Dono',
  'Motivo',
  'Observações',
  'Instagram (site da empresa)',
  'Facebook (site da empresa)',
  'LinkedIn (site da empresa)',
  'WhatsApp (site da empresa)',
  'E-mail (site da empresa)',
  'Negociação',
  'place_id do Google',
  'Salvo em',
  'Atualizado em',
] as const;

/** A cell a spreadsheet would run as a formula ("=", "+", "-", "@") is kept as text. */
const asText = (value: string | null) =>
  value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : (value ?? '');
const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * The prospects as a spreadsheet: our data only. Google's name, address, phone, site and rating
 * are not stored, so they cannot be exported (Maps Platform terms); the place_id may be, and opens
 * the company on Google Maps.
 */
export function prospectsToCsv(items: readonly Prospect[]): string {
  const rows = items.map((prospect) => [
    PROSPECT_STATUS_LABELS[prospect.status],
    asText(prospect.ownerName),
    asText(prospect.reason),
    asText(prospect.notes),
    ...PROSPECT_ENRICHMENT_KEYS.map((key) => asText(prospect.enrichment[key]?.value ?? null)),
    prospect.leadId ?? '',
    prospect.placeId,
    when(prospect.createdAt),
    when(prospect.updatedAt),
  ]);
  return `\uFEFF${toCsv([PROSPECT_EXPORT_HEADERS as unknown as string[], ...rows])}`;
}

export async function exportProspects(
  db: Database,
  actor: Actor,
  filter: { status?: ProspectStatus; owner?: string },
): Promise<{ csv: string; count: number }> {
  const items = await listProspects(db, actor, filter, PROSPECT_EXPORT_MAX_ROWS);
  return { csv: prospectsToCsv(items), count: items.length };
}
