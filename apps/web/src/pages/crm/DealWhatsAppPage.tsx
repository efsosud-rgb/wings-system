import { LEAD_PIPELINE_LABELS, type LeadNote } from '@wings/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { useAddNote, useLead, type LoadedLead } from '../../api/leads.js';
import { Icon } from '../../components/Icon.js';
import { FilesTab } from './DealTabs.js';
import { formatDateTime, formatDay, formatPhone, money } from './format.js';

/**
 * The WhatsApp conversation of a deal, opened from its page (Eric, 06/10/2026):
 * the conversation in the centre, the message field below, and on the right
 * Visão geral, Anotações and Arquivos of the lead; voice and video calls by
 * WhatsApp at the top. Until the official WhatsApp API is connected the
 * screen opens empty — no sample message — with sending, voice and video
 * disabled, "em breve". Notes and files are the deal's own and work now.
 */

const SOON = 'Em breve: pela API oficial do WhatsApp, quando a conta estiver ligada';

export function DealWhatsAppPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const loaded = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');
  if (loaded.isLoading)
    return (
      <div className="crm-page">
        <p className="crm-muted" style={{ padding: 'var(--space-5)' }}>
          Carregando…
        </p>
      </div>
    );
  if (loaded.isError || !loaded.data)
    return (
      <div className="crm-page">
        <div className="crm-empty">
          <span>Negociação não encontrada ou fora do seu alcance.</span>
          <Link className="crm-btn" to="/crm-vendas/negociacoes">
            Voltar às negociações
          </Link>
        </div>
      </div>
    );
  const data = loaded.data;
  const { lead } = data;
  return (
    <div className="crm-page crm-wa">
      <header className="crm-wa-head">
        <Link className="crm-btn is-quiet is-small" to={`/crm-vendas/negociacoes/${lead.id}`}>
          ‹ Negociação
        </Link>
        <div className="crm-wa-who">
          <span className="crm-wa-avatar" aria-hidden="true">
            <Icon name="message" size={18} />
          </span>
          <div>
            <h1>{lead.name ?? 'Sem nome'}</h1>
            <span className="crm-sub">
              {lead.phone ? formatPhone(lead.phone) : 'Sem telefone'} · WhatsApp
            </span>
          </div>
        </div>
        <div className="crm-wa-calls" role="group" aria-label="Chamadas pelo WhatsApp">
          <button type="button" className="crm-icon-btn" disabled title={SOON} aria-label="Ligação de voz (em breve)">
            <Icon name="phone" size={18} />
          </button>
          <button type="button" className="crm-icon-btn" disabled title={SOON} aria-label="Chamada de vídeo (em breve)">
            <Icon name="video" size={18} />
          </button>
          <small className="crm-sub">em breve</small>
        </div>
      </header>
      <div className="crm-wa-body">
        <section className="crm-wa-chat" aria-label="Conversa">
          <div className="crm-wa-messages">
            <p className="crm-wa-empty">
              Nenhuma mensagem ainda. A conversa aparece aqui quando a API oficial do WhatsApp
              estiver ligada.
            </p>
          </div>
          <form className="crm-wa-compose" onSubmit={(event) => event.preventDefault()}>
            <input
              className="crm-input"
              aria-label="Mensagem"
              placeholder="Escreva uma mensagem (em breve)"
              disabled
            />
            <button type="submit" className="crm-btn is-primary" disabled title={SOON}>
              Enviar
            </button>
          </form>
        </section>
        <aside className="crm-wa-side">
          <section className="crm-panel" aria-label="Visão geral">
            <h2>Visão geral</h2>
            <dl className="crm-kv crm-about">
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
              {lead.company && (
                <div style={{ display: 'contents' }}>
                  <dt>Empresa</dt>
                  <dd>{lead.company.name}</dd>
                </div>
              )}
              <div style={{ display: 'contents' }}>
                <dt>Criada em</dt>
                <dd>{formatDateTime(lead.createdAt)}</dd>
              </div>
            </dl>
          </section>
          <NotesPanel data={data} canWrite={canWrite} />
          <section className="crm-panel" aria-label="Arquivos">
            <h2>Arquivos</h2>
            <FilesTab lead={lead} canWrite={canWrite} />
          </section>
        </aside>
      </div>
    </div>
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
