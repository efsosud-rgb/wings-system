import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import { loadEnv } from '../../env.js';
import { createApprovalNotifier } from './notifiers/factory.js';
import {
  accountOfChange,
  accountsStatus,
  openAlerts,
  releaseKillSwitchOnRecord,
  renderAlertsSheet,
  requestCampaignChange,
  resolveUnknownExecution,
  type ChangeKind,
} from './ops.js';
import { createPlatformClient } from './platform/factory.js';
import { formatBrl } from './platform/money.js';

/**
 * Operator commands for a supervised write session. See docs/ads/primeira-escrita.md.
 *
 * Nothing here writes to an ad platform. `request` only puts a change in front
 * of an approver; executing it stays a button a person presses.
 *
 *   node dist/modules/ads/ops-cli.js status
 *   node dist/modules/ads/ops-cli.js preflight [--expect-user <id na Meta>]
 *   node dist/modules/ads/ops-cli.js alerts
 *   node dist/modules/ads/ops-cli.js request --account act_… --campaign 1202… \
 *        --kind pause_campaign --reason "…"
 *   node dist/modules/ads/ops-cli.js resolve-unknown --change <uuid>
 *   node dist/modules/ads/ops-cli.js release-kill-switch --account act_… --reason "…"
 */

const KINDS: readonly ChangeKind[] = ['pause_campaign', 'resume_campaign', 'set_daily_budget'];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} é obrigatório`);
  return value;
}

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const command = process.argv[2];

  try {
    switch (command) {
      case 'status': {
        console.warn(
          `ADS_WRITES_ENABLED neste processo: ${env.ADS_WRITES_ENABLED ? 'LIGADO' : 'desligado'} ` +
            `(a API lê o próprio ambiente ao subir — confira também na tela da aprovação)`,
        );
        for (const account of await accountsStatus(db)) {
          const age =
            account.reconciledMinutesAgo === null
              ? 'NUNCA neste mês'
              : `há ${account.reconciledMinutesAgo} min`;
          console.warn(
            `\n${account.externalId} — ${account.name}\n` +
              `  trava: ${account.killSwitchEngaged ? `ACIONADA (${account.killSwitchReason ?? 'sem motivo'})` : 'livre'}\n` +
              `  reconciliação: ${age}${account.reconciliationFresh ? '' : ' [VELHA — execução será recusada]'}\n` +
              `  alterações: ${account.changes.pendingApproval} aguardando aprovação, ` +
              `${account.changes.approved} aprovadas sem executar, ` +
              `${account.changes.unknown} com resultado DESCONHECIDO`,
          );
        }
        return;
      }

      case 'preflight': {
        // Read-only. A write token without ads_management would otherwise be
        // discovered at the button, with everyone watching.
        if (!env.META_WRITE_TOKEN) throw new Error('META_WRITE_TOKEN não configurado');
        const response = await fetch('https://graph.facebook.com/v23.0/me/permissions', {
          headers: { Authorization: `Bearer ${env.META_WRITE_TOKEN}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`Meta respondeu ${response.status} ao ler as permissões`);
        const body = (await response.json()) as {
          data?: { permission: string; status: string }[];
        };
        const granted = new Set(
          (body.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission),
        );
        for (const permission of ['ads_read', 'ads_management']) {
          console.warn(`  ${permission}: ${granted.has(permission) ? 'concedida' : 'AUSENTE'}`);
        }
        if (!granted.has('ads_management')) {
          throw new Error('o token não tem ads_management — a Meta vai recusar qualquer escrita');
        }

        // Who the token belongs to. A token minted by a person dies when that
        // person loses access; one minted by a BM system user does not.
        const me = await fetch('https://graph.facebook.com/v23.0/me?fields=id', {
          headers: { Authorization: `Bearer ${env.META_WRITE_TOKEN}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!me.ok) throw new Error(`Meta respondeu ${me.status} ao ler o dono do token`);
        const owner = (await me.json()) as { id?: string };
        console.warn(`  dono do token (id na Meta): ${owner.id ?? 'desconhecido'}`);
        const expected = arg('expect-user');
        if (expected && owner.id !== expected) {
          throw new Error(`o token NÃO pertence ao usuário esperado (${expected})`);
        }
        if (expected) console.warn('  pertence ao usuário esperado');

        console.warn('token apto a escrever. Nada foi escrito.');
        return;
      }

      case 'alerts': {
        // The sheet goes to stdout so it can be redirected into a file.
        process.stdout.write(`${renderAlertsSheet(await openAlerts(db))}\n`);
        return;
      }

      case 'request': {
        const kind = required('kind') as ChangeKind;
        if (!KINDS.includes(kind)) throw new Error(`--kind deve ser um de: ${KINDS.join(', ')}`);
        const to = arg('to-cents');
        if (kind === 'set_daily_budget' && !to) {
          throw new Error('set_daily_budget exige --to-cents (orçamento diário em centavos)');
        }

        const result = await requestCampaignChange(db, {
          accountExternalId: required('account'),
          campaignExternalId: required('campaign'),
          kind,
          toDailyBudgetCents: to ? Number(to) : undefined,
          reason: required('reason'),
          notifier: createApprovalNotifier(env, db),
        });
        if (!result.ok) throw new Error(`recusado — ${result.message}`);

        console.warn(
          `solicitação criada: alteração ${result.value.changeRequestId}\n` +
            `  exposição no mês: ${formatBrl(result.value.exposureDeltaCents)}\n` +
            (result.value.approvalId
              ? `  aguardando aprovação: /marketing/trafego-pago-wings/aprovacoes/${result.value.approvalId}\n`
              : `  aprovada automaticamente pela política\n`) +
            `Nada foi enviado à plataforma.`,
        );
        return;
      }

      case 'resolve-unknown': {
        const changeId = required('change');
        const account = await accountOfChange(db, changeId);
        if (!account) throw new Error('alteração não encontrada');
        // Always a reader here, whatever the write switch says.
        const { client } = createPlatformClient({ ...env, ADS_WRITES_ENABLED: false }, account);
        if (!client) throw new Error('sem credenciais para ler esta conta');

        const result = await resolveUnknownExecution(db, client, changeId);
        if (!result.ok) throw new Error(`recusado — ${result.message}`);
        console.warn(
          `plataforma mostra: ${result.value.observed}\n` +
            `resolvido como: ${result.value.resolution === 'applied' ? 'APLICADA' : 'NÃO APLICADA (reserva devolvida)'}\n` +
            `A trava continua acionada. Libere com release-kill-switch quando estiver seguro.`,
        );
        return;
      }

      case 'release-kill-switch': {
        const result = await releaseKillSwitchOnRecord(db, {
          accountExternalId: required('account'),
          reason: required('reason'),
        });
        if (!result.ok) throw new Error(`recusado — ${result.message}`);
        console.warn(
          `trava liberada. Motivo anterior: ${result.value.previousReason ?? '(nenhum)'}\n` +
            `Se a causa persistir, a próxima ingestão aciona de novo.`,
        );
        return;
      }

      default:
        throw new Error(
          'comando desconhecido. Use: status | preflight | alerts | request | resolve-unknown | release-kill-switch',
        );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
