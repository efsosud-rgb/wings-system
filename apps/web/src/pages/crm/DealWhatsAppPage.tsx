import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { useLead } from '../../api/leads.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { useConversationAttendance, useWhatsAppThread } from '../../api/whatsapp.js';
import { CallPanel } from './CallPanel.js';
import { DealSidePanel } from './DealSidePanel.js';
import { ImportChatPanel } from './ImportChatPanel.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import { AttendanceBar, heldByOf } from './WhatsAppAttendance.js';
import { formatPhone } from './format.js';

/**
 * The WhatsApp conversation of a deal, opened from its page (Eric, 06/10/2026):
 * the conversation in the centre, the message field below, and on the right
 * Visão geral, Anotações and Arquivos of the lead; voice and video calls by
 * WhatsApp at the top. The conversation is the official WhatsApp (Cloud API,
 * docs/whatsapp/cloud-api.md), refreshed every few seconds while open; until
 * the API is connected on the server it says so and sending stays off. The
 * voice button opens the call panel; video is "em breve". Reading and sending
 * are `leads.whatsapp` (Admin and Diretoria any lead, a seller their own).
 * "Importar do celular" brings in a chat exported on the phone, as history
 * (`ImportChatPanel`); it also keeps the file, so it needs `leads.write` too.
 */

const SOON = 'Em breve: pela API oficial do WhatsApp, quando a conta estiver ligada';

export function DealWhatsAppPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const loaded = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');
  const canWhatsApp = hasPermission(session.data, 'leads.whatsapp');
  const [calling, setCalling] = useState(false);
  const [importing, setImporting] = useState(false);
  if (loaded.isLoading)
    return (
      <div className="crm-page">
        <p className="crm-muted" style={{ padding: 'var(--space-5)' }}>
          Carregando…
        </p>
      </div>
    );
  // A failed request is not "not found": say why (a 404 reads "não foi encontrado").
  if (!loaded.data)
    return (
      <div className="crm-page">
        <div className="crm-empty">
          {loaded.isError ? (
            <LoadFailure
              what="a negociação"
              error={loaded.error}
              onRetry={() => void loaded.refetch()}
            />
          ) : (
            <span>Negociação não encontrada ou fora do seu alcance.</span>
          )}
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
      {/* A refresh failed: what was loaded stays on screen, with the reason above it. */}
      {loaded.isError && (
        <div style={{ padding: 'var(--space-2) var(--space-5)' }}>
          <LoadFailure
            what="a negociação"
            error={loaded.error}
            onRetry={() => void loaded.refetch()}
          />
        </div>
      )}
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
        {canWhatsApp && canWrite && (
          <button
            type="button"
            className="crm-btn is-small"
            title="Importar uma conversa exportada do WhatsApp do celular"
            onClick={() => setImporting(true)}
          >
            <Icon name="upload" size={14} /> Importar do celular
          </button>
        )}
      </header>
      {importing && <ImportChatPanel leadId={lead.id} onClose={() => setImporting(false)} />}
      {calling && (
        <CallPanel
          leadId={lead.id}
          name={lead.name}
          phone={lead.phone}
          canWrite={canWrite}
          onClose={() => setCalling(false)}
        />
      )}
      <div className="crm-wa-body">
        <DealChat leadId={lead.id} canSend={canWhatsApp} />
        <DealSidePanel data={data} canWrite={canWrite} />
      </div>
    </div>
  );
}

function DealChat({ leadId, canSend }: { leadId: string; canSend: boolean }) {
  const thread = useWhatsAppThread({ leadId }, canSend);
  const session = useSession();
  // Who answers it, as in the Central: a person who does not hold it takes it here too.
  const attendance = useConversationAttendance(thread.data?.conversationId ?? null);
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
  if (!thread.data)
    return (
      <section className="crm-wa-chat" aria-label="Conversa">
        {thread.isError ? (
          <div className="crm-wa-off">
            <LoadFailure
              what="a conversa"
              error={thread.error}
              onRetry={() => void thread.refetch()}
            />
          </div>
        ) : (
          <p className="crm-muted crm-wa-off">Carregando a conversa…</p>
        )}
      </section>
    );
  const numberChats = thread.data.numberChats ?? [];
  return (
    <WhatsAppChat
      thread={{ leadId }}
      data={thread.data}
      canSend={canSend}
      heldBy={heldByOf(attendance.data, session.data?.employeeId)}
      notice={
        <>
          {attendance.data && (
            <AttendanceBar
              id={attendance.data.attendance.conversationId}
              view={attendance.data}
              me={session.data?.employeeId ?? null}
            />
          )}
          {thread.isError && (
            <LoadFailure
              what="a conversa"
              error={thread.error}
              onRetry={() => void thread.refetch()}
            />
          )}
          {/* This page is the official number's; the deal's chats on work numbers open in the Central. */}
          {numberChats.length > 0 && (
            <p className="crm-wa-window">
              Também pelo WhatsApp de:{' '}
              {numberChats.map((chat, i) => (
                <span key={chat.conversationId}>
                  {i > 0 && ', '}
                  <Link to={`/crm-vendas/whatsapp/${chat.conversationId}`}>
                    {chat.number.label ??
                      (chat.number.phone ? formatPhone(chat.number.phone) : 'número')}
                    {chat.number.ownerName ? ` (${chat.number.ownerName})` : ''}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </>
      }
    />
  );
}
