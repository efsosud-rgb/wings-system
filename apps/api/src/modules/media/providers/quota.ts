import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { mediaCreditLedger } from '../../../db/schema/index.js';

/**
 * The free providers' quotas are OURS: a count of what this system started,
 * read from the append-only ledger, never asked of the service. The provider's
 * own limit may be higher or lower; ours is the one that refuses first.
 */

/** Midnight today and the first of this month in São Paulo (UTC-3 all year since 2019). */
export function periodStarts(now: Date): { day: Date; month: Date; minute: Date } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  return {
    day: new Date(`${day}T00:00:00-03:00`),
    month: new Date(`${day.slice(0, 7)}-01T00:00:00-03:00`),
    minute: new Date(now.getTime() - 60_000),
  };
}

/** Outputs a provider was asked for since `since`: the `quantity` of every `started` row. */
export async function outputsStarted(db: Database, provider: string, since: Date): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(coalesce((${mediaCreditLedger.params}->>'quantity')::int, 1)), 0)`,
    })
    .from(mediaCreditLedger)
    .where(
      and(
        eq(mediaCreditLedger.provider, provider),
        eq(mediaCreditLedger.event, 'started'),
        gte(mediaCreditLedger.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Reais counted against the ceiling since `since`, for one provider or for all. */
export async function brlCounted(db: Database, since: Date, provider?: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${mediaCreditLedger.brlCentsDelta}), 0)` })
    .from(mediaCreditLedger)
    .where(
      and(
        gte(mediaCreditLedger.createdAt, since),
        provider ? eq(mediaCreditLedger.provider, provider) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

/** Dollars to the cents of reais the ledger counts, rounded up: a ceiling never rounds in the spender's favour. */
export const usdToBrlCents = (usd: number, brlPerUsd: number) =>
  Math.ceil(usd * brlPerUsd * 100 - 1e-9);
