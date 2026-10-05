import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { processDueRuns } from './automations.js';
import { runCrmAlerts } from './crm-alerts.js';
import type { CrmMailTransport } from './crm-mail.js';

/**
 * The CRM cycle, run by the API process: what is due in the automations, then
 * the deadline alerts. One cycle at a time in this process (`busy`) and across
 * replicas (a transaction-level advisory lock held for the cycle: a replica
 * that does not get it simply skips this tick). Failures are logged by kind
 * only, never with a lead's data, and the next tick tries again.
 */

export const DEFAULT_CYCLE_MINUTES = 5;
const LOCK_KEY = 'crm:automations:cycle';

/** `*\/N * * * *` as minutes; anything else (or nothing) is the default 5. */
export function cycleMinutesOf(cron: string | undefined): number {
  const match = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(cron?.trim() ?? '');
  const minutes = match ? Number(match[1]) : DEFAULT_CYCLE_MINUTES;
  return minutes >= 1 && minutes <= 59 ? minutes : DEFAULT_CYCLE_MINUTES;
}

export interface CycleDeps {
  db: Database;
  mail: CrmMailTransport;
  stageStuckDays: number;
  log: (facts: Record<string, unknown>) => void;
}

export interface CycleResult {
  ran: boolean;
  automations?: { done: number; skipped: number; failed: number };
  alerts?: { written: number };
}

export async function runCrmCycle(deps: CycleDeps, now = new Date()): Promise<CycleResult> {
  return deps.db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false };
    const automations = await processDueRuns(deps.db, { mail: deps.mail, now: () => now });
    const alerts = await runCrmAlerts(deps.db, { stageStuckDays: deps.stageStuckDays }, now);
    return { ran: true, automations, alerts };
  });
}

export function startCrmAutomationsScheduler(deps: CycleDeps & { cron?: string; tickMs?: number }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runCrmCycle(deps);
      if (result.ran)
        deps.log({ job: 'crm-automations', ...result.automations, alerts: result.alerts?.written });
    } catch (error) {
      deps.log({
        job: 'crm-automations',
        error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? cycleMinutesOf(deps.cron) * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
