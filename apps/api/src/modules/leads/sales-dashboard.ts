import type { LeadPipeline, SalesDashboard, SalesSlice } from '@wings/shared';
import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { employees, leads } from '../../db/schema/index.js';
import { listStages, type Executor } from './crm.js';

/**
 * Dashboard › Vendas: one funnel's open deals by stage, brand and owner, what
 * was won this month and the 90-day conversion. Aggregates only; the caller's
 * scope (`ownerEmployeeId` for a seller) is the same as the kanban's.
 */

export const CONVERSION_DAYS = 90;

/** First instant of the current month in São Paulo (UTC−3, no daylight saving). */
export function saoPauloMonthStart(now: Date): Date {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 3));
}

const weigh = (valueCents: number, probability: number) =>
  Math.round((valueCents * probability) / 100);

export async function salesDashboardOf(
  db: Executor,
  input: { pipeline: LeadPipeline; ownerEmployeeId?: string; now?: Date },
): Promise<SalesDashboard> {
  const now = input.now ?? new Date();
  const monthStart = saoPauloMonthStart(now);
  const since = new Date(now.getTime() - CONVERSION_DAYS * 86_400_000);
  const scope = and(
    eq(leads.pipeline, input.pipeline),
    input.ownerEmployeeId ? eq(leads.ownerEmployeeId, input.ownerEmployeeId) : undefined,
  );
  const open = and(scope, isNull(leads.won));
  const value = sql<number>`coalesce(sum(${leads.valueCents}), 0)::bigint`;
  const count = sql<number>`count(*)::int`;

  const stages = await listStages(db, { pipeline: input.pipeline });
  const probabilityOf = new Map(stages.map((stage) => [stage.id, stage.probability]));
  // Weighted per stage before grouping by brand or owner, so every slice weighs the same way.
  const weighted = sql<number>`coalesce(sum(${leads.valueCents} * coalesce((select s.probability from crm_stages s where s.id = ${leads.stageId}), 0) / 100.0), 0)::float8`;

  const [byStage, byBrand, byOwner, wonByOwner, closed, unvalued] = await Promise.all([
    db
      .select({ stageId: leads.stageId, total: count, valueCents: value })
      .from(leads)
      .where(open)
      .groupBy(leads.stageId),
    db
      .select({ brand: leads.brand, total: count, valueCents: value, weightedCents: weighted })
      .from(leads)
      .where(open)
      .groupBy(leads.brand),
    db
      .select({
        ownerEmployeeId: leads.ownerEmployeeId,
        ownerName: employees.fullName,
        total: count,
        valueCents: value,
        weightedCents: weighted,
      })
      .from(leads)
      .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
      .where(open)
      .groupBy(leads.ownerEmployeeId, employees.fullName),
    db
      .select({
        ownerEmployeeId: leads.ownerEmployeeId,
        ownerName: employees.fullName,
        total: count,
        valueCents: value,
      })
      .from(leads)
      .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
      .where(and(scope, eq(leads.won, true), gte(leads.closedAt, monthStart)))
      .groupBy(leads.ownerEmployeeId, employees.fullName),
    db
      .select({
        won: sql<number>`(count(*) filter (where ${leads.won}))::int`,
        lost: sql<number>`(count(*) filter (where not ${leads.won}))::int`,
      })
      .from(leads)
      .where(and(scope, isNotNull(leads.won), gte(leads.closedAt, since))),
    db
      .select({ total: count })
      .from(leads)
      .where(and(open, isNull(leads.valueCents))),
  ]);

  const totalOf = new Map(byStage.map((row) => [row.stageId, row]));
  const stageSlice = (stageId: string | null, probability: number): SalesSlice => {
    const row = totalOf.get(stageId);
    const valueCents = Number(row?.valueCents ?? 0);
    return { total: row?.total ?? 0, valueCents, weightedCents: weigh(valueCents, probability) };
  };
  const stageRows: SalesDashboard['stages'] = stages
    .filter((stage) => stage.active || totalOf.has(stage.id))
    .map((stage) => ({
      stage: { id: stage.id, name: stage.name, probability: stage.probability },
      ...stageSlice(stage.id, probabilityOf.get(stage.id) ?? 0),
    }));
  if (totalOf.has(null)) stageRows.unshift({ stage: null, ...stageSlice(null, 0) });

  const sellers = new Map<string | null, SalesDashboard['sellers'][number]>();
  const seller = (id: string | null, name: string | null) => {
    const found = sellers.get(id);
    if (found) return found;
    const fresh = {
      ownerEmployeeId: id,
      ownerName: name,
      total: 0,
      valueCents: 0,
      weightedCents: 0,
      wonMonth: 0,
      wonMonthCents: 0,
    };
    sellers.set(id, fresh);
    return fresh;
  };
  for (const row of byOwner) {
    Object.assign(seller(row.ownerEmployeeId, row.ownerName), {
      total: row.total,
      valueCents: Number(row.valueCents),
      weightedCents: Math.round(Number(row.weightedCents)),
    });
  }
  for (const row of wonByOwner) {
    Object.assign(seller(row.ownerEmployeeId, row.ownerName), {
      wonMonth: row.total,
      wonMonthCents: Number(row.valueCents),
    });
  }

  const openTotal = stageRows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      valueCents: sum.valueCents + row.valueCents,
      weightedCents: sum.weightedCents + row.weightedCents,
    }),
    { total: 0, valueCents: 0, weightedCents: 0 },
  );
  const won = closed[0]?.won ?? 0;
  const lost = closed[0]?.lost ?? 0;
  const bySize = <T extends { total: number; valueCents: number }>(a: T, b: T) =>
    b.valueCents - a.valueCents || b.total - a.total;

  return {
    pipeline: input.pipeline,
    stages: stageRows,
    brands: byBrand
      .map((row) => ({
        brand: row.brand,
        total: row.total,
        valueCents: Number(row.valueCents),
        weightedCents: Math.round(Number(row.weightedCents)),
      }))
      .sort(bySize),
    sellers: [...sellers.values()].sort(
      (a, b) => bySize(a, b) || b.wonMonthCents - a.wonMonthCents,
    ),
    open: openTotal,
    wonMonth: {
      total: wonByOwner.reduce((sum, row) => sum + row.total, 0),
      valueCents: wonByOwner.reduce((sum, row) => sum + Number(row.valueCents), 0),
    },
    conversion: {
      won,
      lost,
      rate: won + lost > 0 ? won / (won + lost) : null,
      days: CONVERSION_DAYS,
    },
    openWithoutValue: unvalued[0]?.total ?? 0,
    monthStart: monthStart.toISOString(),
  };
}
