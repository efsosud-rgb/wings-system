import { existsSync, readFileSync } from 'node:fs';
import { adAccounts } from '../../db/schema/index.js';
import { createTestDatabase } from '../../test/db.js';
import { openPeriod, getPeriodState } from './budget-guard.js';
import { MetaReadOnlyClient } from './platform/meta-client.js';
import { formatBrl } from './platform/money.js';
import { reconcileAccount } from './reconcile.js';

/**
 * Live read-only verification against the real Meta ad account.
 *
 * Reads only: the client used here has no mutating code path at all, and the
 * token is expected to carry `ads_read` without `ads_management`, so a write
 * would be refused by Meta as well.
 *
 * Reconciliation runs against a THROWAWAY database, never staging, so a real
 * account's data can be pushed through the whole pipeline without leaving
 * anything behind.
 *
 *   node dist/modules/ads/verify-live.js --cap 400000 --usable 70
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Parses an env file without sourcing it: values may contain spaces or quotes. */
function readEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function main() {
  const secrets = readEnvFile('/etc/wings-crm/meta.env');
  const token = secrets.META_SYSTEM_USER_TOKEN ?? process.env.META_SYSTEM_USER_TOKEN;
  const accountId = secrets.META_AD_ACCOUNT_ID ?? process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) throw new Error('META_SYSTEM_USER_TOKEN / META_AD_ACCOUNT_ID missing');

  const capCents = Number(arg('cap') ?? 400_000);
  const usablePercent = Number(arg('usable') ?? 70);

  const client = new MetaReadOnlyClient({ accessToken: token, adAccountId: accountId });
  console.warn(`account: ${accountId}`);

  // --- 1. account -----------------------------------------------------------
  const account = await client.getAccount();
  console.warn('\n[1] account');
  console.warn(`    currency:      ${account.currency}`);
  console.warn(
    `    spend_cap:     ${account.spendCapCents === null ? '(none set)' : formatBrl(account.spendCapCents)} (raw cents: ${account.spendCapCents ?? 0})`,
  );
  console.warn(
    `    amount_spent:  ${formatBrl(account.amountSpentCents)} (raw cents: ${account.amountSpentCents})`,
  );
  console.warn(`    cap reached:   ${account.capReached}`);

  // --- 2. campaigns ---------------------------------------------------------
  const campaigns = await client.listCampaigns();
  const active = campaigns.filter((c) => c.status === 'ACTIVE');
  console.warn(`\n[2] campaigns: ${campaigns.length} total, ${active.length} active`);
  for (const campaign of campaigns.slice(0, 10)) {
    const budget =
      campaign.dailyBudgetCents === null
        ? campaign.lifetimeBudgetCents === null
          ? 'sem orçamento próprio'
          : `lifetime ${formatBrl(campaign.lifetimeBudgetCents)}`
        : `${formatBrl(campaign.dailyBudgetCents)}/dia`;
    console.warn(`    ${campaign.status.padEnd(8)} ${budget.padEnd(28)} ${campaign.name}`);
  }
  if (campaigns.length > 10) console.warn(`    … and ${campaigns.length - 10} more`);

  // --- 3. insights ----------------------------------------------------------
  const periodStart = `${new Date().toISOString().slice(0, 7)}-01`;
  const spend = await client.getSpend(periodStart);
  const totalSpend = spend.reduce((sum, row) => sum + row.spendCents, 0);
  console.warn(`\n[3] insights since ${periodStart}: ${spend.length} rows`);
  console.warn(`    total: ${formatBrl(totalSpend)} (raw cents: ${totalSpend})`);
  for (const row of spend.slice(0, 5)) {
    console.warn(`    ${row.date}  ${formatBrl(row.spendCents).padStart(12)}  ${row.campaignId}`);
  }

  // --- 4. reconciliation, against a throwaway database ----------------------
  console.warn('\n[4] reconciliation (throwaway database, no staging data touched)');
  const harness = await createTestDatabase();
  try {
    const [row] = await harness.db
      .insert(adAccounts)
      .values({ platform: 'meta', externalId: accountId, name: 'Wings Matriz (verificação)' })
      .returning({ id: adAccounts.id });
    if (!row) throw new Error('failed to create scratch account');

    await openPeriod(harness.db, {
      adAccountId: row.id,
      periodMonth: periodStart,
      capCents,
      usablePercent,
    });

    const result = await reconcileAccount(harness.db, client, row.id);
    const state = await getPeriodState(harness.db, row.id, periodStart);

    console.warn(`    campaigns synced:    ${result.campaignsSynced}`);
    console.warn(`    spend rows recorded: ${result.spendRowsRecorded}`);
    console.warn(`    spent:               ${formatBrl(result.spentCents)}`);
    console.warn(`    committed (exposure):${formatBrl(result.committedCents)}`);
    console.warn(
      `    cap / usable:        ${formatBrl(capCents)} / ${formatBrl(state?.usableCents ?? 0)}`,
    );
    console.warn(`    available to plan:   ${formatBrl(state?.availableCents ?? 0)}`);
    console.warn(`    out-of-band change:  ${result.outOfBandChangeDetected}`);
    console.warn(`    kill switch engaged: ${result.killSwitchEngaged}`);

    // Cross-check: our own total against what Meta reports on the account.
    const drift = result.spentCents - account.amountSpentCents;
    console.warn(
      `\n[5] drift check (insights total vs account amount_spent): ${formatBrl(Math.abs(drift))}`,
    );
    console.warn(
      '    Note: amount_spent counts against the account spending limit and may cover a',
    );
    console.warn('    different window than this month, so a difference is expected, not a bug.');
  } finally {
    await harness.drop();
    console.warn('\n    throwaway database dropped');
  }

  console.warn('\nNo write was attempted: this client has no mutating code path.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
