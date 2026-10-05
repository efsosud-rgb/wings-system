import {
  isTaskOverdue,
  LEAD_CHANNEL_LABELS,
  LEAD_LEGAL_BASIS_LABELS,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  LEAD_SOURCE_LABELS,
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  type Lead,
  type LeadEvent,
  type LeadNote,
  type LeadStageHistoryEntry,
  type LeadTask,
  type LeadTaskKind,
  type ScoreCriterion,
} from '@wings/shared';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import {
  useAddNote,
  useCreateTask,
  useLead,
  useResearchLead,
  useSellers,
  useStages,
  useUpdateLead,
  useUpdateTask,
} from '../api/leads.js';
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
  'lead.received.site_form': 'Formulário do site enviado',
  'rd.deal_linked': 'Negócio aberto no RD CRM ligado a este lead',
  'lead.created_manually': 'Cadastrado manualmente',
  'research.queued': 'Pesquisa colocada na fila',
  'research.started': 'Pesquisa iniciada',
  'research.done': 'Pesquisa concluída',
  'research.failed': 'Pesquisa falhou',
  'lead.imported.rd_crm': 'Trazido do RD CRM',
  'lead.stage_changed': 'Etapa alterada',
  'lead.outcome_changed': 'Resultado alterado',
  'lead.owner_changed': 'Dono alterado',
  'lead.pipeline_changed': 'Funil alterado',
  'lead.note_added': 'Anotação escrita',
  'lead.task_created': 'Tarefa criada',
  'lead.task_done': 'Tarefa concluída',
  'lead.task_updated': 'Tarefa alterada',
  'rd.deal_created': 'Negócio criado no RD CRM pela entrada automática',
  'rd.other_deal': 'Outro negócio da mesma pessoa no RD CRM',
};

function RdCrm({ lead }: { lead: Lead }) {
  const crm = lead.crm;
  return (
    <fieldset className="block">
      <legend>Cópia no RD CRM</legend>
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
            Lido do RD {sinceLabel(crm.syncedAt)}. O RD é cópia durante a transição:{' '}
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

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/**
 * Where the lead is and who works it: funnel, stage, owner and outcome. Every
 * change is one PATCH; the API re-checks who may do what (a seller only on
 * their own leads; handing over needs `leads.assign`).
 */
function Work({
  lead,
  canWrite,
  canAssign,
}: {
  lead: Lead;
  canWrite: boolean;
  canAssign: boolean;
}) {
  const stages = useStages(lead.pipeline ?? '');
  const sellers = useSellers();
  const update = useUpdateLead(lead.id);
  const [lostReason, setLostReason] = useState('');
  const [losing, setLosing] = useState(false);
  const { work } = lead;
  const open = work.won === null;
  const activeStages = (stages.data?.stages ?? []).filter(
    (stage) => stage.active || stage.id === work.stageId,
  );
  return (
    <fieldset className="block">
      <legend>No funil</legend>
      <dl className="lead-facts">
        <dt>Funil</dt>
        <dd>
          {canWrite ? (
            <select
              className="control"
              value={lead.pipeline ?? ''}
              disabled={update.isPending}
              onChange={(event) =>
                event.target.value &&
                update.mutate({ pipeline: event.target.value as (typeof LEAD_PIPELINES)[number] })
              }
            >
              <option value="">—</option>
              {LEAD_PIPELINES.map((pipeline) => (
                <option key={pipeline} value={pipeline}>
                  {LEAD_PIPELINE_LABELS[pipeline]}
                </option>
              ))}
            </select>
          ) : lead.pipeline ? (
            LEAD_PIPELINE_LABELS[lead.pipeline]
          ) : (
            '—'
          )}
        </dd>
        {lead.brand && (
          <>
            <dt>Marca</dt>
            <dd>{lead.brand}</dd>
          </>
        )}
        <dt>Etapa</dt>
        <dd>
          {canWrite && open && lead.pipeline ? (
            <select
              className="control"
              value={work.stageId ?? ''}
              disabled={update.isPending || stages.isLoading}
              onChange={(event) =>
                event.target.value && update.mutate({ stageId: event.target.value })
              }
            >
              <option value="">— sem etapa —</option>
              {activeStages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.position}. {stage.name}
                  {stage.active ? '' : ' (desativada)'}
                </option>
              ))}
            </select>
          ) : (
            (work.stage ?? '—')
          )}
          {work.won === true && <span className="status status-active"> Ganho</span>}
          {work.won === false && <span className="status status-inactive"> Perdido</span>}
        </dd>
        <dt>Na etapa desde</dt>
        <dd>
          {work.stageChangedAt
            ? `${formatDateTime(work.stageChangedAt)} (${sinceLabel(work.stageChangedAt)})`
            : '—'}
        </dd>
        <dt>Dono</dt>
        <dd>
          {canAssign ? (
            <select
              className="control"
              value={lead.ownerEmployeeId ?? ''}
              disabled={update.isPending}
              onChange={(event) => update.mutate({ ownerEmployeeId: event.target.value || null })}
            >
              <option value="">— sem dono —</option>
              {(sellers.data?.sellers ?? [])
                .filter((seller) => seller.active || seller.id === lead.ownerEmployeeId)
                .map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
            </select>
          ) : (
            (work.ownerName ?? '—')
          )}
        </dd>
        {work.won === false && (
          <>
            <dt>Motivo da perda</dt>
            <dd>{work.lostReason ?? '—'}</dd>
          </>
        )}
        {work.closedAt && (
          <>
            <dt>Fechado em</dt>
            <dd>{formatDateTime(work.closedAt)}</dd>
          </>
        )}
      </dl>
      {canWrite && (
        <div className="lead-actions">
          {open && !losing && (
            <>
              <Button
                type="button"
                variant="primary"
                disabled={update.isPending}
                onClick={() => update.mutate({ won: true })}
              >
                Marcar ganho
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => setLosing(true)}
              >
                Marcar perdido
              </Button>
            </>
          )}
          {open && losing && (
            <form
              className="lead-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                update.mutate({ won: false, lostReason }, { onSuccess: () => setLosing(false) });
              }}
            >
              <input
                className="control"
                placeholder="Motivo da perda"
                value={lostReason}
                maxLength={200}
                onChange={(event) => setLostReason(event.target.value)}
                autoFocus
              />
              <Button
                type="submit"
                variant="primary"
                disabled={update.isPending || lostReason.trim().length < 2}
              >
                Confirmar perda
              </Button>
              <Button type="button" variant="ghost" onClick={() => setLosing(false)}>
                Cancelar
              </Button>
            </form>
          )}
          {!open && (
            <Button
              type="button"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ won: null })}
            >
              Reabrir
            </Button>
          )}
        </div>
      )}
      {update.error && (
        <Alert kind="error">{errorText(update.error, 'Não foi possível alterar o lead.')}</Alert>
      )}
      <p className="muted">
        {work.managedBy === 'rd'
          ? 'Etapa e dono ainda lidos do RD CRM; a primeira mudança feita aqui passa o lead para o Wings System.'
          : 'Lead trabalhado no Wings System; o RD CRM recebe cópia durante a transição.'}
      </p>
    </fieldset>
  );
}

function Notes({ lead, notes, canWrite }: { lead: Lead; notes: LeadNote[]; canWrite: boolean }) {
  const add = useAddNote(lead.id);
  const [body, setBody] = useState('');
  return (
    <fieldset className="block">
      <legend>Anotações</legend>
      {canWrite && (
        <form
          className="lead-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate({ body }, { onSuccess: () => setBody('') });
          }}
        >
          <textarea
            className="control"
            rows={3}
            placeholder="O que aconteceu nesta conversa? (fica só nesta ficha)"
            value={body}
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={add.isPending || body.trim().length === 0}
          >
            Anotar
          </Button>
        </form>
      )}
      {add.error && <Alert kind="error">{errorText(add.error, 'Não foi possível anotar.')}</Alert>}
      {notes.length === 0 && <p className="muted">Nenhuma anotação ainda.</p>}
      <ol className="lead-notes">
        {notes.map((note) => (
          <li key={note.id}>
            <div className="muted">
              {formatDateTime(note.at)} · {note.authorName ?? 'Sistema'}
            </div>
            <div className="lead-wrap">{note.body}</div>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}

const toLocalInput = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function Tasks({ lead, tasks, canWrite }: { lead: Lead; tasks: LeadTask[]; canWrite: boolean }) {
  const create = useCreateTask(lead.id);
  const update = useUpdateTask(lead.id);
  const [form, setForm] = useState({
    kind: 'follow_up' as LeadTaskKind,
    title: '',
    dueAt: toLocalInput(new Date(Date.now() + 86_400_000)),
  });
  const open = tasks.filter((task) => !task.doneAt);
  const done = tasks.filter((task) => task.doneAt);
  return (
    <fieldset className="block">
      <legend>Tarefas</legend>
      {canWrite && (
        <form
          className="lead-task-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { kind: form.kind, title: form.title, dueAt: new Date(form.dueAt).toISOString() },
              { onSuccess: () => setForm((current) => ({ ...current, title: '' })) },
            );
          }}
        >
          <select
            className="control"
            value={form.kind}
            onChange={(event) =>
              setForm((c) => ({ ...c, kind: event.target.value as LeadTaskKind }))
            }
          >
            {LEAD_TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {LEAD_TASK_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          <input
            className="control"
            placeholder="O que fazer"
            value={form.title}
            maxLength={160}
            onChange={(event) => setForm((c) => ({ ...c, title: event.target.value }))}
          />
          <input
            className="control"
            type="datetime-local"
            value={form.dueAt}
            onChange={(event) => setForm((c) => ({ ...c, dueAt: event.target.value }))}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || form.title.trim().length < 2}
          >
            Criar tarefa
          </Button>
        </form>
      )}
      {create.error && (
        <Alert kind="error">{errorText(create.error, 'Não foi possível criar a tarefa.')}</Alert>
      )}
      {open.length === 0 && <p className="muted">Nenhuma tarefa aberta.</p>}
      <ul className="lead-tasks">
        {open.map((task) => (
          <li key={task.id} className={isTaskOverdue(task) ? 'task-overdue' : ''}>
            {canWrite && (
              <input
                type="checkbox"
                aria-label={`Concluir: ${task.title}`}
                checked={false}
                disabled={update.isPending}
                onChange={() => update.mutate({ taskId: task.id, done: true })}
              />
            )}
            <span>
              <strong>{task.title}</strong>
              <span className="cell-sub">
                {' '}
                {LEAD_TASK_KIND_LABELS[task.kind]} · vence {formatDateTime(task.dueAt)}
                {isTaskOverdue(task) ? ' · atrasada' : ''} · {task.assigneeName ?? '—'}
                {task.auto ? ' · automática' : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <details>
          <summary className="muted">{done.length} concluída(s)</summary>
          <ul className="lead-tasks">
            {done.map((task) => (
              <li key={task.id} className="task-done">
                <s>{task.title}</s>
                <span className="cell-sub">
                  {' '}
                  feita {formatDateTime(task.doneAt)} por {task.doneByName ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}

const SOURCE_LABELS: Record<LeadStageHistoryEntry['source'], string> = {
  wings: 'no Wings System',
  rd: 'lido do RD CRM',
  import: 'pela importação',
  sofia: 'pela Sofia',
};

function History({ history }: { history: LeadStageHistoryEntry[] }) {
  if (history.length === 0) return null;
  return (
    <fieldset className="block">
      <legend>Histórico de etapas</legend>
      <ol className="lead-timeline">
        {history.map((entry) => (
          <li key={entry.id}>
            <span className="muted">{formatDateTime(entry.at)}</span> {entry.fromStage ?? '—'} →{' '}
            {entry.toStage ?? '—'}
            {entry.won === true
              ? ' · ganho'
              : entry.won === false
                ? ` · perdido (${entry.lostReason ?? 'sem motivo'})`
                : ''}
            <span className="cell-sub">
              {' '}
              {SOURCE_LABELS[entry.source]}
              {entry.actorName ? ` · ${entry.actorName}` : ''}
            </span>
          </li>
        ))}
      </ol>
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
              title="Nenhuma regra mapeou a origem para um cliente. Cadastre a regra em CRM Vendas → Landing pages."
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
        {lead.city && (
          <>
            <dt>Cidade</dt>
            <dd>{lead.city}</dd>
          </>
        )}
        {lead.formAnswers &&
          Object.entries(lead.formAnswers).map(([question, answer]) => (
            <Fragment key={question}>
              <dt className="lead-wrap">{question.replace(/_/g, ' ')}</dt>
              <dd className="lead-wrap">{answer}</dd>
            </Fragment>
          ))}
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
  const canAssign = hasPermission(session.data, 'leads.assign');

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
        <Work lead={data} canWrite={canWrite} canAssign={canAssign} />
        <Tasks lead={data} tasks={lead.data.tasks} canWrite={canWrite} />
      </div>
      <Notes lead={data} notes={lead.data.notes} canWrite={canWrite} />
      <div className="grid-2 lead-grid">
        <Origin lead={data} />
        <RdCrm lead={data} />
      </div>
      <History history={lead.data.history} />
      <Consent lead={data} />
      <Research lead={data} canWrite={canWrite} />
      <Timeline events={lead.data.events} />
    </>
  );
}
