import {
  isCloseForecastOverdue,
  LEAD_CALL_OUTCOME_LABELS,
  LEAD_CALL_OUTCOMES,
  LEAD_CHANNEL_LABELS,
  LEAD_NAME_MAX,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_SUSPECT_REASONS,
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  sourceBadgeOf,
  type Lead,
  type LeadCallOutcome,
  type LeadTask,
  type LeadTaskKind,
  LEAD_CHECK_LABELS,
  normalizeInstagram,
  normalizeWebsite,
  type LeadCheck,
} from '@wings/shared';
import {
  Fragment,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { CompanyLink } from '../../components/CompanyLink.js';
import { ApiError } from '../../api/client.js';
import {
  useAddActivity,
  useBrands,
  useLeadFiles,
  useLinkContact,
  useUnlinkContact,
  useUpdateDeal,
} from '../../api/crm.js';
import {
  useAddNote,
  useCheckLead,
  useClearSuspect,
  useCreateTask,
  useLead,
  useSellers,
  useStages,
  useUpdateLead,
  useUpdateTask,
  type LoadedLead,
} from '../../api/leads.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { failureReason } from '../../lib/failure.js';
import { CallPanel } from './CallPanel.js';
import { CompanyResearchPanel } from './CompanyResearchPanel.js';
import { DealSummary } from './DealSummary.js';
import { DealTabs, type View } from './DealTabs.js';
import {
  dueLabel,
  formatDateTime,
  formatDay,
  formatPhone,
  isPast,
  money,
  parseMoney,
  stageTone,
  toLocalInput,
} from './format.js';
import { EnteredAt } from './EnteredAt.js';

/**
 * The deal's page: who and how much on top, the stage bar you click, win or
 * lose; on the left the contact, the company and where it came from; in the
 * middle what you register (note, task, call, e-mail) and one timeline; on
 * the right what is next and the first-contact clock.
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

export function DealPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const loaded = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');
  // Only who edits deals and may assign them (the Admin) picks the owner; for everyone else it is read-only.
  const canAssign = canWrite && hasPermission(session.data, 'leads.assign');
  const [tab, setTab] = useState<Tab>('note');
  const [view, setView] = useState<View>('history');
  const [calling, setCalling] = useState(false);
  const register = useRef<HTMLElement>(null);
  const sections = useRef<HTMLElement>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const contacts = useRef<{ add: () => void }>(null);
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
  const scrollTo = (ref: RefObject<HTMLElement | null>) =>
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // E-mail lives in the sections below; everything else is registered in "Registrar".
  const act = (next: Tab) => {
    // "Ligação" opens the call panel, never the browser's tel: prompt.
    if (next === 'call') {
      setCalling(true);
      return;
    }
    if (next === 'email' || next === 'meet') {
      setView(next === 'email' ? 'email' : 'meetings');
      scrollTo(sections);
      return;
    }
    setTab(next);
    scrollTo(register);
  };
  const show = (next: View) => {
    setView(next);
    scrollTo(sections);
  };
  const addFile = () => {
    show('files');
    // The input only exists once the tab is on screen.
    setTimeout(() => filePick.current?.click(), 0);
  };
  return (
    <div className="crm-page">
      <div className="crm-page-scroll" style={{ padding: 0 }}>
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
        <Head data={data} canWrite={canWrite} canAssign={canAssign} />
        {canWrite && <ActionBar lead={data.lead} active={tab} onAct={act} />}
        {calling && (
          <CallPanel
            leadId={data.lead.id}
            name={data.lead.name}
            phone={data.lead.phone}
            canWrite={canWrite}
            onClose={() => setCalling(false)}
          />
        )}
        <div className="crm-deal-body">
          <div className="crm-stack">
            <AboutPanel lead={data.lead} canWrite={canWrite} canAssign={canAssign} />
            <OriginPanel lead={data.lead} />
            <FormFieldsPanel lead={data.lead} canWrite={canWrite} />
            <CompanyResearchPanel
              research={data.lead.research}
              leadId={data.lead.id}
              canWrite={canWrite}
            />
            <ContactPanel data={data} canWrite={canWrite} ref={contacts} />
          </div>
          <div className="crm-stack is-center">
            <SuspectStrip lead={data.lead} canWrite={canWrite} />
            <FirstContactStrip data={data} canWrite={canWrite} onAct={act} />
            <DealSummary lead={data.lead} canWrite={canWrite} />
            <NextPanel data={data} canWrite={canWrite} onAct={act} />
            {canWrite && <Register lead={data.lead} tab={tab} onTab={setTab} ref={register} />}
            <DealTabs
              data={data}
              view={view}
              onView={setView}
              canWrite={canWrite}
              onCreateTask={() => act('task')}
              onRegisterMeeting={() => act('meeting')}
              client={
                data.lead.pipeline === 'expansao' ? (
                  <BrandEdit lead={data.lead} canWrite={canWrite} />
                ) : undefined
              }
              pickRef={filePick}
              ref={sections}
            />
          </div>
          <div className="crm-stack">
            <AssociationCards
              data={data}
              canWrite={canWrite}
              onAddContact={() => contacts.current?.add()}
              onAddFile={addFile}
              onShowFiles={() => show('files')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The open first-contact task: the deal is "new" until someone does it. */
const firstContactOf = (data: LoadedLead): LeadTask | undefined =>
  data.tasks.find((task) => task.kind === 'first_contact' && !task.doneAt);

/** Whole days since the deal entered its stage: "0 dias", "1 dia", "12 dias". */
export function daysInStage(since: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - new Date(since).getTime()) / 86_400_000));
  return `${days} ${days === 1 ? 'dia' : 'dias'}`;
}

/** The time of day a deadline falls on, "14:35"; with the day when it is not today. */
function deadlineLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

// --- head ------------------------------------------------------------------------------------

function Head({
  data,
  canWrite,
  canAssign,
}: {
  data: LoadedLead;
  canWrite: boolean;
  canAssign: boolean;
}) {
  const { lead } = data;
  const stages = useStages(lead.pipeline ?? '');
  const update = useUpdateLead(lead.id);
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const open = lead.work.won === null;
  const forecastOverdue = isCloseForecastOverdue({
    expectedCloseAt: lead.expectedCloseAt,
    won: lead.work.won,
  });
  const list = (stages.data?.stages ?? []).filter(
    (stage) => stage.active || stage.id === lead.work.stageId,
  );
  const currentIndex = list.findIndex((stage) => stage.id === lead.work.stageId);
  const badge = sourceBadgeOf(lead.origin.source);
  return (
    <header className="crm-deal-head">
      <div className="crm-deal-title">
        <Link
          className="crm-btn is-quiet is-small"
          to={`/crm-vendas/negociacoes?funil=${lead.pipeline ?? 'expansao'}`}
        >
          ‹ Negociações
        </Link>
        <DealName lead={lead} canWrite={canWrite} />
        {lead.work.won === true && <span className="crm-status is-won">Ganha</span>}
        {lead.work.won === false && (
          <span className="crm-status is-lost">
            Perdida{lead.work.lostReason ? ` · ${lead.work.lostReason}` : ''}
          </span>
        )}
        {open && firstContactOf(data) && <span className="crm-badge is-new">Nova</span>}
        {lead.pipeline && <span className="crm-badge">{LEAD_PIPELINE_LABELS[lead.pipeline]}</span>}
        <span className={`crm-badge tone-${badge.tone}`}>{badge.label}</span>
        {lead.brand && <span className="crm-badge is-brand">{lead.brand}</span>}
        <span className="crm-head-spacer" />
        {canWrite && open && !losing && (
          <>
            <button
              type="button"
              className="crm-btn is-success"
              disabled={update.isPending}
              onClick={() => update.mutate({ won: true })}
            >
              Marcar venda
            </button>
            <button type="button" className="crm-btn is-danger" onClick={() => setLosing(true)}>
              Marcar perda
            </button>
          </>
        )}
        {canWrite && open && losing && (
          <form
            className="crm-quick-row"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                { won: false, lostReason: reason },
                { onSuccess: () => setLosing(false) },
              );
            }}
          >
            <input
              className="crm-input"
              placeholder="Motivo da perda"
              value={reason}
              maxLength={200}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="submit"
              className="crm-btn is-danger"
              disabled={reason.trim().length < 2 || update.isPending}
            >
              Confirmar perda
            </button>
            <button type="button" className="crm-btn is-quiet" onClick={() => setLosing(false)}>
              Cancelar
            </button>
          </form>
        )}
        {canWrite && !open && (
          <button
            type="button"
            className="crm-btn"
            disabled={update.isPending}
            onClick={() => update.mutate({ won: null })}
          >
            Reabrir
          </button>
        )}
      </div>
      <div className="crm-deal-facts">
        <span>
          Empresa <b>{lead.company?.name ?? '—'}</b>
        </span>
        <span>
          Valor <ValueEdit lead={lead} canWrite={canWrite} />
        </span>
        <span className={forecastOverdue ? 'is-overdue' : undefined}>
          Previsão de fechamento <ForecastEdit lead={lead} canWrite={canWrite} />
        </span>
        <span>
          Dono <OwnerEdit lead={lead} canAssign={canAssign} />
        </span>
        <span>
          Entrou em{' '}
          <b>
            <EnteredAt at={lead.enteredAt} source={lead.enteredAtSource} />
          </b>
        </span>
      </div>
      {list.length > 0 && (
        <div className="crm-stagebar" role="group" aria-label="Etapas">
          {list.map((stage, index) => (
            <button
              key={stage.id}
              type="button"
              className={
                index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : ''
              }
              style={
                index <= currentIndex
                  ? (stageTone(stage.position) as React.CSSProperties)
                  : undefined
              }
              disabled={
                !canWrite ||
                !open ||
                update.isPending ||
                stage.id === lead.work.stageId ||
                !stage.active
              }
              title={`${stage.probability}% de chance`}
              onClick={() => update.mutate({ stageId: stage.id })}
            >
              {stage.name}
              {index === currentIndex && (
                <span className="crm-stage-days">
                  {' · '}
                  {daysInStage(lead.work.stageChangedAt ?? lead.createdAt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {stages.isError && (
        <LoadFailure what="as etapas" error={stages.error} onRetry={() => void stages.refetch()} />
      )}
      {update.error && (
        <p className="crm-error">
          {errorText(update.error, 'Não foi possível alterar a negociação.')}
        </p>
      )}
    </header>
  );
}

/** The estimated value, edited in place: blur or Enter saves. */
function ValueEdit({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const [value, setValue] = useState<string | null>(null);
  if (!canWrite) return <b>{money(lead.valueCents, true)}</b>;
  return (
    <input
      className="crm-inline-edit"
      aria-label="Valor estimado"
      value={
        value ??
        (lead.valueCents === null
          ? ''
          : (lead.valueCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }))
      }
      placeholder="R$ 0,00"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value === null) return;
        const cents = parseMoney(value);
        if (cents !== undefined && cents !== lead.valueCents) deal.mutate({ valueCents: cents });
        setValue(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** The expected close date: a date field, clearable, "vencida" when behind us. */
function ForecastEdit({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const forecastOverdue = isCloseForecastOverdue({
    expectedCloseAt: lead.expectedCloseAt,
    won: lead.work.won,
  });
  return (
    <>
      {canWrite ? (
        <span className="crm-date-edit">
          <input
            type="date"
            className="crm-inline-edit"
            aria-label="Previsão de fechamento"
            value={lead.expectedCloseAt ?? ''}
            disabled={deal.isPending}
            onChange={(e) => {
              // A date input gives '' while a part is missing and the year
              // digit by digit; a full year is the sign the person finished.
              const next = e.target.value;
              if (next !== '' && Number(next.slice(0, 4)) < 2000) return;
              if (next !== (lead.expectedCloseAt ?? ''))
                deal.mutate({ expectedCloseAt: next || null });
            }}
          />
          {lead.expectedCloseAt && (
            <button
              type="button"
              className="crm-inline-clear"
              aria-label="Limpar previsão de fechamento"
              disabled={deal.isPending}
              onClick={() => deal.mutate({ expectedCloseAt: null })}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ) : (
        <b>{formatDay(lead.expectedCloseAt)}</b>
      )}
      {forecastOverdue && <span className="crm-forecast-overdue">vencida</span>}
    </>
  );
}

/** The owner: a select for who assigns, a name for everyone else. */
function OwnerEdit({ lead, canAssign }: { lead: Lead; canAssign: boolean }) {
  const sellers = useSellers(canAssign);
  const update = useUpdateLead(lead.id);
  if (!canAssign) return <b>{lead.work.ownerName ?? '—'}</b>;
  return (
    <select
      className="crm-inline-edit"
      aria-label="Dono"
      value={lead.ownerEmployeeId ?? ''}
      // Without the list of sellers the select would show "sem dono" for a deal that has one.
      disabled={update.isPending || !sellers.data}
      title={
        sellers.isError
          ? `Não foi possível carregar os donos: ${failureReason(sellers.error)}`
          : undefined
      }
      onChange={(e) => update.mutate({ ownerEmployeeId: e.target.value || null })}
    >
      <option value="">— sem dono —</option>
      {!sellers.data && lead.ownerEmployeeId && (
        <option value={lead.ownerEmployeeId}>{lead.work.ownerName ?? '—'}</option>
      )}
      {(sellers.data?.sellers ?? [])
        .filter((s) => s.active || s.id === lead.ownerEmployeeId)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </select>
  );
}

/** The deal's name: a heading that becomes a field on click; Enter saves, Esc cancels. */
function DealName({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const [draft, setDraft] = useState<string | null>(null);
  const name = lead.name ?? 'Sem nome';
  if (!canWrite) return <h1>{name}</h1>;
  if (draft === null)
    return (
      <h1>
        <button
          type="button"
          className="crm-name-edit"
          aria-label={`Renomear ${name}`}
          title="Clique para renomear"
          onClick={() => setDraft(lead.name ?? '')}
        >
          {name}
        </button>
      </h1>
    );
  const save = () => {
    const next = draft.trim();
    if (next.length < 2 || next === lead.name) return setDraft(null);
    deal.mutate({ name: next }, { onSuccess: () => setDraft(null) });
  };
  return (
    <span className="crm-name-form">
      <input
        className="crm-input"
        aria-label="Nome da negociação"
        value={draft}
        maxLength={LEAD_NAME_MAX}
        autoFocus
        disabled={deal.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') setDraft(null);
        }}
        onBlur={() => deal.isPending || setDraft(null)}
      />
      {deal.error && (
        <span className="crm-error">{errorText(deal.error, 'Não foi possível renomear.')}</span>
      )}
    </span>
  );
}

type Action = { tab: Tab; icon: IconName; label: string; soon?: string; href?: string };
const ACTIONS: Action[] = [
  { tab: 'note', icon: 'edit', label: 'Anotação' },
  { tab: 'email', icon: 'mail', label: 'E-mail' },
  { tab: 'call', icon: 'phone', label: 'Ligação' },
  // Opens the conversation screen; sending waits there for the official API.
  { tab: 'whatsapp', icon: 'message', label: 'WhatsApp', href: 'whatsapp' },
  // Opens the Reunião section; agendar/iniciar wait there for the Google integration.
  { tab: 'meet', icon: 'video', label: 'Reunião' },
  { tab: 'task', icon: 'check', label: 'Tarefa' },
];

/**
 * One row of icon-and-label actions under the head: each opens the matching
 * register tab. WhatsApp and Reunião wait for their integrations; "Mais"
 * holds what is rarer (a meeting already held, the RD copy).
 */
function ActionBar({
  lead,
  active,
  onAct,
}: {
  lead: Lead;
  active: Tab;
  onAct: (tab: Tab) => void;
}) {
  const [more, setMore] = useState(false);
  return (
    <div className="crm-actions" role="toolbar" aria-label="Ações">
      {ACTIONS.map((action) =>
        action.href ? (
          <Link
            key={action.tab}
            className="crm-action"
            to={`/crm-vendas/negociacoes/${lead.id}/${action.href}`}
            aria-label={action.label}
          >
            <span className="crm-action-icon" aria-hidden="true">
              <Icon name={action.icon} size={18} />
            </span>
            <span>{action.label}</span>
          </Link>
        ) : (
          <button
            key={action.tab}
            type="button"
            className={`crm-action${active === action.tab ? ' is-active' : ''}`}
            disabled={Boolean(action.soon)}
            title={action.soon}
            aria-label={action.soon ? `${action.label} (em breve)` : action.label}
            onClick={() => onAct(action.tab)}
          >
            <span className="crm-action-icon" aria-hidden="true">
              <Icon name={action.icon} size={18} />
            </span>
            <span>{action.label}</span>
            {action.soon && <small>em breve</small>}
          </button>
        ),
      )}
      <span className="crm-action-more crm-menu">
        <button
          type="button"
          className={`crm-action${more ? ' is-active' : ''}`}
          aria-label="Mais"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          <span className="crm-action-icon" aria-hidden="true">
            <Icon name="more" size={18} />
          </span>
          <span>Mais</span>
        </button>
        {more && (
          <div className="crm-menu-list" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMore(false);
                onAct('meeting');
              }}
            >
              Registrar reunião feita
            </button>
            {lead.crm && (
              <a role="menuitem" href={lead.crm.rdUrl} target="_blank" rel="noopener noreferrer">
                Abrir a cópia no RD CRM
              </a>
            )}
          </div>
        )}
      </span>
    </div>
  );
}

/** "Nova negociação: faça o primeiro contato até HH:MM" while the first-contact task is open. */
function FirstContactStrip({
  data,
  canWrite,
  onAct,
}: {
  data: LoadedLead;
  canWrite: boolean;
  onAct: (tab: Tab) => void;
}) {
  const update = useUpdateTask(data.lead.id);
  const first = firstContactOf(data);
  if (!first || data.lead.work.won !== null) return null;
  const late = isPast(first.dueAt);
  return (
    <section className={`crm-strip${late ? ' is-late' : ''}`} aria-label="Primeiro contato">
      <Icon name={late ? 'alert' : 'clock'} size={16} />
      <div>
        <b>
          {late
            ? 'Nova negociação: o prazo do primeiro contato venceu'
            : `Nova negociação: faça o primeiro contato até ${deadlineLabel(first.dueAt)}`}
        </b>
        <div className="crm-sub">
          1 hora útil desde a chegada · <Countdown dueAt={first.dueAt} inline />
          {first.assigneeName ? ` · ${first.assigneeName}` : ''}
        </div>
      </div>
      {canWrite && (
        <div className="crm-quick-row">
          <button type="button" className="crm-btn is-small" onClick={() => onAct('call')}>
            Ligar
          </button>
          <button
            type="button"
            className="crm-btn is-small is-primary"
            disabled={update.isPending}
            onClick={() => update.mutate({ taskId: first.id, done: true })}
          >
            Contato feito
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Marked as a likely robot sign-up: the reasons in plain words. Nothing was
 * closed or lost; the seller confirms (Perdido) or clears the mark.
 */
function SuspectStrip({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const clear = useClearSuspect();
  if (!lead.suspect) return null;
  return (
    <section className="crm-strip is-late" aria-label="Lead suspeito">
      <Icon name="alert" size={16} />
      <div>
        <b>Lead suspeito de robô: confirme antes de trabalhar</b>
        <ul className="crm-sub" style={{ margin: 0, paddingLeft: '1.1em' }}>
          {lead.suspect.reasons.map((reason) => (
            <li key={reason}>{LEAD_SUSPECT_REASONS[reason] ?? reason}</li>
          ))}
        </ul>
        <div className="crm-sub">
          Marcado em {new Date(lead.suspect.at).toLocaleString('pt-BR')}. Nada foi apagado nem
          marcado como perdido.
        </div>
        {clear.isError && <div className="crm-sub">Não deu para tirar a marca. Tente de novo.</div>}
      </div>
      {canWrite && (
        <div className="crm-quick-row">
          <button
            type="button"
            className="crm-btn is-small"
            disabled={clear.isPending}
            onClick={() => clear.mutate(lead.id)}
          >
            {clear.isPending ? 'Tirando…' : 'Não é robô'}
          </button>
        </div>
      )}
    </section>
  );
}

// --- left column -----------------------------------------------------------------------------

const FIELDS_KEY = 'crm.deal.fields';

interface Field {
  key: string;
  label: string;
  value: ReactNode;
}

/** The person's choice of fields and their order, kept in this browser only. */
function readFieldPrefs(): { order: string[]; hidden: string[] } | null {
  try {
    const raw = localStorage.getItem(FIELDS_KEY);
    return raw ? (JSON.parse(raw) as { order: string[]; hidden: string[] }) : null;
  } catch {
    return null;
  }
}

/** The fields in the person's order; new ones (a form's question never seen) go at the end. */
export function orderFields<T extends { key: string }>(
  fields: T[],
  prefs: { order: string[]; hidden: string[] } | null,
): { shown: T[]; all: T[] } {
  if (!prefs) return { shown: fields, all: fields };
  const rank = new Map(prefs.order.map((key, index) => [key, index] as const));
  const all = [...fields].sort(
    (a, b) =>
      (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );
  return { shown: all.filter((field) => !prefs.hidden.includes(field.key)), all };
}

/**
 * "Sobre a negociação": every field of the deal and every answer of the
 * forms, the deal's own fields edited in place, the answers as the person
 * gave them. "Personalizar" chooses and orders the fields for this browser.
 */
function AboutPanel({
  lead,
  canWrite,
  canAssign,
}: {
  lead: Lead;
  canWrite: boolean;
  canAssign: boolean;
}) {
  const { origin } = lead;
  const [prefs, setPrefs] = useState(readFieldPrefs);
  const [customizing, setCustomizing] = useState(false);
  const fields: Field[] = [
    { key: 'value', label: 'Valor', value: <ValueEdit lead={lead} canWrite={canWrite} /> },
    {
      key: 'forecast',
      label: 'Previsão',
      value: <ForecastEdit lead={lead} canWrite={canWrite} />,
    },
    { key: 'owner', label: 'Dono', value: <OwnerEdit lead={lead} canAssign={canAssign} /> },
    {
      key: 'pipeline',
      label: 'Funil',
      value: lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—',
    },
    { key: 'stage', label: 'Etapa', value: lead.work.stage ?? '—' },
    { key: 'company', label: 'Empresa', value: <CompanyEdit lead={lead} canWrite={canWrite} /> },
    ...(lead.pipeline === 'expansao'
      ? [{ key: 'brand', label: 'Marca', value: <BrandEdit lead={lead} canWrite={canWrite} /> }]
      : []),
    ...(lead.city ? [{ key: 'city', label: 'Cidade', value: lead.city }] : []),
    {
      key: 'source',
      label: 'Fonte',
      value: `${LEAD_SOURCE_LABELS[origin.source]}${origin.channel ? ` · ${LEAD_CHANNEL_LABELS[origin.channel]}` : ''}`,
    },
    {
      key: 'enteredAt',
      label: 'Entrou em',
      value: <EnteredAt at={lead.enteredAt} source={lead.enteredAtSource} />,
    },
    ...(origin.campaignName || origin.campaignId
      ? [{ key: 'campaign', label: 'Campanha', value: origin.campaignName ?? origin.campaignId }]
      : []),
    ...(origin.landingPage ? [{ key: 'page', label: 'Página', value: origin.landingPage }] : []),
    // Meta, TikTok and Google forms carry the moment the person submitted them (`consentedAt`).
    ...(lead.consent.consentedAt &&
    (origin.source === 'meta_lead_ads' ||
      origin.source === 'tiktok_lead_ads' ||
      origin.source === 'google_lead_form')
      ? [
          {
            key: 'form',
            label: 'Origem',
            value: `Preencheu o formulário em ${formatDateTime(lead.consent.consentedAt)}`,
          },
        ]
      : []),
    ...Object.entries(lead.formAnswers ?? {}).map(([question, answer]) => ({
      key: `answer:${question}`,
      label: question.replace(/_/g, ' '),
      value: answer,
    })),
    ...(lead.firstMessage
      ? [{ key: 'firstMessage', label: '1ª mensagem', value: lead.firstMessage }]
      : []),
    ...(lead.crm
      ? [
          {
            key: 'rd',
            label: 'RD CRM',
            value: (
              <a href={lead.crm.rdUrl} target="_blank" rel="noopener noreferrer">
                abrir a cópia
              </a>
            ),
          },
        ]
      : []),
    ...(lead.research.summary
      ? [
          {
            key: 'research',
            label: 'Pesquisa',
            value: (
              <details>
                <summary className="crm-sub">
                  Pesquisa automática
                  {lead.research.score !== null ? ` · perfil ${lead.research.score}/100` : ''}
                </summary>
                <p className="crm-sub" style={{ whiteSpace: 'pre-wrap' }}>
                  {lead.research.summary}
                </p>
              </details>
            ),
          },
        ]
      : []),
  ];
  const { shown, all } = orderFields(fields, prefs);
  const save = (next: { order: string[]; hidden: string[] } | null) => {
    setPrefs(next);
    try {
      if (next) localStorage.setItem(FIELDS_KEY, JSON.stringify(next));
      else localStorage.removeItem(FIELDS_KEY);
    } catch {
      // a private window: the choice lasts this page only
    }
  };
  const move = (key: string, by: -1 | 1) => {
    const order = all.map((field) => field.key);
    const index = order.indexOf(key);
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    order.splice(index, 1);
    order.splice(target, 0, key);
    save({ order, hidden: prefs?.hidden ?? [] });
  };
  const toggle = (key: string) => {
    const hidden = prefs?.hidden ?? [];
    save({
      order: all.map((field) => field.key),
      hidden: hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key],
    });
  };
  return (
    <section className="crm-panel" aria-label="Sobre a negociação">
      <h2>
        Sobre a negociação
        <button
          type="button"
          className="crm-btn is-small is-quiet"
          aria-expanded={customizing}
          onClick={() => setCustomizing((v) => !v)}
        >
          {customizing ? 'Pronto' : 'Personalizar'}
        </button>
      </h2>
      {customizing ? (
        <div className="crm-fields-custom" role="group" aria-label="Campos">
          {all.map((field, index) => (
            <div key={field.key} className="crm-fields-row">
              <label>
                <input
                  type="checkbox"
                  checked={!prefs?.hidden.includes(field.key)}
                  onChange={() => toggle(field.key)}
                />
                {field.label}
              </label>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                aria-label={`Subir ${field.label}`}
                disabled={index === 0}
                onClick={() => move(field.key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                aria-label={`Descer ${field.label}`}
                disabled={index === all.length - 1}
                onClick={() => move(field.key, 1)}
              >
                ↓
              </button>
            </div>
          ))}
          <button type="button" className="crm-btn is-small is-quiet" onClick={() => save(null)}>
            Voltar ao padrão
          </button>
        </div>
      ) : (
        <dl className="crm-kv crm-about">
          {shown.map((field) => (
            <div key={field.key} style={{ display: 'contents' }}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** The company: a link, "Trocar" to name another (made or found by name), "Desligar". */
function CompanyEdit({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  if (editing)
    return (
      <form
        className="crm-record-form"
        onSubmit={(event) => {
          event.preventDefault();
          deal.mutate({ companyName: name }, { onSuccess: () => setEditing(false) });
        }}
      >
        <input
          className="crm-input"
          aria-label="Nome da empresa"
          placeholder="Nome da empresa"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        {deal.error && (
          <span className="crm-error">{errorText(deal.error, 'Não foi possível salvar.')}</span>
        )}
        <div className="crm-quick-row">
          {lead.company && (
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() =>
                deal.mutate({ companyId: null }, { onSuccess: () => setEditing(false) })
              }
            >
              Desligar
            </button>
          )}
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setEditing(false)}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="crm-btn is-small is-primary"
            disabled={name.trim().length < 2 || deal.isPending}
          >
            Salvar
          </button>
        </div>
      </form>
    );
  return (
    <span className="crm-about-company">
      {lead.company ? (
        <CompanyLink id={lead.company.id}>{lead.company.name}</CompanyLink>
      ) : (
        <span className="crm-muted">Nenhuma</span>
      )}
      {lead.company?.clientId && <span className="crm-sub"> · já é cliente</span>}
      {canWrite && (
        <button
          type="button"
          className="crm-btn is-small is-quiet"
          onClick={() => {
            setName(lead.company?.name ?? '');
            setEditing(true);
          }}
        >
          {lead.company ? 'Trocar' : '+ Definir'}
        </button>
      )}
    </span>
  );
}

/** The brand of interest (Expansão): one of the brands registered as clients. */
function BrandEdit({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const brands = useBrands();
  if (!canWrite) return <>{lead.brand ?? '—'}</>;
  return (
    <>
      <select
        className="crm-select"
        aria-label="Marca"
        value={lead.origin.clientMapped ? lead.origin.clientId : ''}
        // Without the brand list the select would show "Sem marca" for a deal that has one.
        disabled={deal.isPending || !brands.data}
        title={
          brands.isError
            ? `Não foi possível carregar as marcas: ${failureReason(brands.error)}`
            : undefined
        }
        onChange={(e) => deal.mutate({ brandClientId: e.target.value || null })}
      >
        <option value="">{lead.brand ? `${lead.brand} (não cadastrada)` : 'Sem marca'}</option>
        {!brands.data && lead.origin.clientMapped && (
          <option value={lead.origin.clientId}>{lead.brand ?? lead.origin.clientName}</option>
        )}
        {(brands.data?.brands ?? []).map((brand) => (
          <option key={brand.clientId} value={brand.clientId}>
            {brand.name}
          </option>
        ))}
      </select>
      {deal.error && (
        <span className="crm-error">{errorText(deal.error, 'Não foi possível salvar.')}</span>
      )}
    </>
  );
}

/** A small "Copiar" that says "Copiado" for a moment. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="crm-btn is-small is-quiet crm-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined); // the browser refused: the value stays on the screen to select
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

/**
 * A phone and an e-mail with their copy buttons, the call panel and the
 * WhatsApp conversation. The number is text, never a tel: link.
 */
function Reach({
  phone,
  email,
  leadId,
  name,
  canWrite,
}: {
  phone: string | null;
  email: string | null;
  leadId: string;
  name: string | null;
  canWrite: boolean;
}) {
  const [calling, setCalling] = useState(false);
  return (
    <div className="crm-reach">
      {phone && (
        <span>
          <span>{formatPhone(phone)}</span>
          <CopyButton value={`+${phone}`} label="Copiar telefone" />
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            title="Ligar"
            aria-label="Ligar"
            onClick={() => setCalling(true)}
          >
            <Icon name="phone" size={13} />
          </button>
          <Link
            className="crm-btn is-small is-quiet"
            to={`/crm-vendas/negociacoes/${leadId}/whatsapp`}
            title="Abrir a conversa do WhatsApp"
            aria-label="Conversa do WhatsApp"
          >
            <Icon name="message" size={13} />
          </Link>
        </span>
      )}
      {email && (
        <span>
          <a href={`mailto:${email}`}>{email}</a>
          <CopyButton value={email} label="Copiar e-mail" />
        </span>
      )}
      {calling && (
        <CallPanel
          leadId={leadId}
          name={name}
          phone={phone}
          canWrite={canWrite}
          onClose={() => setCalling(false)}
        />
      )}
    </div>
  );
}

function ContactPanel({
  data,
  canWrite,
  ref,
}: {
  data: LoadedLead;
  canWrite: boolean;
  ref: RefObject<{ add: () => void } | null>;
}) {
  const { lead } = data;
  const link = useLinkContact(lead.id);
  const unlink = useUnlinkContact(lead.id);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', jobTitle: '' });
  const panel = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => ({
    add: () => {
      setAdding(true);
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  }));
  return (
    <section className="crm-panel" ref={panel} aria-label="Contatos">
      <h2>
        Contatos
        {canWrite && !adding && (
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setAdding(true)}
          >
            + Adicionar contato
          </button>
        )}
      </h2>
      {lead.contacts.length === 0 && (
        <div className="crm-stack" style={{ gap: 2 }}>
          <div className="crm-sub">A pessoa da negociação</div>
          <Reach
            phone={lead.phone}
            email={lead.email}
            leadId={lead.id}
            name={lead.name}
            canWrite={canWrite}
          />
        </div>
      )}
      {lead.contacts.map((contact) => (
        <div key={contact.id} className="crm-stack" style={{ gap: 2 }}>
          <div className="crm-tl-head">
            <b>
              <Link to={`/crm-vendas/contatos/${contact.id}`}>{contact.name ?? 'Sem nome'}</Link>
              {contact.primary ? ' · principal' : ''}
              {contact.jobTitle ? ` · ${contact.jobTitle}` : ''}
            </b>
            {canWrite && lead.contacts.length > 1 && (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => unlink.mutate(contact.id)}
              >
                remover
              </button>
            )}
          </div>
          <Reach
            phone={contact.phone}
            email={contact.email}
            leadId={lead.id}
            name={contact.name}
            canWrite={canWrite}
          />
        </div>
      ))}
      {adding && (
        <form
          className="crm-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            link.mutate(
              { contact: form },
              {
                onSuccess: () => {
                  setAdding(false);
                  setForm({ name: '', phone: '', email: '', jobTitle: '' });
                },
              },
            );
          }}
        >
          <input
            className="crm-input"
            placeholder="Nome"
            value={form.name}
            onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
            autoFocus
          />
          <div className="crm-row">
            <input
              className="crm-input"
              placeholder="Telefone"
              value={form.phone}
              onChange={(e) => setForm((c) => ({ ...c, phone: e.target.value }))}
            />
            <input
              className="crm-input"
              placeholder="E-mail"
              value={form.email}
              onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))}
            />
          </div>
          <input
            className="crm-input"
            placeholder="Cargo"
            value={form.jobTitle}
            onChange={(e) => setForm((c) => ({ ...c, jobTitle: e.target.value }))}
          />
          {link.error && (
            <span className="crm-error">
              {errorText(link.error, 'Não foi possível adicionar.')}
            </span>
          )}
          <div className="crm-quick-row">
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() => setAdding(false)}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="crm-btn is-small is-primary"
              disabled={link.isPending || (!form.phone && !form.email)}
            >
              Adicionar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** One form field and what the arrival check said about it; "—" and the reason when missing. */
function FieldCheckRow({
  label,
  value,
  check,
}: {
  label: string;
  value: ReactNode | null;
  /** null: a field that is not checked (shown without a badge). */
  check: LeadCheck | undefined | null;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="crm-field-value">{value ?? '—'}</span>
        {check === null ? null : check ? (
          <span className={`crm-check is-${check.status}`}>{LEAD_CHECK_LABELS[check.status]}</span>
        ) : (
          <span className="crm-check is-nao_verificado">Não conferido ainda</span>
        )}
        {check?.reason ? <span className="crm-sub crm-check-reason">{check.reason}</span> : null}
      </dd>
    </>
  );
}

/**
 * "Dados do formulário": the five fields a lead form asks (name, WhatsApp,
 * Instagram, site, company and CNPJ), each with what the arrival check said,
 * and "Conferir de novo".
 */
const UTM_LABELS = {
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  content: 'utm_content',
  term: 'utm_term',
} as const;

/**
 * Where the lead came from, in full: the ad (campaign, set and ad, by the ids
 * the lead keeps), the visit (UTMs, RD's origin label, the form) and the
 * form's answers. Only what is known shows; nothing is filled in.
 */
function OriginPanel({ lead }: { lead: Lead }) {
  const { origin } = lead;
  const ref = (item: { externalId: string; name: string | null } | null) =>
    item ? `${item.name ?? 'nome ainda não lido da conta'} · id ${item.externalId}` : null;
  const rows: { key: string; label: string; value: ReactNode }[] = [];
  const push = (key: string, label: string, value: ReactNode | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') rows.push({ key, label, value });
  };
  if (origin.ad) {
    push('adPlatform', 'Plataforma', origin.ad.platform);
    push('adCampaign', 'Campanha', ref(origin.ad.campaign));
    push('adSet', 'Conjunto', ref(origin.ad.adSet));
    push('ad', 'Anúncio', ref(origin.ad.ad));
  } else if (origin.campaignName || origin.campaignId) {
    push('campaign', 'Campanha', origin.campaignName ?? origin.campaignId);
  }
  for (const [key, label] of Object.entries(UTM_LABELS) as [keyof typeof UTM_LABELS, string][])
    push(`utm:${key}`, label, origin.utm?.[key]);
  push('traffic', 'Origem no RD', origin.trafficSource);
  push('form', 'Formulário', origin.conversionIdentifier ?? origin.formId);
  push('page', 'Página', origin.landingPage);
  for (const [question, answer] of Object.entries(lead.formAnswers ?? {}))
    push(`answer:${question}`, question.replace(/_/g, ' '), answer);
  push('companyName', 'Nome da empresa', lead.fields.companyName);
  push('instagram', 'Instagram', lead.fields.instagram);
  push('website', 'Site', lead.fields.website);
  push('city', 'Cidade', lead.city);
  return (
    <section className="crm-panel" aria-label="Origem">
      <h2>Origem</h2>
      {rows.length === 0 ? (
        <p className="crm-sub">
          — A entrada não trouxe anúncio, UTM nem respostas de formulário para este lead.
        </p>
      ) : (
        <dl className="crm-kv">
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

function FormFieldsPanel({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const recheck = useCheckLead();
  const { fields, checks } = lead;
  const site = fields.website;
  // Links only for what passed the format check: never an IP, never a broken @.
  const siteLink =
    site && normalizeWebsite(site) === site ? (
      <a href={site} target="_blank" rel="noopener noreferrer nofollow">
        {site.replace(/^https?:\/\//, '').replace(/\/$/, '')}
      </a>
    ) : (
      site
    );
  return (
    <section className="crm-panel" aria-label="Dados do formulário">
      <h2>Dados do formulário</h2>
      <dl className="crm-kv crm-checks">
        <FieldCheckRow label="Nome" value={lead.name} check={null} />
        <FieldCheckRow
          label="WhatsApp"
          value={lead.phone ? 'ver em Contato' : null}
          check={checks.whatsapp}
        />
        <FieldCheckRow
          label="Instagram"
          value={
            fields.instagram && normalizeInstagram(fields.instagram) === fields.instagram ? (
              <a
                href={`https://www.instagram.com/${fields.instagram}/`}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                @{fields.instagram}
              </a>
            ) : (
              fields.instagram
            )
          }
          check={checks.instagram}
        />
        <FieldCheckRow label="Site" value={siteLink} check={checks.website} />
        <FieldCheckRow label="Nome da empresa" value={fields.companyName} check={null} />
        <FieldCheckRow label="CNPJ" value={fields.cnpj} check={checks.cnpj} />
      </dl>
      {canWrite ? (
        <p>
          <button
            type="button"
            className="crm-btn"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate(lead.id)}
          >
            {recheck.isPending ? 'Conferindo…' : 'Conferir de novo'}
          </button>
          {recheck.isError ? (
            <span className="crm-sub"> Não foi possível conferir agora.</span>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

// --- center: register + timeline ---------------------------------------------------------------

type Tab = 'note' | 'task' | 'call' | 'meeting' | 'email' | 'whatsapp' | 'meet';

function Register({
  lead,
  tab,
  onTab,
  ref,
}: {
  lead: Lead;
  tab: Tab;
  onTab: (tab: Tab) => void;
  ref: RefObject<HTMLElement | null>;
}) {
  const setTab = onTab;
  const note = useAddNote(lead.id);
  const task = useCreateTask(lead.id);
  const activity = useAddActivity(lead.id);
  const [body, setBody] = useState('');
  const [taskForm, setTaskForm] = useState({
    kind: 'follow_up' as LeadTaskKind,
    title: '',
    dueAt: toLocalInput(new Date(Date.now() + 86_400_000)),
  });
  const [call, setCall] = useState({
    outcome: 'answered' as LeadCallOutcome,
    minutes: '',
    note: '',
  });
  const [meeting, setMeeting] = useState({
    at: toLocalInput(new Date(Date.now() + 86_400_000)),
    participants: '',
    meetUrl: '',
    note: '',
  });
  const error = note.error ?? task.error ?? activity.error;
  const tabs: [Tab, string, boolean][] = [
    ['note', 'Anotação', false],
    ['task', 'Tarefa', false],
    ['call', 'Ligação', false],
    ['meeting', 'Reunião', false],
  ];
  return (
    <section className="crm-panel" ref={ref} id="registrar">
      <div className="crm-record-tabs" role="tablist" aria-label="Registrar">
        {tabs.map(([key, label, disabled]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'is-active' : ''}
            disabled={disabled}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'note' && (
        <form
          className="crm-record-form"
          onSubmit={(e) => {
            e.preventDefault();
            note.mutate({ body }, { onSuccess: () => setBody('') });
          }}
        >
          <textarea
            className="crm-textarea"
            placeholder="O que aconteceu? (fica só nesta negociação)"
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="crm-quick-row">
            <button
              type="submit"
              className="crm-btn is-primary"
              disabled={note.isPending || body.trim().length === 0}
            >
              Anotar
            </button>
          </div>
        </form>
      )}
      {tab === 'task' && (
        <form
          className="crm-record-form"
          onSubmit={(e) => {
            e.preventDefault();
            task.mutate(
              {
                kind: taskForm.kind,
                title: taskForm.title,
                dueAt: new Date(taskForm.dueAt).toISOString(),
              },
              { onSuccess: () => setTaskForm((c) => ({ ...c, title: '' })) },
            );
          }}
        >
          <div className="crm-row">
            <select
              className="crm-select"
              value={taskForm.kind}
              onChange={(e) => setTaskForm((c) => ({ ...c, kind: e.target.value as LeadTaskKind }))}
            >
              {LEAD_TASK_KINDS.filter((k) => k !== 'first_contact').map((k) => (
                <option key={k} value={k}>
                  {LEAD_TASK_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <input
              className="crm-input"
              type="datetime-local"
              value={taskForm.dueAt}
              onChange={(e) => setTaskForm((c) => ({ ...c, dueAt: e.target.value }))}
            />
          </div>
          <input
            className="crm-input"
            placeholder="O que fazer"
            value={taskForm.title}
            maxLength={160}
            onChange={(e) => setTaskForm((c) => ({ ...c, title: e.target.value }))}
          />
          <div className="crm-quick-row">
            <button
              type="submit"
              className="crm-btn is-primary"
              disabled={task.isPending || taskForm.title.trim().length < 2}
            >
              Criar tarefa
            </button>
          </div>
        </form>
      )}
      {tab === 'call' && (
        <form
          className="crm-record-form"
          onSubmit={(e) => {
            e.preventDefault();
            activity.mutate(
              {
                kind: 'call',
                outcome: call.outcome,
                durationSeconds: call.minutes ? Math.round(Number(call.minutes) * 60) : undefined,
                note: call.note || undefined,
              },
              { onSuccess: () => setCall({ outcome: 'answered', minutes: '', note: '' }) },
            );
          }}
        >
          <div className="crm-row">
            <select
              className="crm-select"
              value={call.outcome}
              onChange={(e) =>
                setCall((c) => ({ ...c, outcome: e.target.value as LeadCallOutcome }))
              }
            >
              {LEAD_CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {LEAD_CALL_OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
            <input
              className="crm-input"
              type="number"
              min={0}
              max={600}
              placeholder="Duração (min)"
              value={call.minutes}
              onChange={(e) => setCall((c) => ({ ...c, minutes: e.target.value }))}
            />
          </div>
          <textarea
            className="crm-textarea"
            placeholder="Observação"
            value={call.note}
            maxLength={2000}
            onChange={(e) => setCall((c) => ({ ...c, note: e.target.value }))}
          />
          <div className="crm-quick-row">
            {lead.phone && <CopyPhone phone={lead.phone} />}
            <button type="submit" className="crm-btn is-primary" disabled={activity.isPending}>
              Registrar ligação
            </button>
          </div>
        </form>
      )}
      {tab === 'meeting' && (
        <form
          className="crm-record-form"
          onSubmit={(e) => {
            e.preventDefault();
            activity.mutate(
              {
                kind: 'meeting',
                at: new Date(meeting.at).toISOString(),
                participants: meeting.participants || undefined,
                meetUrl: meeting.meetUrl || undefined,
                note: meeting.note || undefined,
              },
              {
                onSuccess: () =>
                  setMeeting((c) => ({ ...c, participants: '', meetUrl: '', note: '' })),
              },
            );
          }}
        >
          <div className="crm-row">
            <input
              className="crm-input"
              type="datetime-local"
              value={meeting.at}
              onChange={(e) => setMeeting((c) => ({ ...c, at: e.target.value }))}
            />
            <input
              className="crm-input"
              placeholder="Participantes"
              value={meeting.participants}
              maxLength={500}
              onChange={(e) => setMeeting((c) => ({ ...c, participants: e.target.value }))}
            />
          </div>
          <input
            className="crm-input"
            placeholder="Link do Meet (https://meet.google.com/…)"
            value={meeting.meetUrl}
            onChange={(e) => setMeeting((c) => ({ ...c, meetUrl: e.target.value }))}
          />
          <textarea
            className="crm-textarea"
            placeholder="Pauta ou resultado"
            value={meeting.note}
            maxLength={2000}
            onChange={(e) => setMeeting((c) => ({ ...c, note: e.target.value }))}
          />
          <div className="crm-quick-row">
            <button type="submit" className="crm-btn is-primary" disabled={activity.isPending}>
              Registrar reunião
            </button>
          </div>
        </form>
      )}
      {error && <p className="crm-error">{errorText(error, 'Não foi possível registrar.')}</p>}
    </section>
  );
}

/** The phone to dial, as text, with a button that copies it; "Copiado" for a moment after. */
function CopyPhone({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="crm-copy-phone">
      <span className="crm-call-number-inline">{formatPhone(phone)}</span>
      <button
        type="button"
        className="crm-btn is-quiet"
        aria-label="Copiar telefone"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(`+${phone}`)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </span>
  );
}

// --- right column ------------------------------------------------------------------------------

/** One card of the right column: a title with its count, "Adicionar", and the rows. */
function AssocCard({
  title,
  count,
  onAdd,
  soon,
  children,
}: {
  title: string;
  /** `null` when the count could not be loaded: it shows "—", never a made-up 0. */
  count: number | null;
  onAdd?: () => void;
  soon?: string;
  children?: ReactNode;
}) {
  return (
    <section className="crm-panel crm-assoc" aria-label={`${title}: ${count ?? '—'}`}>
      <h2>
        <span>
          {title} <span className="crm-count">{count ?? '—'}</span>
        </span>
        {soon ? (
          <button type="button" className="crm-btn is-small is-quiet" disabled title={soon}>
            em breve
          </button>
        ) : (
          onAdd && (
            <button type="button" className="crm-btn is-small is-quiet" onClick={onAdd}>
              + Adicionar
            </button>
          )
        )}
      </h2>
      {children}
    </section>
  );
}

/** Contatos, Empresa, Propostas and Arquivos, with counts, as HubSpot keeps them on the right. */
function AssociationCards({
  data,
  canWrite,
  onAddContact,
  onAddFile,
  onShowFiles,
}: {
  data: LoadedLead;
  canWrite: boolean;
  onAddContact: () => void;
  onAddFile: () => void;
  onShowFiles: () => void;
}) {
  const { lead } = data;
  const deal = useUpdateDeal(lead.id);
  const files = useLeadFiles(lead.id);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <AssocCard
        title="Contatos"
        count={lead.contacts.length}
        onAdd={canWrite ? onAddContact : undefined}
      >
        {lead.contacts.length === 0 ? (
          <p className="crm-muted">A pessoa da negociação, ao lado.</p>
        ) : (
          lead.contacts.map((contact) => (
            <div key={contact.id} className="crm-assoc-row">
              <Link to={`/crm-vendas/contatos/${contact.id}`}>{contact.name ?? 'Sem nome'}</Link>
              <span className="crm-sub">
                {contact.jobTitle ?? (contact.primary ? 'principal' : '')}
              </span>
            </div>
          ))
        )}
      </AssocCard>
      <AssocCard
        title="Empresa"
        count={lead.company ? 1 : 0}
        onAdd={canWrite && !lead.company && !naming ? () => setNaming(true) : undefined}
      >
        {lead.company && (
          <div className="crm-assoc-row">
            <CompanyLink id={lead.company.id}>{lead.company.name}</CompanyLink>
            {lead.company.clientId && <span className="crm-sub">já é cliente</span>}
          </div>
        )}
        {!lead.company && !naming && <p className="crm-muted">Nenhuma empresa ligada.</p>}
        {naming && (
          <form
            className="crm-record-form"
            onSubmit={(event) => {
              event.preventDefault();
              deal.mutate({ companyName: name }, { onSuccess: () => setNaming(false) });
            }}
          >
            <input
              className="crm-input"
              aria-label="Nome da empresa"
              placeholder="Nome da empresa"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            <div className="crm-quick-row">
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setNaming(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="crm-btn is-small is-primary"
                disabled={name.trim().length < 2 || deal.isPending}
              >
                Salvar
              </button>
            </div>
          </form>
        )}
      </AssocCard>
      <AssocCard title="Propostas" count={0} soon="Em breve: propostas feitas e enviadas daqui">
        <p className="crm-muted">Nenhuma proposta.</p>
      </AssocCard>
      <AssocCard
        title="Arquivos"
        count={files.data ? files.data.length : null}
        onAdd={canWrite ? onAddFile : undefined}
      >
        {files.isLoading && <p className="crm-muted">Carregando…</p>}
        {files.isError && (
          <LoadFailure
            what="os arquivos"
            error={files.error}
            onRetry={() => void files.refetch()}
          />
        )}
        {files.isSuccess && files.data.length === 0 && <p className="crm-muted">Nenhum arquivo.</p>}
        {files.data && files.data.length > 0 && (
          <>
            {files.data.slice(0, 3).map((file) => (
              <div key={file.id} className="crm-assoc-row">
                <button type="button" className="crm-link-btn" onClick={onShowFiles}>
                  {file.name}
                </button>
              </div>
            ))}
            {files.data.length > 3 && (
              <button type="button" className="crm-link-btn crm-sub" onClick={onShowFiles}>
                Ver todos
              </button>
            )}
          </>
        )}
      </AssocCard>
    </>
  );
}

function Countdown({ dueAt, inline }: { dueAt: string; inline?: boolean }) {
  const diff = new Date(dueAt).getTime() - Date.now();
  const late = diff < 0;
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const text =
    hours >= 48
      ? `${Math.floor(hours / 24)} d`
      : `${hours}h ${String(minutes).padStart(2, '0')}min`;
  const label = late ? `−${text}` : text;
  if (inline)
    return <span className={`crm-countdown is-inline ${late ? 'is-late' : 'is-ok'}`}>{label}</span>;
  return <div className={`crm-countdown ${late ? 'is-late' : 'is-ok'}`}>{label}</div>;
}

function NextPanel({
  data,
  canWrite,
  onAct,
}: {
  data: LoadedLead;
  canWrite: boolean;
  onAct: (tab: Tab) => void;
}) {
  const update = useUpdateTask(data.lead.id);
  const open = data.tasks
    .filter((task) => !task.doneAt && task.kind !== 'first_contact')
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <>
      <section className="crm-panel">
        <h2>
          Próximas tarefas
          {canWrite && (
            <button type="button" className="crm-btn is-small" onClick={() => onAct('task')}>
              Criar tarefa
            </button>
          )}
        </h2>
        {open.length === 0 && <p className="crm-muted">Nenhuma tarefa aberta.</p>}
        {open.map((task) => (
          <label key={task.id} className={`crm-task-line${isPast(task.dueAt) ? ' is-late' : ''}`}>
            {canWrite && (
              <input
                type="checkbox"
                checked={false}
                disabled={update.isPending}
                onChange={() => update.mutate({ taskId: task.id, done: true })}
                aria-label={`Concluir ${task.title}`}
              />
            )}
            <span>
              {task.title}
              <div className="crm-task-when">
                {LEAD_TASK_KIND_LABELS[task.kind]} · {dueLabel(task.dueAt)}
                {isPast(task.dueAt) ? ' · atrasada' : ''} · {task.assigneeName ?? '—'}
              </div>
            </span>
          </label>
        ))}
      </section>
    </>
  );
}
