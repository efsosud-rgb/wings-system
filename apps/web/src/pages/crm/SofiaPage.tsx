import {
  LEAD_PIPELINE_LABELS,
  SOFIA_SEGMENT_LABELS,
  SOFIA_STATE_LABELS,
  SOFIA_STATES,
  type SofiaConversationDetail,
  type SofiaConversationItem,
  type SofiaOverview,
  type SofiaSegment,
  type SofiaState,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  useSofiaAttendance,
  useSofiaConversation,
  useSofiaConversations,
  useSofiaOverview,
  type SofiaFilter,
} from '../../api/sofia.js';
import { useMarkWhatsAppRead } from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { ago, formatPhone } from './format.js';
import { SofiaSettingsForm } from './SofiaSettingsForm.js';
import { WhatsAppChat } from './WhatsAppChat.js';
import './sofia.css';

/**
 * CRM Vendas → Sofia (SDR IA): every WhatsApp conversation with who has it
 * now — Sofia, a seller, a person of the team — what she found out and the
 * deal she made; taking a conversation, giving it back to her, closing it;
 * and her settings. The list is the reader's scope (`leads.whatsapp`, a seller
 * their own deals); the settings are read by all and edited by `sofia.manage`.
 * Desktop shows the list and the conversation side by side; a phone shows one
 * at a time.
 */

const BASE = '/crm-vendas/sofia';

const SEGMENT_FILTERS: { value: SofiaSegment | 'none'; label: string }[] = [
  { value: 'expansao', label: SOFIA_SEGMENT_LABELS.expansao },
  { value: 'formatacao', label: SOFIA_SEGMENT_LABELS.formatacao },
  { value: 'outro', label: SOFIA_SEGMENT_LABELS.outro },
  { value: 'none', label: 'Sem funil' },
];

/** The two states that come with a reason worth reading in the list. */
const SHOWS_REASON: SofiaState[] = ['waiting_human', 'closed'];

const usd = (value: number) =>
  value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const nameOf = (item: SofiaConversationItem) =>
  item.leadName ?? item.profileName ?? formatPhone(item.phone);

/** "Expansão · Casa do Churros", or whichever of the two is known. */
const funnelOf = (item: SofiaConversationItem) =>
  [item.segment ? SOFIA_SEGMENT_LABELS[item.segment] : null, item.brandName]
    .filter(Boolean)
    .join(' · ');

function StateBadge({ state }: { state: SofiaState }) {
  return <span className={`sofia-state is-${state}`}>{SOFIA_STATE_LABELS[state]}</span>;
}

export function SofiaPage() {
  const { id } = useParams<{ id: string }>();
  const overview = useSofiaOverview();
  const [tab, setTab] = useState<'conversas' | 'configuracao'>('conversas');
  // Once opened, the settings stay mounted (hidden): a half-edited form survives a look at the list.
  const [settingsOpened, setSettingsOpened] = useState(false);
  const info = overview.data;
  return (
    <div className="crm-page sofia">
      <header className="crm-head">
        <h1>Sofia (SDR IA)</h1>
        {info && (
          <>
            <span className={`sofia-status${info.enabled ? ' is-on' : ''}`}>
              {info.enabled ? 'Ligada' : 'Desligada'}
            </span>
            <span className="crm-sub" title={`Modelo: ${info.model}`}>
              IA: US$ {usd(info.spentTodayUsd)} de US$ {usd(info.dailyUsd)} hoje
            </span>
          </>
        )}
      </header>
      {info && (!info.whatsappConfigured || !info.aiConfigured) && (
        <div className="sofia-warnings">
          {!info.whatsappConfigured && (
            <p className="sofia-warn">O WhatsApp oficial ainda não está ligado neste servidor.</p>
          )}
          {!info.aiConfigured && (
            <p className="sofia-warn">
              A chave da IA não está configurada: a Sofia passa toda conversa para uma pessoa.
            </p>
          )}
        </div>
      )}
      <div className="crm-tabs" role="tablist" aria-label="Sofia">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'conversas'}
          className={`crm-tab${tab === 'conversas' ? ' is-active' : ''}`}
          onClick={() => setTab('conversas')}
        >
          Conversas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'configuracao'}
          className={`crm-tab${tab === 'configuracao' ? ' is-active' : ''}`}
          onClick={() => {
            setTab('configuracao');
            setSettingsOpened(true);
          }}
        >
          Configuração
        </button>
      </div>
      {tab === 'conversas' && <Conversations id={id} overview={info} />}
      {settingsOpened && (
        <div className="crm-page-scroll" hidden={tab !== 'configuracao'}>
          {overview.isLoading ? (
            <p className="crm-muted">Carregando…</p>
          ) : (
            <SofiaSettingsForm canManage={info?.canManage ?? false} />
          )}
        </div>
      )}
    </div>
  );
}

function Conversations({ id, overview }: { id?: string; overview?: SofiaOverview }) {
  const [filter, setFilter] = useState<SofiaFilter>({});
  const [q, setQ] = useState('');
  const timer = useRef<number | null>(null);
  const list = useSofiaConversations(filter);
  const rows = list.data?.conversations ?? [];
  const counts = overview?.counts;
  const total = counts ? SOFIA_STATES.reduce((sum, state) => sum + counts[state], 0) : null;
  const chip = (state: SofiaState | undefined, label: string, count: number | null) => (
    <button
      key={state ?? 'all'}
      type="button"
      className={`crm-chip${filter.state === state ? ' is-on' : ''}`}
      aria-pressed={filter.state === state}
      onClick={() => setFilter((f) => ({ ...f, state }))}
    >
      {label}
      {count !== null && <span className="sofia-count">{count}</span>}
    </button>
  );
  return (
    <div className={`sofia-split${id ? ' has-selection' : ''}`}>
      <section className="sofia-list-pane" aria-label="Conversas">
        <div className="sofia-filters" role="search">
          <div className="crm-filter-chips" role="group" aria-label="Quem atende">
            {chip(undefined, 'Todas', total)}
            {SOFIA_STATES.map((state) =>
              chip(
                state,
                state === 'closed' ? 'Encerradas' : SOFIA_STATE_LABELS[state],
                counts ? counts[state] : null,
              ),
            )}
          </div>
          <div className="sofia-filter-row">
            <select
              className={`crm-select${filter.segment ? ' has-value' : ''}`}
              aria-label="Funil"
              value={filter.segment ?? ''}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  segment: (e.target.value || undefined) as SofiaFilter['segment'],
                }))
              }
            >
              <option value="">Todos os funis</option>
              {SEGMENT_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              className={`crm-input${q ? ' has-value' : ''}`}
              type="search"
              placeholder="Buscar por nome ou telefone"
              aria-label="Buscar"
              value={q}
              maxLength={80}
              onChange={(event) => {
                const value = event.target.value;
                setQ(value);
                if (timer.current) window.clearTimeout(timer.current);
                timer.current = window.setTimeout(
                  () => setFilter((f) => ({ ...f, q: value })),
                  300,
                );
              }}
            />
          </div>
        </div>
        {list.isLoading && <p className="crm-muted sofia-pad">Carregando…</p>}
        {list.isError && !list.data && (
          <p className="crm-error sofia-pad">Não foi possível carregar as conversas.</p>
        )}
        {!list.isLoading && !list.isError && rows.length === 0 && (
          <div className="crm-empty">
            <span>Nenhuma conversa com esses filtros.</span>
          </div>
        )}
        <ul className="sofia-list">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <ConversationRow row={row} selected={row.conversationId === id} />
            </li>
          ))}
        </ul>
      </section>
      <section className="sofia-detail-pane" aria-label="Conversa selecionada">
        {id ? (
          <ConversationDetail key={id} id={id} />
        ) : (
          <div className="crm-empty">
            <span>Escolha uma conversa para ver o que a Sofia descobriu.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function ConversationRow({ row, selected }: { row: SofiaConversationItem; selected: boolean }) {
  const funnel = funnelOf(row);
  return (
    <Link
      className={`sofia-row${selected ? ' is-selected' : ''}`}
      to={`${BASE}/${row.conversationId}`}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="sofia-row-top">
        <b>{nameOf(row)}</b>
        <span className="sofia-row-when">
          {row.unreadCount > 0 && (
            <span className="sofia-unread" title="Mensagens que você ainda não abriu">
              {row.unreadCount}
            </span>
          )}
          <span className="crm-muted">{row.lastAt ? ago(row.lastAt) : ''}</span>
        </span>
      </span>
      <span className="sofia-row-tags">
        <StateBadge state={row.state} />
        {funnel && <span className="crm-sub">{funnel}</span>}
      </span>
      <span className="sofia-row-preview crm-sub">{row.preview ?? '—'}</span>
      {(row.ownerName || (row.reason && SHOWS_REASON.includes(row.state))) && (
        <span className="sofia-row-foot crm-muted">
          {[row.ownerName, SHOWS_REASON.includes(row.state) ? row.reason : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
    </Link>
  );
}

function ConversationDetail({ id }: { id: string }) {
  const session = useSession();
  const detail = useSofiaConversation(id);
  const attendance = useSofiaAttendance(id);
  const { mutate: markRead } = useMarkWhatsAppRead();
  const last = detail.data?.thread.messages.at(-1)?.id;
  // Opening the conversation here counts as read too, as on the WhatsApp screen.
  useEffect(() => {
    if (last) markRead(id);
  }, [id, last, markRead]);
  const back = (
    <Link className="crm-btn is-quiet is-small sofia-back" to={BASE}>
      ‹ Conversas
    </Link>
  );
  if (detail.isLoading)
    return (
      <div className="sofia-detail">
        {back}
        <p className="crm-muted">Carregando a conversa…</p>
      </div>
    );
  if (!detail.data)
    return (
      <div className="sofia-detail">
        {back}
        <div className="crm-empty">
          <span>Conversa não encontrada ou fora do seu alcance.</span>
        </div>
      </div>
    );
  const data = detail.data;
  const { item, can } = data;
  const funnel = funnelOf(item);
  const act = (action: 'take' | 'give_back' | 'close') => {
    if (
      action === 'close' &&
      !window.confirm('Encerrar esta conversa? Se a pessoa escrever de novo, ela recomeça.')
    )
      return;
    attendance.mutate(action);
  };
  return (
    <div className="sofia-detail">
      {back}
      <header className="sofia-detail-head">
        <div className="crm-wa-who">
          <span className="crm-wa-avatar" aria-hidden="true">
            <Icon name="message" size={18} />
          </span>
          <div>
            <h2>{nameOf(item)}</h2>
            <span className="crm-sub">
              {formatPhone(item.phone)}
              {funnel ? ` · ${funnel}` : ''}
            </span>
          </div>
        </div>
        <div className="sofia-detail-state">
          <StateBadge state={item.state} />
          {item.reason && <span className="crm-sub">{item.reason}</span>}
        </div>
        <div className="sofia-actions">
          {can.take && (
            <button
              type="button"
              className="crm-btn is-primary is-small"
              disabled={attendance.isPending}
              onClick={() => act('take')}
            >
              Assumir conversa
            </button>
          )}
          {can.giveBack && (
            <button
              type="button"
              className="crm-btn is-small"
              disabled={attendance.isPending}
              onClick={() => act('give_back')}
            >
              Devolver para a Sofia
            </button>
          )}
          {can.close && (
            <button
              type="button"
              className="crm-btn is-small is-danger"
              disabled={attendance.isPending}
              onClick={() => act('close')}
            >
              Encerrar
            </button>
          )}
        </div>
      </header>
      {attendance.error ? (
        <p className="crm-error" role="alert">
          {errorText(attendance.error, 'Não foi possível mudar quem atende.')}
        </p>
      ) : null}
      <div className="sofia-detail-body">
        <div className="sofia-chat">
          {item.state !== 'with_person' && (
            <p className="sofia-note">Escrever na conversa tira a conversa da Sofia.</p>
          )}
          <WhatsAppChat
            thread={data.lead ? { leadId: data.lead.id } : { conversationId: item.conversationId }}
            data={data.thread}
            canSend={hasPermission(session.data, 'leads.whatsapp')}
          />
        </div>
        <aside className="crm-wa-side">
          <Facts data={data} />
          <Origin data={data} />
          <Deal data={data} />
        </aside>
      </div>
    </div>
  );
}

function Facts({ data }: { data: SofiaConversationDetail }) {
  return (
    <section className="crm-panel" aria-label="O que a Sofia descobriu">
      <h2>O que a Sofia descobriu</h2>
      {data.facts.length === 0 ? (
        <p className="crm-muted">Ainda nada.</p>
      ) : (
        <dl className="crm-kv sofia-kv">
          {data.facts.map((fact) => (
            <div key={fact.key} style={{ display: 'contents' }}>
              <dt>{fact.label}</dt>
              <dd>{fact.answer}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Origin({ data }: { data: SofiaConversationDetail }) {
  const { code, adHeadline, adId } = data.origin;
  return (
    <section className="crm-panel" aria-label="Origem">
      <h2>Origem</h2>
      {code || adHeadline || adId ? (
        <dl className="crm-kv sofia-kv">
          {code && (
            <div style={{ display: 'contents' }}>
              <dt>Código</dt>
              <dd>{code}</dd>
            </div>
          )}
          {(adHeadline || adId) && (
            <div style={{ display: 'contents' }}>
              <dt>Anúncio</dt>
              <dd>
                {adHeadline ?? 'Sem título'}
                {adId && <small className="crm-muted"> · {adId}</small>}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="crm-sub">Mensagem direta</p>
      )}
    </section>
  );
}

function Deal({ data }: { data: SofiaConversationDetail }) {
  const { lead } = data;
  return (
    <section className="crm-panel" aria-label="Negociação">
      <h2>Negociação</h2>
      {lead ? (
        <>
          <Link className="sofia-deal-link" to={`/crm-vendas/negociacoes/${lead.id}`}>
            {lead.name ?? 'Sem nome'}
          </Link>
          <dl className="crm-kv sofia-kv">
            <div style={{ display: 'contents' }}>
              <dt>Funil</dt>
              <dd>{lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}</dd>
            </div>
            <div style={{ display: 'contents' }}>
              <dt>Etapa</dt>
              <dd>{lead.stage ?? '—'}</dd>
            </div>
            <div style={{ display: 'contents' }}>
              <dt>Dono</dt>
              <dd>{lead.ownerName ?? 'Sem dono'}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="crm-sub">
          Nenhuma negociação ainda: a Sofia cria quando terminar as perguntas.
        </p>
      )}
    </section>
  );
}
