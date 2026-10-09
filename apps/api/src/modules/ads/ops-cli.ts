import { readFileSync } from 'node:fs';
import { campaignDraftSchema, type CampaignDraft } from '@wings/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { loadDotEnv } from '../../db/load-env.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaignSavedDrafts,
  employees,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createSpecOf, preflightChange, type PreflightResult } from './executor.js';
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
import { canPreflight } from './platform/types.js';
import { formatBrl } from './platform/money.js';
import { storageOf } from '../../lib/storage/index.js';

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
 *        --kind pause_campaign --reason "…" [--requested-by e-mail@wingscompany.com.br]
 *   node dist/modules/ads/ops-cli.js resolve-unknown --change <uuid>
 *   node dist/modules/ads/ops-cli.js release-kill-switch --account act_… --reason "…"
 *   node dist/modules/ads/ops-cli.js preflight-google --approval <uuid>
 *   node dist/modules/ads/ops-cli.js preflight-google --example
 *   node dist/modules/ads/ops-cli.js save-draft --file rascunho.json [--name "…"]
 *
 * `preflight-google` sends Google the exact request with `validateOnly`: the
 * real account checks it and nothing is created or changed. It works with the
 * write switch off. `--example` rehearses a built-in Search campaign, for a
 * dry run before there is any request.
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

        // Who asked, when a person did: shown as "Solicitado por" on the approval.
        const requesterEmail = arg('requested-by');
        const requester = requesterEmail
          ? await db.query.employees.findFirst({
              where: sql`lower(${employees.email}) = ${requesterEmail.trim().toLowerCase()}`,
            })
          : undefined;
        if (requesterEmail && !requester)
          throw new Error(`--requested-by: nenhum funcionário com o e-mail ${requesterEmail}`);
        const result = await requestCampaignChange(db, {
          requestedBy: requester?.id ?? null,
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

      case 'preflight-google': {
        const account = await db.query.adAccounts.findFirst({
          where: and(eq(adAccounts.platform, 'google'), isNull(adAccounts.archivedAt)),
        });
        if (!account) throw new Error('nenhuma conta Google Ads ativa neste ambiente');
        // Always a reader, whatever the write switch says: validateOnly never writes.
        const { client } = createPlatformClient({ ...env, ADS_WRITES_ENABLED: false }, account);
        if (!client) throw new Error('sem credenciais do Google para esta conta');
        if (!canPreflight(client)) throw new Error('este cliente não valida sem escrever');

        const approvalId = arg('approval');
        if (approvalId) {
          const approval = await db.query.adApprovalRequests.findFirst({
            where: eq(adApprovalRequests.id, approvalId),
          });
          if (!approval) throw new Error('aprovação não encontrada');
          const result = await preflightChange(db, client, approval.changeRequestId, {
            storage: storageOf({ env }),
          });
          printPreflight(result);
          if (!result.ok) process.exitCode = 1;
          return;
        }
        if (!arg('example') && !process.argv.includes('--example')) {
          throw new Error('informe --approval <uuid> ou --example');
        }
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
          new Date(),
        );
        const end = new Date(Date.now() + 14 * 86_400_000);
        const draft: CampaignDraft = campaignDraftSchema.parse({
          platform: 'google_search',
          name: `Ensaio validateOnly ${today}`,
          objective: 'lead',
          idealCustomerProfile:
            'Empresário dono de negócio próprio que quer expandir a marca por franquias.',
          reach: { states: ['SP'], cities: [], customLocations: [] },
          destinationUrl: 'https://wingscompany.com.br/',
          startDate: today,
          endDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(end),
          dailyBudgetCents: 2000,
          utms: {
            utm_source: 'google',
            utm_medium: 'cpc',
            utm_campaign: 'ensaio-validateonly',
            utm_content: 'lead',
          },
          startPaused: true,
          search: {
            adGroupName: 'Ensaio · grupo 1',
            keywords: [
              '[franquear minha empresa]',
              '"como franquear meu negócio"',
              '[expandir por franquias]',
            ],
            negativeKeywords: ['vaga', 'emprego', 'curso', 'grátis', 'pdf'],
            headlines: [
              'Franqueie o Seu Negócio',
              'Expansão por Franquias',
              'Consultoria de Franquias',
              'Wings Company',
            ],
            descriptions: [
              'Formatação de franquia com método próprio e acompanhamento da Wings.',
              'Fale com um consultor e veja se o seu negócio está pronto para franquear.',
            ],
          },
        });
        const spec = createSpecOf({
          name: draft.name,
          startPaused: true,
          dailyBudgetCents: draft.dailyBudgetCents,
          startDate: draft.startDate,
          endDate: draft.endDate,
          payload: draft,
        });
        const outcome = await client.validateWrite({ kind: 'create_campaign', spec });
        printPreflight(
          outcome.status === 'ok'
            ? { ok: true, ...outcome }
            : outcome.status === 'rejected'
              ? { ok: false, ...outcome }
              : { ok: false, ...outcome },
        );
        if (outcome.status !== 'ok') process.exitCode = 1;
        return;
      }

      case 'save-draft': {
        // Puts a campaign in the builder's "Rascunhos salvos": no request, no
        // approval, no WhatsApp, nothing reserved. Validated like a request.
        const raw = JSON.parse(readFileSync(required('file'), 'utf8')) as unknown;
        const draft = campaignDraftSchema.parse(raw);
        const [row] = await db
          .insert(adCampaignSavedDrafts)
          .values({ name: arg('name') ?? draft.name, platform: draft.platform, payload: draft })
          .returning({ id: adCampaignSavedDrafts.id });
        console.warn(
          `rascunho salvo: ${row?.id} — "${arg('name') ?? draft.name}" (${draft.platform})`,
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
          'comando desconhecido. Use: status | preflight | preflight-google | save-draft | alerts | request | resolve-unknown | release-kill-switch',
        );
    }
  } finally {
    await pool.end();
  }
}

function printPreflight(result: PreflightResult): void {
  switch (result.status) {
    case 'ok':
      console.warn(
        `validateOnly: o Google ACEITOU a solicitação inteira (${result.operations.length} operações). Nada foi escrito.\n` +
          result.operations.map((label) => `  - ${label}`).join('\n'),
      );
      return;
    case 'rejected':
      console.warn(
        `validateOnly: o Google RECUSOU — ${result.code}\n  ${result.message}\nNada foi escrito.`,
      );
      return;
    case 'unavailable':
      console.warn(`validateOnly: o Google não respondeu (${result.reason}). Nada foi validado.`);
      return;
    case 'refused':
      console.warn(`recusado antes de chamar o Google — ${result.reason}: ${result.message}`);
      return;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
