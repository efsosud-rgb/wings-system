import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { applyPlatformLimit, getPeriodState } from './budget-guard.js';
import { runIngestionCycle } from './ingest-cycle.js';
import { createAlertNotifier } from './notifiers/factory.js';
import { activeAdAccounts, archiveAdAccount } from './metrics.js';
import { createGoogleClient } from './platform/google-client.js';
import { formatBrl } from './platform/money.js';
import { createMetaClient } from './platform/factory.js';
import { enforceReconciliationFreshness, periodMonthOf } from './reconcile.js';
import { seedAdAccount } from './seed-account.js';

/**
 * The job the Coolify scheduled task runs.
 *
 * Read-only against the platform: it mirrors campaigns, ad sets, ads and
 * creatives, pulls daily performance, and reconciles spend. It never writes to
 * an ad platform, so a scheduling mistake costs nothing but API calls.
 *
 *   node dist/modules/ads/ingest-cli.js            # ingest everything
 *   node dist/modules/ads/ingest-cli.js --seed     # create the account row first
 *   node dist/modules/ads/ingest-cli.js --seed --account act_… --name "…" --cap 250000 --usable 70
 *   node dist/modules/ads/ingest-cli.js --seed --platform google --account 4268586278 \
 *        --name "…" --cap 250000 --usable 70       # --cap is in cents
 *   node dist/modules/ads/ingest-cli.js --days 30  # wider metrics window
 *   node dist/modules/ads/ingest-cli.js --archive act_… --reason "…"
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
    if (!env.META_WRITE_TOKEN) {
      // Fail loudly: a scheduled task that quietly does nothing is worse than
      // one that fails visibly.
      throw new Error('No Meta credentials configured — nothing to ingest.');
    }

    const archiveTarget = arg('archive');
    if (archiveTarget) {
      const reason = arg('reason');
      if (!reason) throw new Error('--archive requires --reason "…"');
      const result = await archiveAdAccount(db, archiveTarget, reason);
      if (!result) throw new Error(`conta ${archiveTarget} não encontrada`);
      console.warn(
        `arquivada ${archiveTarget}: ${result.alertsResolved} alerta(s) resolvido(s). ` +
          `Motivo: ${reason}\nNenhuma linha foi apagada — a conta some da ingestão, do cockpit e dos alertas.`,
      );
      return;
    }

    const now = new Date();
    const days = Number(arg('days') ?? 7);
    const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString().slice(0, 10);

    if (flag('seed')) {
      const seeded = await seedAdAccount(
        db,
        env,
        {
          platform: arg('platform'),
          account: arg('account'),
          name: arg('name'),
          cap: arg('cap'),
          usable: arg('usable'),
        },
        now,
      );
      console.warn(
        `seeded ${seeded.platform}:${seeded.externalId}: cap ${formatBrl(seeded.capCents)}, ` +
          `${seeded.usablePercent}% usable, period ${seeded.periodMonth}`,
      );
    }

    const accounts = await activeAdAccounts(db, 'meta');
    if (accounts.length === 0) {
      throw new Error('No active ad accounts configured. Run once with --seed --account act_…');
    }

    // Each account is its own failure domain: one that throws is reported and
    // the rest are still served. See ingest-cycle.ts.
    const cycle = await runIngestionCycle(db, accounts, {
      // One client per account. Reusing a single client across accounts is how
      // one account's campaigns ended up filed under another.
      // Always a reader, even while the write switch is on for a supervised
      // session: this job has no business holding a client that can spend.
      clientFor: (account) =>
        createMetaClient({ ...env, ADS_WRITES_ENABLED: false }, account.externalId).client,
      since,
      now,
      notifier: createAlertNotifier(env, db),
      onAccountDone: async (result) => {
        console.warn(`\n${result.account.platform}:${result.account.externalId}`);
        if (result.status === 'skipped') {
          console.warn('  sem credenciais para esta conta — pulando');
          return;
        }
        if (result.status === 'failed') {
          console.error(`  FALHOU em ${result.step}: ${result.error}`);
          console.error('  as demais contas seguem; esta fica sem reconciliar neste ciclo');
          return;
        }

        const { reconciled, ads, metrics, alerts } = result;
        console.warn(
          `  reconcile: ${reconciled.campaignsSynced} campanhas, ${reconciled.adSetsSynced} conjuntos, ` +
            `gasto ${formatBrl(reconciled.spentCents)}, comprometido ${formatBrl(reconciled.committedCents)}` +
            (reconciled.killSwitchEngaged ? ' [TRAVA ACIONADA]' : ''),
        );
        console.warn(
          `  ads: ${ads.ads} anúncios, ${ads.creatives} criativos` +
            (ads.disapproved > 0 ? `, ${ads.disapproved} REPROVADOS` : ''),
        );
        for (const level of ['campaign', 'ad_set', 'ad'] as const) {
          console.warn(
            `  métricas ${level.padEnd(8)}: ${metrics[level].rows} linhas desde ${since}, ` +
              `gasto ${formatBrl(metrics[level].spendCents)}, conversões ${metrics[level].conversions}`,
          );
        }
        console.warn(
          `  alertas: ${alerts.detected} detectados (${alerts.opened} novos, ${alerts.resolved} resolvidos), ` +
            `${alerts.notified} notificados` +
            (alerts.notificationErrors > 0 ? `, ${alerts.notificationErrors} FALHAS DE ENVIO` : ''),
        );

        const state = await getPeriodState(db, result.account.id, periodMonthOf(now));
        if (state) {
          console.warn(
            `  orçamento: teto ${formatBrl(state.capCents)}, utilizável ${formatBrl(state.usableCents)}, ` +
              `disponível ${formatBrl(state.availableCents)}`,
          );
          if (state.platformRemainingCents !== null) {
            const binding = state.platformRemainingCents < state.usableCents - state.committedCents;
            console.warn(
              `  plataforma: ainda permite ${formatBrl(state.platformRemainingCents)} ` +
                `(${state.platformLimitSource ?? 'fonte desconhecida'})` +
                (binding ? ' [TETO REAL — menor que o interno]' : ''),
            );
          }
        }
      },
    });
    let failures = cycle.failed;

    // Google: only the spending ceiling for now. Mirroring campaigns and
    // metrics from Google needs decisions this wave does not take.
    const googleClient = createGoogleClient(env);
    if (googleClient) {
      const googleAccounts = await activeAdAccounts(db, 'google');
      for (const account of googleAccounts) {
        try {
          const limit = await googleClient.getSpendLimit();
          await applyPlatformLimit(db, {
            adAccountId: account.id,
            periodMonth: periodMonthOf(now),
            limit,
            now,
          });
          console.warn(
            `\ngoogle:${account.externalId}\n  saldo/limite: ` +
              `${limit.remainingCents === null ? 'sem limite' : formatBrl(limit.remainingCents)} ` +
              `(${limit.source})`,
          );
        } catch (error) {
          failures += 1;
          console.error(
            `\ngoogle:${account.externalId}\n  FALHOU: ` +
              (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
          );
        }
      }
    }

    // Dead-man switch. Accounts served a moment ago are fresh by construction;
    // what this catches is the account that has been failing cycle after cycle
    // while the others carried on. It is frozen until a person looks.
    const stale = await enforceReconciliationFreshness(db);
    for (const entry of stale) {
      console.error(
        `\nTRAVA ACIONADA: conta ${entry.accountId} sem reconciliar há ${entry.ageMinutes} min ` +
          `— gasto real desconhecido. Libere com ops-cli release-kill-switch depois de verificar.`,
      );
    }

    if (failures > 0) {
      // Every account had its turn; now fail visibly so the scheduler shows it.
      throw new Error(`${failures} conta(s) falharam neste ciclo — veja acima.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
