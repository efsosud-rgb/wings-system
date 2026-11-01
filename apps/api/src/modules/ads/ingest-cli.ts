import { createDb, type Database } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { getPeriodState } from './budget-guard.js';
import { runIngestionCycle, runReconciliationCycle } from './ingest-cycle.js';
import { createAlertNotifier } from './notifiers/factory.js';
import { activeAdAccounts, archiveAdAccount } from './metrics.js';
import { formatBrl } from './platform/money.js';
import { createPlatformClient } from './platform/factory.js';
import { CHANGE_REQUEST_MAX_AGE_HOURS, expireStaleChanges } from './expiry.js';
import { enforceReconciliationFreshness, periodMonthOf } from './reconcile.js';
import { seedAdAccount } from './seed-account.js';
import { WordPressClient } from '../../lib/wordpress.js';
import { syncBlogPosts } from '../site/blog-sync.js';
import { Ga4Client, ga4CredentialsOf } from '../../lib/ga4.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { syncCampaignLeads } from './campaign-leads-sync.js';
import { syncGa4Traffic, syncRdCrmDeals } from './funnel-sync.js';
import {
  followRdStages,
  rdOwnerAllowlist,
  importRdDeals,
  rdCrmReader,
  refreshStageTimes,
} from '../leads/rd-import.js';
import {
  accountRecordOf,
  finishIngestRun,
  INGEST_DEADLINE_MS,
  reconcileRecordOf,
  startIngestRun,
  type IngestKind,
  type IngestRunAccount,
  type IngestRunSite,
} from './ingest-runs.js';

/**
 * The job the Coolify scheduled tasks run — two of them, both read-only
 * against the platform, so a scheduling mistake costs nothing but API calls.
 *
 *   node dist/modules/ads/ingest-cli.js                 # full cycle: campaigns,
 *                                                        # ads, metrics, breakdowns,
 *                                                        # alerts, reconciliation
 *   node dist/modules/ads/ingest-cli.js --reconcile-only # fast cycle: balance,
 *                                                        # platform limit and
 *                                                        # campaign status only —
 *                                                        # the 15-min task
 *   node dist/modules/ads/ingest-cli.js --seed     # create the account row first
 *   node dist/modules/ads/ingest-cli.js --seed --account act_… --name "…" --cap 250000 --usable 70
 *   node dist/modules/ads/ingest-cli.js --seed --platform google --account 4268586278 \
 *        --name "…" --cap 250000 --usable 70       # --cap is in cents
 *   node dist/modules/ads/ingest-cli.js --days 30  # wider metrics window (full cycle only)
 *   node dist/modules/ads/ingest-cli.js --manual   # from a shell, not the scheduled task
 *   node dist/modules/ads/ingest-cli.js --archive act_… --reason "…"
 *
 * Every run writes a row to `ingest_runs` when it starts and when it ends, so
 * the dashboard can say when the last one of each kind was, what failed and
 * whether the scheduled one is overdue. The blog mirror (Canais próprios)
 * stays a step of the full cycle only, non-fatal there. Both cycles end with
 * the dead-man check (`enforceReconciliationFreshness`): the fast cycle keeps
 * accounts fresh on its own now, but the full cycle still checks too, in case
 * the fast task itself is what stopped running. Then old change requests
 * expire (`expireStaleChanges`), their reservations given back.
 */

/**
 * One cycle of each kind at a time. A session-level advisory lock on its own
 * connection: it dies with the process, so a run that is killed can never
 * leave the next one blocked. A second run that finds it taken leaves quietly.
 */
const LOCK_KEYS: Record<Exclude<IngestKind, 'youtube'>, number> = {
  full: 7_202_601,
  reconcile: 7_202_602,
};

/**
 * The run in progress, so a SIGTERM (a redeploy replacing the container) or
 * the deadline can close its row as failed instead of leaving it "running".
 */
let current: { runId: string; accounts: IngestRunAccount[] } | null = null;

/** Old requests expire at the end of every cycle; counts and ids only in the log. */
async function reportExpired(db: Database, now: Date): Promise<void> {
  const { expired, failed } = await expireStaleChanges(db, { now });
  for (const entry of failed) {
    console.error(`pedido ${entry.changeRequestId} NÃO expirou: ${entry.error}`);
  }
  for (const entry of expired) {
    console.warn(
      `pedido ${entry.changeRequestId} expirou (${entry.why === 'age' ? `mais de ${CHANGE_REQUEST_MAX_AGE_HOURS} h` : 'mês virou'}); reserva devolvida`,
    );
  }
}

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

    const kind: Exclude<IngestKind, 'youtube'> = flag('reconcile-only') ? 'reconcile' : 'full';
    const lockClient = await pool.connect();
    const locked = await lockClient.query<{ ok: boolean }>(
      'select pg_try_advisory_lock($1) as ok',
      [LOCK_KEYS[kind]],
    );
    if (!locked.rows[0]?.ok) {
      lockClient.release(true);
      console.warn(`já há uma ingestão (${kind}) em andamento; esta sai sem fazer nada`);
      return;
    }
    // Destroying the connection at the end frees the lock with it.
    const releaseLock = () => lockClient.release(true);

    const stop = async (reason: 'interrupted' | 'timeout') => {
      const run = current;
      current = null;
      if (run) {
        await finishIngestRun(db, run.runId, {
          status: 'failed',
          accounts: run.accounts,
          site: null,
          error: reason,
        }).catch(() => undefined);
      }
      console.error(reason === 'timeout' ? 'prazo da ingestão estourado' : 'ingestão interrompida');
      releaseLock();
      await pool.end().catch(() => undefined);
      process.exit(1);
    };
    const deadline = setTimeout(() => void stop('timeout'), INGEST_DEADLINE_MS[kind]);
    deadline.unref();
    process.once('SIGTERM', () => void stop('interrupted'));
    process.once('SIGINT', () => void stop('interrupted'));

    try {
      await cycle();
    } finally {
      clearTimeout(deadline);
      current = null;
      releaseLock();
    }
  } finally {
    await pool.end();
  }

  /** The cycle itself, inside the lock and the deadline. */
  async function cycle() {
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

    if (flag('reconcile-only')) {
      const runId = await startIngestRun(db, {
        trigger: flag('manual') ? 'manual_reconcile' : 'scheduled_reconcile',
        since,
        now,
      });
      const recorded: IngestRunAccount[] = [];
      current = { runId, accounts: recorded };

      const cycle = await runReconciliationCycle(db, accounts, {
        clientFor: (account) =>
          createPlatformClient({ ...env, ADS_WRITES_ENABLED: false }, account).client,
        now,
        onAccountDone: (result) => {
          recorded.push(reconcileRecordOf(result));
          console.warn(`${result.account.platform}:${result.account.externalId}`);
          if (result.status === 'skipped') {
            console.warn('  sem credenciais para esta conta — pulando');
            return;
          }
          if (result.status === 'failed') {
            console.error(`  FALHOU: ${result.error}`);
            return;
          }
          console.warn(
            `  reconcile: ${result.reconciled.campaignsSynced} campanhas, gasto ` +
              `${formatBrl(result.reconciled.spentCents)}, comprometido ` +
              `${formatBrl(result.reconciled.committedCents)}` +
              (result.reconciled.killSwitchEngaged ? ' [TRAVA ACIONADA]' : ''),
          );
        },
      });
      const failures = cycle.failed;

      await finishIngestRun(db, runId, {
        status: failures > 0 ? 'failed' : 'ok',
        accounts: recorded,
        site: null,
        error: failures > 0 ? `${failures} conta(s) falharam` : null,
      });

      const stale = await enforceReconciliationFreshness(db, { now });
      for (const entry of stale) {
        console.error(
          `TRAVA ACIONADA: conta ${entry.accountId} sem reconciliar há ${entry.ageMinutes} min ` +
            `— gasto real desconhecido. Libere com ops-cli release-kill-switch depois de verificar.`,
        );
      }
      await reportExpired(db, now);

      // Leads das Campanhas, after the statuses are fresh: counts only in the log. Without the RD
      // token only the Wings leads are read (RD is left alone).
      try {
        const leads = await syncCampaignLeads(db, {
          rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
          rdMarketing:
            env.RD_MKT_CLIENT_ID && env.RD_MKT_CLIENT_SECRET && env.RD_MKT_REFRESH_TOKEN
              ? {
                  clientId: env.RD_MKT_CLIENT_ID,
                  clientSecret: env.RD_MKT_CLIENT_SECRET,
                  refreshToken: env.RD_MKT_REFRESH_TOKEN,
                }
              : null,
          box: createSecretBox(env.CPF_ENCRYPTION_KEY),
          now,
        });
        console.warn(
          `leads das campanhas: ${leads.deals} negócio(s) do Funil Formatação, ` +
            `${leads.paired} ligado(s) a lead do Wings pelo contato, ` +
            `${leads.wingsLeads} lead(s) do Wings sem negócio, ` +
            `${leads.attributed} atribuído(s), ${leads.unattributed} sem atribuição, ` +
            `${leads.tests} de teste; UTM consultada ${leads.utmLookups}x (${leads.utmFailures} falha(s)); ${leads.leadsFilled} lead(s) ganharam a campanha`,
        );
      } catch (error) {
        console.error(
          `leads das campanhas: falhou (${error instanceof Error ? error.name : 'unknown'})`,
        );
      }

      if (failures > 0) {
        throw new Error(`${failures} conta(s) falharam neste ciclo de reconciliação — veja acima.`);
      }
      return;
    }

    const runId = await startIngestRun(db, {
      trigger: flag('manual') ? 'manual' : 'scheduled',
      since,
      now,
    });
    const recorded: IngestRunAccount[] = [];
    current = { runId, accounts: recorded };

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
        for (const level of Object.values(metrics)) {
          for (const warning of level.warnings) console.warn(`  AVISO: ${warning}`);
        }
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

    // After the click: the site's sessions (GA4) and the RD CRM deals, for the
    // funnel. Read only, each on its own, and never the cause of a failed run.
    const today = now.toISOString().slice(0, 10);
    const ga4Credentials = ga4CredentialsOf(env);
    if (env.GA4_PROPERTY_ID && ga4Credentials) {
      try {
        const ga4 = new Ga4Client({ propertyId: env.GA4_PROPERTY_ID, credentials: ga4Credentials });
        const read = await syncGa4Traffic(db, ga4, {
          propertyId: env.GA4_PROPERTY_ID,
          since,
          until: today,
          now,
        });
        console.warn(`\nga4: ${read.rows} linha(s), ${read.sessions} sessão(ões) desde ${since}`);
      } catch (error) {
        // The class and code only: a message could quote the request.
        console.error(
          `\nga4: falhou (${error instanceof Error ? `${error.name}${'code' in error ? ` ${String(error.code)}` : ''}` : 'unknown'})`,
        );
      }
    }
    if (env.RD_CRM_API_TOKEN) {
      try {
        const read = await syncRdCrmDeals(db, {
          token: env.RD_CRM_API_TOKEN,
          since: new Date(now.getTime() - 90 * 24 * 3600_000).toISOString().slice(0, 10),
          until: today,
          now,
        });
        console.warn(`rd crm: ${read.deals} negociação(ões) dos últimos 90 dias`);
        // CRM phase 1: the Funil follows RD — stages of the leads it has, the
        // deals of the last 3 days it lacks, and a few stage histories.
        if (env.CRM_RD_FOLLOW_ENABLED !== 'true') {
          console.warn('funil: seguimento do RD desligado (CRM_RD_FOLLOW_ENABLED)');
        } else
          try {
            const follow = await followRdStages(db, {
              deals: read.raw,
              pipelines: read.pipelines,
              ownerRdUserIds: rdOwnerAllowlist(env.CRM_RD_OWNER_USER_IDS),
            });
            const reader = rdCrmReader(env.RD_CRM_API_TOKEN);
            const imported = await importRdDeals(db, reader, {
              apply: true,
              since: new Date(now.getTime() - 3 * 24 * 3600_000),
              window: { since: new Date(now.getTime() - 3 * 24 * 3600_000), until: now },
              histories: true,
              onlyMissing: true,
              ownerRdUserIds: rdOwnerAllowlist(env.CRM_RD_OWNER_USER_IDS),
              // Only this hourly cycle: recent new deals with no owner join the rotation.
              distributeNew: true,
              batchId: `rd-crm-sync-${now.toISOString().replace(/[-:]/g, '').slice(0, 13)}Z`,
            });
            const times = await refreshStageTimes(db, reader, {
              pipelines: read.pipelines,
              limit: 40,
            });
            console.warn(
              `funil: ${follow.updated} lead(s) seguiram o RD (${follow.stageChanged} mudaram de etapa); ${imported.created} novo(s), ${imported.merged} ligado(s), ${imported.testDeals} de teste pulado(s); rodízio ${imported.rotation.assigned} com dono, ${imported.rotation.empty} sem dono; histórico ${times.read} lido(s), ${times.failed} falha(s)`,
            );
          } catch (error) {
            console.error(`funil: falhou (${error instanceof Error ? error.name : 'unknown'})`);
          }
      } catch (error) {
        console.error(`rd crm: falhou (${error instanceof Error ? error.name : 'unknown'})`);
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
    await reportExpired(db, new Date());

    if (failures > 0) {
      // Every account had its turn; now fail visibly so the scheduler shows it.
      throw new Error(`${failures} conta(s) falharam neste ciclo — veja acima.`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
