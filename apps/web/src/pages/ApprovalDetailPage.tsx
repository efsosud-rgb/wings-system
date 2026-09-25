import {
  APPROVAL_STATUS_LABEL,
  APPROVAL_TRIGGER_LABEL,
  CAMPAIGN_OBJECTIVE_LABEL,
  CHANGE_KIND_LABEL,
  CHANGE_STATUS_LABEL,
  CREATIVE_FORMATS,
  CREATIVE_TYPE_LABEL,
  PLACEMENT_POSITION_LABEL,
  PLACEMENT_PUBLISHERS,
  PLACEMENT_PUBLISHER_LABEL,
  PREVIEW_PLACEMENTS,
  PREVIEW_PLACEMENT_LABEL,
  applyUtms,
  campaignDays,
  describeReach,
  estimateCostCents,
  SEARCH_BIDDING_LABEL,
  SEARCH_LOCATION_MODE_LABEL,
  isGooglePlatform,
  parseSearchKeyword,
  type ApprovalDetail,
  type CampaignDraft,
  type ExecutionStepView,
  type PreviewPlacement,
} from '@wings/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import {
  useApproval,
  useDecideApproval,
  useExecuteApproval,
  useOfficialPreviews,
  usePreflightApproval,
  useRequestCampaignChange,
} from '../api/ads.js';
import { ApiError } from '../api/client.js';
import { ApprovalSimulator } from '../components/ApprovalSimulator.js';
import { AdPreviewGallery } from '../components/campaign-builder/AdPreview.js';
import { SearchAdPreview, YoutubePreview } from '../components/campaign-builder/GooglePreview.js';
import { Alert, Button, Field, Input } from '../components/ui.js';

function formatBrl(cents: number | null): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

const AUDIT_LABEL: Record<string, string> = {
  'ads.approval_requested': 'Solicitação registrada',
  'ads.approval_escalated': 'Escalada para a Diretoria',
  'ads.approval_granted': 'Aprovada',
  'ads.approval_rejected': 'Recusada',
  'ads.approval_denied_to_actor': 'Tentativa de decisão sem permissão',
  'ads.preflight': 'Validação prévia na plataforma (sem escrever)',
};

/**
 * What the executor created on the platform, or tried to. A create is several
 * writes in a row, so after a failure in the middle this list is how a person
 * sees what exists there.
 */
const STEP_STATUS_LABEL: Record<ExecutionStepView['status'], string> = {
  created: 'criado',
  failed: 'falhou',
  unknown: 'desconhecido',
};

function ExecutionSteps({
  steps,
  platform,
}: {
  steps: ExecutionStepView[];
  platform: ApprovalDetail['platform'];
}) {
  if (steps.length === 0) return null;
  return (
    <div className="execution-steps">
      <span className="field-label">
        O que foi criado {platform === 'google' ? 'no Google' : 'na Meta'}
      </span>
      <ol>
        {[...steps]
          .sort((a, b) => a.seq - b.seq)
          .map((step) => (
            <li key={step.seq} className={`execution-step execution-step-${step.status}`}>
              <strong>{step.label}</strong> — {STEP_STATUS_LABEL[step.status]}
              {step.externalId && <span className="cell-sub mono"> id {step.externalId}</span>}
              {step.message && <span className="cell-sub"> {step.message}</span>}
            </li>
          ))}
      </ol>
    </div>
  );
}

/** Meta's own iframes only: anything else is not rendered at all. */
const OFFICIAL_PREVIEW_HOSTS = ['https://www.facebook.com/', 'https://business.facebook.com/'];

/**
 * Meta's official preview, per placement. It only exists once the ads do, so
 * this is asked for after execution; before that the approximate one stands.
 */
function OfficialPreviews({ approvalId }: { approvalId: string }) {
  const [placement, setPlacement] = useState<PreviewPlacement>('facebook_feed');
  const query = useOfficialPreviews(approvalId, placement, true);
  const failure = query.error instanceof ApiError ? query.error : null;
  const previews = query.data?.previews ?? [];
  const trusted = previews.filter((preview) =>
    OFFICIAL_PREVIEW_HOSTS.some((host) => preview.iframeSrc.startsWith(host)),
  );

  return (
    <section className="block">
      <legend>Prévia oficial da Meta</legend>
      <Field label="Posicionamento">
        <select
          className="control"
          value={placement}
          onChange={(event) => setPlacement(event.target.value as PreviewPlacement)}
        >
          {PREVIEW_PLACEMENTS.map((key) => (
            <option key={key} value={key}>
              {PREVIEW_PLACEMENT_LABEL[key]}
            </option>
          ))}
        </select>
      </Field>
      {query.isLoading && <p className="muted">Pedindo a prévia à Meta…</p>}
      {failure?.code === 'not_created_yet' && (
        <Alert kind="info">Os anúncios ainda não existem na Meta.</Alert>
      )}
      {query.isError && failure?.code !== 'not_created_yet' && (
        <Alert kind="error">
          {query.error.message} A prévia aproximada acima continua valendo.
        </Alert>
      )}
      {query.data && trusted.length < previews.length && (
        <Alert kind="error">Uma prévia não pôde ser exibida: o endereço não é da Meta.</Alert>
      )}
      {query.data && previews.length === 0 && (
        <p className="muted">A Meta não devolveu prévia para este posicionamento.</p>
      )}
      <div className="official-previews">
        {trusted.map((preview) => (
          <figure key={preview.adName} className="official-preview">
            <figcaption className="field-label">{preview.adName}</figcaption>
            <iframe
              title={preview.adName}
              src={preview.iframeSrc}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </figure>
        ))}
      </div>
    </section>
  );
}

function describeDraftPlacements(placements: NonNullable<CampaignDraft['placements']>): string {
  if (placements.mode !== 'manual') return 'Automático (Advantage+)';
  return PLACEMENT_PUBLISHERS.flatMap((publisher) =>
    placements[publisher].length === 0
      ? []
      : [
          `${PLACEMENT_PUBLISHER_LABEL[publisher]}: ${placements[publisher]
            .map((position) => PLACEMENT_POSITION_LABEL[position])
            .join(', ')}`,
        ],
  ).join(' · ');
}

function Summary({ approval }: { approval: ApprovalDetail }) {
  const budgetChange =
    approval.changeKind === 'set_daily_budget'
      ? `${formatBrl(approval.fromValueCents)} → ${formatBrl(approval.toValueCents)} por dia`
      : (CHANGE_KIND_LABEL[approval.changeKind] ?? approval.changeKind);

  return (
    <section className="block">
      <legend>O que está sendo decidido</legend>
      <div className="grid-3 readonly">
        <div>
          <span className="field-label">Alteração</span>
          <p>{budgetChange}</p>
        </div>
        <div>
          <span className="field-label">Exposição até o fim do mês</span>
          <p className="mono">{formatBrl(approval.amountCents)}</p>
        </div>
        <div>
          <span className="field-label">Motivo da aprovação</span>
          <p>{APPROVAL_TRIGGER_LABEL[approval.trigger]}</p>
        </div>
        <div>
          <span className="field-label">Conta</span>
          <p>
            {approval.platform.toUpperCase()} — {approval.accountName}
          </p>
          <span className="cell-sub">{approval.accountExternalId}</span>
        </div>
        <div>
          <span className="field-label">Campanha</span>
          <p>{approval.campaignName}</p>
          <span className="cell-sub">
            orçamento{' '}
            {approval.budgetLevel === 'ad_set'
              ? 'no conjunto de anúncios (ABO)'
              : approval.budgetLevel === 'campaign'
                ? 'na campanha (CBO)'
                : 'não definido'}
          </span>
        </div>
        <div>
          <span className="field-label">Solicitado por</span>
          <p>
            {approval.requestedByAgent
              ? 'Agente de tráfego pago'
              : (approval.requestedByName ?? '—')}
          </p>
          {approval.suggestedByAgent && <span className="tag tag-agent">sugerido pelo agente</span>}
          <span className="cell-sub">{formatDateTime(approval.requestedAt)}</span>
        </div>
      </div>
      {approval.requestReason && (
        <p className="field-hint">Justificativa: {approval.requestReason}</p>
      )}
    </section>
  );
}

/**
 * The campaign being asked for, whole. An approval of a creation is bound to
 * exactly this, so the approver reads everything the requester submitted.
 */
function DraftCampaign({ draft }: { draft: CampaignDraft }) {
  const days = campaignDays(draft.startDate, draft.endDate) ?? 0;
  const format = CREATIVE_FORMATS[draft.platform].find((item) => item.key === draft.formatKey);
  const google = isGooglePlatform(draft.platform);
  const date = (value: string) => value.split('-').reverse().join('/');
  // A Meta draft from before ad sets existed names no page: it creates the
  // campaign alone, exactly as it was approved to.
  const metaTree = !google && Boolean(draft.identity);

  return (
    <section className="block">
      <legend>A campanha que será criada</legend>
      {metaTree ? (
        <Alert kind="info">
          Tudo nasce <strong>pausado</strong>: a campanha, um conjunto de anúncios e um anúncio por
          variação. Nada entrega e nada gasta até alguém ligar no Gerenciador de Anúncios.
        </Alert>
      ) : draft.platform === 'google_search' && draft.search ? (
        <Alert kind="info">
          Tudo nasce <strong>pausado</strong>: a campanha, o grupo de anúncios e o anúncio, numa
          única escrita atômica no Google (ou entra tudo, ou nada). Não entrega e não gasta.
          Ativar é um pedido de <strong>retomada</strong>, com aprovação própria, que liga os três.
        </Alert>
      ) : draft.startPaused ? (
        <Alert kind="info">
          Nasce <strong>pausada</strong> e vazia: só o objeto campanha é criado, sem{' '}
          {google ? 'grupo' : 'conjunto'} de anúncios e sem anúncio. Não entrega e não gasta. Ativar
          depois é outro pedido.
          {!google && ' Pedido anterior aos conjuntos de anúncios: cria só a campanha.'}
        </Alert>
      ) : (
        <Alert kind="error">
          Nasce <strong>ativa</strong>. Nesta fase só o objeto campanha é criado — sem conjunto de
          anúncios ela ainda não entrega —, mas a verba abaixo já fica reservada no mês.
        </Alert>
      )}
      <div className="grid-3 readonly">
        <div>
          <span className="field-label">Objetivo</span>
          <p>{CAMPAIGN_OBJECTIVE_LABEL[draft.objective]}</p>
        </div>
        <div>
          <span className="field-label">Duração</span>
          <p>
            {date(draft.startDate)} a {date(draft.endDate)}
          </p>
          <span className="cell-sub">{days} dias</span>
        </div>
        <div>
          <span className="field-label">Verba diária</span>
          <p className="mono">{formatBrl(draft.dailyBudgetCents)}</p>
          <span className="cell-sub">
            custo total estimado{' '}
            {formatBrl(estimateCostCents(draft.dailyBudgetCents, days, draft.platform))}
          </span>
        </div>
        {!google && (
          <div>
            <span className="field-label">Formato</span>
            <p>{format ? `${format.label} (${format.ratio})` : draft.formatKey}</p>
          </div>
        )}
        {metaTree && draft.identity && (
          <>
            <div>
              <span className="field-label">Faixa etária</span>
              <p>
                {draft.ageMin ?? '—'} a {draft.ageMax ?? '—'} anos
              </p>
            </div>
            <div>
              <span className="field-label">Posicionamentos</span>
              <p>{draft.placements ? describeDraftPlacements(draft.placements) : '—'}</p>
            </div>
            <div>
              <span className="field-label">Página e Instagram</span>
              <p className="mono">Página {draft.identity.pageId}</p>
              <span className="cell-sub mono">
                {draft.identity.instagramActorId
                  ? `Instagram ${draft.identity.instagramActorId}`
                  : 'sem conta do Instagram'}
              </span>
            </div>
            <div>
              <span className="field-label">Criativos</span>
              {draft.variations.map((variation, index) => (
                <p key={index}>
                  {index + 1}. {CREATIVE_TYPE_LABEL[variation.creativeType ?? 'image']}
                  {variation.creativeType === 'carousel' &&
                    ` (${(variation.cards ?? []).length} cartões)`}
                </p>
              ))}
            </div>
          </>
        )}
        {draft.platform === 'youtube' && (
          <div>
            <span className="field-label">Tipo no Google</span>
            <p>Demand Gen, restrita ao YouTube</p>
            <span className="cell-sub mono builder-url">{draft.youtube?.videoUrl}</span>
          </div>
        )}
        {draft.platform === 'google_search' && (
          <div>
            <span className="field-label">Tipo no Google</span>
            <p>Pesquisa (só a rede de pesquisa do Google)</p>
            {draft.search && (
              <span className="cell-sub">Grupo de anúncios: {draft.search.adGroupName?.trim() || draft.name}</span>
            )}
          </div>
        )}
        <div>
          <span className="field-label">Destino com UTMs</span>
          <p className="mono builder-url">{applyUtms(draft.destinationUrl, draft.utms, 0)}</p>
        </div>
      </div>
      <div className="readonly draft-audience">
        <span className="field-label">Cliente ideal</span>
        <p>{draft.idealCustomerProfile}</p>
        <span className="field-label">Área de alcance</span>
        <p>{describeReach(draft.reach)}</p>
        {draft.search && (
          <>
            <span className="field-label">Palavras-chave (grupo de anúncios)</span>
            <p>{draft.search.keywords.join(' · ')}</p>
            <span className="cell-sub">
              {describeMatches(draft.search.keywords)} · [colchetes] = exata, “aspas” = frase; ampla
              não é usada
            </span>
            <span className="field-label">Rede · local · lance</span>
            <p>
              Só Pesquisa do Google (sem parceiros, sem Display) ·{' '}
              {SEARCH_LOCATION_MODE_LABEL[draft.search.locationMode ?? 'presence']} ·{' '}
              {SEARCH_BIDDING_LABEL[draft.search.bidding ?? 'maximize_clicks']}
              {(draft.search.bidding ?? 'maximize_clicks') === 'maximize_clicks' &&
                ` de ${formatBrl(draft.search.maxCpcCents ?? null)}`}
            </p>
            <span className="field-label">Palavras-chave negativas (campanha, correspondência de frase)</span>
            <p>{draft.search.negativeKeywords.join(' · ') || '—'}</p>
            <span className="field-label">Títulos ({draft.search.headlines.length})</span>
            <p>{draft.search.headlines.join(' | ')}</p>
            <span className="field-label">Descrições ({draft.search.descriptions.length})</span>
            <p>{draft.search.descriptions.join(' ')}</p>
          </>
        )}
        <span className="cell-sub">
          {draft.platform === 'google_search'
            ? 'Vai tudo para o Google na mesma escrita: estados, cidades e raio na campanha (presença), idioma português, negativas na campanha, palavras-chave e anúncio responsivo no grupo. Antes de escrever, o executor valida a solicitação inteira com validateOnly.'
            : draft.platform === 'youtube'
              ? 'Registrado no pedido. Em Demand Gen, localização, idioma e a restrição ao YouTube moram no grupo de anúncios: só chegam ao Google quando existir a criação dele.'
              : metaTree
                ? 'Área de alcance, faixa etária e idioma português vão para a Meta no conjunto de anúncios, criado junto com a campanha.'
                : 'Registrado no pedido. Público e localização só chegam à Meta quando existir a criação do conjunto de anúncios.'}
        </span>
      </div>
      {draft.youtube && (
        <YoutubePreview
          videoUrl={draft.youtube.videoUrl}
          headline={draft.youtube.headline}
          destinationUrl={draft.destinationUrl}
        />
      )}
      {draft.search && (
        <SearchAdPreview
          headlines={draft.search.headlines}
          descriptions={draft.search.descriptions}
          destinationUrl={draft.destinationUrl}
        />
      )}
      {!google && (
        <AdPreviewGallery
          variations={draft.variations}
          destinationUrl={draft.destinationUrl}
          format={format}
        />
      )}
    </section>
  );
}

/** "2 exatas, 1 frase" — what the approver is agreeing to bid on. */
function describeMatches(keywords: string[]): string {
  const exact = keywords.filter((item) => parseSearchKeyword(item)?.match === 'exact').length;
  const phrase = keywords.filter((item) => parseSearchKeyword(item)?.match === 'phrase').length;
  const parts = [];
  if (exact > 0) parts.push(`${exact} exata${exact === 1 ? '' : 's'}`);
  if (phrase > 0) parts.push(`${phrase} frase${phrase === 1 ? '' : 's'}`);
  return parts.join(', ') || 'sem correspondência marcada';
}

/**
 * The rehearsal: Google checks the exact request against the real account and
 * writes nothing. Offered before and after the decision, with writes on or
 * off — a refusal here is what the executor would have met at the click.
 */
function Preflight({ approvalId }: { approvalId: string }) {
  const preflight = usePreflightApproval(approvalId);
  const answer = preflight.data;
  const failure = preflight.error instanceof ApiError ? preflight.error : null;
  return (
    <section className="block">
      <legend>Validação prévia no Google (validateOnly)</legend>
      <p className="field-hint">
        Envia ao Google a solicitação exata, marcada para <strong>só validar</strong>: a conta real
        confere cada campo e nada é criado nem alterado. Pode ser feita antes da aprovação e não
        depende da chave de escrita.
      </p>
      {failure && <Alert kind="error">{failure.message}</Alert>}
      {answer?.status === 'ok' && (
        <Alert kind="success">
          O Google aceitou a solicitação inteira ({answer.operations?.length ?? 0} operações). Nada
          foi escrito.
          {answer.operations && answer.operations.length > 0 && (
            <ul className="preflight-operations">
              {answer.operations.map((label, index) => (
                <li key={`${label}-${index}`}>{label}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {answer?.status === 'rejected' && (
        <Alert kind="error">
          O Google recusaria esta solicitação ({answer.code}): {answer.message}. Nada foi escrito.
          Corrija o pedido e faça um novo.
        </Alert>
      )}
      {answer?.status === 'unavailable' && (
        <Alert kind="error">
          O Google não respondeu à validação ({answer.reason}). Nada foi validado; tente de novo.
        </Alert>
      )}
      <div className="form-actions">
        <Button
          type="button"
          variant="ghost"
          disabled={preflight.isPending}
          onClick={() => void preflight.mutateAsync()}
        >
          {preflight.isPending ? 'Validando…' : 'Validar no Google (sem escrever)'}
        </Button>
      </div>
    </section>
  );
}

/**
 * What comes after a campaign exists: switching it on and changing its
 * budget are requests of their own, each with its approval and its click.
 * Nothing here touches the platform; it only files the request.
 */
function NextRequests({ approval }: { approval: ApprovalDetail }) {
  const request = useRequestCampaignChange();
  const [reason, setReason] = useState('');
  const [budgetText, setBudgetText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const failure = request.error instanceof ApiError ? request.error : null;

  const file = async (kind: 'resume_campaign' | 'pause_campaign' | 'set_daily_budget') => {
    setProblem(null);
    if (reason.trim().length < 3) {
      setProblem('Informe o motivo do pedido');
      return;
    }
    let toDailyBudgetCents: number | undefined;
    if (kind === 'set_daily_budget') {
      const value = Number(budgetText.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0) {
        setProblem('Informe o novo orçamento diário, como 30,00');
        return;
      }
      toDailyBudgetCents = Math.round(value * 100);
    }
    await request.mutateAsync({
      accountExternalId: approval.accountExternalId,
      campaignExternalId: approval.campaignExternalId,
      kind,
      toDailyBudgetCents,
      reason: reason.trim(),
    });
  };

  return (
    <section className="block">
      <legend>Próximos pedidos sobre esta campanha</legend>
      <p className="field-hint">
        A campanha existe {approval.platform === 'google' ? 'no Google' : 'na Meta'}, pausada. Cada
        pedido abaixo passa pela mesma aprovação e pelo mesmo clique de execução.
        {approval.platform === 'google' &&
          ' “Ativar” liga a campanha, o grupo de anúncios e o anúncio criados pelo sistema.'}
      </p>
      {request.isSuccess && request.data.approvalId && (
        <Alert kind="success">
          Pedido registrado.{' '}
          <Link to={`/marketing/trafego-pago-wings/aprovacoes/${request.data.approvalId}`}>
            Abrir a aprovação
          </Link>
        </Alert>
      )}
      {failure && <Alert kind="error">{failure.message}</Alert>}
      <Field label="Motivo" error={problem ?? undefined}>
        <Input
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ex.: lançamento aprovado pela Diretoria"
        />
      </Field>
      <Field label="Novo orçamento diário (R$)" hint="Só para o pedido de orçamento.">
        <Input
          inputMode="decimal"
          value={budgetText}
          onChange={(event) => setBudgetText(event.target.value)}
          placeholder="30,00"
        />
      </Field>
      <div className="form-actions">
        <Button type="button" disabled={request.isPending} onClick={() => void file('resume_campaign')}>
          Pedir ativação da campanha
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={request.isPending}
          onClick={() => void file('set_daily_budget')}
        >
          Pedir novo orçamento diário
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={request.isPending}
          onClick={() => void file('pause_campaign')}
        >
          Pedir pausa
        </Button>
      </div>
    </section>
  );
}

function PeriodContext({ approval }: { approval: ApprovalDetail }) {
  const remaining = Math.max(
    0,
    Math.min(
      approval.periodUsableCents - approval.periodCommittedCents,
      approval.periodCapCents - approval.periodSpentCents - approval.periodCommittedCents,
    ),
  );
  return (
    <section className="block">
      <legend>Orçamento do mês nesta conta</legend>
      <div className="grid-3 readonly">
        <div>
          <span className="field-label">Teto</span>
          <p className="mono">{formatBrl(approval.periodCapCents)}</p>
        </div>
        <div>
          <span className="field-label">Utilizável (70%)</span>
          <p className="mono">{formatBrl(approval.periodUsableCents)}</p>
        </div>
        <div>
          <span className="field-label">Já gasto</span>
          <p className="mono">{formatBrl(approval.periodSpentCents)}</p>
        </div>
        <div>
          <span className="field-label">Comprometido</span>
          <p className="mono">{formatBrl(approval.periodCommittedCents)}</p>
        </div>
        <div>
          <span className="field-label">Ainda disponível</span>
          <p className="mono">{formatBrl(remaining)}</p>
        </div>
      </div>
    </section>
  );
}

export function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: user } = useSession();
  const query = useApproval(id);
  const decide = useDecideApproval(id ?? '');
  const execute = useExecuteApproval(id ?? '');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const approval = query.data?.approval;
  const canDecide = hasPermission(user, 'ads.approve');
  const canRequest = hasPermission(user, 'ads.request');
  const open = approval?.status === 'pending' || approval?.status === 'escalated';

  if (query.isLoading) return <div className="page-loading">Carregando…</div>;
  if (query.isError || !approval) {
    return (
      <>
        <header className="page-header">
          <h1>Aprovação</h1>
        </header>
        <Alert kind="error">Solicitação não encontrada.</Alert>
        <p>
          <Link to="/marketing/trafego-pago-wings/aprovacoes">Voltar às aprovações</Link>
        </p>
      </>
    );
  }

  const submit = async (decision: 'approved' | 'rejected') => {
    setReasonError(null);
    // Rejecting requires a reason; approving does not.
    if (decision === 'rejected' && reason.trim().length < 3) {
      setReasonError('Informe o motivo da recusa');
      return;
    }
    await decide.mutateAsync({ decision, reason: reason.trim() || undefined });
  };

  const failure = decide.error instanceof ApiError ? decide.error : null;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Aprovação de orçamento</h1>
          <p>
            {APPROVAL_STATUS_LABEL[approval.status]}
            {approval.escalatedAt && ` · escalada em ${formatDateTime(approval.escalatedAt)}`}
          </p>
        </div>
        <Link to="/marketing/trafego-pago-wings/aprovacoes" className="btn btn-ghost btn-inline">
          Voltar
        </Link>
      </header>

      {approval.notificationError && (
        <Alert kind="error">
          A notificação por WhatsApp falhou ({approval.notificationError}). A solicitação continua
          aguardando decisão.
        </Alert>
      )}

      <Summary approval={approval} />
      {approval.draft && <DraftCampaign draft={approval.draft} />}
      {approval.platform === 'google' &&
        approval.changeKind === 'resume_campaign' &&
        approval.changeStatus !== 'executed' && (
          <Alert kind="info">
            Retomar no Google liga a campanha <strong>e</strong> o grupo de anúncios e o anúncio
            que o sistema criou pausados com ela. A partir daí ela entrega e gasta.
          </Alert>
        )}
      <PeriodContext approval={approval} />
      {id &&
        canRequest &&
        approval.platform === 'google' &&
        (approval.changeStatus === 'pending_approval' || approval.changeStatus === 'approved') && (
          <Preflight approvalId={id} />
        )}
      {/* The simulator explores budgets of a campaign that exists; a draft has none yet. */}
      {id && !approval.draft && <ApprovalSimulator approvalId={id} />}

      {open && canDecide && (
        <section className="block">
          <legend>Sua decisão</legend>
          <Field
            label="Motivo"
            error={reasonError ?? undefined}
            hint="Obrigatório para recusar; opcional para aprovar."
          >
            <Input
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: dentro do plano do mês"
            />
          </Field>

          {failure && <Alert kind="error">{failure.message}</Alert>}

          <div className="form-actions">
            <Button
              type="button"
              disabled={decide.isPending}
              onClick={() => void submit('approved')}
            >
              {decide.isPending ? 'Enviando…' : 'Aprovar'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => void submit('rejected')}
            >
              Recusar
            </Button>
          </div>
        </section>
      )}

      {open && !canDecide && (
        <Alert kind="info">
          Apenas Admin Master ou Diretoria podem decidir sobre alterações de orçamento.
        </Alert>
      )}

      {!open && (
        <Alert kind={approval.status === 'approved' ? 'success' : 'info'}>
          {APPROVAL_STATUS_LABEL[approval.status]}
          {approval.decidedByName && ` por ${approval.decidedByName}`}
          {approval.decidedAt && ` em ${formatDateTime(approval.decidedAt)}`}
          {approval.decisionReason && ` — “${approval.decisionReason}”`}
        </Alert>
      )}

      {approval.status === 'approved' && (
        <section className="block">
          <legend>Execução na plataforma</legend>
          <p className="field-hint">
            Situação da alteração: <strong>{CHANGE_STATUS_LABEL[approval.changeStatus]}</strong>
            {approval.executedAt && ` · ${formatDateTime(approval.executedAt)}`}
          </p>

          {approval.changeStatus === 'approved' && canDecide && (
            <>
              {!approval.executionAvailable && (
                <Alert kind="info">
                  A execução em contas reais está desligada nesta configuração. A aprovação fica
                  registrada e nada é enviado{' '}
                  {approval.platform === 'google' ? 'ao Google' : 'ao Meta'}.
                </Alert>
              )}
              {execute.isError && (
                <Alert kind="error">
                  {execute.error instanceof ApiError
                    ? execute.error.message
                    : 'Não foi possível executar.'}
                </Alert>
              )}
              {execute.isSuccess && <Alert kind="success">Alteração aplicada na plataforma.</Alert>}
              <div className="form-actions">
                <Button
                  type="button"
                  disabled={execute.isPending || !approval.executionAvailable}
                  onClick={() => void execute.mutateAsync()}
                >
                  {execute.isPending
                    ? 'Executando…'
                    : approval.platform === 'google'
                      ? 'Executar no Google'
                      : 'Executar no Meta'}
                </Button>
                <span className="field-hint">
                  Esta ação altera a campanha real e movimenta dinheiro.
                </span>
              </div>
            </>
          )}

          {approval.changeStatus === 'unknown' && (
            <Alert kind="error">
              A plataforma não confirmou o resultado da última tentativa. A conta foi congelada:
              verifique no Gerenciador de Anúncios antes de tentar de novo.
            </Alert>
          )}

          {approval.changeStatus === 'executed' && (
            <Alert kind="success">Alteração já aplicada na plataforma.</Alert>
          )}

          <ExecutionSteps steps={approval.executionSteps ?? []} platform={approval.platform} />
        </section>
      )}

      {canRequest &&
        approval.changeKind === 'create_campaign' &&
        approval.changeStatus === 'executed' &&
        approval.campaignExternalId !== '' && <NextRequests approval={approval} />}

      {id &&
        approval.changeStatus === 'executed' &&
        approval.platform !== 'google' &&
        approval.draft?.identity && <OfficialPreviews approvalId={id} />}

      <section className="block">
        <legend>Trilha de auditoria</legend>
        {approval.auditTrail.length === 0 ? (
          <p className="muted">Sem registros.</p>
        ) : (
          <ol className="audit-trail">
            {approval.auditTrail.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <strong>{AUDIT_LABEL[entry.action] ?? entry.action}</strong>
                <span className="cell-sub">
                  {formatDateTime(entry.at)}
                  {entry.actorName ? ` · ${entry.actorName}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
