import { LEAD_PIPELINE_LABELS, type LeadNote } from '@wings/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { useAddNote, useLead, type LoadedLead } from '../../api/leads.js';
import { Icon } from '../../components/Icon.js';
import { useWhatsAppThread } from '../../api/whatsapp.js';
import { CallPanel } from './CallPanel.js';
import { FilesTab } from './DealTabs.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import { EnteredAt } from './EnteredAt.js';
import { formatDateTime, formatDay, formatPhone, money } from './format.js';

/**
 * The WhatsApp conversation of a deal, opened from its page (Eric, 06/10/2026):
 * the conversation in the centre, the message field below, and on the right
 * Visão geral, Anotações and Arquivos of the lead; voice and video calls by
 * WhatsApp at the top. The conversation is the official WhatsApp (Cloud API,
 * docs/whatsapp/cloud-api.md), refreshed every few seconds while open; until
 * the API is connected on the server it says so and sending stays off. The
 * voice button opens the call panel; video is "em breve". Reading and sending
 * are `leads.whatsapp` (Admin and Diretoria any lead, a seller their own).
 */

const SOON = 'Em breve: pela API oficial do WhatsApp, quando a conta estiver ligada';

export function DealWhatsAppPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const loaded = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');
  const canWhatsApp = hasPermission(session.data, 'leads.whatsapp');
  const thread = useWhatsAppThread({ leadId: id ?? '' }, Boolean(id) && canWhatsApp);
  const [calling, setCalling] = useState(false);
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
          <button
            type="button"
            className="crm-icon-btn"
            title="Ligação"
            aria-label="Ligação de voz"
            onClick={() => setCalling(true)}
          >
            <Icon name="phone" size={18} />
          </button>
          <button
            type="button"
            className="crm-icon-btn"
            disabled
            title={SOON}
            aria-label="Chamada de vídeo (em breve)"
          >
            <Icon name="video" size={18} />
          </button>
          <small className="crm-sub">vídeo em breve</small>
        </div>
      </header>
      {calling && (
        <CallPanel
          leadId={lead.id}
          name={lead.name}
          phone={lead.phone}
          canWrite={canWrite}
          whatsappCalling={thread.data?.calling ?? false}
          onClose={() => setCalling(false)}
        />
      )}
      <div className="crm-wa-body">
        <DealChat leadId={lead.id} canSend={canWhatsApp} />
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
                <dt>Entrou em</dt>
                <dd>
                  <EnteredAt at={lead.enteredAt} source={lead.enteredAtSource} />
                </dd>
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

function DealChat({ leadId, canSend }: { leadId: string; canSend: boolean }) {
  const thread = useWhatsAppThread({ leadId }, canSend);
  if (!canSend)
    return (
      <section className="crm-wa-chat" aria-label="Conversa">
        <p className="crm-wa-off">Seu acesso não inclui o WhatsApp desta negociação.</p>
      </section>
    );
  if (thread.isLoading)
    return (
      <section className="crm-wa-chat" aria-label="Conversa">
        <p className="crm-muted crm-wa-off">Carregando a conversa…</p>
      </section>
    );
  if (thread.isError || !thread.data)
    return (
      <section className="crm-wa-chat" aria-label="Conversa">
        <p className="crm-error crm-wa-off">Não foi possível abrir a conversa.</p>
      </section>
    );
  return <WhatsAppChat thread={{ leadId }} data={thread.data} canSend={canSend} />;
}
