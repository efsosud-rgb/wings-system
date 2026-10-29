import {
  SECTOR_SLUGS,
  SECTORS,
  SOFIA_STATE_LABELS,
  SOFIA_STATES,
  WA_ASSIGNMENT_MODE_LABELS,
  WA_ASSIGNMENT_MODES,
  WA_INBOX_FILTER_LABELS,
  WA_INBOX_FILTERS,
  WA_STATUS_LABELS,
  isSectorSlug,
  type DealWhatsApp,
  type WaAssignmentMode,
  type WaConversationItem,
  type WaMessageStatus,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { hasPermission, permissionScope, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import { useLead } from '../../api/leads.js';
import {
  useAssignmentMode,
  useChatNumbers,
  useConversationAttendance,
  useConversationDeals,
  useReplying,
  useSetAssignmentMode,
  useLinkConversation,
  useMarkWhatsAppRead,
  useOfficialNumber,
  useSetOfficialNumber,
  useWhatsAppConversation,
  useWhatsAppInbox,
  type WhatsAppInboxFilter,
} from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { DealSidePanel } from './DealSidePanel.js';
import { formatDateTime, formatPhone } from './format.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import { AttendanceBar, AttendanceHistory, heldByOf } from './WhatsAppAttendance.js';
import { NewNumber, WhatsAppNewConversation } from './WhatsAppNewConversation.js';
import { listTimeOf } from './whatsapp-time.js';

/**
 * CRM Vendas → WhatsApp, the Central (docs/whatsapp/central.md): WhatsApp Web for each person
 * (Eric, 07/10), laid out as WhatsApp Desktop (20/10), in three areas (26/10). Left, the list: the
 * official number's conversations and the work numbers' chats in the reader's reach, with search,
 * the tabs and the filters (number, department, state, days), 50 at a time. Middle, the open
 * conversation. Right, the contact: the deal beside it, or the deals of its phone to join. The
 * filters and the open conversation live in the address, so going to the deal and back loses
 * nothing. New messages show at once: the stream every screen keeps open makes the list and the
 * open conversation fetch again (`api/whatsapp-inbox.ts`). A seller sees their own deals'
 * conversations and their own work number's chats; Admin and Diretoria see every one.
 */

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

/** The company number a conversation is on: a work number's name, or the official one. */
const numberNameOf = (number: WaConversationItem['number'] | DealWhatsApp['number']) =>
  number ? (number.label ?? (number.phone ? formatPhone(number.phone) : 'Número')) : 'Oficial';

export function WhatsAppInboxPage() {
  return <WhatsAppWeb />;
}

/** The same screen with a conversation open (`/crm-vendas/whatsapp/:id`). */
export function WhatsAppWaitingPage() {
  const { id } = useParams<{ id: string }>();
  return <WhatsAppWeb openId={id} />;
}

/** The address's names for the filters (the screen's language). */
const PARAMS = {
  filter: 'filtro',
  q: 'busca',
  number: 'numero',
  sector: 'setor',
  state: 'situacao',
  from: 'de',
  to: 'ate',
} as const;

function WhatsAppWeb({ openId }: { openId?: string }) {
  const [params, setParams] = useSearchParams();
  const read = (key: keyof typeof PARAMS) => params.get(PARAMS[key]) ?? '';
  const write = (key: keyof typeof PARAMS, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(PARAMS[key], value);
        else next.delete(PARAMS[key]);
        // "Nova conversa" from a contact or a company is asked for once.
        next.delete('nova');
        return next;
      },
      { replace: true },
    );
  const filterParam = read('filter');
  const filter: WhatsAppInboxFilter = (WA_INBOX_FILTERS as readonly string[]).includes(filterParam)
    ? (filterParam as WhatsAppInboxFilter)
    : 'all';
  const [search, setSearch] = useState(read('q'));
  const q = useDebounced(search);
  useEffect(() => {
    // The typed search goes to the address once it settles; the address is read once, above.
    if (q !== read('q')) write('q', q);
  }, [q]);
  const asked = params.get('nova');
  const [starting, setStarting] = useState(asked !== null);
  const session = useSession();
  // Eric, 14/10: until the official number is live, a seller uses the phone's WhatsApp. The
  // other levels are not affected. Not known yet (loading, failed) is "not live" for a seller.
  const seller = permissionScope(session.data, 'leads.whatsapp') !== 'all';
  const official = useOfficialNumber();
  const numbers = useChatNumbers();
  const ownNumbers = (numbers.data?.numbers ?? []).filter((n) => n.connected);
  // A seller with a work number of their own writes there even before the official number is live.
  const soon = seller && official.data?.live !== true && ownNumbers.length === 0;
  const narrow = {
    number: read('number'),
    sector: read('sector'),
    state: read('state'),
    from: read('from'),
    to: read('to'),
  };
  const list = useWhatsAppInbox(filter, q, narrow);
  const rows = list.data?.conversations ?? [];
  const open = rows.find((row) => row.conversationId === openId) ?? null;
  const location = useLocation();
  const narrowed = Object.values(narrow).filter(Boolean).length;
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
        {hasPermission(session.data, 'crm.manage') && <AssignmentModeSwitch />}
        {hasPermission(session.data, 'integrations.manage') && (
          <>
            <OfficialNumberSwitch live={official.data?.live} />
            <Link className="crm-muted" to="/crm-vendas/whatsapp/numeros">
              Números de WhatsApp
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
        <div className="crm-tabs crm-wa-tabs" role="tablist" aria-label="Filtro">
          {WA_INBOX_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`crm-tab${filter === key ? ' is-active' : ''}`}
              onClick={() => write('filter', key === 'all' ? '' : key)}
            >
              {WA_INBOX_FILTER_LABELS[key]}
            </button>
          ))}
        </div>
        <details className="crm-wa-filters" open={narrowed > 0}>
          <summary>Filtros{narrowed > 0 ? ` (${narrowed})` : ''}</summary>
          <div className="crm-wa-filters-grid">
            <label className="crm-field">
              <span>Número</span>
              <select
                className="crm-select"
                value={narrow.number}
                onChange={(e) => write('number', e.target.value)}
              >
                <option value="">Todos</option>
                <option value="official">Oficial</option>
                {(numbers.data?.numbers ?? []).map((n) => (
                  <option key={n.id} value={n.id}>
                    {numberNameOf(n)}
                    {n.ownerName ? ` (${n.ownerName})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="crm-field">
              <span>Departamento</span>
              <select
                className="crm-select"
                value={narrow.sector}
                onChange={(e) => write('sector', e.target.value)}
              >
                <option value="">Todos</option>
                {SECTOR_SLUGS.map((slug) => (
                  <option key={slug} value={slug}>
                    {SECTORS[slug].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="crm-field">
              <span>Situação</span>
              <select
                className="crm-select"
                value={narrow.state}
                onChange={(e) => write('state', e.target.value)}
              >
                <option value="">Todas</option>
                {SOFIA_STATES.map((state) => (
                  <option key={state} value={state}>
                    {SOFIA_STATE_LABELS[state]}
                  </option>
                ))}
              </select>
            </label>
            <label className="crm-field">
              <span>De</span>
              <input
                className="crm-input"
                type="date"
                value={narrow.from}
                onChange={(e) => write('from', e.target.value)}
              />
            </label>
            <label className="crm-field">
              <span>Até</span>
              <input
                className="crm-input"
                type="date"
                value={narrow.to}
                onChange={(e) => write('to', e.target.value)}
              />
            </label>
          </div>
        </details>
        {list.isLoading && <p className="crm-muted">Carregando…</p>}
        {list.isError && (
          <LoadFailure what="as conversas" error={list.error} onRetry={() => void list.refetch()} />
        )}
        {list.isSuccess && rows.length === 0 && (
          <div className="crm-empty">
            <span>
              {q || narrowed > 0
                ? 'Nenhuma conversa com essa busca ou esses filtros.'
                : filter === 'unread'
                  ? 'Nenhuma conversa com mensagem não lida.'
                  : filter === 'unanswered'
                    ? 'Nenhuma conversa esperando resposta.'
                    : filter === 'all'
                      ? 'Nenhuma conversa ainda.'
                      : 'Nenhuma conversa neste filtro.'}
            </span>
          </div>
        )}
        <ul className="crm-wa-web-rows">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <ConversationRow
                row={row}
                active={row.conversationId === openId}
                term={q}
                search={location.search}
              />
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <button
            type="button"
            className="crm-btn"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? 'Carregando…' : 'Carregar mais conversas'}
          </button>
        )}
      </aside>
      <section className="crm-wa-web-main">
        {openId ? (
          <OpenConversation id={openId} item={open} />
        ) : (
          <div className="crm-empty crm-wa-web-none">
            <Icon name="message" size={28} />
            <span>Escolha uma conversa ou comece uma nova.</span>
          </div>
        )}
      </section>
      {starting && (
        <WhatsAppNewConversation
          initial={asked ?? ''}
          onClose={() => {
            setStarting(false);
            if (asked !== null)
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  next.delete('nova');
                  return next;
                },
                { replace: true },
              );
          }}
        />
      )}
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
  search,
}: {
  row: WaConversationItem;
  active: boolean;
  term: string;
  search: string;
}) {
  const tick = row.lastDirection === 'out' && row.lastStatus ? TICKS[row.lastStatus] : null;
  const withSofia = row.attendance === 'sofia' || row.attendance === 'waiting_human';
  const read = row.lastStatus === 'read' || row.lastStatus === 'played';
  const name = nameOf(row);
  const responsible = row.holderName;
  const queue = row.queue && isSectorSlug(row.queue) ? SECTORS[row.queue].name : null;
  // A search that found a message shows that message, as WhatsApp's search does.
  const at = row.match?.at ?? row.lastAt;
  return (
    <Link
      className={`crm-wa-row${row.unreadCount > 0 ? ' is-unanswered' : ''}${active ? ' is-active' : ''}`}
      to={{ pathname: `/crm-vendas/whatsapp/${row.conversationId}`, search }}
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
        <span className="crm-wa-row-line crm-sub crm-wa-row-meta">
          <span>
            {formatPhone(row.phone)} · {numberNameOf(row.number)} ·{' '}
            {row.attendance === 'sofia' ? 'Sofia' : 'Pessoa'}
            {responsible ? ` · ${responsible}` : queue ? ` · fila ${queue}` : ' · sem responsável'}
          </span>
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
  const attendance = useConversationAttendance(id);
  const replying = useReplying(id);
  const typedAt = useRef(0);
  const { mutate: markRead } = useMarkWhatsAppRead();
  const location = useLocation();
  const [showPanel, setShowPanel] = useState(false);
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
        <Link
          className="crm-btn"
          to={{ pathname: '/crm-vendas/whatsapp', search: location.search }}
        >
          Voltar às conversas
        </Link>
      </div>
    );
  const data = thread.data;
  const leadId = data.leadId;
  const name = item
    ? nameOf(item)
    : (data.profileName ?? (data.phone ? formatPhone(data.phone) : 'Sem nome'));
  const back = `${location.pathname}${location.search}`;
  const view = attendance.data;
  const heldBy = heldByOf(view, session.data?.employeeId);
  const onTyping = () => {
    // "Está respondendo" lasts 45 s on the server: renewed at most every 20 s while typing.
    if (Date.now() - typedAt.current < 20_000) return;
    typedAt.current = Date.now();
    replying.mutate();
  };
  return (
    <div className="crm-wa-web-open">
      <header className="crm-wa-head">
        <Link
          className="crm-btn is-quiet is-small crm-wa-web-back"
          to={{ pathname: '/crm-vendas/whatsapp', search: location.search }}
        >
          ‹ Conversas
        </Link>
        <div className="crm-wa-who">
          <Avatar name={name} seed={id} />
          <div>
            <h1>{name}</h1>
            <span className="crm-sub">
              {data.phone ? formatPhone(data.phone) : 'Sem telefone'} · {numberNameOf(data.number)}
            </span>
          </div>
        </div>
        {leadId ? (
          <Link
            className="crm-btn is-small"
            to={`/crm-vendas/negociacoes/${leadId}`}
            state={{ back }}
          >
            Abrir negociação
          </Link>
        ) : mayOpenSofia && !data.number ? (
          <Link className="crm-btn is-small" to={`/crm-vendas/sofia/${id}`}>
            Ver na Sofia
          </Link>
        ) : null}
        <button
          type="button"
          className="crm-btn is-small crm-wa-web-panel-toggle"
          aria-pressed={showPanel}
          onClick={() => setShowPanel(!showPanel)}
        >
          {showPanel ? 'Conversa' : 'Contato'}
        </button>
      </header>
      {data.number && (
        <p className="crm-wa-window">
          Pelo WhatsApp de trabalho {numberNameOf(data.number)}
          {data.number.ownerName ? ` (${data.number.ownerName})` : ''}: o que sai daqui aparece no
          celular do dono, e a Sofia não atende por este número.
        </p>
      )}
      {(data.attendance === 'sofia' || data.attendance === 'waiting_human') && (
        <p className="crm-wa-window">
          {data.attendance === 'sofia'
            ? 'A Sofia está atendendo esta conversa. Se você escrever, ela para e a conversa passa a ser sua.'
            : 'Esta conversa espera um atendente. Escreva para assumir.'}
        </p>
      )}
      {view ? (
        <AttendanceBar id={id} view={view} me={session.data?.employeeId ?? null} />
      ) : attendance.isError ? (
        <p className="crm-wa-window is-closed">
          Quem atende: — não foi possível ler agora.{' '}
          <button
            type="button"
            className="crm-btn is-small"
            onClick={() => void attendance.refetch()}
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      {/* What came before stays on screen while the refresh tries again. */}
      {thread.isError && (
        <p className="crm-wa-window is-closed">
          Reconectando… A conversa mostra o que chegou até a última atualização.
        </p>
      )}
      <div className={`crm-wa-web-split${showPanel ? ' show-panel' : ''}`}>
        <WhatsAppChat
          // Sent in this conversation, to its own number (a deal's contact may not be its main phone).
          thread={{ conversationId: id }}
          data={data}
          canSend={canSend}
          heldBy={heldBy}
          onTyping={onTyping}
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
        <div className="crm-wa-web-panel" aria-label="Contato">
          {view && <AttendanceHistory view={view} />}
          {leadId ? (
            <DealPanel leadId={leadId} back={back} />
          ) : (
            <LinkPanel conversationId={id} phone={data.phone} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Who gets a conversation nobody holds (`crm.manage`, as the funnels' rotation). */
function AssignmentModeSwitch() {
  const mode = useAssignmentMode(true);
  const set = useSetAssignmentMode();
  if (!mode.data) return null;
  return (
    <label className="crm-field crm-wa-official">
      <span>Conversa sem responsável</span>
      <select
        className="crm-select"
        value={mode.data.mode}
        disabled={set.isPending}
        onChange={(event) => set.mutate(event.target.value as WaAssignmentMode)}
      >
        {WA_ASSIGNMENT_MODES.map((key) => (
          <option key={key} value={key}>
            {WA_ASSIGNMENT_MODE_LABELS[key]}
          </option>
        ))}
      </select>
      {set.isError && <span className="crm-error"> Não foi possível mudar agora.</span>}
    </label>
  );
}

/** The deal beside the conversation, when the reader may open it. */
function DealPanel({ leadId, back }: { leadId: string; back: string }) {
  const session = useSession();
  const loaded = useLead(leadId);
  if (loaded.isLoading) return <p className="crm-muted">Carregando a negociação…</p>;
  if (!loaded.data)
    return loaded.isError ? (
      <LoadFailure what="a negociação" error={loaded.error} onRetry={() => void loaded.refetch()} />
    ) : (
      <p className="crm-muted">— Negociação fora do seu alcance.</p>
    );
  return (
    <DealSidePanel
      data={loaded.data}
      canWrite={hasPermission(session.data, 'leads.write')}
      back={back}
    />
  );
}

/**
 * A conversation with no deal: the deals of its phone, to join one (nothing is guessed when there
 * are several); none, a new deal for the number, never a second one.
 */
function LinkPanel({ conversationId, phone }: { conversationId: string; phone: string | null }) {
  const session = useSession();
  const deals = useConversationDeals(conversationId, true);
  const link = useLinkConversation(conversationId);
  const found = deals.data?.deals ?? [];
  return (
    <section className="crm-panel" aria-label="Negociação">
      <h2>Negociação</h2>
      <p className="crm-sub">Esta conversa ainda não está numa negociação.</p>
      {deals.isLoading && <p className="crm-muted">Buscando negociações deste telefone…</p>}
      {deals.isError && (
        <LoadFailure
          what="as negociações deste telefone"
          error={deals.error}
          onRetry={() => void deals.refetch()}
        />
      )}
      {found.length > 0 && (
        <>
          <p className="crm-sub">
            {found.length === 1
              ? 'Uma negociação tem este telefone:'
              : `${found.length} negociações têm este telefone: escolha a desta conversa.`}
          </p>
          <ul className="crm-wa-targets">
            {found.map((deal) => (
              <li key={deal.leadId}>
                <button
                  type="button"
                  className="crm-wa-target"
                  disabled={link.isPending}
                  onClick={() => link.mutate(deal.leadId)}
                >
                  <b>Ligar a {deal.name ?? 'Sem nome'}</b>
                  <span className="crm-sub">
                    {deal.ownerName ?? 'Sem dono'}
                    {deal.open ? '' : ' · fechada'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {deals.isSuccess && found.length === 0 && phone && (
        <NewNumber
          phone={phone}
          canCreate={hasPermission(session.data, 'leads.write')}
          onCreated={(leadId) => link.mutate(leadId)}
        />
      )}
      {link.isError && (
        <p className="crm-error" role="alert">
          {link.error instanceof ApiError
            ? link.error.message
            : 'Não foi possível ligar a conversa agora.'}
        </p>
      )}
    </section>
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
