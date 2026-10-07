import {
  SOFIA_STATE_LABELS,
  WA_STATUS_LABELS,
  type WaConversationItem,
  type WaMessageStatus,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import {
  useMarkWhatsAppRead,
  useWhatsAppConversation,
  useWhatsAppInbox,
  type WhatsAppInboxFilter,
} from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { ago, formatPhone } from './format.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import { WhatsAppNewConversation } from './WhatsAppNewConversation.js';

/**
 * CRM Vendas → WhatsApp, as WhatsApp Web for each person (Eric, 07/10): the
 * conversations on the left (search, unread for this reader, the last
 * message's status), the open one on the right, and "Nova conversa" from the
 * company number. A seller sees the conversations of their own deals; Admin
 * and Diretoria see every one, Sofia's included (writing in one takes it from
 * her). New conversations reach Sofia first (her own screen); when she hands
 * one over it shows up here for the deal's owner.
 */

const FILTERS: { key: WhatsAppInboxFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'unread', label: 'Não lidas' },
  { key: 'unanswered', label: 'Sem resposta' },
];

const TICKS: Partial<Record<WaMessageStatus, string>> = {
  pending: '🕓',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  played: '✓✓',
};

function useDebounced(value: string, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const nameOf = (row: { leadName: string | null; profileName: string | null; phone: string }) =>
  row.leadName ?? row.profileName ?? formatPhone(row.phone);

export function WhatsAppInboxPage() {
  return <WhatsAppWeb />;
}

/** The same screen with a conversation open (`/crm-vendas/whatsapp/:id`). */
export function WhatsAppWaitingPage() {
  const { id } = useParams<{ id: string }>();
  return <WhatsAppWeb openId={id} />;
}

function WhatsAppWeb({ openId }: { openId?: string }) {
  const [filter, setFilter] = useState<WhatsAppInboxFilter>('all');
  const [search, setSearch] = useState('');
  const [starting, setStarting] = useState(false);
  const q = useDebounced(search);
  const list = useWhatsAppInbox(filter, q);
  const rows = list.data?.conversations ?? [];
  const open = rows.find((row) => row.conversationId === openId) ?? null;
  return (
    <div className={`crm-page crm-wa-web${openId ? ' has-open' : ''}`}>
      <aside className="crm-wa-web-list" aria-label="Conversas">
        <header className="crm-wa-web-head">
          <h1>WhatsApp</h1>
          <button type="button" className="crm-btn is-primary" onClick={() => setStarting(true)}>
            Nova conversa
          </button>
        </header>
        <input
          className="crm-input"
          type="search"
          aria-label="Buscar conversa"
          placeholder="Buscar por nome ou telefone"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="crm-tabs" role="tablist" aria-label="Filtro">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`crm-tab${filter === f.key ? ' is-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {list.isLoading && <p className="crm-muted">Carregando…</p>}
        {list.isError && <p className="crm-error">Não foi possível carregar as conversas.</p>}
        {!list.isLoading && !list.isError && rows.length === 0 && (
          <div className="crm-empty">
            <span>
              {q
                ? 'Nenhuma conversa com essa busca.'
                : filter === 'unread'
                  ? 'Nenhuma conversa com mensagem não lida.'
                  : filter === 'unanswered'
                    ? 'Nenhuma conversa esperando resposta.'
                    : 'Nenhuma conversa ainda.'}
            </span>
          </div>
        )}
        <ul className="crm-wa-web-rows">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <ConversationRow row={row} active={row.conversationId === openId} />
            </li>
          ))}
        </ul>
      </aside>
      <section className="crm-wa-web-main">
        {openId ? (
          <OpenConversation id={openId} item={open} />
        ) : (
          <div className="crm-empty crm-wa-web-none">
            <Icon name="message" size={28} />
            <span>Escolha uma conversa ou comece uma nova pelo número da empresa.</span>
          </div>
        )}
      </section>
      {starting && <WhatsAppNewConversation onClose={() => setStarting(false)} />}
    </div>
  );
}

function ConversationRow({ row, active }: { row: WaConversationItem; active: boolean }) {
  const tick = row.lastDirection === 'out' && row.lastStatus ? TICKS[row.lastStatus] : null;
  const withSofia = row.attendance === 'sofia' || row.attendance === 'waiting_human';
  const read = row.lastStatus === 'read' || row.lastStatus === 'played';
  return (
    <Link
      className={`crm-wa-row${row.unreadCount > 0 ? ' is-unanswered' : ''}${active ? ' is-active' : ''}`}
      to={`/crm-vendas/whatsapp/${row.conversationId}`}
      aria-current={active ? 'true' : undefined}
    >
      <span className="crm-wa-avatar" aria-hidden="true">
        <Icon name="message" size={16} />
      </span>
      <span className="crm-wa-row-main">
        <b>{nameOf(row)}</b>
        <span className="crm-sub">
          {tick && row.lastStatus && (
            <span
              className={`crm-wa-tick${read ? ' is-read' : ''}`}
              title={WA_STATUS_LABELS[row.lastStatus]}
              aria-label={WA_STATUS_LABELS[row.lastStatus]}
            >
              {tick}{' '}
            </span>
          )}
          {row.lastStatus === 'failed' && <span className="crm-error">Não enviada · </span>}
          {row.preview ?? '—'}
        </span>
      </span>
      <span className="crm-wa-row-side">
        <span className="crm-sub">{row.lastAt ? ago(row.lastAt) : ''}</span>
        {row.unreadCount > 0 && (
          <span className="crm-wa-unread" aria-label={`${row.unreadCount} não lidas`}>
            {row.unreadCount}
          </span>
        )}
        {withSofia && <span className="crm-wa-badge">{SOFIA_STATE_LABELS[row.attendance]}</span>}
        {!row.leadId && !withSofia && <span className="crm-wa-badge">Sem negociação</span>}
      </span>
    </Link>
  );
}

function OpenConversation({ id, item }: { id: string; item: WaConversationItem | null }) {
  const session = useSession();
  const canSend = hasPermission(session.data, 'leads.whatsapp');
  const thread = useWhatsAppConversation(id);
  const { mutate: markRead } = useMarkWhatsAppRead();
  const last = thread.data?.messages.at(-1)?.id;
  // Opening the conversation, and each new message while it is open, counts as read.
  useEffect(() => {
    if (last) markRead(id);
  }, [id, last, markRead]);

  if (thread.isLoading) return <p className="crm-muted crm-wa-web-none">Carregando…</p>;
  if (thread.isError || !thread.data)
    return (
      <div className="crm-empty crm-wa-web-none">
        <span>Conversa não encontrada ou fora do seu alcance.</span>
        <Link className="crm-btn" to="/crm-vendas/whatsapp">
          Voltar às conversas
        </Link>
      </div>
    );
  const data = thread.data;
  const leadId = data.leadId;
  const name = item
    ? nameOf(item)
    : (data.profileName ?? (data.phone ? formatPhone(data.phone) : 'Sem nome'));
  return (
    <div className="crm-wa-web-open">
      <header className="crm-wa-head">
        <Link className="crm-btn is-quiet is-small crm-wa-web-back" to="/crm-vendas/whatsapp">
          ‹ Conversas
        </Link>
        <div className="crm-wa-who">
          <span className="crm-wa-avatar" aria-hidden="true">
            <Icon name="message" size={18} />
          </span>
          <div>
            <h1>{name}</h1>
            <span className="crm-sub">
              {data.phone ? formatPhone(data.phone) : 'Sem telefone'}
              {item?.ownerName ? ` · ${item.ownerName}` : ''}
            </span>
          </div>
        </div>
        {leadId ? (
          <Link className="crm-btn is-small" to={`/crm-vendas/negociacoes/${leadId}`}>
            Abrir negociação
          </Link>
        ) : (
          <Link className="crm-btn is-small" to={`/crm-vendas/sofia/${id}`}>
            Ver na Sofia
          </Link>
        )}
      </header>
      {(data.attendance === 'sofia' || data.attendance === 'waiting_human') && (
        <p className="crm-wa-window">
          {data.attendance === 'sofia'
            ? 'A Sofia está atendendo esta conversa. Se você escrever, ela para e a conversa passa a ser sua.'
            : 'Esta conversa espera um atendente. Escreva para assumir.'}
        </p>
      )}
      <WhatsAppChat
        thread={leadId ? { leadId } : { conversationId: id }}
        data={data}
        canSend={canSend}
      />
    </div>
  );
}
