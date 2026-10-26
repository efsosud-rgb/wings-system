import {
  LEAD_CHANNEL_LABELS,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_LABELS,
  type LeadNote,
  type LeadTask,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAddNote, type LoadedLead } from '../../api/leads.js';
import { Icon } from '../../components/Icon.js';
import { FilesTab } from './DealTabs.js';
import { EnteredAt } from './EnteredAt.js';
import { formatDateTime, formatDay, money } from './format.js';

/**
 * The deal beside a WhatsApp conversation (the deal's own WhatsApp page and the Central's
 * contact panel): company, deal, stage, owner, value, forecast, origin, open tasks, notes and
 * files. `back` is where the deal's page offers to return (the Central with its filters).
 */
export function DealSidePanel({
  data,
  canWrite,
  back,
}: {
  data: LoadedLead;
  canWrite: boolean;
  back?: string;
}) {
  const { lead } = data;
  const origin = lead.origin;
  const tasks = (data.tasks as LeadTask[])
    .filter((task) => !task.doneAt)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <aside className="crm-wa-side">
      <section className="crm-panel" aria-label="Visão geral">
        <h2>Visão geral</h2>
        <dl className="crm-kv crm-about">
          {back !== undefined && (
            <div style={{ display: 'contents' }}>
              <dt>Negociação</dt>
              <dd>
                <Link to={`/crm-vendas/negociacoes/${lead.id}`} state={{ back }}>
                  {lead.name ?? 'Sem nome'}
                </Link>
              </dd>
            </div>
          )}
          {lead.company && (
            <div style={{ display: 'contents' }}>
              <dt>Empresa</dt>
              <dd>{lead.company.name}</dd>
            </div>
          )}
          <div style={{ display: 'contents' }}>
            <dt>Funil</dt>
            <dd>{lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Etapa</dt>
            <dd>{lead.work.stage ?? '—'}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Dono</dt>
            <dd>{lead.work.ownerName ?? '—'}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Valor</dt>
            <dd>{lead.valueCents !== null ? money(lead.valueCents, true) : '—'}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Previsão</dt>
            <dd>{lead.expectedCloseAt ? formatDay(lead.expectedCloseAt) : '—'}</dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Origem</dt>
            <dd>
              {LEAD_SOURCE_LABELS[origin.source]}
              {origin.channel ? ` · ${LEAD_CHANNEL_LABELS[origin.channel]}` : ''}
              {origin.campaignName || origin.campaignId
                ? ` · ${origin.campaignName ?? origin.campaignId}`
                : ''}
            </dd>
          </div>
          <div style={{ display: 'contents' }}>
            <dt>Entrou em</dt>
            <dd>
              <EnteredAt at={lead.enteredAt} source={lead.enteredAtSource} />
            </dd>
          </div>
        </dl>
      </section>
      <section className="crm-panel" aria-label="Tarefas">
        <h2>Tarefas</h2>
        {tasks.length === 0 ? (
          <p className="crm-muted">Nenhuma tarefa aberta.</p>
        ) : (
          <ul className="crm-stack" style={{ gap: 'var(--space-1)' }}>
            {tasks.slice(0, 5).map((task) => (
              <li key={task.id}>
                <b>{task.title}</b>
                <div className="crm-sub">
                  {formatDateTime(task.dueAt)} · {task.assigneeName ?? 'Sem responsável'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <NotesPanel data={data} canWrite={canWrite} />
      <section className="crm-panel" aria-label="Arquivos">
        <h2>Arquivos</h2>
        <FilesTab lead={lead} canWrite={canWrite} />
      </section>
    </aside>
  );
}

function NotesPanel({ data, canWrite }: { data: LoadedLead; canWrite: boolean }) {
  const note = useAddNote(data.lead.id);
  const [body, setBody] = useState('');
  const notes = [...(data.notes as LeadNote[])].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="crm-panel" aria-label="Anotações">
      <h2>Anotações</h2>
      {canWrite && (
        <form
          className="crm-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            note.mutate({ body }, { onSuccess: () => setBody('') });
          }}
        >
          <textarea
            className="crm-textarea"
            placeholder="Anotar sobre a conversa"
            value={body}
            maxLength={4000}
            rows={2}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="crm-quick-row">
            <button
              type="submit"
              className="crm-btn is-small is-primary"
              disabled={note.isPending || body.trim().length === 0}
            >
              Anotar
            </button>
          </div>
        </form>
      )}
      {notes.length === 0 && <p className="crm-muted">Nenhuma anotação.</p>}
      <ol className="crm-timeline">
        {notes.map((item) => (
          <li key={item.id}>
            <span className="crm-tl-icon is-note" aria-hidden="true">
              <Icon name="edit" size={13} />
            </span>
            <div>
              <div className="crm-tl-head">
                <b>{item.authorName ?? 'Anotação'}</b>
                <span>{formatDateTime(item.at)}</span>
              </div>
              <div className="crm-tl-body">{item.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
