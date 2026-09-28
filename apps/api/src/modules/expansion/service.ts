import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { expansionIntakeLedger, expansionLandingPages } from '../../db/schema/index.js';
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

export async function activeRules(db: Database): Promise<LandingPageRule[]> {
  const rows = await db
    .select({ identifier: expansionLandingPages.identifier, brand: expansionLandingPages.brand })
    .from(expansionLandingPages)
    .where(eq(expansionLandingPages.active, true))
    .orderBy(asc(expansionLandingPages.identifier));
  return rows;
}

export interface IntakeCredentials {
  rdCrmToken: string;
  rdMarketing: RdMarketingCredentials;
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
    since: new Date(now.getTime() - options.lookbackHours * 3_600_000),
    dryRun: options.dryRun ?? false,
  });
}
