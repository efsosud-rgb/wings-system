import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { adAccounts } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { getPeriodState, openPeriod } from './budget-guard.js';
import { ensureAdAccount, ingestMetrics, syncAds } from './metrics.js';
import { formatBrl } from './platform/money.js';
import { createMetaClient } from './platform/factory.js';
import { periodMonthOf, reconcileAccount } from './reconcile.js';

/**
 * The job the Coolify scheduled task runs.
 *
 * Read-only against the platform: it mirrors campaigns, ad sets, ads and
 * creatives, pulls daily performance, and reconciles spend. It never writes to
 * an ad platform, so a scheduling mistake costs nothing but API calls.
 *
 *   node dist/modules/ads/ingest-cli.js            # ingest everything
 *   node dist/modules/ads/ingest-cli.js --seed     # create the account row first
 *   node dist/modules/ads/ingest-cli.js --days 30  # wider metrics window
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);

  try {
    const { client } = createMetaClient(env);
    if (!client) {
      // Fail loudly: a scheduled task that quietly does nothing is worse than
      // one that fails visibly.
      throw new Error('No Meta credentials configured — nothing to ingest.');
    }

    const now = new Date();
    const days = Number(arg('days') ?? 7);
    const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString().slice(0, 10);

    if (flag('seed')) {
      const externalId = arg('account') ?? env.META_WRITE_ACCOUNT_ID ?? '';
      if (!externalId) throw new Error('--account act_… is required when seeding');

      const accountId = await ensureAdAccount(db, {
        platform: 'meta',
        externalId,
        name: arg('name') ?? 'Wings Matriz',
      });
      const capCents = Number(arg('cap') ?? 400_000);
      const usablePercent = Number(arg('usable') ?? 70);
      await openPeriod(db, {
        adAccountId: accountId,
        periodMonth: periodMonthOf(now),
        capCents,
        usablePercent,
      });
      console.warn(
        `seeded ${externalId}: cap ${formatBrl(capCents)}, ${usablePercent}% usable, period ${periodMonthOf(now)}`,
      );
    }

    const accounts = await db.query.adAccounts.findMany({ where: eq(adAccounts.platform, 'meta') });
    if (accounts.length === 0) {
      throw new Error('No ad accounts configured. Run once with --seed --account act_…');
    }

    for (const account of accounts) {
      console.warn(`\n${account.platform}:${account.externalId}`);

      const reconciled = await reconcileAccount(db, client, account.id, now);
      console.warn(
        `  reconcile: ${reconciled.campaignsSynced} campanhas, ${reconciled.adSetsSynced} conjuntos, ` +
          `gasto ${formatBrl(reconciled.spentCents)}, comprometido ${formatBrl(reconciled.committedCents)}` +
          (reconciled.killSwitchEngaged ? ' [TRAVA ACIONADA]' : ''),
      );

      const ads = await syncAds(db, client, account.id, now);
      console.warn(
        `  ads: ${ads.ads} anúncios, ${ads.creatives} criativos` +
          (ads.disapproved > 0 ? `, ${ads.disapproved} REPROVADOS` : ''),
      );

      for (const level of ['campaign', 'ad_set', 'ad'] as const) {
        const result = await ingestMetrics(db, client, account.id, level, since, now);
        console.warn(
          `  métricas ${level.padEnd(8)}: ${result.rows} linhas desde ${since}, ` +
            `gasto ${formatBrl(result.spendCents)}, conversões ${result.conversions}`,
        );
      }

      const state = await getPeriodState(db, account.id, periodMonthOf(now));
      if (state) {
        console.warn(
          `  orçamento: teto ${formatBrl(state.capCents)}, utilizável ${formatBrl(state.usableCents)}, ` +
            `disponível ${formatBrl(state.availableCents)}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
