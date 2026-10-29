import {
  SOFIA_STATE_LABELS,
  WA_STATUS_LABELS,
  type WaConversationItem,
  type WaMessageStatus,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, permissionScope, useSession } from '../../api/auth.js';
import {
  useMarkWhatsAppRead,
  useOfficialNumber,
  useSetOfficialNumber,
  useWhatsAppConversation,
  useWhatsAppInbox,
  type WhatsAppInboxFilter,
} from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDateTime, formatPhone } from './format.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import { WhatsAppNewConversation } from './WhatsAppNewConversation.js';
import { listTimeOf } from './whatsapp-time.js';

/**
 * CRM Vendas → WhatsApp, as WhatsApp Web for each person (Eric, 07/10), laid
 * out as WhatsApp Desktop (20/10): the conversations on the left (search by
 * name, phone or a message's text, unread for this reader, the last message's
 * status), the open one on the right, and "Nova conversa" from the company
 * number. New messages show at once: the stream every screen keeps open makes
 * the list and the open conversation fetch again (`api/whatsapp-inbox.ts`). A seller sees the conversations of their own deals; Admin
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
  const session = useSession();
  // Eric, 14/10: until the official number is live, a seller uses the phone's WhatsApp. The
  // other levels are not affected. Not known yet (loading, failed) is "not live" for a seller.
  const seller = permissionScope(session.data, 'leads.whatsapp') !== 'all';
  const official = useOfficialNumber();
  const soon = seller && official.data?.live !== true;
  const q = useDebounced(search);
  const list = useWhatsAppInbox(filter, q);
  const rows = list.data?.conversations ?? [];
  const open = rows.find((row) => row.conversationId === openId) ?? null;
  return (
    <div className={`crm-page crm-wa-web${openId ? ' has-open' : ''}`}>
      <aside className="crm-wa-web-list" aria-label="Conversas">
        <header className="crm-wa-web-head">
          <h1>WhatsApp</h1>
          <button
            type="button"
            className="crm-btn is-primary"
            onClick={() => setStarting(true)}
            disabled={soon}
            title={soon ? 'Em breve: depois da troca do número' : undefined}
          >
            Nova conversa
          </button>
          {hasPermission(session.data, 'whatsapp.import_bulk') && (
            <Link className="crm-btn" to="/crm-vendas/whatsapp/importar-lote">
              Importar em lote
            </Link>
          )}
        </header>
        {soon && (
          <p className="crm-wa-soon" role="status">
            <span className="crm-chip">em breve</span> O WhatsApp do sistema começa a funcionar
            depois da troca do número. Até lá, use o WhatsApp do celular.
          </p>
        )}
        {hasPermission(session.data, 'integrations.manage') && (
          <>
            <OfficialNumberSwitch live={official.data?.live} />
            <Link className="crm-muted" to="/crm-vendas/whatsapp/numeros">
              Números dos vendedores
            </Link>
          </>
        )}
        <input
          className="crm-input"
          type="search"
          aria-label="Buscar conversa"
          placeholder="Buscar nome, telefone ou mensagem"
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
        {list.isError && (
          <LoadFailure what="as conversas" error={list.error} onRetry={() => void list.refetch()} />
        )}
        {list.isSuccess && rows.length === 0 && (
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
              <ConversationRow row={row} active={row.conversationId === openId} term={q} />
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

/** WhatsApp Desktop's round picture: the initials on one of the theme's tones, fixed per conversation. */
function Avatar({ name, seed }: { name: string; seed: string }) {
  const words = name.match(/\p{L}+/gu) ?? [];
  // By code point: a profile name in a "fancy" alphabet (𝓜𝓪𝓻𝓲𝓪) is two units per letter.
  const initialOf = (word: string | undefined) => (word ? [...word][0] : undefined);
  const first = initialOf(words[0]);
  const last = words.length > 1 ? initialOf(words.at(-1)) : undefined;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const tone = (hash % 8) + 1;
  return (
    <span
      className="crm-wa-avatar"
      aria-hidden="true"
      style={{ background: `var(--stage-${tone})`, color: `var(--stage-${tone}-fg)` }}
    >
      {first ? `${first}${last ?? ''}`.toUpperCase() : <Icon name="user" size={16} />}
    </span>
  );
}

/** A found message with the searched term marked (the API cut it around the term). */
function Marked({ text, term }: { text: string; term: string }) {
  const wanted = term.replace(/\s+/g, ' ').trim();
  const at = wanted
    ? text.toLocaleLowerCase('pt-BR').indexOf(wanted.toLocaleLowerCase('pt-BR'))
    : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + wanted.length)}</mark>
      {text.slice(at + wanted.length)}
    </>
  );
}

function ConversationRow({
  row,
  active,
  term,
}: {
  row: WaConversationItem;
  active: boolean;
  term: string;
}) {
  const tick = row.lastDirection === 'out' && row.lastStatus ? TICKS[row.lastStatus] : null;
  const withSofia = row.attendance === 'sofia' || row.attendance === 'waiting_human';
  const read = row.lastStatus === 'read' || row.lastStatus === 'played';
  const name = nameOf(row);
  // A search that found a message shows that message, as WhatsApp's search does.
  const at = row.match?.at ?? row.lastAt;
  return (
    <Link
      className={`crm-wa-row${row.unreadCount > 0 ? ' is-unanswered' : ''}${active ? ' is-active' : ''}`}
      to={`/crm-vendas/whatsapp/${row.conversationId}`}
      aria-current={active ? 'true' : undefined}
    >
      <Avatar name={name} seed={row.conversationId} />
      <span className="crm-wa-row-main">
        <span className="crm-wa-row-line">
          <b>{name}</b>
          {at && (
            <time className="crm-wa-row-time" dateTime={at} title={formatDateTime(at)}>
              {listTimeOf(at)}
            </time>
          )}
        </span>
        <span className="crm-wa-row-line">
          <span className="crm-sub crm-wa-row-preview">
            {row.match ? (
              <Marked text={row.match.text} term={term} />
            ) : (
              <>
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
              </>
            )}
          </span>
          {withSofia && <span className="crm-wa-badge">{SOFIA_STATE_LABELS[row.attendance]}</span>}
          {!row.leadId && !withSofia && <span className="crm-wa-badge">Sem negociação</span>}
          {row.unreadCount > 0 && (
            <span className="crm-wa-unread" aria-label={`${row.unreadCount} não lidas`}>
              {row.unreadCount}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

function OpenConversation({ id, item }: { id: string; item: WaConversationItem | null }) {
  const session = useSession();
  const canSend = hasPermission(session.data, 'leads.whatsapp');
  const mayOpenSofia = hasPermission(session.data, 'sofia.read');
  const thread = useWhatsAppConversation(id);
  const { mutate: markRead } = useMarkWhatsAppRead();
  const last = thread.data?.messages.at(-1)?.id;
  // Opening the conversation, and each new message while it is open, counts as read.
  useEffect(() => {
    if (last) markRead(id);
  }, [id, last, markRead]);

  if (thread.isLoading) return <p className="crm-muted crm-wa-web-none">Carregando…</p>;
  // A failed request is not "not found": say why (a 404 reads "não foi encontrado").
  if (!thread.data)
    return (
      <div className="crm-empty crm-wa-web-none">
        {thread.isError ? (
          <LoadFailure
            what="a conversa"
            error={thread.error}
            onRetry={() => void thread.refetch()}
          />
        ) : (
          <span>Conversa não encontrada ou fora do seu alcance.</span>
        )}
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
          <Avatar name={name} seed={id} />
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
        ) : mayOpenSofia ? (
          <Link className="crm-btn is-small" to={`/crm-vendas/sofia/${id}`}>
            Ver na Sofia
          </Link>
        ) : null}
      </header>
      {(data.attendance === 'sofia' || data.attendance === 'waiting_human') && (
        <p className="crm-wa-window">
          {data.attendance === 'sofia'
            ? 'A Sofia está atendendo esta conversa. Se você escrever, ela para e a conversa passa a ser sua.'
            : 'Esta conversa espera um atendente. Escreva para assumir.'}
        </p>
      )}
      <WhatsAppChat
        // Sent in this conversation, to its own number (a deal's contact may not be its main phone).
        thread={{ conversationId: id }}
        data={data}
        canSend={canSend}
        notice={
          thread.isError ? (
            <LoadFailure
              what="a conversa"
              error={thread.error}
              onRetry={() => void thread.refetch()}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/** The Admin Master's switch: on the day the number is swapped, the sellers' WhatsApp opens. */
function OfficialNumberSwitch({ live }: { live: boolean | undefined }) {
  const set = useSetOfficialNumber();
  if (live === undefined) return null;
  const next = !live;
  return (
    <p className="crm-muted crm-wa-official">
      Número oficial para os vendedores: <b>{live ? 'ligado' : 'desligado (em breve)'}</b>{' '}
      <button
        type="button"
        className="crm-btn"
        disabled={set.isPending}
        onClick={() => {
          const ask = next
            ? 'Ligar o WhatsApp do sistema para os vendedores? Faça isso só depois da troca do número.'
            : 'Voltar o WhatsApp dos vendedores para "em breve"?';
          if (window.confirm(ask)) set.mutate(next);
        }}
      >
        {next ? 'Ligar' : 'Desligar'}
      </button>
      {set.isError && <span className="crm-error"> Não foi possível mudar agora.</span>}
    </p>
  );
}
