import { objectiveKindOf, type AdPlatform, type HealthItem, type HealthState } from '@wings/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adAlerts, adCampaigns } from '../../../db/schema/index.js';
import { pacingFacts } from '../alerts.js';
import type { ConversionSource } from '../platform/types.js';
import { creatives, sumsByEntity, type Account } from './queries.js';
import { addDays, dayIn } from './window.js';

/**
 * "Saúde da conta": four questions per paid account, answered from our own
 * tables, each with its state, what was seen (with the numbers) and what to
 * do. Nothing here calls a platform; the pixel and conversion-action reads
 * come from `ad_account_daily.conversion_sources`, written by the ingest job.
 */

const CONVERSION_DAYS = 3;
/** Spend without a single lead past this is a problem, not a quiet day. */
const SILENT_SPEND_PROBLEM_CENTS = 10_000;
const FATIGUE_DAYS = 14;
const RESULTLESS_DAYS = 7;

const brl = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SOURCE_STATE: Record<ConversionSource['status'], string> = {
  active: 'ativo',
  inactive: 'inativo',
  unknown: 'sem dado',
};

function conversionsItem(
  account: Account,
  sources: ConversionSource[] | null,
  recent: { spendCents: number; conversions: number },
): HealthItem {
  const platform = account.platform as AdPlatform;
  const action =
    platform === 'meta'
      ? 'Confira o pixel e a CAPI no Gerenciador de Eventos.'
      : 'Confira as tags de conversão em Ferramentas › Conversões no Google Ads.';
  const named = (sources ?? []).map((source) => `${source.name}: ${SOURCE_STATE[source.status]}`);
  const sourcesText =
    sources === null
      ? 'estado do pixel/tags não lido pela ingestão'
      : named.length === 0
        ? 'nenhuma fonte de conversão informada'
        : named.join(', ');
  const figures = `${recent.conversions} lead(s) e ${brl(recent.spendCents)} gastos nos últimos ${CONVERSION_DAYS} dias; ${sourcesText}.`;

  const anyActive = (sources ?? []).some((source) => source.status === 'active');
  const anyInactive = (sources ?? []).some((source) => source.status === 'inactive');
  let state: HealthState;
  if (anyInactive && recent.conversions === 0) state = 'problem';
  else if (anyActive || recent.conversions > 0) state = 'ok';
  else if (recent.spendCents >= SILENT_SPEND_PROBLEM_CENTS) state = 'problem';
  else if (recent.spendCents > 0) state = 'attention';
  else state = 'unknown';

  return {
    key: 'conversions_measuring',
    platform,
    state,
    detail: figures,
    action: state === 'ok' ? '' : action,
  };
}

export async function accountHealth(
  db: Database,
  accounts: Account[],
  latestDays: Map<string, { conversionSources: unknown }>,
  now = new Date(),
): Promise<HealthItem[]> {
  const ids = accounts.map((account) => account.id);
  if (ids.length === 0) return [];
  const today = dayIn(now);

  const [recent, last7, wornOut, fatigueAlerts, campaigns] = await Promise.all([
    sumsByEntity(db, ids, 'campaign', addDays(today, -(CONVERSION_DAYS - 1)), today),
    sumsByEntity(db, ids, 'campaign', addDays(today, -(RESULTLESS_DAYS - 1)), today),
    creatives(db, FATIGUE_DAYS, now).then((result) =>
      result.creatives.filter((creative) => creative.fatigue.wornOut),
    ),
    db
      .select({ adAccountId: adAlerts.adAccountId, count: sql<string>`count(*)` })
      .from(adAlerts)
      .where(
        and(
          inArray(adAlerts.adAccountId, ids),
          eq(adAlerts.kind, 'creative_fatigue'),
          isNull(adAlerts.resolvedAt),
        ),
      )
      .groupBy(adAlerts.adAccountId),
    db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
  ]);
  const alertsByAccount = new Map(fatigueAlerts.map((row) => [row.adAccountId, Number(row.count)]));

  const items: HealthItem[] = [];
  for (const account of accounts) {
    const platform = account.platform as AdPlatform;
    const own = campaigns.filter((campaign) => campaign.adAccountId === account.id);
    const ownIds = new Set(own.map((campaign) => campaign.externalId));

    // Conversions measuring.
    const recentTotals = { spendCents: 0, conversions: 0 };
    for (const [entity, totals] of recent) {
      if (!ownIds.has(entity)) continue;
      recentTotals.spendCents += totals.spendCents;
      recentTotals.conversions += totals.conversions;
    }
    const sources = latestDays.get(account.id)?.conversionSources;
    items.push(
      conversionsItem(
        account,
        Array.isArray(sources) ? (sources as ConversionSource[]) : null,
        recentTotals,
      ),
    );

    // Creative fatigue.
    const worn = wornOut.filter((creative) => creative.platform === platform);
    const openAlerts = alertsByAccount.get(account.id) ?? 0;
    const fatigueCount = Math.max(worn.length, openAlerts);
    items.push({
      key: 'creative_fatigue',
      platform,
      state: fatigueCount === 0 ? 'ok' : fatigueCount <= 2 ? 'attention' : 'problem',
      detail:
        fatigueCount === 0
          ? `Nenhum criativo desgastado nos últimos ${FATIGUE_DAYS} dias.`
          : `${worn.length} criativo(s) com CTR em queda e frequência alta em ${FATIGUE_DAYS} dias${
              worn.length > 0
                ? ` (${worn
                    .slice(0, 3)
                    .map((creative) => creative.name)
                    .join(', ')})`
                : ''
            }; ${openAlerts} alerta(s) aberto(s).`,
      action: fatigueCount === 0 ? '' : 'Troque o criativo ou amplie o público.',
    });

    // Spend pacing.
    const pacing = await pacingFacts(db, account.id, now);
    if (!pacing || pacing.deviationPercent === null) {
      items.push({
        key: 'spend_pacing',
        platform,
        state: 'unknown',
        detail: pacing
          ? 'Ainda cedo no mês para medir o ritmo.'
          : 'Sem período de orçamento aberto.',
        action: '',
      });
    } else {
      const deviation = Math.abs(pacing.deviationPercent);
      const ahead = pacing.deviationPercent > 0;
      items.push({
        key: 'spend_pacing',
        platform,
        state: deviation < 20 ? 'ok' : deviation < 40 ? 'attention' : 'problem',
        detail: `Gasto ${brl(pacing.spentCents)} contra ${brl(pacing.expectedCents)} esperados até hoje (${pacing.deviationPercent > 0 ? '+' : ''}${pacing.deviationPercent}%), com ${brl(pacing.usableCents)} utilizáveis no mês.`,
        action:
          deviation < 20
            ? ''
            : ahead
              ? 'Reveja os orçamentos diários antes que o teto do mês feche a conta.'
              : 'Verba parada: confira campanhas pausadas ou orçamentos baixos demais.',
      });
    }

    // Active leads campaigns without a result in 7 days.
    const silent = own.filter((campaign) => {
      if (campaign.status !== 'ACTIVE') return false;
      if (objectiveKindOf(campaign.objective, platform) !== 'leads') return false;
      const totals = last7.get(campaign.externalId);
      return totals !== undefined && totals.spendCents > 0 && totals.conversions === 0;
    });
    items.push({
      key: 'active_without_results',
      platform,
      state: silent.length === 0 ? 'ok' : silent.length === 1 ? 'attention' : 'problem',
      detail:
        silent.length === 0
          ? `Nenhuma campanha ativa de leads gastando sem resultado há ${RESULTLESS_DAYS} dias.`
          : `${silent.length} campanha(s) ativa(s) de leads com gasto e zero leads em ${RESULTLESS_DAYS} dias: ${silent
              .slice(0, 4)
              .map(
                (campaign) =>
                  `${campaign.name} (${brl(last7.get(campaign.externalId)?.spendCents ?? 0)})`,
              )
              .join(', ')}.`,
      action:
        silent.length === 0
          ? ''
          : 'Pause ou revise a segmentação; veja o veredito na aba Campanhas.',
    });
  }
  return items;
}
