import type { Database } from '../../db/client.js';
import { runAlerts, type AlertNotifier, type RunAlertsResult } from './alerts.js';
import {
  BREAKDOWN_KINDS,
  ingestBreakdown,
  recordAccountDay,
  type AccountDayResult,
  type BreakdownIngestResult,
} from './breakdowns.js';
import { ingestMetrics, syncAds, type IngestResult, type SyncAdsResult } from './metrics.js';
import type { AdsPlatformClient, BreakdownKind, MetricsLevel } from './platform/types.js';
import { reconcileAccount, type ReconcileResult } from './reconcile.js';

/**
 * One ingestion cycle over every active account, each in isolation.
 *
 * An account is its own failure domain. The cycle used to be a bare loop, so
 * the first account that threw — an expired token, a missing budget period, an
 * empty account the platform answers oddly for — ended the run, and every
 * account after it went unreconciled. Reconciliation is what confirms a write
 * landed, so one broken account could leave a real change unverified on
 * another.
 *
 * Failure stays loud: a failed account is reported with the step it died in,
 * and the caller is expected to exit non-zero. What changes is only that the
 * other accounts are still served first.
 */

const METRIC_LEVELS: readonly MetricsLevel[] = ['campaign', 'ad_set', 'ad'];

export type IngestStep =
  | 'client'
  | 'reconcile'
  | 'ads'
  | `metrics:${MetricsLevel}`
  | `breakdown:${BreakdownKind}`
  | 'account_day'
  | 'alerts';

export interface CycleAccount {
  id: string;
  platform: string;
  externalId: string;
}

export type AccountCycleResult =
  | {
      status: 'ok';
      account: CycleAccount;
      reconciled: ReconcileResult;
      ads: SyncAdsResult;
      metrics: Record<MetricsLevel, IngestResult>;
      breakdowns: Record<BreakdownKind, BreakdownIngestResult>;
      accountDay: AccountDayResult;
      alerts: RunAlertsResult;
    }
  | { status: 'skipped'; account: CycleAccount; reason: 'no_credentials' }
  | {
      status: 'failed';
      account: CycleAccount;
      /** The step that threw. Later steps did not run for this account. */
      step: IngestStep;
      error: string;
    };

export interface CycleOptions {
  /** Builds the client for one account. Never share a client across accounts. */
  clientFor: (account: CycleAccount) => AdsPlatformClient | null;
  /** First day of the metrics window, YYYY-MM-DD. */
  since: string;
  now?: Date;
  notifier?: AlertNotifier;
  /** Called as each account finishes, so a long run reports as it goes. */
  onAccountDone?: (result: AccountCycleResult) => void | Promise<void>;
}

export interface CycleResult {
  accounts: AccountCycleResult[];
  failed: number;
}

/** Platform and database errors carry ids and codes, never personal data. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function ingestAccount(
  db: Database,
  account: CycleAccount,
  options: CycleOptions,
): Promise<AccountCycleResult> {
  const now = options.now ?? new Date();
  let step: IngestStep = 'client';

  try {
    const client = options.clientFor(account);
    if (!client) return { status: 'skipped', account, reason: 'no_credentials' };

    step = 'reconcile';
    const reconciled = await reconcileAccount(db, client, account.id, now);

    step = 'ads';
    const ads = await syncAds(db, client, account.id, now);

    const metrics = {} as Record<MetricsLevel, IngestResult>;
    for (const level of METRIC_LEVELS) {
      step = `metrics:${level}`;
      metrics[level] = await ingestMetrics(db, client, account.id, level, options.since, now);
    }

    // The splits the dashboard's audience view reads. Campaign level only,
    // one platform aggregation per split (see breakdowns.ts).
    const breakdowns = {} as Record<BreakdownKind, BreakdownIngestResult>;
    for (const kind of BREAKDOWN_KINDS) {
      step = `breakdown:${kind}`;
      breakdowns[kind] = await ingestBreakdown(db, client, account.id, kind, options.since, now);
    }

    step = 'account_day';
    const accountDay = await recordAccountDay(db, client, account.id, now);

    step = 'alerts';
    const alerts = await runAlerts(db, account.id, { notifier: options.notifier, now });

    return { status: 'ok', account, reconciled, ads, metrics, breakdowns, accountDay, alerts };
  } catch (error) {
    return { status: 'failed', account, step, error: describeError(error) };
  }
}

export async function runIngestionCycle(
  db: Database,
  accounts: CycleAccount[],
  options: CycleOptions,
): Promise<CycleResult> {
  const results: AccountCycleResult[] = [];

  for (const account of accounts) {
    const result = await ingestAccount(db, account, options);
    results.push(result);
    try {
      await options.onAccountDone?.(result);
    } catch {
      // Reporting is a courtesy; it must never cost the next account its turn.
    }
  }

  return {
    accounts: results,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}
