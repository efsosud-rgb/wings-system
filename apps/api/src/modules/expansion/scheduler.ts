import type { Database } from '../../db/client.js';
import { runIntakeOnce, type IntakeCredentials } from './service.js';

/**
 * The job "expansion-intake": every 5 minutes, the conversions of the last 48
 * hours that have no deal in RD CRM get one (docs/expansion-intake.md). The
 * long lookback costs nothing extra: the ledger and the contact check make a
 * conversion already handled a no-op, and it lets the job catch up after an
 * outage. One pass at a time per process. Never started by `buildApp`.
 */

export const EXPANSION_INTAKE_JOB = 'expansion-intake';
const TICK_MS = 5 * 60_000;
const LOOKBACK_HOURS = 48;

export function startExpansionIntakeScheduler(deps: {
  db: Database;
  credentials: IntakeCredentials;
  log: (facts: Record<string, unknown>) => void;
  tickMs?: number;
}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runIntakeOnce(deps.db, deps.credentials, {
        lookbackHours: LOOKBACK_HOURS,
      });
      // Counts only: no name, e-mail, phone or RD text.
      deps.log({
        job: EXPANSION_INTAKE_JOB,
        contacts: result.contacts,
        conversions: result.conversions,
        created: result.created,
        existingDeal: result.existingDeal,
        alreadyDecided: result.alreadyDecided,
        failed: result.failed,
        unverified: result.unverified,
      });
    } catch (error) {
      deps.log({
        job: EXPANSION_INTAKE_JOB,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
