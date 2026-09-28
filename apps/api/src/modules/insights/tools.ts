import {
  AD_ACCOUNT_PLATFORM,
  AGENT_LEARNING_LEADS_PER_WEEK,
  AGENT_TOOL_LABEL,
  DASHBOARD_WINDOWS,
  EMPTY_TOTALS,
  campaignDaysInMonth,
  estimateCostCents,
  fatigueOf,
  objectiveKindOf,
  ratiosOf,
  registerInsightsSchema,
  registerSuggestionsSchema,
  type AgentConsultation,
  type CampaignSuggestion,
  type DashboardWindow,
  type Insight,
  type InsightToolName,
  type MetricTotals,
} from '@wings/shared';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaigns,
  adCreatives,
  adMetricsBreakdownDaily,
  adMetricsDaily,
  campaignSuggestions,
  insights,
} from '../../db/schema/index.js';
import { getPeriodState } from '../ads/budget-guard.js';
import { activeAccounts, sumsByEntity } from '../ads/dashboard/queries.js';
import { dashboardTargets } from '../ads/dashboard/targets.js';
import { campaignVerdicts } from '../ads/dashboard/verdicts.js';
import { addDays, dayIn } from '../ads/dashboard/window.js';
import { campaignPerformance } from '../ads/metrics.js';
import type { LlmToolDefinition } from '../agent/llm.js';
import { scrubDeep } from '../agent/scrub.js';
import {
  AGENT_TOOL_DEFINITIONS,
  changeCard,
  dataEnvelope,
  runAgentTool,
  type ToolContext as AgentToolContext,
} from '../agent/tools.js';

/**
 * What the insights generator can do: read our own tables and write cards.
 *
 * The read side is the traffic agent's own read tools plus a few wider ones
 * (breakdowns, the spend × leads curve, creative fatigue, verdicts, targets).
 * The write side is `registrar_insights` and `registrar_sugestoes`, which put
 * rows in two tables and nothing else: no budget is reserved, no request is
 * created and no platform is called. The list is closed; a tool name the
 * model invents is answered with a refusal.
 */

export { dataEnvelope };

export interface InsightToolContext {
  db: Database;
  now: Date;
  /** Who asked, when somebody did; null for the schedule. */
  requestedBy: string | null;
  runId: string;
}

export interface InsightToolOutcome {
  result: unknown;
  summary: string;
  /** How many cards a write tool stored; zero for reads and refusals. */
  stored: number;
  /** A write tool said no: the reasons, for the model to correct. */
  refusal?: string[];
}

/** The agent's read tools the generator may call. Neither proposal tool, no builder draft. */
const BORROWED_READ_TOOLS = [
  'estado_da_conta',
  'desempenho_campanhas',
  'conjuntos_e_anuncios',
  'alertas_abertos',
  'perfil_cliente_ideal',
] as const;
type BorrowedTool = (typeof BORROWED_READ_TOOLS)[number];

const brl = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toWindow(days: number): DashboardWindow {
  return (DASHBOARD_WINDOWS.find((window) => window >= days) ?? 90) as DashboardWindow;
}

const figures = (totals: MetricTotals) => {
  const ratios = ratiosOf(totals);
  return {
    gasto_centavos: totals.spendCents,
    impressoes: totals.impressions,
    cliques: totals.clicks,
    leads: totals.conversions,
    ctr_percentual: ratios.ctrMilli === null ? null : ratios.ctrMilli / 1000,
    cpl_centavos: ratios.costPerLeadCents,
  };
};

// ---------------------------------------------------------------------------
// Read tools of the generator's own
// ---------------------------------------------------------------------------

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

async function quebrasDePublico(
  ctx: InsightToolContext,
  raw: unknown,
): Promise<InsightToolOutcome> {
  const args = z.object({ dias: z.number().int().min(7).max(90).default(30) }).parse(raw ?? {});
  const accounts = await activeAccounts(ctx.db);
  const ids = accounts.map((account) => account.id);
  const until = dayIn(ctx.now);
  const since = addDays(until, -(args.dias - 1));
  if (ids.length === 0) {
    return {
      result: { periodo: { desde: since, ate: until }, quebras: {} },
      summary: 'Nenhuma conta ativa',
      stored: 0,
    };
  }
  const where = and(
    inArray(adMetricsBreakdownDaily.adAccountId, ids),
    gte(adMetricsBreakdownDaily.day, since),
    lte(adMetricsBreakdownDaily.day, until),
  );
  const sums = {
    spendCents: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.spendCents}), 0)`,
    impressions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.impressions}), 0)`,
    clicks: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.clicks}), 0)`,
    conversions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.conversions}), 0)`,
  };
  const totalsOf = (row: Record<keyof typeof sums, string>): MetricTotals => ({
    ...EMPTY_TOTALS,
    spendCents: Number(row.spendCents),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    conversions: Number(row.conversions),
  });

  const [rows, weekdayHour] = await Promise.all([
    ctx.db
      .select({
        kind: adMetricsBreakdownDaily.kind,
        key: adMetricsBreakdownDaily.key,
        subKey: adMetricsBreakdownDaily.subKey,
        ...sums,
      })
      .from(adMetricsBreakdownDaily)
      .where(where)
      .groupBy(
        adMetricsBreakdownDaily.kind,
        adMetricsBreakdownDaily.key,
        adMetricsBreakdownDaily.subKey,
      ),
    ctx.db
      .select({
        weekday: sql<string>`extract(dow from ${adMetricsBreakdownDaily.day})::int`,
        hour: adMetricsBreakdownDaily.key,
        ...sums,
      })
      .from(adMetricsBreakdownDaily)
      .where(and(where, eq(adMetricsBreakdownDaily.kind, 'hour')))
      .groupBy(sql`extract(dow from ${adMetricsBreakdownDaily.day})`, adMetricsBreakdownDaily.key),
  ]);

  const bySpend = (a: { gasto_centavos: number }, b: { gasto_centavos: number }) =>
    b.gasto_centavos - a.gasto_centavos;
  const slice = (kind: string, label: (row: { key: string; subKey: string }) => string | null) =>
    rows
      .filter((row) => row.kind === kind)
      .flatMap((row) => {
        const name = label(row);
        return name === null ? [] : [{ fatia: name, ...figures(totalsOf(row)) }];
      })
      .sort(bySpend)
      .slice(0, 25);
  // Age and gender one side at a time: Google reports them apart, Meta crossed.
  const sided = (side: 'key' | 'subKey') => {
    const merged = new Map<string, MetricTotals>();
    for (const row of rows.filter((row) => row.kind === 'age_gender')) {
      const name = row[side];
      if (name === 'all' || name === '') continue;
      const previous = merged.get(name) ?? EMPTY_TOTALS;
      const totals = totalsOf(row);
      merged.set(name, {
        ...previous,
        spendCents: previous.spendCents + totals.spendCents,
        impressions: previous.impressions + totals.impressions,
        clicks: previous.clicks + totals.clicks,
        conversions: previous.conversions + totals.conversions,
      });
    }
    return [...merged].map(([fatia, totals]) => ({ fatia, ...figures(totals) })).sort(bySpend);
  };

  const result = {
    periodo: { desde: since, ate: until, dias: args.dias },
    observacao:
      'Quebras no nível de campanha, somadas sobre as contas ativas. Alcance não entra; CPL vazio quer dizer sem lead.',
    posicionamento: slice('placement', (row) => `${row.key}/${row.subKey}`),
    idade: sided('key'),
    genero: sided('subKey'),
    regiao: slice('region', (row) => row.key || 'não informada'),
    hora: slice('hour', (row) => `${row.key}h`),
    dispositivo: slice('device', (row) => row.key || 'não informado'),
    dia_da_semana_x_hora: weekdayHour
      .map((row) => ({
        dia: WEEKDAYS[Number(row.weekday)] ?? row.weekday,
        hora: `${row.hour}h`,
        ...figures(totalsOf(row)),
      }))
      .sort(bySpend)
      .slice(0, 30),
  };
  const kinds = Object.entries(result).filter(
    ([, value]) => Array.isArray(value) && value.length > 0,
  ).length;
  return {
    result: scrubDeep(result),
    summary:
      kinds === 0
        ? 'Nenhuma quebra espelhada no período'
        : `${kinds} quebras, últimos ${args.dias} dias`,
    stored: 0,
  };
}

async function curvaGastoLeads(ctx: InsightToolContext, raw: unknown): Promise<InsightToolOutcome> {
  const args = z.object({ dias: z.number().int().min(14).max(180).default(90) }).parse(raw ?? {});
  const accounts = await activeAccounts(ctx.db);
  const ids = accounts.map((account) => account.id);
  const until = dayIn(ctx.now);
  const since = addDays(until, -(args.dias - 1));
  if (ids.length === 0)
    return { result: { campanhas: [] }, summary: 'Nenhuma conta ativa', stored: 0 };

  const [campaigns, rows] = await Promise.all([
    ctx.db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
    ctx.db
      .select({
        entity: adMetricsDaily.entityExternalId,
        week: sql<string>`to_char(date_trunc('week', ${adMetricsDaily.day}::date), 'YYYY-MM-DD')`,
        spendCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
        conversions: sql<string>`coalesce(sum(${adMetricsDaily.conversions}), 0)`,
        clicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}), 0)`,
        budget: sql<string>`coalesce(avg(${adMetricsDaily.dailyBudgetCents}), 0)`,
        days: sql<string>`count(*)`,
      })
      .from(adMetricsDaily)
      .where(
        and(
          inArray(adMetricsDaily.adAccountId, ids),
          eq(adMetricsDaily.level, 'campaign'),
          gte(adMetricsDaily.day, since),
          lte(adMetricsDaily.day, until),
        ),
      )
      .groupBy(
        adMetricsDaily.entityExternalId,
        sql`date_trunc('week', ${adMetricsDaily.day}::date)`,
      ),
  ]);
  const platformOf = new Map(
    accounts.map((account) => [account.id, account.platform as 'meta' | 'google']),
  );

  const campanhas = campaigns
    .filter(
      (campaign) =>
        objectiveKindOf(campaign.objective, platformOf.get(campaign.adAccountId) ?? 'meta') ===
        'leads',
    )
    .map((campaign) => {
      const semanas = rows
        .filter((row) => row.entity === campaign.externalId)
        .sort((a, b) => a.week.localeCompare(b.week))
        .map((row) => {
          const spend = Number(row.spendCents);
          const leads = Number(row.conversions);
          return {
            semana_de: row.week,
            dias_com_dado: Number(row.days),
            gasto_centavos: spend,
            leads,
            cpl_centavos: leads > 0 ? Math.round(spend / leads) : null,
            verba_diaria_media_centavos: Math.round(Number(row.budget)),
          };
        });
      const spend = semanas.reduce((total, week) => total + week.gasto_centavos, 0);
      const leads = semanas.reduce((total, week) => total + week.leads, 0);
      return {
        id_na_plataforma: campaign.externalId,
        nome: campaign.name,
        plataforma: platformOf.get(campaign.adAccountId),
        status: campaign.status,
        verba_diaria_centavos: campaign.dailyBudgetCents,
        total: {
          gasto_centavos: spend,
          leads,
          cpl_centavos: leads > 0 ? Math.round(spend / leads) : null,
        },
        semanas,
      };
    })
    .filter((campaign) => campaign.semanas.length > 0)
    .sort((a, b) => b.total.gasto_centavos - a.total.gasto_centavos)
    .slice(0, 30);

  return {
    result: scrubDeep({
      periodo: { desde: since, ate: until, dias: args.dias },
      observacao:
        'Semanas começam na segunda. Saturação: o CPL sobe quando o gasto semanal sobe. Só campanhas de leads.',
      campanhas,
    }),
    summary: `${campanhas.length} campanha(s) de leads, ${args.dias} dias por semana`,
    stored: 0,
  };
}

async function desgasteCriativos(
  ctx: InsightToolContext,
  raw: unknown,
): Promise<InsightToolOutcome> {
  const args = z.object({ dias: z.number().int().min(7).max(90).default(14) }).parse(raw ?? {});
  const accounts = await activeAccounts(ctx.db);
  const ids = accounts.map((account) => account.id);
  const until = dayIn(ctx.now);
  const since = addDays(until, -(args.dias - 1));
  const midpoint = addDays(since, Math.floor(args.dias / 2) - 1);
  if (ids.length === 0)
    return { result: { anuncios: [] }, summary: 'Nenhuma conta ativa', stored: 0 };

  const [ads, campaigns, creatives, sums, first, second] = await Promise.all([
    ctx.db.query.adAds.findMany({ where: inArray(adAds.adAccountId, ids) }),
    ctx.db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
    ctx.db.query.adCreatives.findMany({ where: inArray(adCreatives.adAccountId, ids) }),
    sumsByEntity(ctx.db, ids, 'ad', since, until),
    sumsByEntity(ctx.db, ids, 'ad', since, midpoint),
    sumsByEntity(ctx.db, ids, 'ad', addDays(midpoint, 1), until),
  ]);
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const creativeByKey = new Map(
    creatives.map((creative) => [`${creative.adAccountId}:${creative.externalId}`, creative]),
  );

  const anuncios = ads
    .flatMap((ad) => {
      const totals = sums.get(ad.externalId);
      if (!totals || totals.impressions === 0) return [];
      const ratios = ratiosOf(totals);
      const fatigue = fatigueOf(
        ratiosOf(first.get(ad.externalId) ?? EMPTY_TOTALS).ctrMilli,
        ratiosOf(second.get(ad.externalId) ?? EMPTY_TOTALS).ctrMilli,
        ratios.frequencyMilli,
      );
      const creative = ad.creativeExternalId
        ? creativeByKey.get(`${ad.adAccountId}:${ad.creativeExternalId}`)
        : undefined;
      return [
        {
          id_na_plataforma: ad.externalId,
          nome: ad.name,
          campanha: ad.campaignId ? (campaignById.get(ad.campaignId)?.name ?? null) : null,
          id_da_campanha: ad.campaignId
            ? (campaignById.get(ad.campaignId)?.externalId ?? null)
            : null,
          formato: creative?.format ?? 'unknown',
          status_efetivo: ad.effectiveStatus,
          ...figures(totals),
          frequencia: ratios.frequencyMilli === null ? null : ratios.frequencyMilli / 1000,
          ctr_primeira_metade:
            fatigue.firstHalfCtrMilli === null ? null : fatigue.firstHalfCtrMilli / 1000,
          ctr_segunda_metade:
            fatigue.secondHalfCtrMilli === null ? null : fatigue.secondHalfCtrMilli / 1000,
          desgastado: fatigue.wornOut,
        },
      ];
    })
    .sort((a, b) => b.gasto_centavos - a.gasto_centavos)
    .slice(0, 40);
  const worn = anuncios.filter((ad) => ad.desgastado).length;
  return {
    result: scrubDeep({
      periodo: { desde: since, ate: until, dias: args.dias },
      regra:
        'Desgastado quando o CTR da segunda metade caiu 20% ou mais em relação à primeira, com frequência 2 ou mais.',
      anuncios,
    }),
    summary: `${anuncios.length} anúncio(s) que entregaram, ${worn} desgastado(s)`,
    stored: 0,
  };
}

/** The verdicts the generator reads at most, biggest spenders first. */
const VERDICTS_MAX = 40;

async function vereditosCampanhas(
  ctx: InsightToolContext,
  raw: unknown,
): Promise<InsightToolOutcome> {
  const args = z.object({ dias: z.number().int().min(7).max(90).default(30) }).parse(raw ?? {});
  const rows = await campaignVerdicts(ctx.db, toWindow(args.dias), ctx.now);
  const label = {
    positive: 'positiva',
    attention: 'atenção',
    negative: 'negativa',
    no_target: 'sem meta',
    insufficient: 'poucos dados',
  };
  const campanhas = rows
    .map((row) => ({
      id_na_plataforma: row.campaignExternalId,
      nome: row.name,
      plataforma: row.platform,
      status: row.status,
      objetivo: row.objectiveKind,
      verba_diaria_centavos: row.dailyBudgetCents,
      veredito: label[row.verdict.verdict],
      decidido_por: row.verdict.primary,
      motivos: row.verdict.reasons.map((reason) => ({
        sinal: reason.signal,
        estado: reason.state,
        texto: reason.text,
      })),
      ...figures(row.totals),
    }))
    .sort((a, b) => b.gasto_centavos - a.gasto_centavos);
  // A campaign that spent nothing in the window and is not running has no
  // verdict worth reading; with 80+ old campaigns they were most of an 81k-char
  // result. Capped too, biggest spenders first.
  const relevant = campanhas.filter(
    (campanha) => campanha.gasto_centavos > 0 || campanha.status === 'ACTIVE',
  );
  const shown = relevant.slice(0, VERDICTS_MAX);
  return {
    result: scrubDeep({
      periodo_dias: toWindow(args.dias),
      campanhas: shown,
      omitidas_sem_gasto_nem_ativas: campanhas.length - relevant.length,
      omitidas_pelo_limite: relevant.length - shown.length,
    }),
    summary: `${campanhas.length} campanha(s) com veredito, ${toWindow(args.dias)} dias`,
    stored: 0,
  };
}

async function metasDeCpl(ctx: InsightToolContext): Promise<InsightToolOutcome> {
  const targets = await dashboardTargets(ctx.db, ctx.now);
  const metas = targets.map((target) => ({
    objetivo: target.objectiveKind,
    meta_confirmada_centavos: target.targetCents,
    confirmada_em: target.confirmedAt,
    proposta_do_historico_centavos: target.proposedCents,
    base_da_proposta: target.proposedBasis,
  }));
  const confirmed = metas.filter((meta) => meta.meta_confirmada_centavos !== null).length;
  return {
    result: {
      metas,
      observacao:
        'Sem meta confirmada, o veredito de uma campanha de leads é "sem meta". A meta é decisão de uma pessoa.',
    },
    summary: confirmed === 0 ? 'Nenhuma meta confirmada' : `${confirmed} meta(s) confirmada(s)`,
    stored: 0,
  };
}

// ---------------------------------------------------------------------------
// Write tools: cards, and only cards
// ---------------------------------------------------------------------------

function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

function refuse(reasons: string[], summary: string): InsightToolOutcome {
  return { result: { aceita: false, corrija: reasons }, summary, stored: 0, refusal: reasons };
}

/** Mirrored campaigns of active accounts by platform id, for resolving a card's campaign. */
async function mirroredCampaigns(db: Database) {
  return db
    .select({ id: adCampaigns.id, externalId: adCampaigns.externalId })
    .from(adCampaigns)
    .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
    .where(isNull(adAccounts.archivedAt));
}

async function registrarInsights(
  ctx: InsightToolContext,
  raw: unknown,
): Promise<InsightToolOutcome> {
  const parsed = registerInsightsSchema.safeParse(raw);
  if (!parsed.success)
    return refuse(issuesOf(parsed.error), 'Insights recusados: incompletos ou fora das regras');
  const campaigns = await mirroredCampaigns(ctx.db);
  const idOf = new Map(campaigns.map((campaign) => [campaign.externalId, campaign.id]));

  const problems: string[] = [];
  for (const [index, insight] of parsed.data.insights.entries()) {
    if (insight.campaignExternalId && !idOf.has(insight.campaignExternalId)) {
      problems.push(
        `insights.${index}.campaignExternalId: campanha não encontrada. Use o id de desempenho_campanhas.`,
      );
    }
    if (insight.action) {
      const probe = await changeCard(
        ctx.db,
        { id: '', status: 'open', createdAt: ctx.now, approvalId: null },
        insight.action,
      );
      if (!probe)
        problems.push(`insights.${index}.action.campaignExternalId: campanha não encontrada.`);
    }
  }
  if (problems.length > 0) return refuse(problems, 'Insights recusados: campanha não encontrada');

  const rows = parsed.data.insights.map((insight): typeof insights.$inferInsert => {
    const payload = scrubDeep(insight) as Insight;
    const campaignExternalId =
      payload.campaignExternalId ?? payload.action?.campaignExternalId ?? null;
    return {
      runId: ctx.runId,
      kind: payload.kind,
      payload,
      campaignExternalId,
      campaignId: campaignExternalId ? (idOf.get(campaignExternalId) ?? null) : null,
      createdAt: ctx.now,
    };
  });
  await ctx.db.insert(insights).values(rows);
  return {
    result: {
      aceita: true,
      registrados: rows.length,
      observacao:
        'Os insights viraram cartões na tela. Nada foi pedido nem alterado; só uma pessoa cria pedido.',
    },
    summary: `${rows.length} insight(s) registrado(s)`,
    stored: rows.length,
  };
}

/** The same guard `propor_campanha` applies: fits the ceiling, and warns below the learning phase. */
async function suggestionRefusal(
  ctx: InsightToolContext,
  index: number,
  suggestion: CampaignSuggestion,
): Promise<string | null> {
  const proposal = suggestion.proposal;
  const today = dayIn(ctx.now);
  if (proposal.startDate < today) {
    return `suggestions.${index}.proposal.startDate: o início não pode ser antes de hoje (${today})`;
  }
  const [account] = await ctx.db.query.adAccounts.findMany({
    where: and(
      isNull(adAccounts.archivedAt),
      eq(adAccounts.platform, AD_ACCOUNT_PLATFORM[proposal.platform]),
    ),
    orderBy: asc(adAccounts.createdAt),
  });
  if (!account) return null;
  const period = await getPeriodState(
    ctx.db,
    account.id,
    `${dayIn(ctx.now, account.timezone).slice(0, 7)}-01`,
  );
  const daysThisMonth = campaignDaysInMonth(proposal.startDate, proposal.endDate, today);
  const costThisMonth = estimateCostCents(
    proposal.dailyBudgetCents,
    daysThisMonth,
    proposal.platform,
  );
  if (period && costThisMonth > period.availableCents) {
    const perCent = estimateCostCents(100, daysThisMonth, proposal.platform) / 100;
    const maxDaily = perCent > 0 ? Math.floor(period.availableCents / perCent / 100) * 100 : 0;
    return `suggestions.${index}.proposal.dailyBudgetCents: o custo neste mês (${brl(costThisMonth)}) passa do disponível (${brl(period.availableCents)}). A maior verba diária que cabe é ${brl(maxDaily)}: proponha essa e avise em budgetNote, ou encurte o período.`;
  }
  if (proposal.objective !== 'traffic') {
    const performance = await campaignPerformance(ctx.db, account.id, addDays(today, -90));
    const mirrored = await ctx.db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, account.id),
    });
    const objectiveOf = new Map(mirrored.map((row) => [row.externalId, row.objective]));
    const counted = performance.filter((row) => {
      const objective = objectiveOf.get(row.campaignExternalId) ?? null;
      return objective === null
        ? row.conversions > 0
        : objectiveKindOf(objective, 'meta') === 'leads';
    });
    const spend = counted.reduce((total, row) => total + row.spendCents, 0);
    const leads = counted.reduce((total, row) => total + row.conversions, 0);
    const cpl = leads >= 5 ? Math.round(spend / leads) : null;
    if (cpl !== null) {
      const minDaily = Math.ceil((cpl * AGENT_LEARNING_LEADS_PER_WEEK) / 7);
      if (proposal.dailyBudgetCents < minDaily && !proposal.budgetNote) {
        return `suggestions.${index}.proposal.dailyBudgetCents: com o CPL dos últimos 90 dias (${brl(cpl)}), ${AGENT_LEARNING_LEADS_PER_WEEK} leads por semana pedem ao menos ${brl(minDaily)} por dia. Suba a verba ou explique em budgetNote o que esperar.`;
      }
    }
  }
  return null;
}

async function registrarSugestoes(
  ctx: InsightToolContext,
  raw: unknown,
): Promise<InsightToolOutcome> {
  const parsed = registerSuggestionsSchema.safeParse(raw);
  if (!parsed.success)
    return refuse(issuesOf(parsed.error), 'Sugestões recusadas: incompletas ou fora das regras');
  const problems: string[] = [];
  for (const [index, suggestion] of parsed.data.suggestions.entries()) {
    const problem = await suggestionRefusal(ctx, index, suggestion);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0)
    return refuse(problems, 'Sugestões recusadas: não cabem no teto ou estão fora das regras');

  const rows = parsed.data.suggestions.map(
    (suggestion): typeof campaignSuggestions.$inferInsert => ({
      runId: ctx.runId,
      payload: scrubDeep(suggestion) as CampaignSuggestion,
      createdAt: ctx.now,
    }),
  );
  await ctx.db.insert(campaignSuggestions).values(rows);
  return {
    result: {
      aceita: true,
      registradas: rows.length,
      observacao:
        'As sugestões viraram cartões com o botão "Abrir no construtor". Nada foi criado nem pedido.',
    },
    summary: `${rows.length} sugestão(ões) de campanha registrada(s)`,
    stored: rows.length,
  };
}

// ---------------------------------------------------------------------------
// The lists, and the one way in
// ---------------------------------------------------------------------------

const borrowed = AGENT_TOOL_DEFINITIONS.filter((tool) =>
  (BORROWED_READ_TOOLS as readonly string[]).includes(tool.name),
);

const READ_DEFINITIONS: LlmToolDefinition[] = [
  ...borrowed,
  {
    name: 'quebras_de_publico',
    description:
      'Gasto, impressões, cliques, leads, CTR e CPL por posicionamento, idade, gênero, região, hora, dispositivo e dia da semana × hora, no nível de campanha, somados sobre as contas ativas. Valores em centavos.',
    parameters: {
      type: 'object',
      properties: {
        dias: {
          type: 'integer',
          minimum: 7,
          maximum: 90,
          description: 'Janela em dias. Padrão 30.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'curva_gasto_leads',
    description:
      'Por campanha de leads, semana a semana: gasto, leads, CPL e verba diária média em vigor. Serve para ver saturação (CPL subindo com o gasto) e a verba ideal. Valores em centavos.',
    parameters: {
      type: 'object',
      properties: {
        dias: {
          type: 'integer',
          minimum: 14,
          maximum: 180,
          description: 'Janela em dias. Padrão 90.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'desgaste_criativos',
    description:
      'Por anúncio que entregou: CTR da primeira metade contra a segunda, frequência e a marca de desgastado, com campanha e formato.',
    parameters: {
      type: 'object',
      properties: {
        dias: {
          type: 'integer',
          minimum: 7,
          maximum: 90,
          description: 'Janela em dias. Padrão 14.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vereditos_campanhas',
    description:
      'Veredito de cada campanha (positiva, atenção, negativa, sem meta, poucos dados) com os motivos em números: CPL contra a meta, CTR contra a mediana da conta, tendência de 7 dias, frequência e ritmo de gasto.',
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', enum: [7, 14, 30, 90], description: 'Janela em dias. Padrão 30.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'metas_de_cpl',
    description:
      'As metas de CPL e CPC confirmadas por uma pessoa, e o que o histórico propõe para cada uma.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const INSIGHTS_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  ...READ_DEFINITIONS,
  {
    name: 'registrar_insights',
    description:
      'Registra os insights da semana como cartões. Cada um com título, findings (o que os números mostram, com os números), evidence (rótulo e valor, ao menos um número), suggestion, impact, confidence e, quando a sugestão for pausar, mudar verba ou negativar termo numa campanha lida nesta rodada, action no formato de propor_alteracao. Chame uma vez, com todos os insights. Insight incompleto recusa o lote inteiro e volta com o que corrigir.',
    parameters: z.toJSONSchema(registerInsightsSchema, { io: 'input' }) as Record<string, unknown>,
  },
];

export const SUGGESTIONS_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  ...READ_DEFINITIONS,
  {
    name: 'registrar_sugestoes',
    description:
      'Registra 2 ou 3 sugestões de campanha nova, COMPLETAS no formato do construtor (o mesmo de propor_campanha: datas AAAA-MM-DD, mínimo 7 dias, verba em centavos, reach, utms, explanations, assumptions; Meta com idade, posicionamentos, formato e 2 ou 3 variações com mediaBrief; Google Pesquisa com palavras-chave, negativas, títulos e descrições; YouTube com título e mediaBrief), cada uma com a faixa esperada de CPL e de leads no período e a motivação em números lidos nesta rodada. Chame uma vez. Sugestão que não cabe no teto ou incompleta recusa o lote e volta com o que corrigir.',
    parameters: z.toJSONSchema(registerSuggestionsSchema, { io: 'input' }) as Record<
      string,
      unknown
    >,
  },
];

const OWN_HANDLERS: Record<
  InsightToolName,
  (ctx: InsightToolContext, args: unknown) => Promise<InsightToolOutcome>
> = {
  quebras_de_publico: quebrasDePublico,
  curva_gasto_leads: curvaGastoLeads,
  desgaste_criativos: desgasteCriativos,
  vereditos_campanhas: vereditosCampanhas,
  metas_de_cpl: (ctx) => metasDeCpl(ctx),
  registrar_insights: registrarInsights,
  registrar_sugestoes: registrarSugestoes,
};

function isOwnTool(name: string): name is InsightToolName {
  return Object.hasOwn(OWN_HANDLERS, name);
}
function isBorrowedTool(name: string): name is BorrowedTool {
  return (BORROWED_READ_TOOLS as readonly string[]).includes(name);
}

export function isInsightTool(name: string): name is InsightToolName | BorrowedTool {
  return isOwnTool(name) || isBorrowedTool(name);
}

/**
 * Runs one tool call for the generator. Like the agent's: nothing the model
 * does throws; a tool that does not exist, arguments that are not JSON or
 * that do not validate each come back as a refusal it can read and correct.
 * `allowed` is the write tool of this run; the other one does not exist here.
 */
export async function runInsightTool(
  ctx: InsightToolContext,
  call: { name: string; arguments: string },
  allowed: 'registrar_insights' | 'registrar_sugestoes',
  options: { cut?: boolean } = {},
): Promise<InsightToolOutcome & { consultation: AgentConsultation | null }> {
  const writeTools = ['registrar_insights', 'registrar_sugestoes'];
  if (!isInsightTool(call.name) || (writeTools.includes(call.name) && call.name !== allowed)) {
    return {
      result: {
        erro: `A ferramenta "${call.name.slice(0, 60)}" não existe. Você só lê dados e registra cartões; nada é executado por você.`,
      },
      summary: 'Ferramenta inexistente',
      stored: 0,
      consultation: null,
    };
  }

  let args: unknown;
  try {
    args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch {
    const reason = options.cut
      ? 'Os argumentos foram cortados pelo limite de tamanho da resposta. Chame a ferramenta de novo, sem texto antes e com textos mais curtos.'
      : 'Os argumentos não são JSON válido.';
    return {
      result: { erro: reason },
      summary: 'Argumentos inválidos',
      stored: 0,
      consultation: null,
      ...(writeTools.includes(call.name)
        ? { refusal: ['Os cartões chegaram incompletos do modelo (resposta cortada).'] }
        : {}),
    };
  }

  if (isBorrowedTool(call.name)) {
    // The agent's own handler, with a context that stores nothing: read tools never write.
    const agentContext: AgentToolContext = {
      db: ctx.db,
      employeeId: ctx.requestedBy ?? '',
      conversationId: '',
      now: ctx.now,
      builderDraft: undefined,
    };
    const outcome = await runAgentTool(
      agentContext,
      { name: call.name, arguments: JSON.stringify(args) },
      0,
      options,
    );
    return {
      result: outcome.result,
      summary: outcome.summary,
      stored: 0,
      consultation: outcome.consultation,
    };
  }

  try {
    const outcome = await OWN_HANDLERS[call.name](ctx, args);
    return {
      ...outcome,
      consultation: {
        tool: call.name,
        label: AGENT_TOOL_LABEL[call.name],
        summary: outcome.summary,
      },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        result: { erro: 'Argumentos inválidos.', corrija: issuesOf(error) },
        summary: 'Argumentos inválidos',
        stored: 0,
        consultation: null,
      };
    }
    throw error;
  }
}
