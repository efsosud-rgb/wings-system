import {
  AGENT_CHANGE_KIND_LABEL,
  AGENT_DRAFT_FIELD_LABEL,
  PAID_PLATFORMS,
  type AgentCampaignProposal,
  type AgentCampaignProposalCard,
  type AgentChangeProposalCard,
  type AgentProposalCard,
} from '@wings/shared';
import { Link } from 'react-router-dom';
import { useMarkProposalApplied, useRequestFromProposal } from '../../api/agent.js';
import { Button } from '../ui.js';
import { formatBrl, formatDate } from '../campaign-builder/format.js';

/**
 * What the agent proposed, as cards. A card does nothing by being on screen:
 * each one has at most one button, and the action happens on that click.
 */

const APPROVALS_PATH = '/marketing/trafego-pago-wings/aprovacoes';

function platformLabel(key: string): string {
  return PAID_PLATFORMS.find((item) => item.key === key)?.label ?? key;
}

function CampaignCard({
  proposal,
  onApplyCampaign,
  onActed,
}: {
  proposal: AgentCampaignProposalCard;
  onApplyCampaign?: (payload: AgentCampaignProposal) => void;
  onActed: (next: AgentProposalCard) => void;
}) {
  const markApplied = useMarkProposalApplied();
  const applied = proposal.status === 'applied';
  const { payload } = proposal;

  return (
    <article className="agent-card" aria-label={`Proposta de campanha: ${payload.name}`}>
      <header className="agent-card-head">
        <span className="agent-card-kind">Proposta de campanha</span>
        <strong>{payload.name}</strong>
      </header>
      <p>{payload.summary}</p>
      <dl className="agent-card-facts">
        <div>
          <dt>Plataforma</dt>
          <dd>{platformLabel(payload.platform)}</dd>
        </div>
        <div>
          <dt>Verba por dia</dt>
          <dd className="mono">{formatBrl(payload.dailyBudgetCents)}</dd>
        </div>
        <div>
          <dt>Período</dt>
          <dd>
            {formatDate(payload.startDate)} a {formatDate(payload.endDate)}
          </dd>
        </div>
      </dl>
      <details className="agent-details">
        <summary>Por que cada escolha</summary>
        <dl className="agent-card-reasons">
          {payload.explanations.map((item) => (
            <div key={item.field}>
              <dt>{AGENT_DRAFT_FIELD_LABEL[item.field]}</dt>
              <dd>{item.reason}</dd>
            </div>
          ))}
        </dl>
      </details>

      {applied && (
        <p className="agent-card-state" role="status">
          Aplicada no construtor
        </p>
      )}
      {onApplyCampaign ? (
        <Button
          type="button"
          variant={applied ? 'ghost' : 'primary'}
          onClick={() => {
            onApplyCampaign(payload);
            onActed({ ...proposal, status: 'applied' });
            markApplied.mutate(proposal.id);
          }}
        >
          {applied ? 'Aplicar de novo' : 'Aplicar no construtor'}
        </Button>
      ) : (
        <p className="field-hint">Abra a aba Mídia paga para aplicar.</p>
      )}
      {markApplied.isError && (
        <p className="field-hint">
          O formulário foi preenchido, mas não foi possível registrar a aplicação.
        </p>
      )}
    </article>
  );
}

function ChangeCard({
  proposal,
  canRequest,
  onActed,
}: {
  proposal: AgentChangeProposalCard;
  canRequest: boolean;
  onActed: (next: AgentProposalCard) => void;
}) {
  const request = useRequestFromProposal();
  const { payload } = proposal;
  const requested = proposal.status === 'requested';
  const approvalId = proposal.approvalId;

  return (
    <article
      className="agent-card"
      aria-label={`Proposta de alteração: ${AGENT_CHANGE_KIND_LABEL[payload.kind]}`}
    >
      <header className="agent-card-head">
        <span className="agent-card-kind">Proposta de alteração</span>
        <strong>{AGENT_CHANGE_KIND_LABEL[payload.kind]}</strong>
      </header>
      <p className="agent-card-campaign">{proposal.campaignName}</p>

      {payload.kind === 'set_daily_budget' && payload.toDailyBudgetCents !== undefined && (
        <p className="mono agent-card-budget">
          {proposal.currentDailyBudgetCents !== null
            ? `De ${formatBrl(proposal.currentDailyBudgetCents)} para ${formatBrl(payload.toDailyBudgetCents)} por dia`
            : `${formatBrl(payload.toDailyBudgetCents)} por dia`}
        </p>
      )}
      {payload.kind === 'add_negative_keyword' && payload.term && (
        <p>
          Termo: <span className="mono">{payload.term}</span>
        </p>
      )}

      <p>{payload.justification}</p>
      <dl className="agent-card-facts">
        {payload.evidence.map((item) => (
          <div key={`${item.label}:${item.value}`}>
            <dt>{item.label}</dt>
            <dd className="mono">{item.value}</dd>
          </div>
        ))}
      </dl>

      {requested ? (
        <p className="agent-card-state" role="status">
          Pedido criado, aguardando aprovação.{' '}
          {approvalId && <Link to={`${APPROVALS_PATH}/${approvalId}`}>Ver o pedido</Link>}
        </p>
      ) : !proposal.requestable ? (
        <p className="field-hint">
          {proposal.notRequestableReason ?? 'O sistema não cria pedido para esta alteração.'}
        </p>
      ) : !canRequest ? (
        <p className="field-hint">Você não tem permissão para pedir alterações.</p>
      ) : (
        <Button
          type="button"
          disabled={request.isPending}
          onClick={() =>
            request.mutate(proposal.id, {
              onSuccess: (result) =>
                onActed({
                  ...proposal,
                  status: 'requested',
                  approvalId: result.approvalId ?? result.proposal.approvalId,
                }),
            })
          }
        >
          {request.isPending ? 'Criando pedido…' : 'Criar pedido'}
        </Button>
      )}
      {request.isError && (
        <p className="field-error" role="alert">
          {request.error instanceof Error
            ? request.error.message
            : 'Não foi possível criar o pedido.'}
        </p>
      )}
    </article>
  );
}

export function ProposalCard({
  proposal,
  canRequest,
  onApplyCampaign,
  onActed,
}: {
  proposal: AgentProposalCard;
  canRequest: boolean;
  onApplyCampaign?: (payload: AgentCampaignProposal) => void;
  /** The card as it stands after a click, so the panel can keep showing it that way. */
  onActed: (next: AgentProposalCard) => void;
}) {
  return proposal.kind === 'campaign' ? (
    <CampaignCard proposal={proposal} onApplyCampaign={onApplyCampaign} onActed={onActed} />
  ) : (
    <ChangeCard proposal={proposal} canRequest={canRequest} onActed={onActed} />
  );
}
