import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, expansionIntakeLedger, leadSourceRules } from '../../db/schema/index.js';
import {
  runExpansionIntake,
  type IntakeResult,
  type Ledger,
  type LandingPageRule,
} from './intake.js';
import { RdCrm, RdMarketing, type RdMarketingCredentials } from './rd.js';

export function dbLedger(db: Database): Ledger {
  return {
    async has(key) {
      const row = await db.query.expansionIntakeLedger.findFirst({
        where: eq(expansionIntakeLedger.conversionKey, key),
        columns: { id: true },
      });
      return Boolean(row);
    },
    async record(entry) {
      await db
        .insert(expansionIntakeLedger)
        .values({
          conversionKey: entry.key,
          target: entry.target,
          outcome: entry.outcome,
          rdDealId: entry.dealId,
        })
        .onConflictDoNothing();
    },
  };
}

/**
 * The brands' landing pages: the source rules of funnel Expansão. The brand
 * is the rule's own name for it (what RD's campaigns are named after), else
 * the client's.
 */
export async function activeRules(db: Database): Promise<LandingPageRule[]> {
  const rows = await db
    .select({ identifier: leadSourceRules.pattern, brand: leadSourceRules.brand, clientName: clients.name })
    .from(leadSourceRules)
    .leftJoin(clients, eq(clients.id, leadSourceRules.clientId))
    .where(
      and(
        eq(leadSourceRules.kind, 'landing_page'),
        eq(leadSourceRules.pipeline, 'expansao'),
        eq(leadSourceRules.active, true),
      ),
    )
    .orderBy(asc(leadSourceRules.pattern));
  return rows.flatMap((row) => {
    const brand = row.brand ?? row.clientName;
    return brand ? [{ identifier: row.identifier, brand }] : [];
  });
}

export interface IntakeCredentials {
  rdCrmToken: string;
  rdMarketing: RdMarketingCredentials;
  expansionOwnerId?: string | null;
}

/** One pass over the last `lookbackHours` of conversions. */
export async function runIntakeOnce(
  db: Database,
  credentials: IntakeCredentials,
  options: { lookbackHours: number; dryRun?: boolean; fetchImpl?: typeof fetch; now?: Date },
): Promise<IntakeResult> {
  const now = options.now ?? new Date();
  return runExpansionIntake({
    marketing: new RdMarketing(credentials.rdMarketing, options.fetchImpl),
    crm: new RdCrm(credentials.rdCrmToken, options.fetchImpl),
    ledger: dbLedger(db),
    rules: await activeRules(db),
    expansionOwnerId: credentials.expansionOwnerId ?? null,
    since: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    dryRun: options.dryRun ?? false,
    now: () => now,
  });
}
