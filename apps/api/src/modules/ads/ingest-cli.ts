import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { getPeriodState } from './budget-guard.js';
import { runIngestionCycle } from './ingest-cycle.js';
import { createAlertNotifier } from './notifiers/factory.js';
import { activeAdAccounts, archiveAdAccount } from './metrics.js';
import { formatBrl } from './platform/money.js';
import { createPlatformClient } from './platform/factory.js';
import { enforceReconciliationFreshness, periodMonthOf } from './reconcile.js';
import { seedAdAccount } from './seed-account.js';
import { WordPressClient } from '../../lib/wordpress.js';
import { syncBlogPosts } from '../site/blog-sync.js';
import {
  accountRecordOf,
  finishIngestRun,
  startIngestRun,
  type IngestRunAccount,
  type IngestRunSite,
} from './ingest-runs.js';

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
 *   node dist/modules/ads/ingest-cli.js --manual   # from a shell, not the scheduled task
 *   node dist/modules/ads/ingest-cli.js --archive act_… --reason "…"
 *
 * Every run writes a row to `ingest_runs` when it starts and when it ends, so
 * the dashboard can say when the last ingestion was, what failed and whether
 * the scheduled one is overdue. The blog mirror (Canais próprios) is a step
 * of the same run, non-fatal: a site that does not answer never costs an ad
 * account its reconciliation.
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

    // Every active account, Meta and Google alike. A Google account only gets
    // a client when the environment is credentialed for that exact customer;
    // otherwise it is reported as skipped, like a Meta account without a token.
    const accounts = await activeAdAccounts(db);
    if (!accounts.some((account) => account.platform === 'meta')) {
      throw new Error('No active ad accounts configured. Run once with --seed --account act_…');
    }

    const runId = await startIngestRun(db, {
      trigger: flag('manual') ? 'manual' : 'scheduled',
      since,
      now,
    });
    const recorded: IngestRunAccount[] = [];

    // Each account is its own failure domain: one that throws is reported and
    // the rest are still served. See ingest-cycle.ts.
    const cycle = await runIngestionCycle(db, accounts, {
      // One client per account. Reusing a single client across accounts is how
      // one account's campaigns ended up filed under another.
      // Always a reader, even while the write switch is on for a supervised
      // session: this job has no business holding a client that can spend.
      clientFor: (account) =>
        createPlatformClient({ ...env, ADS_WRITES_ENABLED: false }, account).client,
      since,
      now,
      notifier: createAlertNotifier(env, db),
      onAccountDone: async (result) => {
        recorded.push(accountRecordOf(result));
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

        const { reconciled, ads, metrics, alerts, breakdowns, accountDay } = result;
        // What the token could not read, said once per cycle: the account is
        // fine, the field is "não disponível" until somebody grants it.
        for (const warning of accountDay.warnings) console.warn(`  AVISO: ${warning}`);
        for (const split of Object.values(breakdowns)) {
          if (split.unavailable) {
            console.warn(
              `  AVISO: quebra ${split.kind} não disponível para o token: ${split.error ?? ''}`,
            );
          }
        }
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
    const failures = cycle.failed;

    // The blog mirror for Canais próprios. Reads only; a failure is recorded
    // on the run and changes nothing else.
    let site: IngestRunSite | null = null;
    if (env.WORDPRESS_BASE_URL && env.WORDPRESS_USERNAME && env.WORDPRESS_APP_PASSWORD) {
      try {
        const synced = await syncBlogPosts(
          db,
          new WordPressClient({
            baseUrl: env.WORDPRESS_BASE_URL,
            username: env.WORDPRESS_USERNAME,
            applicationPassword: env.WORDPRESS_APP_PASSWORD,
          }),
          now,
        );
        site = { status: 'ok', posts: synced.posts };
        console.warn(`\nblog: ${synced.posts} post(s) espelhado(s)`);
      } catch (error) {
        site = { status: 'failed', error: error instanceof Error ? error.name : 'unknown' };
        console.error('\nblog: falhou ao espelhar os posts; o restante do ciclo não foi afetado');
      }
    }

    await finishIngestRun(db, runId, {
      status: failures > 0 ? 'failed' : 'ok',
      accounts: recorded,
      site,
      error: failures > 0 ? `${failures} conta(s) falharam` : null,
    });

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
