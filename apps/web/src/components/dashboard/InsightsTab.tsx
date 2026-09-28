import {
  AD_PLATFORM_LABEL,
  CAMPAIGN_VERDICT_LABEL,
  INSIGHT_CONFIDENCE_LABEL,
  INSIGHTS_FAILED_RUNS_PER_DAY,
  INSIGHT_KIND_LABEL,
  type CampaignVerdict,
  type InsightCard,
  type InsightRun,
  type InsightsUsageToday,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  useDashboardCampaigns,
  useGenerateInsights,
  useInsightRun,
  useInsights,
  useMarkInsightSeen,
  useRequestFromInsight,
} from '../../api/dashboard.js';
import { Alert, Button } from '../ui.js';
import { formatDateTime, formatMoney, formatUsdMicro } from './format.js';
import { StatePill, stateOfVerdict } from './icons.js';
import { SuggestionsPanel } from './SuggestionsPanel.js';

/**
 * Insights e sugestões: what the model read in our own tables and what it
 * proposes, every Monday and on "Gerar agora". A card does nothing by being
 * on screen. "Criar pedido" makes a request in the person's own name through
 * the approval gate, marked "sugerido pela IA"; everything else is a
 * recommendation a person marks as seen.
 */

const APPROVALS_PATH = '/marketing/trafego-pago-wings/aprovacoes';

const VERDICTS_SHOWN: CampaignVerdict[] = ['positive', 'attention', 'negative', 'no_target'];

/** Where the run came from, and what it cost: the line above the cards. */
export function runLine(run: InsightRun): string {
  const by = run.trigger === 'schedule' ? 'pela agenda' : `por ${run.requestedByName ?? 'uma pessoa'}`;
  const sources = run.consulted.length;
  return `${run.status === 'failed' ? 'Tentativa' : 'Gerados'} ${formatDateTime(run.startedAt)} ${by} · custo ${formatUsdMicro(run.costMicroUsd)} · consultou ${sources} ${sources === 1 ? 'fonte' : 'fontes'}`;
}

/** Why "Gerar agora" is off, in one sentence; null when it is on. */
export function generateBlocker(input: {
  configured: boolean;
  usage: InsightsUsageToday;
  running: boolean;
}): string | null {
  if (!input.configured) return 'O OpenRouter não está configurado neste ambiente.';
  if (input.running) return 'Uma geração está em andamento.';
  if (input.usage.failedRuns >= INSIGHTS_FAILED_RUNS_PER_DAY) {
    return 'Várias gerações falharam hoje. Para não gastar à toa, a geração volta amanhã.';
  }
  if (input.usage.exhausted) return 'O teto diário de IA dos insights foi atingido. Volta amanhã.';
  return null;
}

/**
 * The bar with the run, the ceiling and the button. Shared by the insights
 * and the suggestions panel: same run shape, same ceiling.
 */
export function RunBar({
  title,
  latestRun,
  runningRun,
  usage,
  configured,
  nextScheduledAt,
  onGenerate,
  generating,
  error,
}: {
  title: string;
  latestRun: InsightRun | null;
  runningRun: InsightRun | null;
  usage: InsightsUsageToday;
  configured: boolean;
  nextScheduledAt: string;
  onGenerate: () => void;
  generating: boolean;
  error: unknown;
}) {
  const running = runningRun !== null || generating;
  const blocker = generateBlocker({ configured, usage, running });
  return (
    <div className="runbar">
      <div className="runbar-text">
        <h2>{title}</h2>
        <p className="muted">
          {runningRun
            ? `Gerando desde ${formatDateTime(runningRun.startedAt)}…`
            : latestRun
              ? runLine(latestRun)
              : 'Nenhuma geração ainda.'}
        </p>
        {latestRun?.status === 'failed' && !runningRun && (
          <p className="field-error" role="alert">
            A última geração falhou ({latestRun.error ?? 'sem código'}). Nada foi alterado; gere de novo.
          </p>
        )}
        <p className="cell-sub">
          Hoje: {formatUsdMicro(usage.spentMicroUsd)} de {formatUsdMicro(usage.limitMicroUsd)} · próxima geração
          automática {formatDateTime(nextScheduledAt)}
        </p>
      </div>
      <div className="runbar-action">
        <Button type="button" onClick={onGenerate} disabled={blocker !== null || running}>
          {running ? 'Gerando…' : 'Gerar agora'}
        </Button>
        {blocker && <p className="field-hint">{blocker}</p>}
        {error instanceof ApiError && (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        )}
      </div>
    </div>
  );
}

function Impact({ impact }: { impact: InsightCard['impact'] }) {
  const money =
    impact.estimatedCentsPerMonth === null
      ? null
      : `${impact.direction === 'save' ? 'economia' : impact.direction === 'gain' ? 'ganho' : 'sem mudança'} de ${formatMoney(impact.estimatedCentsPerMonth)} por mês`;
  return (
    <p>
      {impact.text}
      {money && <span className="cell-sub">{money}</span>}
    </p>
  );
}

function Consulted({ consulted }: { consulted: InsightCard['consulted'] }) {
  if (consulted.length === 0) return null;
  return (
    <details className="agent-details">
      <summary>O que consultei ({consulted.length})</summary>
      <ul className="agent-card-plain">
        {consulted.map((item, index) => (
          <li key={`${item.tool}-${index}`}>
            <b>{item.label}</b>
            <span className="cell-sub">{item.summary}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function OpenInsight({ insight, canRequest }: { insight: InsightCard; canRequest: boolean }) {
  const seen = useMarkInsightSeen();
  const request = useRequestFromInsight();
  const action = insight.action;

  return (
    <article className="insight" aria-label={`Insight: ${insight.title}`}>
      <div className="insight-side">
        <span className="insight-kind">{INSIGHT_KIND_LABEL[insight.kind]}</span>
        <span className={`insight-confidence confidence-${insight.confidence}`}>
          Confiança {INSIGHT_CONFIDENCE_LABEL[insight.confidence].toLowerCase()}
        </span>
        {insight.campaignName && (
          <span className="cell-sub">
            {insight.campaignName}
            {insight.platform && ` · ${AD_PLATFORM_LABEL[insight.platform]}`}
          </span>
        )}
      </div>
      <div className="insight-main">
        <h3>{insight.title}</h3>
        <div className="insight-block">
          <span className="agent-card-label">O que os números mostram</span>
          <p>{insight.findings}</p>
          <dl className="agent-card-facts">
            {insight.evidence.map((item) => (
              <div key={`${item.label}:${item.value}`}>
                <dt>{item.label}</dt>
                <dd className="mono">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="insight-block">
          <span className="agent-card-label">Sugestão</span>
          <p>{insight.suggestion}</p>
        </div>
        <div className="insight-block">
          <span className="agent-card-label">Impacto estimado</span>
          <Impact impact={insight.impact} />
        </div>
        <Consulted consulted={insight.consulted} />

        <div className="insight-actions">
          {action && action.requestable ? (
            canRequest ? (
              <Button
                type="button"
                disabled={request.isPending}
                onClick={() => request.mutate(insight.id)}
              >
                {request.isPending ? 'Criando pedido…' : 'Criar pedido'}
              </Button>
            ) : (
              <p className="field-hint">Você não tem permissão para pedir alterações. Marque como visto ou peça a quem tem.</p>
            )
          ) : action ? (
            <p className="field-hint">{action.notRequestableReason ?? 'O sistema não cria pedido para esta alteração.'}</p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={seen.isPending}
            onClick={() => seen.mutate(insight.id)}
          >
            {seen.isPending ? 'Marcando…' : 'Marcar como visto'}
          </Button>
        </div>
        {action && action.requestable && canRequest && (
          <p className="cell-sub">
            O pedido sai no seu nome, marcado "sugerido pela IA", e espera aprovação como qualquer outro.
          </p>
        )}
        {request.isError && (
          <p className="field-error" role="alert">
            {request.error instanceof Error ? request.error.message : 'Não foi possível criar o pedido.'}
          </p>
        )}
        {seen.isError && (
          <p className="field-error" role="alert">
            Não foi possível marcar como visto. Tente de novo.
          </p>
        )}
      </div>
    </article>
  );
}

function HistoryRow({ insight }: { insight: InsightCard }) {
  const what =
    insight.status === 'requested'
      ? 'Pedido criado'
      : insight.status === 'refused'
        ? 'Recusado pelo guardião de orçamento'
        : 'Visto';
  return (
    <li className="insight-history-row">
      <span className="cell-sub mono">{formatDateTime(insight.actedAt ?? insight.createdAt)}</span>
      <span>
        <b>{insight.title}</b>
        <span className="cell-sub">
          {INSIGHT_KIND_LABEL[insight.kind]}
          {insight.campaignName && ` · ${insight.campaignName}`}
        </span>
      </span>
      <span className="cell-sub">
        {what}
        {insight.actedByName && ` por ${insight.actedByName}`}
        {insight.status === 'requested' && insight.approvalId && (
          <>
            {' · '}
            <Link to={`${APPROVALS_PATH}/${insight.approvalId}`}>Ver o pedido</Link>
          </>
        )}
      </span>
    </li>
  );
}

function VerdictStrip() {
  const campaigns = useDashboardCampaigns(30);
  const counts = new Map<CampaignVerdict, number>();
  for (const campaign of campaigns.data?.campaigns.campaigns ?? []) {
    counts.set(campaign.verdict.verdict, (counts.get(campaign.verdict.verdict) ?? 0) + 1);
  }
  if (!campaigns.data) return null;
  return (
    <section className="verdict-strip" aria-label="Vereditos das campanhas em 30 dias">
      <span className="muted">Vereditos em 30 dias:</span>
      {VERDICTS_SHOWN.map((verdict) => (
        <Link key={verdict} to="/dashboard/marketing?aba=campanhas&dias=30" className="verdict-count">
          <StatePill state={stateOfVerdict(verdict)}>
            {CAMPAIGN_VERDICT_LABEL[verdict]} {counts.get(verdict) ?? 0}
          </StatePill>
        </Link>
      ))}
    </section>
  );
}

export function InsightsTab() {
  const { data: user } = useSession();
  const canRequest = hasPermission(user, 'ads.request');
  const insights = useInsights();
  const generate = useGenerateInsights();
  const [followId, setFollowId] = useState<string | undefined>(undefined);
  const running = insights.data?.runningRun ?? null;
  const follow = useInsightRun(followId ?? running?.id, Boolean(followId ?? running));

  // When the run we follow ends, the list is read again and the poll stops.
  useEffect(() => {
    const status = follow.data?.run.status;
    if (status && status !== 'running') {
      setFollowId(undefined);
      void insights.refetch();
    }
  }, [follow.data?.run.status, insights]);

  if (insights.isError) {
    return <Alert kind="error">Não foi possível carregar os insights. Tente de novo em instantes.</Alert>;
  }
  if (!insights.data) return <p className="muted">Carregando…</p>;
  const data = insights.data;
  const runningRun = running ?? (follow.data?.run.status === 'running' ? follow.data.run : null);

  return (
    <>
      <RunBar
        title="Insights"
        latestRun={data.latestRun}
        runningRun={runningRun}
        usage={data.usage}
        configured={data.configured}
        nextScheduledAt={data.nextScheduledAt}
        generating={generate.isPending}
        error={generate.error}
        onGenerate={() =>
          generate.mutate(undefined, { onSuccess: (body) => setFollowId(body.run.id) })
        }
      />

      <VerdictStrip />

      {data.open.length === 0 ? (
        <p className="muted dash-note">
          {data.latestRun
            ? 'Nenhum insight aberto. Os já vistos ficam no histórico abaixo.'
            : 'Nenhum insight ainda. A primeira geração roda na segunda-feira às 7h, ou agora pelo botão.'}
        </p>
      ) : (
        <div className="insights">
          {data.open.map((insight) => (
            <OpenInsight key={insight.id} insight={insight} canRequest={canRequest} />
          ))}
        </div>
      )}

      {data.history.length > 0 && (
        <section className="dash-section insight-history" aria-labelledby="insight-history-title">
          <h2 id="insight-history-title">Histórico</h2>
          <ul>
            {data.history.map((insight) => (
              <HistoryRow key={insight.id} insight={insight} />
            ))}
          </ul>
        </section>
      )}

      <SuggestionsPanel canRequest={canRequest} />
    </>
  );
}
