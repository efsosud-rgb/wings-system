import {
  AD_PLATFORM_LABEL,
  AUDIT_CHECK_INFO,
  auditPriority,
  checkCopyCompliance,
  COMPLIANCE_RULE_LABEL,
  formatBrl,
  type AdPlatform,
  type AgentChangeProposal,
  type AuditCheck,
  type AuditCounts,
  type AuditFinding,
  type AuditLevel,
  type AuditPeriodComparison,
  type AuditRunSummary,
  type AuditScope,
  type AuditStatus,
  type CampaignNode,
  type ConversionsApiStatus,
  type DashboardWindow,
  type HealthItem,
  type HealthItemKey,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adAlerts,
  adApprovalRequests,
  adAuditFindings,
  adAuditRuns,
  adCampaigns,
  adChangeRequests,
  adCreatives,
  adMetricsDaily,
  employees,
} from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { writeAudit } from '../../lib/audit.js';
import { changeCard } from '../agent/tools.js';
import { conversionsApiStatus } from '../leads/meta-capi.js';
import { getPeriodState, reserveChange, type PeriodState } from './budget-guard.js';
import { accountHealth } from './dashboard/health.js';
import { activeAccounts, campaigns, latestAccountDays } from './dashboard/queries.js';
import { addDays, monthOf, windowOf } from './dashboard/window.js';

/**
 * Wings Ads Intelligence: the audit (docs/ads/intelligence.md).
 *
 * Reads our own mirror and nothing else: no platform call, no model, no cost.
 * `loadSnapshot` gathers what the checks need; `evaluateAudit` is a pure
 * function over it, so every rule is tested without a database; `runAudit`
 * stores the run. What already has a rule elsewhere is reused, never rewritten:
 * the campaign verdict and "Saúde da conta" of the Dashboard, the cockpit's
 * alerts, the builder's compliance rule and the budget guard's period.
 */

const brl = formatBrl;
/** A mirror older than this is stale: the ingest runs at least daily. */
const STALE_SYNC_HOURS = 26;
/** The executor refuses a write when the last reconciliation is older (travas.md). */
const RECONCILIATION_FRESH_MINUTES = 120;
const STALE_APPROVAL_HOURS = 48;
/** Committed against usable from which the month is tight. */
const TIGHT_BUDGET_RATIO = 0.9;
/** Campaign and ads disagree beyond this share of the spend (and R$ 1). */
const CONSISTENCY_TOLERANCE = 0.05;

export interface FindingDraft {
  check: AuditCheck;
  platform: AdPlatform | null;
  adAccountId: string | null;
  accountName: string | null;
  status: AuditStatus;
  impact: AuditLevel;
  confidence: AuditLevel;
  effort: AuditLevel;
  title: string;
  detail: string;
  recommendation: string;
  entity: AuditFinding['entity'];
  action: AgentChangeProposal | null;
}

export interface SnapshotAccount {
  id: string;
  platform: AdPlatform;
  name: string;
  externalId: string;
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  lastSyncedAt: Date | null;
  period: PeriodState | null;
}

export interface AuditSnapshot {
  now: Date;
  scope: AuditScope;
  days: number;
  accounts: SnapshotAccount[];
  campaigns: CampaignNode[];
  health: HealthItem[];
  alerts: {
    adAccountId: string;
    kind: string;
    severity: string;
    title: string;
    entityLevel: string | null;
    entityExternalId: string | null;
  }[];
  unknownChanges: Map<string, number>;
  staleApprovals: Map<string, number>;
  activeAds: {
    adAccountId: string;
    externalId: string;
    name: string;
    format: string | null;
    title: string | null;
    body: string | null;
  }[];
  consistency: {
    adAccountId: string;
    campaignExternalId: string;
    name: string;
    campaignCents: number;
    adsCents: number | null;
  }[];
  capi: ConversionsApiStatus;
  comparison: AuditPeriodComparison[];
}

const platformsOf = (scope: AuditScope): AdPlatform[] =>
  scope === 'all' ? ['meta', 'google'] : [scope];

type Levels = Pick<FindingDraft, 'impact' | 'confidence' | 'effort'>;
const levels = (impact: AuditLevel, confidence: AuditLevel, effort: AuditLevel): Levels => ({
  impact,
  confidence,
  effort,
});

const HEALTH_CHECK: Record<HealthItemKey, { check: AuditCheck; levels: Levels }> = {
  conversions_measuring: { check: 'conversion_source', levels: levels('high', 'high', 'medium') },
  active_without_results: {
    check: 'active_without_results',
    levels: levels('high', 'high', 'low'),
  },
  spend_pacing: { check: 'spend_pacing', levels: levels('medium', 'high', 'low') },
  creative_fatigue: { check: 'creative_fatigue', levels: levels('medium', 'medium', 'medium') },
};

const HEALTH_STATUS: Record<HealthItem['state'], AuditStatus> = {
  ok: 'pass',
  attention: 'warn',
  problem: 'fail',
  unknown: 'unknown',
};

const ALERT_CHECK: Record<string, { check: AuditCheck; status: AuditStatus; levels: Levels }> = {
  ad_rejected: { check: 'ad_policy', status: 'fail', levels: levels('high', 'high', 'medium') },
  quality_below_average: {
    check: 'campaign_performance',
    status: 'warn',
    levels: levels('medium', 'medium', 'medium'),
  },
  conversion_silence: {
    check: 'conversion_source',
    status: 'fail',
    levels: levels('high', 'medium', 'medium'),
  },
  meta_ad_without_utms: {
    check: 'tracking_utms',
    status: 'warn',
    levels: levels('medium', 'high', 'low'),
  },
  google_campaign_own_suffix: {
    check: 'tracking_utms',
    status: 'warn',
    levels: levels('medium', 'high', 'low'),
  },
};

const ALERT_ADVICE: Record<string, string> = {
  ad_rejected:
    'Leia o motivo da reprovação no Cockpit, corrija o texto ou a imagem e peça revisão no Gerenciador.',
  quality_below_average:
    'Teste um criativo novo no conjunto (Anúncios com IA gera as variações); mantenha o atual até o novo provar melhor.',
  conversion_silence:
    'Confira se o pixel ou a tag ainda disparam: abra a página e veja o evento no Gerenciador de Eventos.',
  meta_ad_without_utms:
    'Inclua as UTMs no link do anúncio: sem elas o lead chega ao CRM sem campanha.',
  google_campaign_own_suffix: 'Remova o sufixo próprio da campanha para ela herdar o da conta.',
};

export function evaluateAudit(s: AuditSnapshot): FindingDraft[] {
  const platforms = platformsOf(s.scope);
  const accounts = s.accounts.filter((account) => platforms.includes(account.platform));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountByExternal = new Map(
    accounts.map((account) => [`${account.platform}:${account.externalId}`, account]),
  );
  const out: FindingDraft[] = [];
  const push = (
    draft: Omit<FindingDraft, 'adAccountId' | 'accountName' | 'entity' | 'action'> &
      Partial<FindingDraft>,
  ) => out.push({ adAccountId: null, accountName: null, entity: null, action: null, ...draft });
  const forAccount = (account: SnapshotAccount) => ({
    platform: account.platform,
    adAccountId: account.id,
    accountName: account.name,
  });

  for (const platform of platforms) {
    if (!accounts.some((account) => account.platform === platform)) {
      push({
        check: 'data_freshness',
        platform,
        status: 'unknown',
        ...levels('high', 'high', 'medium'),
        title: `Nenhuma conta ${AD_PLATFORM_LABEL[platform]} conectada`,
        detail: 'Sem conta espelhada, nada desta plataforma pode ser auditado.',
        recommendation: 'Conecte a conta em Administração → Integrações e rode a ingestão.',
      });
    }
  }

  // --- per account: freshness, money, operations, consistency ------------------
  for (const account of accounts) {
    const own = forAccount(account);
    const ageHours = account.lastSyncedAt
      ? (s.now.getTime() - account.lastSyncedAt.getTime()) / 3_600_000
      : null;
    const reconciledMinutes = account.period?.lastReconciledAt
      ? (s.now.getTime() - account.period.lastReconciledAt.getTime()) / 60_000
      : null;
    if (ageHours === null || ageHours > STALE_SYNC_HOURS) {
      push({
        check: 'data_freshness',
        ...own,
        status: 'fail',
        ...levels('high', 'high', 'low'),
        title: `${account.name}: dados desatualizados`,
        detail:
          ageHours === null
            ? 'A conta nunca foi espelhada: nenhuma campanha tem data de leitura.'
            : `A última leitura das campanhas foi há ${Math.round(ageHours)} horas (limite: ${STALE_SYNC_HOURS}).`,
        recommendation:
          'Veja no Dashboard → Visão geral se a ingestão está falhando e em qual etapa.',
      });
    } else if (reconciledMinutes === null || reconciledMinutes > RECONCILIATION_FRESH_MINUTES) {
      push({
        check: 'data_freshness',
        ...own,
        status: 'warn',
        ...levels('medium', 'high', 'low'),
        title: `${account.name}: reconciliação do orçamento atrasada`,
        detail:
          reconciledMinutes === null
            ? 'O período do mês nunca foi reconciliado com a plataforma.'
            : `A última reconciliação foi há ${Math.round(reconciledMinutes)} minutos (limite: ${RECONCILIATION_FRESH_MINUTES}).`,
        recommendation:
          'Enquanto isso o executor recusa qualquer alteração aprovada; rode a reconciliação (ingest-cli --reconcile-only).',
      });
    } else {
      push({
        check: 'data_freshness',
        ...own,
        status: 'pass',
        ...levels('medium', 'high', 'low'),
        title: `${account.name}: dados atualizados`,
        detail: `Campanhas lidas há ${Math.round(ageHours)} h; reconciliação há ${Math.round(reconciledMinutes)} min.`,
        recommendation: '',
      });
    }

    const period = account.period;
    if (account.killSwitchEngaged) {
      push({
        check: 'budget_headroom',
        ...own,
        status: 'fail',
        ...levels('high', 'high', 'medium'),
        title: `${account.name}: trava da conta acionada`,
        detail: `Nenhum pedido nem execução sai desta conta. Motivo registrado: ${account.killSwitchReason ?? 'não informado'}.`,
        recommendation:
          'A trava só é liberada por uma pessoa (ops-cli release-kill-switch), depois de resolver a causa.',
      });
    } else if (!period) {
      push({
        check: 'budget_headroom',
        ...own,
        status: 'fail',
        ...levels('high', 'high', 'low'),
        title: `${account.name}: sem teto aberto para o mês`,
        detail: 'Sem o período do mês, o guardião recusa qualquer pedido de verba ou pausa.',
        recommendation: 'Abra o teto do mês em Dashboard → Configurações.',
      });
    } else {
      const ratio = period.usableCents > 0 ? period.committedCents / period.usableCents : 1;
      const figures = `Comprometido ${brl(period.committedCents)} de ${brl(period.usableCents)} utilizáveis (teto ${brl(period.capCents)}); gasto ${brl(period.spentCents)}; disponível ${brl(period.availableCents)}.`;
      push({
        check: 'budget_headroom',
        ...own,
        status: ratio >= TIGHT_BUDGET_RATIO ? 'warn' : 'pass',
        ...levels('medium', 'high', 'low'),
        title:
          ratio >= TIGHT_BUDGET_RATIO
            ? `${account.name}: teto do mês quase todo comprometido`
            : `${account.name}: teto do mês com folga`,
        detail: figures,
        recommendation:
          ratio >= TIGHT_BUDGET_RATIO
            ? 'Novas campanhas e aumentos de verba tendem a ser recusados pelo guardião; reveja o plano antes de pedir.'
            : '',
      });
    }

    const unknown = s.unknownChanges.get(account.id) ?? 0;
    const stale = s.staleApprovals.get(account.id) ?? 0;
    push({
      check: 'pending_operations',
      ...own,
      status: unknown > 0 ? 'fail' : stale > 0 ? 'warn' : 'pass',
      ...(unknown > 0 ? levels('high', 'high', 'medium') : levels('low', 'high', 'low')),
      title:
        unknown > 0
          ? `${account.name}: ${unknown} alteração(ões) com resultado desconhecido`
          : stale > 0
            ? `${account.name}: ${stale} pedido(s) esperando aprovação há mais de ${STALE_APPROVAL_HOURS} h`
            : `${account.name}: nenhuma operação pendente`,
      detail:
        unknown > 0
          ? 'O sistema não sabe se a plataforma aplicou a alteração; nada é repetido sozinho.'
          : stale > 0
            ? 'Pedidos antigos ocupam espaço reservado no teto do mês.'
            : 'Sem pedidos parados nem resultados desconhecidos.',
      recommendation:
        unknown > 0
          ? 'Resolva lendo a plataforma: ops-cli resolve-unknown (nunca reexecute).'
          : stale > 0
            ? 'Decida em Aprovações: aprovar ou recusar libera o teto.'
            : '',
    });

    const rows = s.consistency.filter((row) => row.adAccountId === account.id);
    const comparable = rows.filter((row) => row.adsCents !== null);
    const mismatched = comparable.filter((row) => {
      const diff = Math.abs(row.campaignCents - (row.adsCents ?? 0));
      return diff > 100 && diff > row.campaignCents * CONSISTENCY_TOLERANCE;
    });
    for (const row of mismatched) {
      push({
        check: 'data_consistency',
        ...own,
        status: 'warn',
        ...levels('low', 'medium', 'low'),
        title: `${row.name}: gasto da campanha não bate com o dos anúncios`,
        detail: `No período, a campanha soma ${brl(row.campaignCents)} e os anúncios ${brl(row.adsCents ?? 0)}.`,
        recommendation:
          'Os números da plataforma podem estar sendo revisados; se continuar após a próxima ingestão, compare no Gerenciador.',
        entity: { level: 'campaign', externalId: row.campaignExternalId, name: row.name },
      });
    }
    if (mismatched.length === 0) {
      push({
        check: 'data_consistency',
        ...own,
        status: comparable.length > 0 ? 'pass' : 'unknown',
        ...levels('low', 'medium', 'low'),
        title:
          comparable.length > 0
            ? `${account.name}: gasto por campanha e por anúncio conferem`
            : `${account.name}: sem números por anúncio para conferir`,
        detail:
          comparable.length > 0
            ? `${comparable.length} campanha(s) conferida(s), diferença dentro de ${CONSISTENCY_TOLERANCE * 100}%.`
            : 'A ingestão não gravou números por anúncio no período.',
        recommendation: '',
      });
    }
  }

  // --- the Dashboard's "Saúde da conta" -------------------------------------------
  for (const item of s.health) {
    if (!platforms.includes(item.platform)) continue;
    const mapped = HEALTH_CHECK[item.key];
    push({
      check: mapped.check,
      platform: item.platform,
      status: HEALTH_STATUS[item.state],
      ...mapped.levels,
      title: `${AUDIT_CHECK_INFO[mapped.check].label} (${AD_PLATFORM_LABEL[item.platform]})`,
      detail: item.detail,
      recommendation: item.action,
    });
  }

  // --- campaign verdicts --------------------------------------------------------------
  for (const platform of platforms) {
    const nodes = s.campaigns.filter(
      (node) => node.platform === platform && !node.ended && node.totals.spendCents > 0,
    );
    let positives = 0;
    let withoutTarget = 0;
    for (const node of nodes) {
      const account = accountByExternal.get(`${platform}:${node.accountExternalId}`);
      const verdict = node.verdict.verdict;
      if (verdict === 'positive') positives += 1;
      if (verdict === 'no_target') withoutTarget += 1;
      if (verdict !== 'negative' && verdict !== 'attention') continue;
      const reasons = node.verdict.reasons
        .filter((reason) => reason.state === 'bad' || reason.state === 'neutral')
        .map((reason) => reason.text)
        .join(' ');
      const detail =
        `${brl(node.totals.spendCents)} em ${s.days} dias, ${node.totals.conversions} resultado(s). ${reasons}`.trim();
      const pause: AgentChangeProposal | null =
        verdict === 'negative' && node.status === 'ACTIVE'
          ? {
              kind: 'pause_campaign',
              campaignExternalId: node.externalId,
              justification: `Auditoria: veredito negativo em ${s.days} dias. ${detail}`.slice(
                0,
                600,
              ),
              evidence: [
                { label: `Gasto, ${s.days} dias`, value: brl(node.totals.spendCents) },
                { label: `Resultados, ${s.days} dias`, value: String(node.totals.conversions) },
              ],
            }
          : null;
      push({
        check: 'campaign_performance',
        platform,
        adAccountId: account?.id ?? null,
        accountName: node.accountName,
        status: verdict === 'negative' ? 'fail' : 'warn',
        ...(verdict === 'negative'
          ? levels('high', 'high', 'low')
          : levels('medium', 'medium', 'medium')),
        title: `${node.name}: desempenho ${verdict === 'negative' ? 'negativo' : 'em atenção'}`,
        detail,
        recommendation: pause
          ? 'Pausar até revisar criativo e público. O pedido passa pelo guardião e pela aprovação.'
          : 'Revise criativo, público e lance antes de aumentar a verba.',
        entity: { level: 'campaign', externalId: node.externalId, name: node.name },
        action: pause,
      });
    }
    if (nodes.length > 0 && positives + withoutTarget > 0) {
      push({
        check: 'campaign_performance',
        platform,
        status: withoutTarget > 0 ? 'unknown' : 'pass',
        ...levels('medium', 'medium', 'low'),
        title:
          withoutTarget > 0
            ? `${withoutTarget} campanha(s) ${AD_PLATFORM_LABEL[platform]} sem meta de CPL`
            : `${positives} campanha(s) ${AD_PLATFORM_LABEL[platform]} com veredito positivo`,
        detail: `${nodes.length} campanha(s) com gasto no período; ${positives} positiva(s), ${withoutTarget} sem meta.`,
        recommendation:
          withoutTarget > 0
            ? 'Confirme a meta de CPL em Dashboard → Configurações: sem ela o veredito não julga leads.'
            : '',
      });
    }
  }

  // --- cockpit alerts -----------------------------------------------------------------
  const seenChecks = new Set<string>();
  for (const alert of s.alerts) {
    const account = accountById.get(alert.adAccountId);
    const mapped = ALERT_CHECK[alert.kind];
    if (!account || !mapped) continue;
    seenChecks.add(`${account.platform}:${mapped.check}`);
    push({
      check: mapped.check,
      ...forAccount(account),
      status: alert.severity === 'critical' ? 'fail' : mapped.status,
      ...mapped.levels,
      title: alert.title,
      detail: `Alerta aberto no Cockpit (${alert.kind}).`,
      recommendation: ALERT_ADVICE[alert.kind] ?? '',
      entity:
        alert.entityExternalId && (alert.entityLevel === 'ad' || alert.entityLevel === 'campaign')
          ? { level: alert.entityLevel, externalId: alert.entityExternalId, name: alert.title }
          : null,
    });
  }
  for (const platform of platforms) {
    if (!accounts.some((account) => account.platform === platform)) continue;
    for (const check of ['ad_policy', 'tracking_utms'] as const) {
      if (seenChecks.has(`${platform}:${check}`)) continue;
      push({
        check,
        platform,
        status: 'pass',
        ...levels('medium', 'high', 'low'),
        title: `${AUDIT_CHECK_INFO[check].label} (${AD_PLATFORM_LABEL[platform]})`,
        detail: 'Nenhum alerta aberto no Cockpit.',
        recommendation: '',
      });
    }
  }

  // --- the words and formats of the ads running -----------------------------------------
  for (const platform of platforms) {
    const ads = s.activeAds.filter((ad) => accountById.get(ad.adAccountId)?.platform === platform);
    if (!accounts.some((account) => account.platform === platform)) continue;
    let flagged = 0;
    for (const ad of ads) {
      const text = [ad.title, ad.body].filter(Boolean).join('\n');
      const problems = text ? checkCopyCompliance(text) : [];
      if (problems.length === 0) continue;
      flagged += 1;
      const account = accountById.get(ad.adAccountId);
      push({
        check: 'copy_compliance',
        ...(account ? forAccount(account) : { platform }),
        status: 'warn',
        ...levels('medium', 'medium', 'low'),
        title: `${ad.name}: texto com promessa de ganho`,
        detail: problems
          .map((problem) => `${COMPLIANCE_RULE_LABEL[problem.rule]}: "${problem.excerpt}"`)
          .join('; '),
        recommendation:
          'A plataforma pode reprovar e a promessa expõe a empresa. Gere um texto novo em "Anúncios com IA" e troque o anúncio.',
        entity: { level: 'ad', externalId: ad.externalId, name: ad.name },
      });
    }
    const withText = ads.filter((ad) => ad.title || ad.body).length;
    if (flagged === 0) {
      push({
        check: 'copy_compliance',
        platform,
        status: withText > 0 ? 'pass' : 'unknown',
        ...levels('medium', 'medium', 'low'),
        title: `${AUDIT_CHECK_INFO.copy_compliance.label} (${AD_PLATFORM_LABEL[platform]})`,
        detail:
          withText > 0
            ? `${withText} anúncio(s) ativo(s) lido(s), nenhum com promessa de ganho.`
            : 'Nenhum anúncio ativo com texto espelhado para ler.',
        recommendation: '',
      });
    }

    if (platform === 'meta') {
      const formats = new Set(
        ads.map((ad) => ad.format).filter((format) => format && format !== 'unknown'),
      );
      push({
        check: 'creative_diversity',
        platform,
        status:
          ads.length === 0
            ? 'not_applicable'
            : ads.length >= 3 && formats.size <= 1
              ? 'warn'
              : 'pass',
        ...levels('low', 'medium', 'medium'),
        title: AUDIT_CHECK_INFO.creative_diversity.label,
        detail:
          ads.length === 0
            ? 'Nenhum anúncio ativo.'
            : `${ads.length} anúncio(s) ativo(s) em ${formats.size} formato(s): ${[...formats].join(', ') || 'não informado'}.`,
        recommendation:
          ads.length >= 3 && formats.size <= 1
            ? 'Teste outro formato (vídeo curto, carrossel ou imagem) no mesmo conjunto.'
            : '',
      });
    }
  }

  // --- Meta's Conversions API -------------------------------------------------------------
  if (platforms.includes('meta')) {
    const capi = s.capi;
    const sent = capi.last7Days.sent;
    push({
      check: 'conversions_api',
      platform: 'meta',
      status: !capi.enabled
        ? 'fail'
        : capi.last7Days.failed > 0
          ? 'warn'
          : sent > 0
            ? 'pass'
            : 'unknown',
      ...levels('high', 'high', 'medium'),
      title: !capi.enabled
        ? 'API de Conversões da Meta desligada'
        : capi.last7Days.failed > 0
          ? 'API de Conversões com envios falhando'
          : sent > 0
            ? 'API de Conversões enviando o evento Lead'
            : 'API de Conversões ligada, sem envio nos últimos 7 dias',
      detail: !capi.enabled
        ? 'O Lead do site chega à Meta só pelo navegador, e bloqueadores e o iOS escondem parte deles. É a principal recomendação da Meta para esta conta.'
        : `Últimos 7 dias: ${sent} enviado(s), ${capi.last7Days.skipped} ignorado(s), ${capi.last7Days.failed} com falha${capi.lastError ? ` (último erro: ${capi.lastError})` : ''}.`,
      recommendation: !capi.enabled
        ? 'Siga docs/ads/conversions-api.md: gerar o token do pixel, ligar META_CAPI_ENABLED na API e no worker, testar com o código de teste e mandar o event_id no GTM.'
        : capi.last7Days.failed > 0
          ? 'Confira o token e o pixel no worker (o erro mostra só o código da Meta).'
          : '',
    });
  }

  return out;
}

/** Everything `evaluateAudit` reads, from our tables only. */
export async function loadSnapshot(
  db: Database,
  env: Env,
  input: { scope: AuditScope; days: DashboardWindow; now: Date },
): Promise<AuditSnapshot> {
  const { now } = input;
  const platforms = platformsOf(input.scope);
  const all = await activeAccounts(db);
  const accounts = all.filter((account) => platforms.includes(account.platform as AdPlatform));
  const ids = accounts.map((account) => account.id);
  const window = windowOf(input.days, now);
  const previousSince = addDays(window.since, -input.days);
  const month = monthOf(now);
  // An empty list reads as `false` in drizzle: no account, no rows.
  const inAccounts = (column: Parameters<typeof inArray>[0]) => inArray(column, ids);

  const [
    periods,
    synced,
    tree,
    latest,
    alerts,
    unknown,
    stale,
    activeAds,
    consistency,
    comparison,
    capi,
  ] = await Promise.all([
    Promise.all(ids.map((id) => getPeriodState(db, id, month.periodMonth))),
    db
      .select({
        id: adCampaigns.adAccountId,
        at: sql<Date | null>`max(${adCampaigns.lastSyncedAt})`,
      })
      .from(adCampaigns)
      .where(inAccounts(adCampaigns.adAccountId))
      .groupBy(adCampaigns.adAccountId),
    campaigns(db, input.days, now),
    latestAccountDays(db, ids),
    db
      .select({
        adAccountId: adAlerts.adAccountId,
        kind: adAlerts.kind,
        severity: adAlerts.severity,
        title: adAlerts.title,
        entityLevel: adAlerts.entityLevel,
        entityExternalId: adAlerts.entityExternalId,
      })
      .from(adAlerts)
      .where(and(inAccounts(adAlerts.adAccountId), sql`${adAlerts.resolvedAt} is null`)),
    db
      .select({ id: adChangeRequests.adAccountId, count: sql<string>`count(*)` })
      .from(adChangeRequests)
      .where(and(inAccounts(adChangeRequests.adAccountId), eq(adChangeRequests.status, 'unknown')))
      .groupBy(adChangeRequests.adAccountId),
    db
      .select({ id: adChangeRequests.adAccountId, count: sql<string>`count(*)` })
      .from(adChangeRequests)
      .where(
        and(
          inAccounts(adChangeRequests.adAccountId),
          eq(adChangeRequests.status, 'pending_approval'),
          lt(
            adChangeRequests.createdAt,
            new Date(now.getTime() - STALE_APPROVAL_HOURS * 3_600_000),
          ),
        ),
      )
      .groupBy(adChangeRequests.adAccountId),
    db
      .select({
        adAccountId: adAds.adAccountId,
        externalId: adAds.externalId,
        name: adAds.name,
        format: adCreatives.format,
        title: adCreatives.title,
        body: adCreatives.body,
      })
      .from(adAds)
      .innerJoin(adCampaigns, eq(adCampaigns.id, adAds.campaignId))
      .leftJoin(
        adCreatives,
        and(
          eq(adCreatives.adAccountId, adAds.adAccountId),
          eq(adCreatives.externalId, adAds.creativeExternalId),
        ),
      )
      .where(
        and(
          inAccounts(adAds.adAccountId),
          eq(adAds.status, 'ACTIVE'),
          eq(adCampaigns.status, 'ACTIVE'),
        ),
      ),
    db
      .select({
        adAccountId: adMetricsDaily.adAccountId,
        campaignExternalId: adCampaigns.externalId,
        name: adCampaigns.name,
        campaignCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}) filter (where ${adMetricsDaily.level} = 'campaign'), 0)`,
        adsCents: sql<
          string | null
        >`sum(${adMetricsDaily.spendCents}) filter (where ${adMetricsDaily.level} = 'ad')`,
      })
      .from(adMetricsDaily)
      .innerJoin(adCampaigns, eq(adCampaigns.id, adMetricsDaily.campaignId))
      .where(
        and(
          inAccounts(adMetricsDaily.adAccountId),
          gte(adMetricsDaily.day, window.since),
          lte(adMetricsDaily.day, window.until),
        ),
      )
      .groupBy(adMetricsDaily.adAccountId, adCampaigns.externalId, adCampaigns.name),
    db
      .select({
        platform: adAccounts.platform,
        current: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}) filter (where ${adMetricsDaily.day} >= ${window.since}), 0)`,
        currentConversions: sql<string>`coalesce(sum(${adMetricsDaily.conversions}) filter (where ${adMetricsDaily.day} >= ${window.since}), 0)`,
        currentClicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}) filter (where ${adMetricsDaily.day} >= ${window.since}), 0)`,
        currentImpressions: sql<string>`coalesce(sum(${adMetricsDaily.impressions}) filter (where ${adMetricsDaily.day} >= ${window.since}), 0)`,
        previous: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}) filter (where ${adMetricsDaily.day} < ${window.since}), 0)`,
        previousConversions: sql<string>`coalesce(sum(${adMetricsDaily.conversions}) filter (where ${adMetricsDaily.day} < ${window.since}), 0)`,
        previousClicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}) filter (where ${adMetricsDaily.day} < ${window.since}), 0)`,
        previousImpressions: sql<string>`coalesce(sum(${adMetricsDaily.impressions}) filter (where ${adMetricsDaily.day} < ${window.since}), 0)`,
      })
      .from(adMetricsDaily)
      .innerJoin(adAccounts, eq(adAccounts.id, adMetricsDaily.adAccountId))
      .where(
        and(
          inAccounts(adMetricsDaily.adAccountId),
          eq(adMetricsDaily.level, 'campaign'),
          gte(adMetricsDaily.day, previousSince),
          lte(adMetricsDaily.day, window.until),
        ),
      )
      .groupBy(adAccounts.platform),
    conversionsApiStatus(db, env, now),
  ]);

  const syncedById = new Map(synced.map((row) => [row.id, row.at ? new Date(row.at) : null]));
  const health = await accountHealth(db, accounts, latest, now);
  const cpl = (cents: number, conversions: number) =>
    conversions > 0 ? Math.round(cents / conversions) : null;

  return {
    now,
    scope: input.scope,
    days: input.days,
    accounts: accounts.map((account, index) => ({
      id: account.id,
      platform: account.platform as AdPlatform,
      name: account.name,
      externalId: account.externalId,
      killSwitchEngaged: account.killSwitchEngaged,
      killSwitchReason: account.killSwitchReason,
      lastSyncedAt: syncedById.get(account.id) ?? null,
      period: periods[index] ?? null,
    })),
    campaigns: tree.campaigns,
    health,
    alerts,
    unknownChanges: new Map(unknown.map((row) => [row.id, Number(row.count)])),
    staleApprovals: new Map(stale.map((row) => [row.id, Number(row.count)])),
    activeAds,
    consistency: consistency.map((row) => ({
      ...row,
      campaignCents: Number(row.campaignCents),
      adsCents: row.adsCents === null ? null : Number(row.adsCents),
    })),
    capi,
    comparison: comparison.map((row) => {
      const current = {
        spendCents: Number(row.current),
        conversions: Number(row.currentConversions),
        clicks: Number(row.currentClicks),
        impressions: Number(row.currentImpressions),
      };
      const previous = {
        spendCents: Number(row.previous),
        conversions: Number(row.previousConversions),
        clicks: Number(row.previousClicks),
        impressions: Number(row.previousImpressions),
      };
      return {
        platform: row.platform as AdPlatform,
        current,
        previous,
        currentCplCents: cpl(current.spendCents, current.conversions),
        previousCplCents: cpl(previous.spendCents, previous.conversions),
      };
    }),
  };
}

const countsOf = (drafts: { status: AuditStatus }[]): AuditCounts => {
  const counts: AuditCounts = { fail: 0, warn: 0, pass: 0, unknown: 0, not_applicable: 0 };
  for (const draft of drafts) counts[draft.status] += 1;
  return counts;
};

/** Runs one audit and stores it with its findings, ordered by priority. */
export async function runAudit(
  db: Database,
  env: Env,
  input: { scope: AuditScope; days: DashboardWindow; requestedBy: string; ip?: string; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const window = windowOf(input.days, now);
  const snapshot = await loadSnapshot(db, env, { scope: input.scope, days: input.days, now });
  const drafts = evaluateAudit(snapshot)
    .map((draft) => ({ draft, priority: auditPriority(draft) }))
    .sort((a, b) => b.priority - a.priority);

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(adAuditRuns)
      .values({
        scope: input.scope,
        days: input.days,
        since: window.since,
        until: window.until,
        status: 'completed',
        counts: countsOf(drafts.map((item) => item.draft)),
        comparison: snapshot.comparison,
        requestedBy: input.requestedBy,
        createdAt: now,
      })
      .returning({ id: adAuditRuns.id });
    if (!run) throw new Error('audit run not stored');
    if (drafts.length > 0) {
      await tx.insert(adAuditFindings).values(
        drafts.map(({ draft, priority }) => ({
          runId: run.id,
          adAccountId: draft.adAccountId,
          check: draft.check,
          platform: draft.platform,
          status: draft.status,
          impact: draft.impact,
          confidence: draft.confidence,
          effort: draft.effort,
          priority,
          title: draft.title.slice(0, 300),
          detail: draft.detail.slice(0, 2000),
          recommendation: draft.recommendation.slice(0, 1000),
          entityLevel: draft.entity?.level ?? null,
          entityExternalId: draft.entity?.externalId ?? null,
          entityName: draft.entity?.name ?? null,
          action: draft.action,
          createdAt: now,
        })),
      );
    }
    return run.id;
  });

  await writeAudit(db, {
    actorEmployeeId: input.requestedBy,
    action: 'ads.audit_run',
    entity: 'ad_audit_run',
    entityId: runId,
    ip: input.ip,
    metadata: { scope: input.scope, days: input.days, findings: drafts.length },
  });
  return runId;
}

export async function auditRunSummaries(
  db: Database,
  options: { id?: string; limit?: number } = {},
): Promise<AuditRunSummary[]> {
  const rows = await db
    .select({ run: adAuditRuns, requestedByName: employees.fullName })
    .from(adAuditRuns)
    .leftJoin(employees, eq(employees.id, adAuditRuns.requestedBy))
    .where(options.id ? eq(adAuditRuns.id, options.id) : undefined)
    .orderBy(desc(adAuditRuns.createdAt))
    .limit(options.limit ?? 20);
  return rows.map(({ run, requestedByName }) => ({
    id: run.id,
    scope: run.scope,
    days: run.days,
    status: run.status,
    since: run.since,
    until: run.until,
    counts: run.counts,
    comparison: run.comparison,
    requestedByName: requestedByName ?? null,
    createdAt: run.createdAt.toISOString(),
    error: run.error,
  }));
}

/** A run's findings, with what each one can still become. */
export async function findingsOf(db: Database, runId: string): Promise<AuditFinding[]> {
  const rows = await db
    .select({ finding: adAuditFindings, approvalId: adApprovalRequests.id })
    .from(adAuditFindings)
    .leftJoin(
      adApprovalRequests,
      eq(adApprovalRequests.changeRequestId, adAuditFindings.changeRequestId),
    )
    .where(eq(adAuditFindings.runId, runId))
    .orderBy(desc(adAuditFindings.priority), adAuditFindings.createdAt);
  return Promise.all(
    rows.map(async ({ finding, approvalId }) => {
      const card =
        finding.action && finding.state === 'open'
          ? await changeCard(
              db,
              { id: finding.id, status: 'open', createdAt: finding.createdAt, approvalId: null },
              finding.action,
            )
          : null;
      return {
        id: finding.id,
        check: finding.check,
        platform: finding.platform,
        accountName: null,
        status: finding.status,
        impact: finding.impact,
        confidence: finding.confidence,
        effort: finding.effort,
        priority: finding.priority,
        title: finding.title,
        detail: finding.detail,
        recommendation: finding.recommendation,
        entity:
          finding.entityLevel && finding.entityExternalId
            ? {
                level: finding.entityLevel,
                externalId: finding.entityExternalId,
                name: finding.entityName ?? finding.entityExternalId,
              }
            : null,
        action: finding.action,
        requestable: card?.requestable ?? false,
        notRequestableReason: finding.action
          ? (card?.notRequestableReason ??
            (finding.state === 'open' ? 'Campanha não encontrada no espelho.' : null))
          : null,
        state: finding.state,
        changeRequestId: finding.changeRequestId,
        approvalId: approvalId ?? null,
      } satisfies AuditFinding;
    }),
  );
}

export type FindingRequestResult =
  | { ok: true; changeRequestId: string; exposureDeltaCents: number; kind: string }
  | { ok: false; status: 404 | 409; error: string; message: string };

/**
 * "Criar pedido" on a finding. The request is the person's own, through the
 * same budget guard as one typed by hand, marked as suggested. The finding is
 * claimed (`open` → `requested`) in the same transaction that reserves the
 * budget: a second click, or a second API instance, finds it taken and gets
 * 409, and a crash midway leaves neither a claim nor a reservation behind.
 * The caller sends the request to the approval gate after this commits.
 */
export async function requestFromFinding(
  db: Database,
  input: { findingId: string; employeeId: string; now?: Date },
): Promise<FindingRequestResult> {
  const now = input.now ?? new Date();
  const finding = await db.query.adAuditFindings.findFirst({
    where: eq(adAuditFindings.id, input.findingId),
  });
  if (!finding) {
    return { ok: false, status: 404, error: 'not_found', message: 'Recomendação não encontrada.' };
  }
  if (finding.state !== 'open') {
    return {
      ok: false,
      status: 409,
      error: 'already_handled',
      message: 'Esta recomendação já foi tratada.',
    };
  }
  const action = finding.action;
  if (!action) {
    return {
      ok: false,
      status: 409,
      error: 'not_requestable',
      message: 'Esta recomendação é feita à mão; ela não vira pedido.',
    };
  }
  const card = await changeCard(
    db,
    { id: finding.id, status: 'open', createdAt: finding.createdAt, approvalId: null },
    action,
  );
  if (!card) {
    return { ok: false, status: 404, error: 'not_found', message: 'Campanha não encontrada.' };
  }
  if (!card.requestable || action.kind === 'add_negative_keyword') {
    return {
      ok: false,
      status: 409,
      error: 'not_requestable',
      message: card.notRequestableReason ?? 'Esta recomendação não vira pedido.',
    };
  }
  const kind = action.kind;
  const [campaign] = await db
    .select({ id: adCampaigns.id, adAccountId: adCampaigns.adAccountId })
    .from(adCampaigns)
    .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
    .where(
      and(eq(adCampaigns.externalId, action.campaignExternalId), isNull(adAccounts.archivedAt)),
    );
  if (!campaign) {
    return { ok: false, status: 404, error: 'not_found', message: 'Campanha não encontrada.' };
  }

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(adAuditFindings)
      .set({ state: 'requested', actedBy: input.employeeId, actedAt: now })
      .where(and(eq(adAuditFindings.id, finding.id), eq(adAuditFindings.state, 'open')))
      .returning({ id: adAuditFindings.id });
    if (claimed.length === 0) {
      return {
        ok: false,
        status: 409,
        error: 'already_handled',
        message: 'Esta recomendação já foi tratada.',
      } as const;
    }
    const reserved = await reserveChange(tx as unknown as Database, {
      adAccountId: campaign.adAccountId,
      campaignId: campaign.id,
      kind,
      toDailyBudgetCents: action.toDailyBudgetCents,
      requestedBy: input.employeeId,
      requestedByAgent: false,
      suggestedByAgent: true,
      reason: `Sugerido pela auditoria (Ads Intelligence): ${action.justification}`.slice(0, 500),
      now,
    });
    if (!reserved.ok) {
      await tx
        .update(adAuditFindings)
        .set({ state: 'refused' })
        .where(eq(adAuditFindings.id, finding.id));
      return { ok: false, status: 409, error: reserved.reason, message: reserved.message } as const;
    }
    await tx
      .update(adAuditFindings)
      .set({ changeRequestId: reserved.value.changeRequestId })
      .where(eq(adAuditFindings.id, finding.id));
    return {
      ok: true,
      changeRequestId: reserved.value.changeRequestId,
      exposureDeltaCents: reserved.value.exposureDeltaCents,
      kind,
    } as const;
  });
}

/** "Descartar": the finding stays in the run, marked as set aside by this person. */
export async function dismissFinding(
  db: Database,
  input: { findingId: string; employeeId: string; now?: Date },
): Promise<boolean> {
  const rows = await db
    .update(adAuditFindings)
    .set({ state: 'dismissed', actedBy: input.employeeId, actedAt: input.now ?? new Date() })
    .where(and(eq(adAuditFindings.id, input.findingId), eq(adAuditFindings.state, 'open')))
    .returning({ id: adAuditFindings.id });
  return rows.length > 0;
}
