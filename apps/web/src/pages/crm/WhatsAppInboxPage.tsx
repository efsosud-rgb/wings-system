import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { useWhatsAppConversations, useWhatsAppThread } from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { ago, formatPhone } from './format.js';
import { WhatsAppChat } from './WhatsAppChat.js';

/**
 * CRM Vendas → WhatsApp: the conversations in the reader's scope, the ones
 * waiting for an answer first. A deal's conversation opens on the deal; one
 * that no deal took yet (someone who wrote without a deal for that phone)
 * opens here, for Admin and Diretoria only, until a deal is made with that
 * number — its messages then move to the deal.
 */

export function WhatsAppInboxPage() {
  const [unanswered, setUnanswered] = useState(true);
  const list = useWhatsAppConversations(unanswered);
  const rows = list.data?.conversations ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>WhatsApp</h1>
        <span className="crm-sub">A lista se atualiza sozinha enquanto está aberta.</span>
      </header>
      <div className="crm-wa-inbox-body">
        <div className="crm-tabs" role="tablist" aria-label="Filtro">
          <button
            type="button"
            role="tab"
            aria-selected={unanswered}
            className={`crm-tab${unanswered ? ' is-active' : ''}`}
            onClick={() => setUnanswered(true)}
          >
            Sem resposta
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!unanswered}
            className={`crm-tab${!unanswered ? ' is-active' : ''}`}
            onClick={() => setUnanswered(false)}
          >
            Todas
          </button>
        </div>
        {list.isLoading && <p className="crm-muted">Carregando…</p>}
        {list.isError && <p className="crm-error">Não foi possível carregar as conversas.</p>}
        {!list.isLoading && rows.length === 0 && (
          <div className="crm-empty">
            <span>
              {unanswered ? 'Nenhuma conversa esperando resposta.' : 'Nenhuma conversa ainda.'}
            </span>
          </div>
        )}
        <ul className="crm-wa-inbox">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <Link
                className={`crm-wa-row${row.unanswered ? ' is-unanswered' : ''}`}
                to={
                  row.leadId
                    ? `/crm-vendas/negociacoes/${row.leadId}/whatsapp`
                    : `/crm-vendas/whatsapp/${row.conversationId}`
                }
              >
                <span className="crm-wa-avatar" aria-hidden="true">
                  <Icon name="message" size={16} />
                </span>
                <span className="crm-wa-row-main">
                  <b>{row.leadName ?? row.profileName ?? formatPhone(row.phone)}</b>
                  <span className="crm-sub">
                    {row.lastDirection === 'out' ? 'Você: ' : ''}
                    {row.preview ?? '—'}
                  </span>
                </span>
                <span className="crm-wa-row-side">
                  <span className="crm-sub">{row.lastAt ? ago(row.lastAt) : ''}</span>
                  {!row.leadId && <span className="crm-wa-badge">Sem negociação</span>}
                  {row.unanswered && <span className="crm-wa-badge is-warn">Sem resposta</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A conversation no deal took yet: read and answer it here (full scope only). */
export function WhatsAppWaitingPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const canSend = hasPermission(session.data, 'leads.whatsapp');
  const thread = useWhatsAppThread({ conversationId: id ?? '' }, Boolean(id));
  if (thread.isLoading)
    return (
      <div className="crm-page">
        <p className="crm-muted" style={{ padding: 'var(--space-5)' }}>
          Carregando…
        </p>
      </div>
    );
  if (thread.isError || !thread.data)
    return (
      <div className="crm-page">
        <div className="crm-empty">
          <span>Conversa não encontrada ou fora do seu alcance.</span>
          <Link className="crm-btn" to="/crm-vendas/whatsapp">
            Voltar ao WhatsApp
          </Link>
        </div>
      </div>
    );
  const data = thread.data;
  return (
    <div className="crm-page crm-wa">
      <header className="crm-wa-head">
        <Link className="crm-btn is-quiet is-small" to="/crm-vendas/whatsapp">
          ‹ WhatsApp
        </Link>
        <div className="crm-wa-who">
          <span className="crm-wa-avatar" aria-hidden="true">
            <Icon name="message" size={18} />
          </span>
          <div>
            <h1>{data.profileName ?? 'Sem nome'}</h1>
            <span className="crm-sub">
              {data.phone ? formatPhone(data.phone) : 'Sem telefone'} · sem negociação
            </span>
          </div>
        </div>
      </header>
      <div className="crm-wa-body is-single">
        <WhatsAppChat thread={{ conversationId: id ?? '' }} data={data} canSend={canSend} />
        <aside className="crm-wa-side">
          <section className="crm-panel">
            <h2>Sem negociação</h2>
            <p className="crm-sub">
              Esta pessoa escreveu e não há negociação aberta com este telefone. Para levar a
              conversa a uma negociação, crie a negociação com este número em Negociações → Nova: as
              mensagens passam para ela.
            </p>
            <Link className="crm-btn" to="/crm-vendas/negociacoes">
              Ir para Negociações
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
