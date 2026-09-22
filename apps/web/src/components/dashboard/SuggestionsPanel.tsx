import {
  AGENT_DRAFT_FIELD_LABEL,
  CAMPAIGN_OBJECTIVE_LABEL,
  CREATIVE_FORMATS,
  PAID_PLATFORMS,
  campaignDays,
  describeReach,
  type CampaignSuggestionCard,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useDismissSuggestion,
  useGenerateSuggestions,
  useInsightRun,
  useSuggestionApplied,
  useSuggestions,
} from '../../api/dashboard.js';
import { writeBuilderHandoff } from '../../lib/builder-handoff.js';
import { formatBrl, formatDate } from '../campaign-builder/format.js';
import { Alert, Button } from '../ui.js';
import { RunBar } from './InsightsTab.js';

/**
 * Sugestões de novas campanhas: two or three complete proposals a week, in
 * the builder's own terms, each with the numbers that motivated it. "Abrir no
 * construtor" fills the studio's form and nothing else; launching stays the
 * person's own request there.
 */

export const STUDIO_PATH = '/marketing/trafego-pago-wings';

function platformLabel(key: string): string {
  return PAID_PLATFORMS.find((item) => item.key === key)?.label ?? key;
}

const range = (value: { min: number; max: number }, format: (n: number) => string) =>
  value.min === value.max ? format(value.min) : `${format(value.min)} a ${format(value.max)}`;

export function SuggestionCard({
  suggestion,
  canRequest,
}: {
  suggestion: CampaignSuggestionCard;
  canRequest: boolean;
}) {
  const navigate = useNavigate();
  const applied = useSuggestionApplied();
  const dismiss = useDismissSuggestion();
  const { proposal } = suggestion;
  const days = campaignDays(proposal.startDate, proposal.endDate);
  const format = CREATIVE_FORMATS.meta.find((item) => item.key === proposal.formatKey);
  const isApplied = suggestion.status === 'applied';

  const open = () => {
    writeBuilderHandoff({ proposal, pending: suggestion.pending });
    applied.mutate(suggestion.id);
    navigate(STUDIO_PATH);
  };

  return (
    <article className="agent-card suggestion" aria-label={`Sugestão de campanha: ${proposal.name}`}>
      <header className="agent-card-head">
        <span className="agent-card-kind">{platformLabel(proposal.platform)}</span>
        <strong>{proposal.name}</strong>
      </header>
      <p>{proposal.summary}</p>
      <dl className="agent-card-facts">
        <div>
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[proposal.objective]}</dd>
        </div>
        <div>
          <dt>Verba por dia</dt>
          <dd className="mono">{formatBrl(proposal.dailyBudgetCents)}</dd>
        </div>
        <div>
          <dt>Duração</dt>
          <dd>
            {formatDate(proposal.startDate)} a {formatDate(proposal.endDate)}
            {days !== null && ` (${days} dias)`}
          </dd>
        </div>
        <div>
          <dt>Área</dt>
          <dd>{describeReach(proposal.reach)}</dd>
        </div>
        {proposal.ageMin !== undefined && proposal.ageMax !== undefined && (
          <div>
            <dt>Idade</dt>
            <dd>
              {proposal.ageMin} a {proposal.ageMax} anos
            </dd>
          </div>
        )}
        {proposal.formatKey && (
          <div>
            <dt>Formato de mídia</dt>
            <dd>{format ? `${format.label} (${format.ratio})` : proposal.formatKey}</dd>
          </div>
        )}
        {proposal.youtube && (
          <div>
            <dt>Formato de mídia</dt>
            <dd>Vídeo no YouTube</dd>
          </div>
        )}
        {proposal.search && (
          <div>
            <dt>Formato de mídia</dt>
            <dd>Anúncio de pesquisa, {proposal.search.keywords.length} palavras-chave</dd>
          </div>
        )}
        <div>
          <dt>CPL esperado</dt>
          <dd className="mono">{range(suggestion.expectedCplCents, formatBrl)}</dd>
        </div>
        <div>
          <dt>Leads esperados no período</dt>
          <dd className="mono">{range(suggestion.expectedLeads, (n) => n.toLocaleString('pt-BR'))}</dd>
        </div>
      </dl>

      <div className="agent-card-block">
        <span className="agent-card-label">Público</span>
        <p>{proposal.idealCustomerProfile}</p>
      </div>

      <div className="agent-card-block">
        <span className="agent-card-label">Os números que motivaram</span>
        <dl className="agent-card-facts">
          {suggestion.motivation.map((item) => (
            <div key={`${item.label}:${item.value}`}>
              <dt>{item.label}</dt>
              <dd className="mono">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <details className="agent-details">
        <summary>Por que cada escolha</summary>
        <dl className="agent-card-reasons">
          {proposal.explanations.map((item) => (
            <div key={item.field}>
              <dt>{AGENT_DRAFT_FIELD_LABEL[item.field]}</dt>
              <dd>{item.reason}</dd>
            </div>
          ))}
        </dl>
      </details>
      {proposal.budgetNote && (
        <p className="agent-card-warning" role="note">
          {proposal.budgetNote}
        </p>
      )}
      {suggestion.pending.length > 0 && (
        <div className="agent-card-block agent-card-pending">
          <span className="agent-card-label">Pendente com você</span>
          <ul className="agent-card-plain">
            {suggestion.pending.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {isApplied && (
        <p className="agent-card-state" role="status">
          Aberta no construtor{suggestion.actedByName ? ` por ${suggestion.actedByName}` : ''}. Nada foi lançado.
        </p>
      )}
      <div className="suggestion-actions">
        <Button type="button" variant={isApplied ? 'ghost' : 'primary'} onClick={open}>
          {isApplied ? 'Abrir de novo no construtor' : 'Abrir no construtor'}
        </Button>
        {!isApplied && (
          <Button type="button" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate(suggestion.id)}>
            Dispensar
          </Button>
        )}
      </div>
      {!canRequest && (
        <p className="field-hint">O construtor abre para você ver; só quem tem permissão de pedir lança dali.</p>
      )}
      {dismiss.isError && (
        <p className="field-error" role="alert">
          Não foi possível dispensar. Tente de novo.
        </p>
      )}
    </article>
  );
}

export function SuggestionsPanel({ canRequest }: { canRequest: boolean }) {
  const suggestions = useSuggestions();
  const generate = useGenerateSuggestions();
  const [followId, setFollowId] = useState<string | undefined>(undefined);
  const running = suggestions.data?.runningRun ?? null;
  const follow = useInsightRun(followId ?? running?.id, Boolean(followId ?? running));

  useEffect(() => {
    const status = follow.data?.run.status;
    if (status && status !== 'running') {
      setFollowId(undefined);
      void suggestions.refetch();
    }
  }, [follow.data?.run.status, suggestions]);

  if (suggestions.isError) {
    return <Alert kind="error">Não foi possível carregar as sugestões de campanha. Tente de novo em instantes.</Alert>;
  }
  if (!suggestions.data) return null;
  const data = suggestions.data;
  const runningRun = running ?? (follow.data?.run.status === 'running' ? follow.data.run : null);
  const open = data.suggestions.filter((item) => item.status !== 'dismissed');

  return (
    <section className="dash-section suggestions" aria-labelledby="suggestions-title">
      <RunBar
        title="Sugestões de novas campanhas"
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
      <span id="suggestions-title" className="sr-only">
        Sugestões de novas campanhas
      </span>
      {open.length === 0 ? (
        <p className="muted dash-note">Nenhuma sugestão aberta. Nada é lançado daqui: uma sugestão só preenche o construtor.</p>
      ) : (
        <div className="suggestions-grid">
          {open.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} canRequest={canRequest} />
          ))}
        </div>
      )}
    </section>
  );
}
