import {
  INACTIVE_OWNER,
  INACTIVE_OWNER_LABEL,
  LEAD_OUTCOME_LABELS,
  LEAD_OUTCOMES,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  LEAD_SORT_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_TASK_KIND_LABELS,
  sourceBadgeOf,
  type BoardCard,
  type BoardColumn,
  type LeadListItem,
  type LeadPipeline,
  type LeadTask,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  downloadExport,
  useBrands,
  useCompleteTask,
  useDealBoard,
  useDealCounters,
  useDealList,
  useDealQuickChange,
  useDeleteView,
  useLoadColumn,
  useSaveView,
  useSavedViews,
  useTaskList,
  type DealFilter,
} from '../../api/crm.js';
import { useCreateLead, useSellers } from '../../api/leads.js';
import { CreateDealModal, CreateTaskModal } from './CreateDealModal.js';
import { DealCard } from './DealCard.js';
import { ImportModal } from './ImportModal.js';
import {
  ago,
  dueLabel,
  formatDate,
  formatPhone,
  isPast,
  money,
  moneyShort,
  stageHue,
} from './format.js';

/**
 * CRM Vendas → Negociações. The board of one funnel is the default view:
 * full height, columns that scroll sideways, the stage arrows with count and
 * value, cards you drag. Lista, Atividades and Calendário are the other
 * views of the same filtered set. Everything here reads what the API
 * decided; no number is computed on the screen except sums it was given.
 */

type View = 'board' | 'list' | 'activities' | 'calendar';

const FILTER_KEYS: (keyof DealFilter)[] = [
  'q',
  'owner',
  'outcome',
  'createdFrom',
  'createdTo',
  'activityDays',
  'source',
  'campaign',
  'clientId',
  'staleDays',
  'sort',
  'stage',
  'mine',
];

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

export function DealsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canWrite = hasPermission(session.data, 'leads.write');
  const canManage = hasPermission(session.data, 'crm.manage');
  const pipeline = (LEAD_PIPELINES as readonly string[]).includes(params.get('funil') ?? '')
    ? (params.get('funil') as LeadPipeline)
    : 'expansao';
  const view = (params.get('visao') as View) || 'board';
  const filter = useMemo(() => {
    const next: DealFilter = {};
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) next[key] = value;
    }
    return next;
  }, [params]);
  const tab = params.get('aba') ?? (filter.mine ? 'mine' : 'all');

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const setFilter = (key: keyof DealFilter, value: string) =>
    update({ [key]: value, aba: tab === 'all' || tab === 'mine' ? tab : undefined });
  const clearFilters = () => {
    const next = new URLSearchParams();
    next.set('funil', pipeline);
    if (view !== 'board') next.set('visao', view);
    setParams(next, { replace: true });
  };

  const views = useSavedViews();
  const saveView = useSaveView();
  const deleteView = useDeleteView();
  const myViews = (views.data?.views ?? []).filter((item) => item.pipeline === pipeline);
  const sellers = useSellers();
  const brands = useBrands();
  const counters = useDealCounters(pipeline);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [taskFor, setTaskFor] = useState<{ id: string; name: string | null } | null>(null);
  const activeFilters = FILTER_KEYS.filter(
    (key) => key !== 'sort' && key !== 'mine' && filter[key],
  ).length;

  const applyTab = (next: string) => {
    if (next === 'all') update({ aba: 'all', mine: undefined });
    else if (next === 'mine') update({ aba: 'mine', mine: 'true' });
    else {
      const saved = myViews.find((item) => item.id === next);
      if (!saved) return;
      const query = new URLSearchParams({ funil: pipeline, aba: saved.id });
      if (view !== 'board') query.set('visao', view);
      for (const [key, value] of Object.entries(saved.filters)) if (value) query.set(key, value);
      setParams(query, { replace: true });
    }
  };

  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Negociações</h1>
        <select
          className="crm-pipeline"
          aria-label="Funil"
          value={pipeline}
          onChange={(event) =>
            update({ funil: event.target.value, stage: undefined, aba: 'all', mine: undefined })
          }
        >
          {LEAD_PIPELINES.map((item) => (
            <option key={item} value={item}>
              {LEAD_PIPELINE_LABELS[item]}
            </option>
          ))}
        </select>
        <div className="crm-counters" aria-label="Resumo do funil">
          <button
            type="button"
            className="crm-counter is-new"
            onClick={() => update({ activityDays: undefined, visao: 'board', sort: 'oldest' })}
            title="Negociações em andamento em que ninguém ainda registrou contato"
          >
            <strong>{counters.data?.untouched ?? '–'}</strong> novas sem contato
          </button>
          <button
            type="button"
            className="crm-counter"
            onClick={() => update({ visao: 'activities' })}
          >
            <strong>{counters.data?.today ?? '–'}</strong> atividades hoje
          </button>
          <button
            type="button"
            className={`crm-counter${(counters.data?.overdue ?? 0) > 0 ? ' is-alert' : ''}`}
            onClick={() => update({ visao: 'activities' })}
          >
            <strong>{counters.data?.overdue ?? '–'}</strong> atrasadas
          </button>
        </div>
        <span className="crm-head-spacer" />
        {canManage && (
          <Link
            className="crm-btn is-quiet"
            to={`/crm-vendas/configuracoes/automacoes/${pipeline}`}
          >
            Regras de automação
          </Link>
        )}
        {canWrite && (
          <button type="button" className="crm-btn is-primary" onClick={() => setCreating(true)}>
            + Criar
          </button>
        )}
        <div className="crm-menu">
          <button
            type="button"
            className="crm-btn is-icon"
            aria-label="Mais ações"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            ⋮
          </button>
          {menu && (
            <div className="crm-menu-list" onMouseLeave={() => setMenu(false)}>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    setImporting(true);
                  }}
                >
                  Importar planilha (CSV)
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenu(false);
                  void downloadExport({ ...filter, pipeline });
                }}
              >
                Exportar lista filtrada (CSV)
              </button>
              {canManage && (
                <Link to="/crm-vendas/configuracoes" onClick={() => setMenu(false)}>
                  Configurações do funil
                </Link>
              )}
            </div>
          )}
        </div>
      </header>

      <nav className="crm-tabs" aria-label="Visões">
        <button
          type="button"
          className={`crm-tab${tab === 'all' ? ' is-active' : ''}`}
          onClick={() => applyTab('all')}
        >
          Todas
        </button>
        <button
          type="button"
          className={`crm-tab${tab === 'mine' ? ' is-active' : ''}`}
          onClick={() => applyTab('mine')}
        >
          Minhas
        </button>
        {myViews.map((saved) => (
          <button
            key={saved.id}
            type="button"
            className={`crm-tab${tab === saved.id ? ' is-active' : ''}`}
            onClick={() => applyTab(saved.id)}
          >
            {saved.name}
            {tab === saved.id && (
              <span
                className="crm-tab-x"
                role="button"
                aria-label={`Excluir a visão ${saved.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (window.confirm(`Excluir a visão "${saved.name}"?`))
                    deleteView.mutate(saved.id, { onSuccess: () => applyTab('all') });
                }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
        {activeFilters > 0 && (tab === 'all' || tab === 'mine') && (
          <button
            type="button"
            className="crm-tab"
            disabled={saveView.isPending}
            onClick={() => {
              const name = window.prompt('Nome da visão');
              if (!name) return;
              const filters: Record<string, string> = {};
              for (const key of FILTER_KEYS) if (filter[key]) filters[key] = filter[key]!;
              saveView.mutate(
                { pipeline, name, filters },
                { onSuccess: (answer) => update({ aba: answer.view.id }) },
              );
            }}
          >
            + Salvar visão
          </button>
        )}
        <div className="crm-tabs-right">
          <div className="crm-segment" role="group" aria-label="Modo de visualização">
            {(
              [
                ['board', 'Kanban'],
                ['list', 'Lista'],
                ['activities', 'Atividades'],
                ['calendar', 'Calendário'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={view === key ? 'is-active' : ''}
                onClick={() => update({ visao: key === 'board' ? undefined : key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <Filters
        pipeline={pipeline}
        filter={filter}
        set={setFilter}
        clear={clearFilters}
        advanced={advanced}
        onAdvanced={() => setAdvanced((open) => !open)}
        sellers={(sellers.data?.sellers ?? []).filter((seller) => seller.active)}
        brands={brands.data?.brands ?? []}
        activeFilters={activeFilters}
      />

      {view === 'board' && (
        <BoardView
          pipeline={pipeline}
          filter={filter}
          canWrite={canWrite}
          onTask={(card) => setTaskFor({ id: card.id, name: card.name })}
        />
      )}
      {view === 'list' && <ListView pipeline={pipeline} filter={filter} />}
      {view === 'activities' && <ActivitiesView pipeline={pipeline} canWrite={canWrite} />}
      {view === 'calendar' && <CalendarView />}

      {creating && (
        <CreateDealModal
          pipeline={pipeline}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/crm-vendas/negociacoes/${id}`);
          }}
        />
      )}
      {importing && <ImportModal pipeline={pipeline} onClose={() => setImporting(false)} />}
      {taskFor && (
        <CreateTaskModal
          leadId={taskFor.id}
          leadName={taskFor.name}
          onClose={() => setTaskFor(null)}
        />
      )}
    </div>
  );
}

// --- filters ----------------------------------------------------------------------------

function Filters({
  pipeline,
  filter,
  set,
  clear,
  advanced,
  onAdvanced,
  sellers,
  brands,
  activeFilters,
}: {
  pipeline: LeadPipeline;
  filter: DealFilter;
  set: (key: keyof DealFilter, value: string) => void;
  clear: () => void;
  advanced: boolean;
  onAdvanced: () => void;
  sellers: { id: string; name: string }[];
  brands: { clientId: string; name: string }[];
  activeFilters: number;
}) {
  const [q, setQ] = useState(filter.q ?? '');
  const timer = useRef<number | null>(null);
  useEffect(() => setQ(filter.q ?? ''), [filter.q]);
  const cls = (key: keyof DealFilter, base: string) => `${base}${filter[key] ? ' has-value' : ''}`;
  return (
    <>
      <div className="crm-filters" role="search">
        <input
          className={cls('q', 'crm-input crm-search')}
          placeholder="Buscar por nome, empresa, e-mail ou telefone"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => set('q', event.target.value), 300);
          }}
        />
        <select
          className={cls('owner', 'crm-select')}
          aria-label="Dono"
          value={filter.owner ?? ''}
          onChange={(e) => set('owner', e.target.value)}
        >
          <option value="">Dono: todos</option>
          <option value={INACTIVE_OWNER}>{INACTIVE_OWNER_LABEL}</option>
          {sellers.map((seller) => (
            <option key={seller.id} value={seller.id}>
              {seller.name}
            </option>
          ))}
        </select>
        <select
          className={cls('outcome', 'crm-select')}
          aria-label="Situação"
          value={filter.outcome ?? ''}
          onChange={(e) => set('outcome', e.target.value)}
        >
          <option value="">Em andamento</option>
          {LEAD_OUTCOMES.filter((item) => item !== 'open').map((item) => (
            <option key={item} value={item}>
              {LEAD_OUTCOME_LABELS[item]}
            </option>
          ))}
        </select>
        <select
          className={cls('source', 'crm-select')}
          aria-label="Origem"
          value={filter.source ?? ''}
          onChange={(e) => set('source', e.target.value)}
        >
          <option value="">Origem: todas</option>
          {LEAD_SOURCES.map((item) => (
            <option key={item} value={item}>
              {LEAD_SOURCE_LABELS[item]}
            </option>
          ))}
        </select>
        {pipeline === 'expansao' && (
          <select
            className={cls('clientId', 'crm-select')}
            aria-label="Marca"
            value={filter.clientId ?? ''}
            onChange={(e) => set('clientId', e.target.value)}
          >
            <option value="">Marca: todas</option>
            {brands.map((brand) => (
              <option key={brand.clientId} value={brand.clientId}>
                {brand.name}
              </option>
            ))}
          </select>
        )}
        <select
          className={cls('staleDays', 'crm-select')}
          aria-label="Parados"
          value={filter.staleDays ?? ''}
          onChange={(e) => set('staleDays', e.target.value)}
        >
          <option value="">Parados: qualquer tempo</option>
          {['3', '7', '15', '30', '60'].map((days) => (
            <option key={days} value={days}>
              Parados há mais de {days} dias
            </option>
          ))}
        </select>
        <select
          className={cls('sort', 'crm-select')}
          aria-label="Ordenação"
          value={filter.sort ?? ''}
          onChange={(e) => set('sort', e.target.value)}
        >
          <option value="">Mais recentes</option>
          {(Object.keys(LEAD_SORT_LABELS) as (keyof typeof LEAD_SORT_LABELS)[])
            .filter((key) => key !== 'recent')
            .map((key) => (
              <option key={key} value={key}>
                {LEAD_SORT_LABELS[key]}
              </option>
            ))}
        </select>
        <button
          type="button"
          className={`crm-btn is-quiet${advanced ? ' is-active' : ''}`}
          onClick={onAdvanced}
          aria-expanded={advanced}
        >
          Filtros avançados{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>
        {activeFilters > 0 && (
          <button type="button" className="crm-btn is-quiet is-small" onClick={clear}>
            Limpar
          </button>
        )}
      </div>
      {advanced && (
        <div className="crm-advanced">
          <label>
            Criadas de
            <input
              className="crm-input"
              type="date"
              value={filter.createdFrom ?? ''}
              onChange={(e) => set('createdFrom', e.target.value)}
            />
          </label>
          <label>
            Criadas até
            <input
              className="crm-input"
              type="date"
              value={filter.createdTo ?? ''}
              onChange={(e) => set('createdTo', e.target.value)}
            />
          </label>
          <label>
            Última atividade
            <select
              className="crm-select"
              value={filter.activityDays ?? ''}
              onChange={(e) => set('activityDays', e.target.value)}
            >
              <option value="">Qualquer</option>
              {['1', '3', '7', '15', '30'].map((days) => (
                <option key={days} value={days}>
                  Nos últimos {days} dias
                </option>
              ))}
            </select>
          </label>
          <label>
            Campanha
            <input
              className="crm-input"
              placeholder="Nome ou id da campanha"
              value={filter.campaign ?? ''}
              onChange={(e) => set('campaign', e.target.value)}
            />
          </label>
          <label>
            Etapa (nome)
            <input
              className="crm-input"
              value={filter.stage ?? ''}
              onChange={(e) => set('stage', e.target.value)}
            />
          </label>
        </div>
      )}
    </>
  );
}

// --- board ------------------------------------------------------------------------------

function BoardView({
  pipeline,
  filter,
  canWrite,
  onTask,
}: {
  pipeline: LeadPipeline;
  filter: DealFilter;
  canWrite: boolean;
  onTask: (card: BoardCard) => void;
}) {
  const board = useDealBoard(pipeline, filter);
  const change = useDealQuickChange();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const data = board.data;
  if (board.isLoading && !data)
    return (
      <p className="crm-muted" style={{ padding: 'var(--space-5)' }}>
        Carregando o quadro…
      </p>
    );
  if (board.isError || !data)
    return (
      <p className="crm-error" style={{ margin: 'var(--space-5)' }}>
        Não foi possível carregar o quadro. Recarregue a página.
      </p>
    );
  const columns = data.columns;
  return (
    <>
      <div
        className="crm-filters-total"
        style={{ padding: '0 var(--space-5) var(--space-1)', marginLeft: 0 }}
      >
        <strong>{data.total}</strong> negociações · <strong>{money(data.valueCents)}</strong> em
        valor · ponderado <strong>{money(data.weightedCents)}</strong>
      </div>
      {change.error && (
        <p className="crm-error" style={{ margin: '0 var(--space-5) var(--space-2)' }}>
          {errorText(change.error, 'Não foi possível alterar a negociação.')}
        </p>
      )}
      {columns.length === 0 && (
        <div className="crm-empty">
          <span>Este funil ainda não tem etapas.</span>
          <Link className="crm-btn" to="/crm-vendas/configuracoes">
            Criar as etapas
          </Link>
        </div>
      )}
      <div
        className="crm-board"
        role="list"
        aria-label={`Quadro ${LEAD_PIPELINE_LABELS[pipeline]}`}
      >
        {columns.map((column, index) => (
          <Column
            key={column.stage?.id ?? 'none'}
            pipeline={pipeline}
            filter={filter}
            column={column}
            first={index === 0 || (index === 1 && columns[0]?.stage === null)}
            canWrite={canWrite}
            isOver={over === (column.stage?.id ?? 'none')}
            onDragOver={() => setOver(column.stage?.id ?? 'none')}
            onDragLeave={() => setOver(null)}
            onDrop={() => {
              if (dragging && column.stage?.active)
                change.mutate({ id: dragging, stageId: column.stage.id });
              setDragging(null);
              setOver(null);
            }}
            renderCard={(card) => (
              <DealCard
                key={card.id}
                card={card}
                canWrite={canWrite}
                dragging={dragging === card.id}
                onDragStart={() => setDragging(card.id)}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onWon={() => change.mutate({ id: card.id, won: true })}
                onLost={(reason) => change.mutate({ id: card.id, won: false, lostReason: reason })}
                onTask={() => onTask(card)}
              />
            )}
          />
        ))}
      </div>
    </>
  );
}

function Column({
  pipeline,
  filter,
  column,
  first,
  canWrite,
  isOver,
  onDragOver,
  onDragLeave,
  onDrop,
  renderCard,
}: {
  pipeline: LeadPipeline;
  filter: DealFilter;
  column: BoardColumn;
  first: boolean;
  canWrite: boolean;
  isOver: boolean;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  renderCard: (card: BoardCard) => React.ReactNode;
}) {
  const more = useLoadColumn();
  const [extra, setExtra] = useState<BoardCard[]>([]);
  useEffect(() => setExtra([]), [column.cards]);
  const cards = [...column.cards, ...extra];
  const canDrop = canWrite && Boolean(column.stage?.active);
  const title = column.stage ? column.stage.name : 'Sem etapa';
  return (
    <section
      role="listitem"
      className={`crm-col${isOver && canDrop ? ' is-over' : ''}`}
      aria-label={`${title}: ${column.total}`}
      onDragOver={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        onDrop();
      }}
    >
      <div
        className={`crm-col-head${column.stage ? '' : ' is-none'}`}
        style={
          column.stage
            ? ({ '--arrow': stageHue(column.stage.position) } as React.CSSProperties)
            : undefined
        }
        title={column.stage ? `${column.stage.probability}% de chance de fechar` : undefined}
      >
        <div className="crm-col-title">
          <span>
            {title}
            {column.stage && !column.stage.active ? ' (desativada)' : ''}
          </span>
          <span>{column.total}</span>
        </div>
        <div className="crm-col-money">
          <span>{moneyShort(column.valueCents)}</span>
          {column.stage && (
            <span>
              {column.stage.probability}% · {moneyShort(column.weightedCents)}
            </span>
          )}
        </div>
      </div>
      <div className="crm-col-body">
        {first && canWrite && column.stage?.active && (
          <QuickDeal pipeline={pipeline} stageId={column.stage.id} />
        )}
        {cards.map(renderCard)}
        {cards.length === 0 && !first && <div className="crm-col-empty">Nenhuma negociação</div>}
        {column.total > cards.length && (
          <button
            type="button"
            className="crm-btn is-small is-quiet crm-col-more"
            disabled={more.isPending}
            onClick={() =>
              more.mutate(
                { pipeline, stageId: column.stage?.id ?? null, offset: cards.length, filter },
                { onSuccess: (answer) => setExtra((current) => [...current, ...answer.cards]) },
              )
            }
          >
            {more.isPending ? 'Carregando…' : `Carregar mais (${column.total - cards.length})`}
          </button>
        )}
      </div>
    </section>
  );
}

/** "+ Negócio rápido" at the top of the first column: name, contact and phone; the rest later. */
function QuickDeal({ pipeline, stageId }: { pipeline: LeadPipeline; stageId: string }) {
  const create = useCreateLead();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', companyName: '', phone: '' });
  if (!open)
    return (
      <button type="button" className="crm-btn is-small" onClick={() => setOpen(true)}>
        + Negócio rápido
      </button>
    );
  return (
    <form
      className="crm-quick"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          {
            name: form.name,
            companyName: form.companyName || undefined,
            phone: form.phone,
            pipeline,
            stageId,
            legalBasis: 'legitimate_interest',
          },
          {
            onSuccess: () => {
              setForm({ name: '', companyName: '', phone: '' });
              setOpen(false);
            },
          },
        );
      }}
    >
      <input
        className="crm-input"
        placeholder="Nome"
        value={form.name}
        autoFocus
        maxLength={120}
        onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
      />
      <input
        className="crm-input"
        placeholder="Empresa (opcional)"
        value={form.companyName}
        maxLength={120}
        onChange={(e) => setForm((c) => ({ ...c, companyName: e.target.value }))}
      />
      <input
        className="crm-input"
        placeholder="Telefone"
        value={form.phone}
        inputMode="tel"
        onChange={(e) => setForm((c) => ({ ...c, phone: e.target.value }))}
      />
      {create.error && (
        <span className="crm-error">{errorText(create.error, 'Não foi possível criar.')}</span>
      )}
      <div className="crm-quick-row">
        <button type="button" className="crm-btn is-small is-quiet" onClick={() => setOpen(false)}>
          Cancelar
        </button>
        <button
          type="submit"
          className="crm-btn is-small is-primary"
          disabled={
            create.isPending ||
            form.name.trim().length < 2 ||
            form.phone.replace(/\D/g, '').length < 10
          }
        >
          Criar
        </button>
      </div>
    </form>
  );
}

// --- list ------------------------------------------------------------------------------

function ListView({ pipeline, filter }: { pipeline: LeadPipeline; filter: DealFilter }) {
  const list = useDealList({ ...filter, pipeline, outcome: filter.outcome ?? 'open' });
  const rows = list.data?.leads ?? [];
  const total = list.data?.total ?? 0;
  const sum = rows.reduce((acc, row) => acc + (row.valueCents ?? 0), 0);
  return (
    <div className="crm-page-scroll">
      <div
        className="crm-filters-total"
        style={{ marginLeft: 0, paddingLeft: 0, marginBottom: 'var(--space-2)' }}
      >
        <strong>{total}</strong> negociações
        {rows.length < total ? ` (mostrando ${rows.length})` : ''} · <strong>{money(sum)}</strong>{' '}
        em valor
      </div>
      {list.isError && <p className="crm-error">Não foi possível carregar a lista.</p>}
      <table className="crm-table">
        <thead>
          <tr>
            <th>Negociação</th>
            <th>Empresa</th>
            <th>Contato</th>
            <th>Etapa</th>
            <th className="is-num">Valor</th>
            <th>Dono</th>
            <th>Na etapa há</th>
            <th>Próxima tarefa</th>
            <th>Origem</th>
            <th>Criada em</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !list.isLoading && (
            <tr>
              <td colSpan={10} className="crm-muted">
                Nenhuma negociação com estes filtros.
              </td>
            </tr>
          )}
          {rows.map((lead: LeadListItem) => {
            const badge = sourceBadgeOf(lead.source);
            const late = lead.nextTask ? isPast(lead.nextTask.dueAt) : false;
            return (
              <tr key={lead.id}>
                <td>
                  <Link to={`/crm-vendas/negociacoes/${lead.id}`}>{lead.name ?? 'Sem nome'}</Link>
                  {lead.won === true && (
                    <span className="crm-status is-won" style={{ marginLeft: 6 }}>
                      Ganha
                    </span>
                  )}
                  {lead.won === false && (
                    <span className="crm-status is-lost" style={{ marginLeft: 6 }}>
                      Perdida
                    </span>
                  )}
                </td>
                <td>{lead.companyName ?? <span className="crm-muted">—</span>}</td>
                <td>
                  <div>{formatPhone(lead.phone)}</div>
                  {lead.email && <div className="crm-sub">{lead.email}</div>}
                </td>
                <td>{lead.stage ?? <span className="crm-muted">—</span>}</td>
                <td className="is-num">{money(lead.valueCents)}</td>
                <td>
                  {lead.ownerInactive ? (
                    <span className="crm-muted">{INACTIVE_OWNER_LABEL}</span>
                  ) : (
                    (lead.ownerName ?? <span className="crm-muted">—</span>)
                  )}
                </td>
                <td>{ago(lead.stageChangedAt ?? lead.createdAt)}</td>
                <td className={late ? 'crm-card-task is-late' : ''}>
                  {lead.nextTask ? (
                    `${lead.nextTask.title} · ${dueLabel(lead.nextTask.dueAt)}`
                  ) : (
                    <span className="crm-muted">—</span>
                  )}
                </td>
                <td>
                  <span className={`crm-badge tone-${badge.tone}`}>{badge.label}</span>
                  {lead.brand && <div className="crm-sub">{lead.brand}</div>}
                </td>
                <td>{formatDate(lead.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- activities ----------------------------------------------------------------------------

function groupByDay(tasks: LeadTask[]) {
  const groups = new Map<string, LeadTask[]>();
  for (const task of tasks) {
    const key = new Date(task.dueAt).toLocaleDateString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
    });
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.entries()];
}

function ActivitiesView({ pipeline, canWrite }: { pipeline: LeadPipeline; canWrite: boolean }) {
  const session = useSession();
  const everyone = hasPermission(session.data, 'leads.assign');
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const tasks = useTaskList({ status, everyone });
  const complete = useCompleteTask();
  const rows = (tasks.data?.tasks ?? []).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <div className="crm-page-scroll">
      <div className="crm-toolbar">
        <div className="crm-segment" role="group" aria-label="Situação">
          <button
            type="button"
            className={status === 'open' ? 'is-active' : ''}
            onClick={() => setStatus('open')}
          >
            Abertas
          </button>
          <button
            type="button"
            className={status === 'done' ? 'is-active' : ''}
            onClick={() => setStatus('done')}
          >
            Concluídas
          </button>
        </div>
        <span className="crm-muted">
          Tarefas, ligações e reuniões de todas as negociações do funil{' '}
          {LEAD_PIPELINE_LABELS[pipeline]}.
        </span>
      </div>
      {rows.length === 0 && (
        <div className="crm-empty">
          Nenhuma atividade {status === 'open' ? 'aberta' : 'concluída'}.
        </div>
      )}
      <div className="crm-activity-list">
        {groupByDay(rows).map(([day, items]) => (
          <div key={day}>
            <div className="crm-activity-day">{day}</div>
            {items.map((task) => {
              const late = !task.doneAt && isPast(task.dueAt);
              return (
                <div
                  key={task.id}
                  className={`crm-activity${late ? ' is-late' : ''}${task.doneAt ? ' is-done' : ''}`}
                >
                  <time>
                    {new Date(task.dueAt).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  <div>
                    <b>{LEAD_TASK_KIND_LABELS[task.kind]}</b> · {task.title} ·{' '}
                    <Link to={`/crm-vendas/negociacoes/${task.leadId}`}>
                      {task.leadName ?? 'negociação'}
                    </Link>
                    {task.leadCompanyName ? (
                      <span className="crm-sub"> · {task.leadCompanyName}</span>
                    ) : null}
                    <div className="crm-sub">
                      {task.assigneeName ?? 'Sem responsável'}
                      {late ? ' · atrasada' : ''}
                    </div>
                  </div>
                  {canWrite && !task.doneAt && (
                    <button
                      type="button"
                      className="crm-btn is-small"
                      disabled={complete.isPending}
                      onClick={() =>
                        complete.mutate({ leadId: task.leadId, taskId: task.id, done: true })
                      }
                    >
                      Concluir
                    </button>
                  )}
                  {task.doneAt && (
                    <span className="crm-sub">feita por {task.doneByName ?? '—'}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- calendar --------------------------------------------------------------------------------

function CalendarView() {
  const session = useSession();
  const everyone = hasPermission(session.data, 'leads.assign');
  const tasks = useTaskList({ status: 'all', everyone });
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const first = new Date(month);
  first.setDate(1 - ((first.getDay() + 6) % 7)); // Monday
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index),
  );
  const byDay = new Map<string, LeadTask[]>();
  for (const task of tasks.data?.tasks ?? []) {
    const key = new Date(task.dueAt).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), task]);
  }
  const today = new Date().toDateString();
  return (
    <div className="crm-page-scroll">
      <div className="crm-cal-nav">
        <button
          type="button"
          className="crm-btn is-small"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          aria-label="Mês anterior"
        >
          ‹
        </button>
        <strong>{month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</strong>
        <button
          type="button"
          className="crm-btn is-small"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          aria-label="Próximo mês"
        >
          ›
        </button>
        <span className="crm-muted">Tarefas e reuniões por data.</span>
      </div>
      <div className="crm-calendar">
        {['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map((label) => (
          <div key={label} className="crm-cal-head">
            {label}
          </div>
        ))}
        {days.map((day) => {
          const items = byDay.get(day.toDateString()) ?? [];
          return (
            <div
              key={day.toISOString()}
              className={`crm-cal-day${day.getMonth() !== month.getMonth() ? ' is-other' : ''}${day.toDateString() === today ? ' is-today' : ''}`}
            >
              <span className="crm-cal-num">{day.getDate()}</span>
              {items.slice(0, 4).map((task) => (
                <Link
                  key={task.id}
                  className={`crm-cal-item${task.kind === 'meeting' ? ' is-meeting' : ''}${!task.doneAt && isPast(task.dueAt) ? ' is-late' : ''}`}
                  to={`/crm-vendas/negociacoes/${task.leadId}`}
                  title={`${task.title} · ${task.leadName ?? ''}`}
                >
                  {new Date(task.dueAt).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  {task.leadName ?? task.title}
                </Link>
              ))}
              {items.length > 4 && <span className="crm-muted">+{items.length - 4}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
