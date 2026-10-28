import type { ProspectingQuota, ProspectingUsage } from '@wings/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { prospectCalls } from '../../db/schema/index.js';
import type { Executor } from '../leads/crm.js';
import { periodStarts } from '../media/providers/quota.js';
import { loadProspectingSettings } from './settings.js';

/**
 * The quota of calls to Google (docs/crm/prospeccao.md): per person per day,
 * and per kind (searches, fichas) per month for the whole company, inside
 * Google's 1,000 free calls of each kind. Days and months are São Paulo's.
 * Calls are reserved under a lock BEFORE they go, all of a sweep or none.
 */

export type CallKind = 'search' | 'details';

async function used(db: Executor, employeeId: string, now: Date) {
  const starts = periodStarts(now);
  const total = sql<number>`coalesce(sum(${prospectCalls.count}), 0)::int`;
  const [today] = await db
    .select({ total })
    .from(prospectCalls)
    .where(and(eq(prospectCalls.employeeId, employeeId), gte(prospectCalls.createdAt, starts.day)));
  const month = await db
    .select({ kind: prospectCalls.kind, total })
    .from(prospectCalls)
    .where(
      and(eq(prospectCalls.tenantId, WINGS_TENANT_ID), gte(prospectCalls.createdAt, starts.month)),
    )
    .groupBy(prospectCalls.kind);
  const ofKind = (kind: CallKind) => month.find((row) => row.kind === kind)?.total ?? 0;
  return { today: today?.total ?? 0, searches: ofKind('search'), details: ofKind('details') };
}

const usageFrom = (
  counts: Awaited<ReturnType<typeof used>>,
  quota: ProspectingQuota,
): ProspectingUsage => ({
  today: { used: counts.today, limit: quota.perUserDaily },
  month: {
    searches: counts.searches,
    searchLimit: quota.monthlySearches,
    details: counts.details,
    detailsLimit: quota.monthlyDetails,
  },
});

export async function usageOf(db: Database, employeeId: string, now: Date) {
  const settings = await loadProspectingSettings(db);
  return usageFrom(await used(db, employeeId, now), settings.quota);
}

/** Why the calls cannot go, in the seller's words; null when they fit. */
export function quotaRefusal(
  usage: ProspectingUsage,
  kind: CallKind,
  count: number,
): string | null {
  const dayLeft = Math.max(0, usage.today.limit - usage.today.used);
  const monthUsed = kind === 'search' ? usage.month.searches : usage.month.details;
  const monthLimit = kind === 'search' ? usage.month.searchLimit : usage.month.detailsLimit;
  const monthLeft = Math.max(0, monthLimit - monthUsed);
  if (count > dayLeft)
    return count > 1 && dayLeft > 0
      ? `A varredura gasta ${count} chamadas e só restam ${dayLeft} hoje.`
      : `Você já usou as ${usage.today.limit} chamadas ao Google de hoje. A cota volta amanhã.`;
  if (count > monthLeft) {
    if (count > 1 && monthLeft > 0)
      return `A varredura gasta ${count} chamadas e só restam ${monthLeft} buscas no mês.`;
    return kind === 'search'
      ? `O mês chegou a ${monthLimit} buscas no Google (cota grátis). A busca volta no dia 1º.`
      : `O mês chegou a ${monthLimit} fichas no Google (cota grátis). A ficha volta no dia 1º.`;
  }
  return null;
}

/**
 * Reserves `count` calls of one kind for the employee, in one transaction under
 * a lock: refused whole when they do not fit, else written before any call
 * goes. A call that then fails still counts (never refunded, never retried):
 * Google may have billed it.
 */
export async function reserveCalls(
  db: Database,
  input: {
    employeeId: string;
    kind: CallKind;
    count: number;
    queryText: string | null;
    locations: string[];
    now: Date;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('prospecting_places_quota'))`);
    const settings = await loadProspectingSettings(tx);
    const usage = usageFrom(await used(tx, input.employeeId, input.now), settings.quota);
    const refusal = quotaRefusal(usage, input.kind, input.count);
    if (refusal) return { ok: false, message: refusal };
    await tx.insert(prospectCalls).values({
      employeeId: input.employeeId,
      kind: input.kind,
      queryText: input.queryText,
      locations: input.locations,
      count: input.count,
      createdAt: input.now,
    });
    return { ok: true };
  });
}
