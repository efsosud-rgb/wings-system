import {
  AGENDA_NOTICES,
  agendaDealPath,
  isDateOnly,
  type AgendaCalendarKey,
  type AgendaEvent,
  type AgendaOverview,
} from '@wings/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useAgendaEvents,
  useAgendaOverview,
  useDeleteAgendaEvent,
  usePastedMeetings,
} from '../api/agenda.js';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { AgendaSidebar } from '../components/agenda/AgendaSidebar.js';
import { ConfirmDialog } from '../components/agenda/ConfirmDialog.js';
import { EventDetails } from '../components/agenda/EventDetails.js';
import { defaultSlot, EventForm, type EventFormTarget } from '../components/agenda/EventForm.js';
import { titleOf } from '../components/agenda/format.js';
import { calendarOf, visibleEvents } from '../components/agenda/layout.js';
import { ListView } from '../components/agenda/ListView.js';
import { MonthView } from '../components/agenda/MonthView.js';
import { TimeGrid } from '../components/agenda/TimeGrid.js';
import {
  AGENDA_VIEWS,
  dayOf,
  instantAt,
  isAgendaView,
  partsOf,
  periodOf,
  periodTitle,
  rangeOf,
  searchPeriod,
  STEP_LABELS,
  stepAnchor,
  type AgendaView,
} from '../components/agenda/time.js';
import { Icon } from '../components/Icon.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { failureReason } from '../lib/failure.js';
import { formatDateTime } from './crm/format.js';
import './agenda.css';

/**
 * Agenda (Eric, 14/10): the person's Google calendar and Wings Company's, with
 * the Google Agenda's layout — day, week, month and list views, a small month
 * and the calendars on the left, details, create, edit and delete. Everyone has
 * it (`calendar.use`); each person sees their own calendar and Wings Company's
 * as Google shares it with them. Times are São Paulo's whatever the browser's
 * zone. One address for everyone, /produtividade/agenda; without `calendar.write` (the sellers,
 * Eric 19/10) it only reads.
 */

const VIEW_STORAGE = 'wings.agenda.view';
const HIDDEN_STORAGE = 'wings.agenda.hidden';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): the screen works, it just will not remember.
  }
}
function storedHidden(): Set<AgendaCalendarKey> {
  try {
    const list: unknown = JSON.parse(readStored(HIDDEN_STORAGE) ?? '[]');
    return new Set(
      Array.isArray(list)
        ? list.filter((key): key is AgendaCalendarKey => key === 'mine' || key === 'wings')
        : [],
    );
  } catch {
    return new Set();
  }
}

const GOOGLE_CODES = new Set([
  'google_rejected',
  'google_unreachable',
  'google_rate_limited',
  'meet_failed',
  'meet_failed_event_kept',
  'google_needs_reconnect',
  'google_not_connected',
  'google_not_configured',
]);

/**
 * A Google-side refusal carries the API's own Portuguese message; LoadFailure
 * says a 5xx only as "o servidor teve um problema", so these are handed to it
 * as the 4xx they read like.
 */
function readable(error: unknown): unknown {
  if (error instanceof ApiError && GOOGLE_CODES.has(error.code) && error.body.message) {
    return new ApiError(422, error.body);
  }
  return error;
}

const unreachable = new ApiError(422, {
  error: 'google_unreachable',
  message: 'O Google não respondeu agora; tente de novo em instantes',
});

function AgendaFrame({ children }: { children: ReactNode }) {
  return (
    <div className="crm-page agenda">
      <header className="crm-head">
        <h1>Agenda</h1>
      </header>
      {children}
    </div>
  );
}

function ConnectNotice({ text }: { text: string }) {
  return (
    <div className="agenda-state">
      <Icon name="calendar" size={32} />
      <p>{text}</p>
      <Link className="crm-btn is-primary" to="/minha-conta">
        Ir para Minha conta
      </Link>
    </div>
  );
}

const PASTED_DAYS = 30;

/** The deal meetings with a pasted link need no Google: listed under the notice until it is connected. */
function PastedMeetings() {
  const [range] = useState(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + PASTED_DAYS * 86_400_000).toISOString(),
    };
  });
  const list = usePastedMeetings(range.from, range.to);
  return (
    <section className="agenda-pasted" aria-label="Reuniões marcadas pela ficha">
      <h2>Reuniões marcadas pela ficha</h2>
      {list.isError ? (
        <LoadFailure what="as reuniões" error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <p className="crm-muted">Carregando…</p>
      ) : list.data.length === 0 ? (
        <p className="crm-muted">
          Nenhuma reunião com link colado nos próximos {PASTED_DAYS} dias.
        </p>
      ) : (
        <ul className="crm-plain-list">
          {list.data.map((event) => (
            <li key={event.id}>
              <Icon name="calendar" size={13} /> {formatDateTime(event.start)} ·{' '}
              {event.title || '(Sem título)'}
              {event.crm?.leadId && (
                <>
                  {' '}
                  <Link className="crm-link-btn" to={agendaDealPath(event.crm.leadId)}>
                    Abrir negociação
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgendaPage() {
  const overview = useAgendaOverview();

  if (overview.isPending) {
    return (
      <AgendaFrame>
        <div className="agenda-skeleton" role="status" aria-label="Carregando a agenda">
          <span className="agenda-skeleton-side" />
          <span className="agenda-skeleton-grid" />
        </div>
      </AgendaFrame>
    );
  }
  if (!overview.data) {
    return (
      <AgendaFrame>
        <div className="agenda-state">
          <LoadFailure
            what="a agenda"
            error={overview.error}
            onRetry={() => void overview.refetch()}
          />
        </div>
      </AgendaFrame>
    );
  }

  const data = overview.data;
  if (data.state === 'not_configured') {
    return (
      <AgendaFrame>
        <div className="agenda-state">
          <Icon name="calendar" size={32} />
          <p>{AGENDA_NOTICES.notConfigured}</p>
        </div>
      </AgendaFrame>
    );
  }
  if (data.state === 'not_connected') {
    return (
      <AgendaFrame>
        <ConnectNotice text={AGENDA_NOTICES.notConnected} />
        <PastedMeetings />
      </AgendaFrame>
    );
  }
  if (data.state === 'needs_reconnect') {
    return (
      <AgendaFrame>
        <ConnectNotice text={AGENDA_NOTICES.needsReconnect} />
        <PastedMeetings />
      </AgendaFrame>
    );
  }
  if (data.state === 'google_unreachable') {
    return (
      <AgendaFrame>
        <div className="agenda-state">
          <LoadFailure
            what="a agenda"
            error={unreachable}
            onRetry={() => void overview.refetch()}
          />
        </div>
      </AgendaFrame>
    );
  }
  return <AgendaWorkspace overview={data} />;
}

type Travel = 'next' | 'previous' | 'none';

function AgendaWorkspace({ overview }: { overview: AgendaOverview }) {
  const [params, setParams] = useSearchParams();
  const [now, setNow] = useState(() => Date.now());
  const today = dayOf(now);
  const [travel, setTravel] = useState<Travel>('none');
  const [hidden, setHidden] = useState<Set<AgendaCalendarKey>>(storedHidden);
  const [sideOpen, setSideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [details, setDetails] = useState<{ event: AgendaEvent; anchor: HTMLElement } | null>(null);
  const [form, setForm] = useState<{
    target: EventFormTarget;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    event: AgendaEvent;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const remove = useDeleteAgendaEvent();
  // The sellers only read here (Eric, 19/10); the API refuses their writes all the same.
  const canWrite = hasPermission(useSession().data, 'calendar.write');

  // The red line of the current time moves every minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const paramView = params.get('visao');
  const storedView = readStored(VIEW_STORAGE);
  const view: AgendaView = isAgendaView(paramView)
    ? paramView
    : isAgendaView(storedView)
      ? storedView
      : 'semana';
  const paramDate = params.get('data');
  const anchor = paramDate && isDateOnly(paramDate) ? paramDate : today;

  const go = useCallback(
    (nextView: AgendaView, nextAnchor: string, direction?: Travel) => {
      setTravel(
        direction ?? (nextAnchor > anchor ? 'next' : nextAnchor < anchor ? 'previous' : 'none'),
      );
      writeStored(VIEW_STORAGE, nextView);
      setQuery(null);
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('visao', nextView);
          next.set('data', nextAnchor);
          return next;
        },
        { replace: true },
      );
    },
    [anchor, setParams],
  );
  const step = useCallback(
    (direction: 1 | -1) =>
      go(view, stepAnchor(view, anchor, direction), direction === 1 ? 'next' : 'previous'),
    [go, view, anchor],
  );

  const searching = query !== null;
  const period = useMemo(
    () => (searching ? searchPeriod(today) : periodOf(view, anchor)),
    [searching, today, view, anchor],
  );
  const range = rangeOf(period);
  const events = useAgendaEvents(range.from, range.to, query ?? undefined);

  const visible = useMemo(
    () =>
      new Set(overview.calendars.map((calendar) => calendar.key).filter((key) => !hidden.has(key))),
    [overview.calendars, hidden],
  );
  const shown = useMemo(
    () => visibleEvents(events.data?.events ?? [], visible),
    [events.data, visible],
  );

  const toggle = (key: AgendaCalendarKey) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeStored(HIDDEN_STORAGE, JSON.stringify([...next]));
      return next;
    });

  const dialogOpen = Boolean(details || form || confirm);

  // Shortcuts, as in the Google Agenda; never while typing or with a dialog open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      const key = event.key;
      if (key === 't') go(view, today);
      else if (key === 'j' || key === 'ArrowRight') step(1);
      else if (key === 'k' || key === 'ArrowLeft') step(-1);
      else {
        const match = AGENDA_VIEWS.find((item) => item.key === key);
        if (!match) return;
        go(match.value, anchor, 'none');
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen, go, step, view, anchor, today]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const openEvent = (event: AgendaEvent, element: HTMLElement) =>
    setDetails({ event, anchor: element });
  const createAt = (start: number, end: number) => {
    if (!canWrite) return;
    setForm({
      target: { kind: 'create', start, end },
      returnFocus: document.activeElement as HTMLElement | null,
    });
  };
  const onCreate = () => {
    setSideOpen(false);
    setForm({
      target: defaultSlot(anchor, today, now),
      returnFocus: document.activeElement as HTMLElement | null,
    });
  };

  const runSearch = () => {
    const text = searchDraft.trim();
    if (!text) return;
    setTravel('none');
    setQuery(text);
  };
  const closeSearch = () => {
    setQuery(null);
    setSearchOpen(false);
    setSearchDraft('');
    setTravel('none');
  };

  const nameOf = (key: AgendaCalendarKey) =>
    calendarOf(overview.calendars, key)?.name ?? 'Wings Company';
  const failures = events.data?.failures ?? [];
  const loading = events.isPending || events.isPlaceholderData;
  const answered = Boolean(events.data) && !events.isPlaceholderData;

  /**
   * "Nothing here" is said only for what was read and is shown: a calendar that
   * failed or is switched off leaves the text qualified, never a bare "nenhum".
   */
  const emptyText = (plain: string) => {
    if (visible.size === 0) return 'Nenhuma agenda selecionada: marque uma agenda à esquerda';
    if (failures.length > 0) return `${plain} nas agendas que puderam ser lidas`;
    if (visible.size < overview.calendars.length) return `${plain} nas agendas exibidas`;
    return plain;
  };

  let content: ReactNode;
  if (events.isError) {
    content = (
      <div className="agenda-failure">
        <LoadFailure
          what="os eventos"
          error={readable(events.error)}
          onRetry={() => void events.refetch()}
        />
      </div>
    );
  } else if (searching) {
    content = answered ? (
      <ListView
        days={period.days}
        events={shown}
        overview={overview}
        today={today}
        empty={emptyText(`Nenhum evento encontrado para “${query}”`)}
        onOpen={openEvent}
        onDay={(day) => go('dia', day)}
      />
    ) : null;
  } else if (view === 'agenda') {
    content = answered ? (
      <ListView
        days={period.days}
        events={shown}
        overview={overview}
        today={today}
        empty={emptyText(
          anchor === today ? 'Nenhum evento nos próximos 30 dias' : 'Nenhum evento neste período',
        )}
        onOpen={openEvent}
        onDay={(day) => go('dia', day)}
      />
    ) : null;
  } else if (view === 'mes') {
    content = (
      <MonthView
        days={period.days}
        month={partsOf(anchor).month}
        events={events.isPlaceholderData ? [] : shown}
        overview={overview}
        today={today}
        onOpen={openEvent}
        onDay={(day) => go('dia', day)}
        onSlot={(day) => {
          const start = instantAt(day, 9 * 60).getTime();
          createAt(start, start + 3_600_000);
        }}
      />
    );
  } else {
    content = (
      <TimeGrid
        days={period.days}
        events={events.isPlaceholderData ? [] : shown}
        overview={overview}
        today={today}
        now={now}
        onOpen={openEvent}
        onDay={(day) => go('dia', day)}
        onSlot={(day, minute) => {
          const start = instantAt(day, minute).getTime();
          createAt(start, start + 3_600_000);
        }}
      />
    );
  }

  const stepLabels = STEP_LABELS[view];

  return (
    <div className={`crm-page agenda${sideOpen ? ' is-side-open' : ''}`}>
      <header className="agenda-toolbar">
        <button
          type="button"
          className="agenda-icon-btn agenda-side-toggle"
          aria-expanded={sideOpen}
          aria-label="Agendas"
          title="Agendas"
          onClick={() => setSideOpen((open) => !open)}
        >
          <Icon name="menu" size={20} />
        </button>
        <h1 className="agenda-brand">
          <Icon name="calendar" size={22} />
          <span>Agenda</span>
        </h1>
        {searching ? (
          <>
            <button
              type="button"
              className="agenda-icon-btn"
              aria-label="Fechar pesquisa"
              title="Fechar pesquisa"
              onClick={closeSearch}
            >
              <Icon name="x" size={20} />
            </button>
            <h2 className="agenda-title" aria-live="polite">
              Resultados para “{query}”
            </h2>
          </>
        ) : (
          <>
            <button type="button" className="agenda-today" onClick={() => go(view, today)}>
              Hoje
            </button>
            <span className="agenda-steps">
              <button
                type="button"
                className="agenda-icon-btn"
                aria-label={stepLabels.previous}
                title={stepLabels.previous}
                onClick={() => step(-1)}
              >
                <Icon name="chevron-right" size={20} className="agenda-flip" />
              </button>
              <button
                type="button"
                className="agenda-icon-btn"
                aria-label={stepLabels.next}
                title={stepLabels.next}
                onClick={() => step(1)}
              >
                <Icon name="chevron-right" size={20} />
              </button>
            </span>
            <h2 className="agenda-title" aria-live="polite">
              {periodTitle(view, anchor)}
            </h2>
          </>
        )}
        <span className="agenda-toolbar-spacer" />
        {searchOpen ? (
          <form
            className="agenda-search"
            role="search"
            onSubmit={(submit) => {
              submit.preventDefault();
              runSearch();
            }}
          >
            <Icon name="search" size={18} />
            <input
              ref={searchRef}
              type="search"
              aria-label="Pesquisar eventos"
              placeholder="Pesquisar"
              value={searchDraft}
              maxLength={200}
              onChange={(change) => setSearchDraft(change.target.value)}
              onKeyDown={(key) => {
                if (key.key === 'Escape') closeSearch();
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="agenda-icon-btn"
            aria-label="Pesquisar"
            title="Pesquisar"
            onClick={() => setSearchOpen(true)}
          >
            <Icon name="search" size={20} />
          </button>
        )}
        <div className="agenda-views" role="group" aria-label="Visualização">
          {AGENDA_VIEWS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={!searching && view === item.value}
              onClick={() => go(item.value, anchor, 'none')}
            >
              {item.label}
            </button>
          ))}
        </div>
        {canWrite && (
          <button
            type="button"
            className="agenda-icon-btn agenda-create-compact"
            aria-label="Criar evento"
            title="Criar evento"
            onClick={onCreate}
          >
            <Icon name="plus" size={20} />
          </button>
        )}
      </header>

      <div className="agenda-body">
        {sideOpen && (
          <div
            className="agenda-side-backdrop"
            aria-hidden="true"
            onClick={() => setSideOpen(false)}
          />
        )}
        <AgendaSidebar
          overview={overview}
          hidden={hidden}
          onToggle={toggle}
          onCreate={canWrite ? onCreate : undefined}
          anchor={anchor}
          today={today}
          period={searching ? periodOf(view, anchor) : period}
          onPick={(day) => {
            setSideOpen(false);
            go(view, day);
          }}
        />
        <main className="agenda-main">
          {overview.wings === 'not_shared' && (
            <p className="agenda-notice">{AGENDA_NOTICES.wingsNotShared}</p>
          )}
          {failures.map((failure) => (
            <p key={failure.calendar} className="agenda-notice is-warning" role="alert">
              Não foi possível ler a agenda {nameOf(failure.calendar)}: {failure.message}
            </p>
          ))}
          {events.data?.truncated && !events.isPlaceholderData && (
            <p className="agenda-notice is-quiet">
              Há mais eventos neste período do que o sistema lê de uma vez; alguns podem não
              aparecer.
            </p>
          )}
          {loading && !events.isError && (
            <p className="agenda-loading" role="status">
              Carregando eventos…
            </p>
          )}
          <div
            key={`${searching ? `q:${query}` : view}|${period.start}`}
            className={`agenda-swap is-${travel}`}
          >
            {content}
          </div>
        </main>
      </div>

      {details && (
        <EventDetails
          event={details.event}
          overview={overview}
          anchor={details.anchor}
          onClose={() => setDetails(null)}
          readOnly={!canWrite}
          onEdit={() => {
            setForm({
              target: { kind: 'edit', event: details.event },
              returnFocus: details.anchor,
            });
            setDetails(null);
          }}
          onDelete={() => {
            remove.reset();
            setConfirm({ event: details.event, returnFocus: details.anchor });
            setDetails(null);
          }}
        />
      )}
      {form && (
        <EventForm
          target={form.target}
          overview={overview}
          returnFocus={form.returnFocus}
          onClose={() => setForm(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`Excluir “${titleOf(confirm.event)}”?`}
          confirmLabel="Excluir"
          busyLabel="Excluindo…"
          busy={remove.isPending}
          error={
            remove.error
              ? remove.error instanceof ApiError
                ? remove.error.message
                : `Não foi possível excluir: ${failureReason(remove.error)}.`
              : null
          }
          returnFocus={confirm.returnFocus}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            remove.mutate(
              { calendar: confirm.event.calendar, id: confirm.event.id },
              { onSuccess: () => setConfirm(null) },
            )
          }
        >
          {confirm.event.guestsNotified ? (
            <p>Os convidados recebem o cancelamento por e-mail.</p>
          ) : (
            !confirm.event.organizer?.self &&
            confirm.event.attendees.some((guest) => !guest.self) && (
              <p>O evento sai só da sua agenda; quem organiza continua com ele.</p>
            )
          )}
          {confirm.event.recurring && <p>Só esta ocorrência é excluída.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
