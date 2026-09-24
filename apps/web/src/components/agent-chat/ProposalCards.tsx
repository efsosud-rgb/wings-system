import {
  AGENT_CHANGE_KIND_LABEL,
  AGENT_DRAFT_FIELD_LABEL,
  CALL_TO_ACTION_LABEL,
  CAMPAIGN_OBJECTIVE_LABEL,
  CREATIVE_FORMATS,
  PAID_PLATFORMS,
  PLACEMENT_POSITION_LABEL,
  campaignDays,
  describeReach,
  keywordWithMatch,
  type AgentCampaignProposal,
  type AgentCampaignProposalCard,
  type AgentChangeProposalCard,
  type AgentGenerationProposalCard,
  type AgentProposalCard,
  type AgentTimelineEditProposalCard,
  GENERATION_STATUS_LABEL,
  MEDIA_IMAGE_USE_LABEL,
  MEDIA_PROVIDER_LABEL,
  type MediaProviderId,
  isGenerationOver,
} from '@wings/shared';
import { createContext, useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarkProposalApplied, useRequestFromProposal } from '../../api/agent.js';
import { ApiError } from '../../api/client.js';
import { useGeneration, useStartGeneration } from '../../api/media.js';
import { MediaThumb } from '../media-studio/MediaLibrary.js';
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

/** Longer than this, the ideal customer goes behind "ver tudo". */
const ICP_PREVIEW = 140;

function placementsLabel(placements: NonNullable<AgentCampaignProposal['placements']>): string {
  if (placements.mode === 'automatic') return 'Automático (Advantage+)';
  const positions = (list: typeof placements.facebook) =>
    list.map((position) => PLACEMENT_POSITION_LABEL[position]).join(', ');
  return [
    placements.facebook.length > 0 ? `Facebook: ${positions(placements.facebook)}` : null,
    placements.instagram.length > 0 ? `Instagram: ${positions(placements.instagram)}` : null,
    placements.threads.length > 0 ? `Threads: ${positions(placements.threads)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type ApplyCampaign = (payload: AgentCampaignProposal, pending: string[]) => void;

function CampaignCard({
  proposal,
  onApplyCampaign,
  onActed,
}: {
  proposal: AgentCampaignProposalCard;
  onApplyCampaign?: ApplyCampaign;
  onActed: (next: AgentProposalCard) => void;
}) {
  const markApplied = useMarkProposalApplied();
  const applied = proposal.status === 'applied';
  const { payload } = proposal;
  const pending = proposal.pending ?? [];
  const days = campaignDays(payload.startDate, payload.endDate);
  const format = CREATIVE_FORMATS.meta.find((item) => item.key === payload.formatKey);
  const icp = payload.idealCustomerProfile;

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
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[payload.objective]}</dd>
        </div>
        <div>
          <dt>Período</dt>
          <dd>
            {formatDate(payload.startDate)} a {formatDate(payload.endDate)}
            {days !== null && ` (${days} dias)`}
          </dd>
        </div>
        <div>
          <dt>Região</dt>
          <dd>{describeReach(payload.reach)}</dd>
        </div>
        {payload.ageMin !== undefined && payload.ageMax !== undefined && (
          <div>
            <dt>Idade</dt>
            <dd>
              {payload.ageMin} a {payload.ageMax} anos
            </dd>
          </div>
        )}
        {payload.placements && (
          <div>
            <dt>Posicionamentos</dt>
            <dd>{placementsLabel(payload.placements)}</dd>
          </div>
        )}
        {payload.formatKey && (
          <div>
            <dt>Formato</dt>
            <dd>{format ? `${format.label} (${format.ratio})` : payload.formatKey}</dd>
          </div>
        )}
      </dl>
      {payload.budgetNote && (
        <p className="agent-card-warning" role="note">
          {payload.budgetNote}
        </p>
      )}

      <div className="agent-card-block">
        <span className="agent-card-label">Público</span>
        {icp.length <= ICP_PREVIEW ? (
          <p>{icp}</p>
        ) : (
          <details className="agent-details">
            <summary>{icp.slice(0, ICP_PREVIEW).trimEnd()}… ver tudo</summary>
            <p>{icp}</p>
          </details>
        )}
      </div>

      {payload.copy.length > 0 && (
        <details className="agent-details">
          <summary>Textos do anúncio ({payload.copy.length} variações)</summary>
          <ol className="agent-card-variations">
            {payload.copy.map((copy, index) => (
              <li key={`${copy.headline}-${index}`}>
                <strong>{copy.headline}</strong>
                <p>{copy.primaryText}</p>
                <span className="muted">Botão: {CALL_TO_ACTION_LABEL[copy.callToAction]}</span>
                <p className="agent-card-brief">
                  <span className="agent-card-label">Briefing para o Design</span>
                  {copy.mediaBrief}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}

      {payload.search && (
        <details className="agent-details">
          <summary>Palavras-chave e anúncio de pesquisa</summary>
          <div className="agent-card-block">
            <span className="agent-card-label">Palavras-chave</span>
            <p className="mono">{payload.search.keywords.map(keywordWithMatch).join(' · ')}</p>
            <span className="agent-card-label">Negativas</span>
            <p className="mono">{payload.search.negativeKeywords.join(' · ')}</p>
            <span className="agent-card-label">Títulos</span>
            <p>{payload.search.headlines.join(' · ')}</p>
            <span className="agent-card-label">Descrições</span>
            <p>{payload.search.descriptions.join(' · ')}</p>
          </div>
        </details>
      )}

      {payload.youtube && (
        <div className="agent-card-block">
          <span className="agent-card-label">Título do vídeo</span>
          <p>{payload.youtube.headline}</p>
          <p className="agent-card-brief">
            <span className="agent-card-label">Briefing para o Design</span>
            {payload.youtube.mediaBrief}
          </p>
        </div>
      )}

      <p className="agent-card-utms mono">
        <span className="agent-card-label">UTMs</span>
        {[
          payload.utms.utm_source,
          payload.utms.utm_medium,
          payload.utms.utm_campaign,
          payload.utms.utm_content,
        ]
          .filter((value) => value !== '')
          .join(' / ')}
      </p>

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
      <details className="agent-details">
        <summary>Premissas</summary>
        <ul className="agent-card-plain">
          {payload.assumptions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
      {pending.length > 0 && (
        <div className="agent-card-block agent-card-pending">
          <span className="agent-card-label">Pendente</span>
          <ul className="agent-card-plain">
            {pending.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

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
            onApplyCampaign(payload, pending);
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

/** Whether the person may spend credits: `marketing.media.generate`. Set by the media studio. */
export const CanGenerateContext = createContext(false);

const credits = (value: number) =>
  `${value.toLocaleString('pt-BR')} ${value === 1 ? 'crédito' : 'créditos'}`;
/** The price as the button says it: credits on Kairogen, reais anywhere else, R$ 0 included. */
const priceOf = (estimate: { credits: number; brlCents: number; providerId: MediaProviderId }) =>
  estimate.providerId === 'kairogen' ? credits(estimate.credits) : formatBrl(estimate.brlCents);

/**
 * A picture or a video the editing agent proposes. The cost is already on the
 * card; the one button spends it, and only when pressed. A generation that went
 * wrong is never sent again from here.
 */
function GenerationCard({
  proposal,
  onActed,
}: {
  proposal: AgentGenerationProposalCard;
  onActed: (next: AgentProposalCard) => void;
}) {
  const canGenerate = useContext(CanGenerateContext);
  const start = useStartGeneration();
  const following = useGeneration(proposal.generationId ?? undefined);
  const generation = following.data?.generation;
  const { payload, estimate } = proposal;
  const params = Object.entries(payload.params);

  return (
    <article className="agent-card" aria-label="Proposta de geração">
      <header className="agent-card-head">
        <span className="agent-card-kind">
          {payload.kind === 'image' ? 'Proposta de imagem' : 'Proposta de vídeo'}
        </span>
      </header>
      <p>{payload.explanation}</p>
      <dl className="agent-card-facts">
        <div>
          <dt>Para quem</dt>
          <dd>{proposal.clientName ?? 'Cliente removido'}</dd>
        </div>
        <div>
          <dt>Provedor</dt>
          <dd>{MEDIA_PROVIDER_LABEL[payload.provider]}</dd>
        </div>
        <div>
          <dt>Modelo</dt>
          <dd className="mono">{payload.model}</dd>
        </div>
        <div>
          <dt>Formato</dt>
          <dd>{payload.aspect}</dd>
        </div>
        <div>
          <dt>Quantidade</dt>
          <dd>{payload.quantity}</dd>
        </div>
        {payload.durationSeconds !== undefined && (
          <div>
            <dt>Duração</dt>
            <dd>{payload.durationSeconds} s</dd>
          </div>
        )}
        {params.map(([key, value]) => (
          <div key={key}>
            <dt className="mono">{key}</dt>
            <dd>{typeof value === 'boolean' ? (value ? 'sim' : 'não') : String(value)}</dd>
          </div>
        ))}
        {payload.referenceAssetId && (
          <div>
            <dt>Imagem enviada</dt>
            <dd>
              {payload.kind === 'video'
                ? 'Primeiro quadro'
                : MEDIA_IMAGE_USE_LABEL[payload.referenceUse]}
            </dd>
          </div>
        )}
        {payload.textInImage && (
          <div>
            <dt>Texto na imagem</dt>
            <dd>{payload.textInImage}</dd>
          </div>
        )}
      </dl>
      {payload.referenceAssetId && (
        <div className="agent-card-media" aria-label="Imagem que vai junto com o pedido">
          <MediaThumb
            asset={{
              kind: 'image',
              downloadPath: `/media/assets/${payload.referenceAssetId}/file`,
            }}
          />
        </div>
      )}
      <details className="agent-details">
        <summary>Prompt enviado ao modelo</summary>
        <p className="agent-text mono" lang="en">
          {payload.prompt}
        </p>
        {payload.negativePrompt && (
          <p className="agent-text mono" lang="en">
            Evitar: {payload.negativePrompt}
          </p>
        )}
      </details>

      {generation?.status === 'succeeded' && generation.assetIds.length > 0 && (
        <div className="agent-card-media">
          {generation.assetIds.map((assetId, index) => (
            <Link
              key={assetId}
              to="/marketing/edicao"
              aria-label={`Mídia gerada ${index + 1} de ${generation.assetIds.length}: ver na biblioteca`}
            >
              <MediaThumb
                asset={{ kind: generation.kind, downloadPath: `/media/assets/${assetId}/file` }}
              />
            </Link>
          ))}
        </div>
      )}
      {proposal.generationId ? (
        <p className="agent-card-state" role="status">
          {generation ? GENERATION_STATUS_LABEL[generation.status] : 'Acompanhando a geração…'}
          {generation?.detail && ` ${generation.detail}`}
          {generation?.status === 'unknown' &&
            ` Confira no ${MEDIA_PROVIDER_LABEL[generation.providerId]} antes de gerar de novo.`}{' '}
          {generation &&
            isGenerationOver(generation.status) &&
            generation.status === 'succeeded' && (
              <Link to="/marketing/edicao">Ver na biblioteca</Link>
            )}
        </p>
      ) : estimate === null ? (
        <p className="field-hint">Não foi possível estimar o custo. Peça de novo.</p>
      ) : (
        <>
          <p className="agent-card-cost">
            Custo estimado: {priceOf(estimate)} · {MEDIA_PROVIDER_LABEL[estimate.providerId]}
          </p>
          {canGenerate ? (
            <Button
              type="button"
              disabled={start.isPending}
              onClick={() =>
                start.mutate(
                  { estimateId: estimate.id, proposalId: proposal.id },
                  {
                    onSuccess: (body) =>
                      onActed({
                        ...proposal,
                        status: 'requested',
                        generationId: body.generation.id,
                      }),
                  },
                )
              }
            >
              Gerar ({priceOf(estimate)})
            </Button>
          ) : (
            <p className="field-hint">Você não tem permissão para gerar mídia.</p>
          )}
        </>
      )}
      {start.error && (
        <p className="field-error" role="alert">
          {start.error instanceof ApiError
            ? start.error.message
            : 'Não foi possível iniciar a geração.'}
        </p>
      )}
    </article>
  );
}

/**
 * What a timeline card needs from the Studio around it. Null where the editor
 * is not on screen (the media page without the Studio): the card then says so.
 */
export interface TimelineEditBridge {
  /** The card now previewed on the timeline, if any. */
  previewing: string | null;
  /** Cards kept in this session, by "Aplicar" or by editing on after the preview. */
  kept: readonly string[];
  preview(card: AgentTimelineEditProposalCard): Promise<boolean>;
  keep(): void;
  discard(): Promise<void>;
}

export const TimelineEditContext = createContext<TimelineEditBridge | null>(null);

/**
 * Changes to the timeline, one line each, written by the server. The card
 * does nothing by being on screen: "Pré-visualizar" puts them on the timeline
 * as one step, "Aplicar" keeps that step and "Descartar" takes it back.
 */
function TimelineEditCard({
  proposal,
  onActed,
}: {
  proposal: AgentTimelineEditProposalCard;
  onActed: (next: AgentProposalCard) => void;
}) {
  const bridge = useContext(TimelineEditContext);
  const [working, setWorking] = useState(false);
  const previewing = bridge?.previewing === proposal.id;
  const applied = proposal.status === 'applied' || (bridge?.kept.includes(proposal.id) ?? false);

  return (
    <article className="agent-card" aria-label="Proposta de edição">
      <header className="agent-card-head">
        <span className="agent-card-kind">Proposta de edição</span>
      </header>
      <p>{proposal.payload.explanation}</p>
      <ol className="agent-card-lines" aria-label="O que muda na linha do tempo">
        {proposal.payload.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      {!bridge ? (
        <p className="field-hint">
          Abra o Studio (Edição de fotos e vídeos) para pré-visualizar esta edição.
        </p>
      ) : previewing ? (
        <>
          <p className="agent-card-state" role="status">
            Prévia na tela. Aplicar mantém como um passo (Ctrl+Z desfaz); Descartar volta ao que
            era.
          </p>
          <div className="agent-card-actions">
            <Button
              type="button"
              onClick={() => {
                bridge.keep();
                onActed({ ...proposal, status: 'applied' });
              }}
            >
              Aplicar
            </Button>
            <Button type="button" variant="ghost" onClick={() => void bridge.discard()}>
              Descartar
            </Button>
          </div>
        </>
      ) : (
        <>
          {applied && (
            <p className="agent-card-state" role="status">
              Aplicada. Ctrl+Z na linha do tempo desfaz, se ainda for a última mudança.
            </p>
          )}
          <Button
            type="button"
            variant={applied ? 'ghost' : undefined}
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await bridge.preview(proposal);
              } finally {
                setWorking(false);
              }
            }}
          >
            {applied ? 'Pré-visualizar de novo' : 'Pré-visualizar'}
          </Button>
        </>
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
  onApplyCampaign?: ApplyCampaign;
  /** The card as it stands after a click, so the panel can keep showing it that way. */
  onActed: (next: AgentProposalCard) => void;
}) {
  if (proposal.kind === 'generation')
    return <GenerationCard proposal={proposal} onActed={onActed} />;
  if (proposal.kind === 'timeline_edit')
    return <TimelineEditCard proposal={proposal} onActed={onActed} />;
  return proposal.kind === 'campaign' ? (
    <CampaignCard proposal={proposal} onApplyCampaign={onApplyCampaign} onActed={onActed} />
  ) : (
    <ChangeCard proposal={proposal} canRequest={canRequest} onActed={onActed} />
  );
}
