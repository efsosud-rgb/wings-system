import {
  LEAD_CHANNEL_LABELS,
  LEAD_LEGAL_BASIS_LABELS,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_LABELS,
  type Lead,
  type LeadEvent,
  type ScoreCriterion,
} from '@wings/shared';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useLead, useResearchLead } from '../api/leads.js';
import { Alert, Button } from '../components/ui.js';
import { formatDateTime, formatPhone, RESEARCH_LABELS, sinceLabel } from './LeadsPage.js';

/**
 * One lead: who, the Origem block (client, channel, landing page or
 * campaign), the Pesquisa block (summary, score with its reasons, links,
 * "Refazer pesquisa") and the LGPD block (legal basis and when consent was
 * given). Everything here is what the API stored; the screen decides nothing.
 */

const EVENT_LABELS: Record<string, string> = {
  'lead.received.rd_station': 'Conversão recebida do RD Station',
  'lead.received.whatsapp': 'Mensagem recebida no WhatsApp pelo link rastreável',
  'lead.received.meta_lead_ads': 'Cadastro recebido do Meta Lead Ads',
  'lead.created_manually': 'Cadastrado manualmente',
  'research.queued': 'Pesquisa colocada na fila',
  'research.started': 'Pesquisa iniciada',
  'research.done': 'Pesquisa concluída',
  'research.failed': 'Pesquisa falhou',
  'lead.imported.rd_crm': 'Trazido do RD CRM',
  'rd.deal_created': 'Negócio criado no RD CRM pela entrada automática',
  'rd.other_deal': 'Outro negócio da mesma pessoa no RD CRM',
};

function RdCrm({ lead }: { lead: Lead }) {
  const crm = lead.crm;
  return (
    <fieldset className="block">
      <legend>No RD CRM</legend>
      {!crm ? (
        <p className="muted">Sem negócio no RD CRM ligado a este lead.</p>
      ) : (
        <>
          <dl className="lead-facts">
            <dt>Funil</dt>
            <dd>
              {lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}
              {crm.rdPipeline && <span className="cell-sub"> ({crm.rdPipeline} no RD)</span>}
            </dd>
            {lead.brand && (
              <>
                <dt>Marca</dt>
                <dd>{lead.brand}</dd>
              </>
            )}
            <dt>Etapa</dt>
            <dd>
              {crm.stage ?? '—'}
              {crm.won === true && <span className="status status-active"> Ganho</span>}
              {crm.won === false && <span className="status status-inactive"> Perdido</span>}
            </dd>
            <dt>Na etapa desde</dt>
            <dd>
              {crm.stageChangedAt
                ? `${formatDateTime(crm.stageChangedAt)} (${sinceLabel(crm.stageChangedAt)})`
                : '— (histórico ainda não lido)'}
            </dd>
            <dt>1º contato</dt>
            <dd>{crm.firstContactAt ? formatDateTime(crm.firstContactAt) : '—'}</dd>
            <dt>Dono</dt>
            <dd>{crm.ownerName ?? '— (usuário do RD sem funcionário ligado)'}</dd>
            {crm.won === false && (
              <>
                <dt>Motivo da perda</dt>
                <dd>{crm.lostReason ?? '—'}</dd>
              </>
            )}
            {crm.closedAt && (
              <>
                <dt>Fechado em</dt>
                <dd>{formatDateTime(crm.closedAt)}</dd>
              </>
            )}
          </dl>
          <p className="muted">
            Etapa lida do RD {sinceLabel(crm.syncedAt)}. O trabalho continua no RD CRM até a virada:{' '}
            <a href={crm.rdUrl} target="_blank" rel="noopener noreferrer">
              abrir o negócio no RD
            </a>
            .
          </p>
        </>
      )}
    </fieldset>
  );
}

function Criterion({ criterion }: { criterion: ScoreCriterion }) {
  const percent =
    criterion.evaluated && criterion.max > 0
      ? Math.round((100 * criterion.points) / criterion.max)
      : 0;
  return (
    <li className="lead-criterion">
      <div className="lead-criterion-head">
        <span>{criterion.label}</span>
        <span className="mono">
          {criterion.evaluated ? `${criterion.points}/${criterion.max}` : 'não avaliado'}
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <ul className="lead-reasons">
        {criterion.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </li>
  );
}

function Research({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const research = useResearchLead();
  const { state } = lead.research;
  const busy = state === 'pending' || state === 'running';
  return (
    <fieldset className="block">
      <legend>Pesquisa</legend>
      <div className="lead-research-head">
        <div>
          <span
            className={`status status-${state === 'done' ? 'active' : state === 'failed' ? 'inactive' : 'on_leave'}`}
          >
            {RESEARCH_LABELS[state]}
          </span>
          {lead.research.updatedAt && (
            <span className="muted"> · {formatDateTime(lead.research.updatedAt)}</span>
          )}
          {lead.research.costUsd > 0 && (
            <span className="muted"> · custo US$ {lead.research.costUsd.toFixed(3)}</span>
          )}
        </div>
        {canWrite && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy || research.isPending}
            onClick={() => research.mutate(lead.id)}
          >
            {busy ? 'Pesquisando…' : 'Refazer pesquisa'}
          </Button>
        )}
      </div>
      {research.error && (
        <Alert kind="error">
          {research.error instanceof ApiError
            ? research.error.message
            : 'Não foi possível pedir a pesquisa.'}
        </Alert>
      )}
      {state === 'failed' && lead.research.error && (
        <Alert kind="warning">A pesquisa falhou: {lead.research.error}</Alert>
      )}
      {busy && (
        <p className="muted">
          O worker está consultando WhatsApp, busca web e Receita. A tela atualiza sozinha.
        </p>
      )}
      {state === 'none' && <p className="muted">Este lead ainda não foi pesquisado.</p>}

      {lead.research.summary && (
        <div className="lead-summary" aria-label="Resumo da pesquisa">
          {lead.research.summary.split('\n').map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}

      {lead.research.criteria.length > 0 && (
        <div className="lead-score">
          <div className="lead-score-figure">
            <strong>{lead.research.score === null ? '—' : lead.research.score}</strong>
            <span className="muted">/100 perfil de franqueado</span>
          </div>
          <ul className="lead-criteria">
            {lead.research.criteria.map((criterion) => (
              <Criterion key={criterion.key} criterion={criterion} />
            ))}
          </ul>
        </div>
      )}

      {lead.research.links.length > 0 && (
        <div>
          <h3 className="lead-subhead">Links encontrados</h3>
          <ul className="lead-links">
            {lead.research.links.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.kind === 'linkedin'
                    ? 'LinkedIn'
                    : link.kind === 'instagram'
                      ? 'Instagram'
                      : 'Página'}
                  : {link.title || link.url}
                </a>
                {link.snippet && <div className="cell-sub">{link.snippet}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

function Origin({ lead }: { lead: Lead }) {
  const { origin } = lead;
  return (
    <fieldset className="block">
      <legend>Origem</legend>
      <dl className="lead-facts">
        <dt>Cliente</dt>
        <dd>
          {origin.clientName}
          {!origin.clientMapped && (
            <span
              className="tag"
              title="Nenhuma regra mapeou a origem para um cliente. Cadastre a regra em Administração → Clientes."
            >
              sem regra
            </span>
          )}
        </dd>
        <dt>Como chegou</dt>
        <dd>{LEAD_SOURCE_LABELS[origin.source]}</dd>
        <dt>Canal</dt>
        <dd>{origin.channel ? LEAD_CHANNEL_LABELS[origin.channel] : '—'}</dd>
        {origin.trackingCode && (
          <>
            <dt>Código do link</dt>
            <dd className="mono">{origin.trackingCode}</dd>
          </>
        )}
        {origin.landingPage && (
          <>
            <dt>Landing page</dt>
            <dd className="lead-wrap">{origin.landingPage}</dd>
          </>
        )}
        {(origin.campaignName || origin.campaignId) && (
          <>
            <dt>Campanha</dt>
            <dd>
              {origin.campaignName ?? 'Sem nome'}
              {origin.campaignId && <span className="cell-sub mono"> {origin.campaignId}</span>}
            </dd>
          </>
        )}
        {origin.formId && (
          <>
            <dt>Formulário</dt>
            <dd className="mono">{origin.formId}</dd>
          </>
        )}
        {lead.firstMessage && (
          <>
            <dt>Primeira mensagem</dt>
            <dd className="lead-wrap">{lead.firstMessage}</dd>
          </>
        )}
      </dl>
    </fieldset>
  );
}

function Consent({ lead }: { lead: Lead }) {
  const { consent } = lead;
  return (
    <fieldset className="block">
      <legend>LGPD</legend>
      <dl className="lead-facts">
        <dt>Base legal</dt>
        <dd>
          {consent.legalBasis ? LEAD_LEGAL_BASIS_LABELS[consent.legalBasis] : 'Não registrada'}
        </dd>
        <dt>Consentimento em</dt>
        <dd>{formatDateTime(consent.consentedAt)}</dd>
        <dt>Onde</dt>
        <dd>{consent.text ?? consent.source ?? '—'}</dd>
      </dl>
    </fieldset>
  );
}

function Timeline({ events }: { events: LeadEvent[] }) {
  return (
    <fieldset className="block">
      <legend>Linha do tempo</legend>
      <ol className="lead-timeline">
        {events.map((event) => (
          <li key={event.id}>
            <span className="muted">{formatDateTime(event.at)}</span>{' '}
            {EVENT_LABELS[event.kind] ?? event.kind}
          </li>
        ))}
      </ol>
    </fieldset>
  );
}

export function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const lead = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');

  if (lead.isLoading) return <div className="page-loading">Carregando…</div>;
  if (lead.isError || !lead.data) {
    return (
      <>
        <Alert kind="error">Lead não encontrado ou fora do seu alcance.</Alert>
        <Link to="/crm-vendas/funil">Voltar ao funil</Link>
      </>
    );
  }
  const data = lead.data.lead;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>{data.name ?? 'Lead sem nome'}</h1>
          <p>
            {formatPhone(data.phone)}
            {data.email ? ` · ${data.email}` : ''}
            {data.whatsapp?.profileName ? ` · WhatsApp: ${data.whatsapp.profileName}` : ''}
          </p>
        </div>
        <div className="lead-head-side">
          {data.whatsapp?.photoUrl && (
            <img className="lead-photo" src={data.whatsapp.photoUrl} alt="" />
          )}
          <Link to="/crm-vendas/funil" className="btn btn-ghost btn-inline">
            Voltar ao funil
          </Link>
        </div>
      </header>
      <div className="grid-2 lead-grid">
        <Origin lead={data} />
        <RdCrm lead={data} />
      </div>
      <Consent lead={data} />
      <Research lead={data} canWrite={canWrite} />
      <Timeline events={lead.data.events} />
    </>
  );
}
