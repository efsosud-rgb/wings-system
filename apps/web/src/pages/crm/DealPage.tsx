import {
  initialsOf,
  isCloseForecastOverdue,
  LEAD_CALL_OUTCOME_LABELS,
  LEAD_CALL_OUTCOMES,
  LEAD_CHANNEL_LABELS,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  sourceBadgeOf,
  type Lead,
  type LeadActivity,
  type LeadCallOutcome,
  type LeadEvent,
  type LeadNote,
  type LeadTask,
  type LeadTaskKind,
  LEAD_CHECK_LABELS,
  normalizeInstagram,
  normalizeWebsite,
  type LeadCheck,
} from '@wings/shared';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  useAddActivity,
  useBrands,
  useLinkContact,
  useUnlinkContact,
  useUpdateDeal,
} from '../../api/crm.js';
import {
  useAddNote,
  useCheckLead,
  useCreateTask,
  useLead,
  useSellers,
  useStages,
  useUpdateLead,
  useUpdateTask,
  type LoadedLead,
} from '../../api/leads.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { LeadEmailTab } from './LeadEmailTab.js';
import {
  ago,
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

/**
 * The deal's page: who and how much on top, the stage bar you click, win or
 * lose; on the left the contact, the company and where it came from; in the
 * middle what you register (note, task, call, e-mail) and one timeline; on
 * the right what is next and the first-contact clock.
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const EVENT_LABELS: Record<string, string> = {
  'lead.received.rd_station': 'Chegou pela landing page',
  'lead.received.whatsapp': 'Chegou pelo WhatsApp',
  'lead.received.meta_lead_ads': 'Chegou pelo Meta Lead Ads',
  'lead.received.tiktok_lead_ads': 'Chegou pelo TikTok Lead Ads',
  'lead.received.site_form': 'Chegou pelo formulário do site',
  'lead.created_manually': 'Negociação criada',
  'lead.imported.rd_crm': 'Trazida do RD CRM',
  'lead.imported.csv': 'Importada de planilha',
  'rd.deal_linked': 'Ligada ao negócio do RD CRM',
  'rd.deal_created': 'Cópia criada no RD CRM',
  'lead.email_sent': 'E-mail ao lead',
  'research.queued': 'Pesquisa pedida',
  'research.done': 'Pesquisa concluída',
  'research.failed': 'Pesquisa não concluída',
  'lead.stage_changed': 'Etapa alterada',
  'lead.outcome_changed': 'Resultado alterado',
  'lead.owner_changed': 'Dono alterado',
  'lead.pipeline_changed': 'Funil alterado',
  'lead.value_changed': 'Valor alterado',
  'lead.expected_close_changed': 'Previsão de fechamento alterada',
  'lead.brand_changed': 'Marca de interesse alterada',
  'lead.company_changed': 'Empresa alterada',
  'lead.contact_linked': 'Contato adicionado',
  'lead.contact_unlinked': 'Contato removido',
  'lead.task_done': 'Tarefa concluída',
  'lead.task_updated': 'Tarefa alterada',
};

export function DealPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const loaded = useLead(id);
  const canWrite = hasPermission(session.data, 'leads.write');
  const canAssign = hasPermission(session.data, 'leads.assign');
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
  return (
    <div className="crm-page">
      <div className="crm-page-scroll" style={{ padding: 0 }}>
        <Head data={data} canWrite={canWrite} canAssign={canAssign} />
        <div className="crm-deal-body">
          <div className="crm-stack">
            <ContactPanel data={data} canWrite={canWrite} />
            <CompanyPanel lead={data.lead} canWrite={canWrite} />
            <OriginPanel lead={data.lead} canWrite={canWrite} />
          </div>
          <div className="crm-stack">
            {canWrite && <Register lead={data.lead} />}
            <Timeline data={data} />
          </div>
          <div className="crm-stack">
            <NextPanel data={data} canWrite={canWrite} />
          </div>
        </div>
      </div>
    </div>
  );
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
  const sellers = useSellers();
  const update = useUpdateLead(lead.id);
  const deal = useUpdateDeal(lead.id);
  const [value, setValue] = useState<string | null>(null);
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
        <h1>{lead.name ?? 'Sem nome'}</h1>
        {lead.work.won === true && <span className="crm-status is-won">Ganha</span>}
        {lead.work.won === false && (
          <span className="crm-status is-lost">
            Perdida{lead.work.lostReason ? ` · ${lead.work.lostReason}` : ''}
          </span>
        )}
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
          Valor{' '}
          {canWrite ? (
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
                if (cents !== undefined && cents !== lead.valueCents)
                  deal.mutate({ valueCents: cents });
                setValue(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <b>{money(lead.valueCents, true)}</b>
          )}
        </span>
        <span className={forecastOverdue ? 'is-overdue' : undefined}>
          Previsão de fechamento{' '}
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
        </span>
        <span>
          Dono{' '}
          {canAssign ? (
            <select
              className="crm-inline-edit"
              aria-label="Dono"
              value={lead.ownerEmployeeId ?? ''}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ ownerEmployeeId: e.target.value || null })}
            >
              <option value="">— sem dono —</option>
              {(sellers.data?.sellers ?? [])
                .filter((s) => s.active || s.id === lead.ownerEmployeeId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          ) : (
            <b>{lead.work.ownerName ?? '—'}</b>
          )}
        </span>
        <span>
          Funil <b>{lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}</b>
        </span>
        <span>
          Na etapa há <b>{ago(lead.work.stageChangedAt ?? lead.createdAt)}</b>
        </span>
        <span>
          Criada em <b>{formatDateTime(lead.createdAt)}</b>
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
            </button>
          ))}
        </div>
      )}
      {(update.error || deal.error) && (
        <p className="crm-error">
          {errorText(update.error ?? deal.error, 'Não foi possível alterar a negociação.')}
        </p>
      )}
    </header>
  );
}

// --- left column -----------------------------------------------------------------------------

function ContactPanel({ data, canWrite }: { data: LoadedLead; canWrite: boolean }) {
  const { lead } = data;
  const link = useLinkContact(lead.id);
  const unlink = useUnlinkContact(lead.id);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', jobTitle: '' });
  return (
    <section className="crm-panel">
      <h2>
        Contatos
        {canWrite && !adding && (
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setAdding(true)}
          >
            + Adicionar
          </button>
        )}
      </h2>
      {lead.contacts.length === 0 && (
        <p className="crm-muted">
          Sem contato ligado. A pessoa da negociação: {formatPhone(lead.phone)}
          {lead.email ? ` · ${lead.email}` : ''}
        </p>
      )}
      {lead.contacts.map((contact) => (
        <div key={contact.id} className="crm-stack" style={{ gap: 2 }}>
          <div className="crm-tl-head">
            <b>
              <Link to={`/crm-vendas/contatos/${contact.id}`}>{contact.name ?? 'Sem nome'}</Link>
              {contact.primary ? ' · principal' : ''}
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
          <div className="crm-sub">
            {contact.jobTitle ? `${contact.jobTitle} · ` : ''}
            {contact.phone ? (
              <a href={`tel:+${contact.phone}`}>{formatPhone(contact.phone)}</a>
            ) : null}
            {contact.phone && contact.email ? ' · ' : ''}
            {contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : null}
          </div>
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

function CompanyPanel({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const deal = useUpdateDeal(lead.id);
  const brands = useBrands();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  return (
    <section className="crm-panel">
      <h2>
        Empresa
        {canWrite && !editing && (
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
      </h2>
      {lead.company ? (
        <div>
          <Link to={`/crm-vendas/empresas/${lead.company.id}`}>{lead.company.name}</Link>
          {lead.company.clientId && <div className="crm-sub">Já é cliente da Wings</div>}
        </div>
      ) : (
        !editing && <p className="crm-muted">Nenhuma empresa ligada.</p>
      )}
      {editing && (
        <form
          className="crm-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            deal.mutate({ companyName: name }, { onSuccess: () => setEditing(false) });
          }}
        >
          <input
            className="crm-input"
            placeholder="Nome da empresa"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
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
      )}
      {lead.pipeline === 'expansao' && (
        <dl className="crm-kv" style={{ marginTop: 'var(--space-2)' }}>
          <dt>Marca</dt>
          <dd>
            {canWrite ? (
              <select
                className="crm-select"
                value={lead.origin.clientMapped ? lead.origin.clientId : ''}
                disabled={deal.isPending}
                onChange={(e) => deal.mutate({ brandClientId: e.target.value || null })}
              >
                <option value="">
                  {lead.brand ? `${lead.brand} (não cadastrada)` : 'Sem marca'}
                </option>
                {(brands.data?.brands ?? []).map((brand) => (
                  <option key={brand.clientId} value={brand.clientId}>
                    {brand.name}
                  </option>
                ))}
              </select>
            ) : (
              (lead.brand ?? '—')
            )}
          </dd>
        </dl>
      )}
      {deal.error && (
        <span className="crm-error">{errorText(deal.error, 'Não foi possível salvar.')}</span>
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

function FormFields({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
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
    <>
      <h3 className="crm-subhead">Dados do formulário</h3>
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
    </>
  );
}

function OriginPanel({ lead, canWrite }: { lead: Lead; canWrite: boolean }) {
  const { origin } = lead;
  return (
    <section className="crm-panel">
      <h2>Origem</h2>
      <dl className="crm-kv">
        <dt>Como chegou</dt>
        <dd>
          {LEAD_SOURCE_LABELS[origin.source]}
          {origin.channel ? ` · ${LEAD_CHANNEL_LABELS[origin.channel]}` : ''}
        </dd>
        {origin.landingPage && (
          <>
            <dt>Página</dt>
            <dd>{origin.landingPage}</dd>
          </>
        )}
        {(origin.campaignName || origin.campaignId) && (
          <>
            <dt>Campanha</dt>
            <dd>{origin.campaignName ?? origin.campaignId}</dd>
          </>
        )}
        {lead.city && (
          <>
            <dt>Cidade</dt>
            <dd>{lead.city}</dd>
          </>
        )}
        {lead.firstMessage && (
          <>
            <dt>1ª mensagem</dt>
            <dd>{lead.firstMessage}</dd>
          </>
        )}
        {lead.crm && (
          <>
            <dt>RD CRM</dt>
            <dd>
              <a href={lead.crm.rdUrl} target="_blank" rel="noopener noreferrer">
                abrir a cópia
              </a>
            </dd>
          </>
        )}
      </dl>
      <FormFields lead={lead} canWrite={canWrite} />
      {lead.formAnswers && Object.keys(lead.formAnswers).length > 0 && (
        <details>
          <summary className="crm-sub">
            Respostas do formulário ({Object.keys(lead.formAnswers).length})
          </summary>
          <dl className="crm-kv">
            {Object.entries(lead.formAnswers).map(([question, answer]) => (
              <div key={question} style={{ display: 'contents' }}>
                <dt>{question.replace(/_/g, ' ')}</dt>
                <dd>{answer}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {lead.research.summary && (
        <details>
          <summary className="crm-sub">
            Pesquisa automática
            {lead.research.score !== null ? ` · perfil ${lead.research.score}/100` : ''}
          </summary>
          <p className="crm-sub" style={{ whiteSpace: 'pre-wrap' }}>
            {lead.research.summary}
          </p>
        </details>
      )}
    </section>
  );
}

// --- center: register + timeline ---------------------------------------------------------------

type Tab = 'note' | 'task' | 'call' | 'meeting' | 'email' | 'whatsapp';

function Register({ lead }: { lead: Lead }) {
  const [tab, setTab] = useState<Tab>('note');
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
    ['email', 'E-mail', false],
    ['whatsapp', 'WhatsApp · em breve', true],
  ];
  return (
    <section className="crm-panel">
      <div className="crm-record-tabs" role="tablist">
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
            {lead.phone && (
              <a className="crm-btn" href={`tel:+${lead.phone}`}>
                Ligar para {formatPhone(lead.phone)}
              </a>
            )}
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
      {tab === 'email' && <LeadEmailTab leadId={lead.id} />}
      {error && <p className="crm-error">{errorText(error, 'Não foi possível registrar.')}</p>}
    </section>
  );
}

interface Entry {
  id: string;
  at: string;
  icon: IconName;
  tone: string;
  title: string;
  by: string | null;
  body?: string | null;
  link?: { href: string; label: string };
}

function entriesOf(data: LoadedLead): Entry[] {
  const entries: Entry[] = [];
  for (const note of data.notes as LeadNote[])
    entries.push({
      id: `n${note.id}`,
      at: note.at,
      icon: 'edit',
      tone: 'note',
      title: 'Anotação',
      by: note.authorName,
      body: note.body,
    });
  for (const activity of data.activities as LeadActivity[]) {
    const call = activity.kind === 'call';
    entries.push({
      id: `a${activity.id}`,
      at: activity.at,
      icon: call ? 'phone' : 'calendar',
      tone: call ? 'call' : 'meeting',
      title: call
        ? `Ligação · ${activity.outcome ? LEAD_CALL_OUTCOME_LABELS[activity.outcome] : ''}${activity.durationSeconds ? ` · ${Math.round(activity.durationSeconds / 60)} min` : ''}`
        : `Reunião${activity.participants ? ` · ${activity.participants}` : ''}`,
      by: activity.actorName,
      body: activity.note,
      link: activity.meetUrl ? { href: activity.meetUrl, label: 'Abrir o Meet' } : undefined,
    });
  }
  for (const task of data.tasks as LeadTask[]) {
    if (task.doneAt)
      entries.push({
        id: `td${task.id}`,
        at: task.doneAt,
        icon: 'check',
        tone: 'task',
        title: `Tarefa concluída · ${task.title}`,
        by: task.doneByName,
      });
    entries.push({
      id: `tc${task.id}`,
      at: task.createdAt,
      icon: 'check-square',
      tone: 'task',
      title: `Tarefa criada · ${task.title} · para ${dueLabel(task.dueAt)}`,
      by: task.auto ? 'Sistema' : task.assigneeName,
    });
  }
  for (const item of data.history)
    entries.push({
      id: `h${item.id}`,
      at: item.at,
      icon: 'arrow-right',
      tone: 'stage',
      title:
        item.won === true
          ? 'Marcada como venda'
          : item.won === false
            ? `Marcada como perda${item.lostReason ? ` · ${item.lostReason}` : ''}`
            : `${item.fromStage ?? '—'} → ${item.toStage ?? '—'}`,
      by:
        item.actorName ??
        (item.source === 'rd'
          ? 'RD CRM'
          : item.source === 'import'
            ? 'Importação'
            : item.source === 'sofia'
              ? 'Sofia'
              : null),
    });
  const skip = new Set([
    'lead.note_added',
    'lead.task_created',
    'lead.task_done',
    'lead.stage_changed',
    'lead.outcome_changed',
    'lead.call_logged',
    'lead.meeting_logged',
  ]);
  for (const event of data.events as LeadEvent[]) {
    if (skip.has(event.kind)) continue;
    entries.push({
      id: `e${event.id}`,
      at: event.at,
      icon: 'more',
      tone: 'event',
      title: EVENT_LABELS[event.kind] ?? 'Atualização',
      by: null,
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function Timeline({ data }: { data: LoadedLead }) {
  const entries = entriesOf(data);
  return (
    <section className="crm-panel">
      <h2>Linha do tempo</h2>
      {entries.length === 0 && <p className="crm-muted">Nada registrado ainda.</p>}
      <ol className="crm-timeline">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className={`crm-tl-icon is-${entry.tone}`} aria-hidden="true">
              <Icon name={entry.icon} size={13} />
            </span>
            <div>
              <div className="crm-tl-head">
                <b>{entry.title}</b>
                <span>
                  {formatDateTime(entry.at)}
                  {entry.by ? ` · ${entry.by}` : ''}
                </span>
              </div>
              {entry.body && <div className="crm-tl-body">{entry.body}</div>}
              {entry.link && (
                <a href={entry.link.href} target="_blank" rel="noopener noreferrer">
                  {entry.link.label}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --- right column ------------------------------------------------------------------------------

function Countdown({ dueAt }: { dueAt: string }) {
  const diff = new Date(dueAt).getTime() - Date.now();
  const late = diff < 0;
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const text =
    hours >= 48
      ? `${Math.floor(hours / 24)} d`
      : `${hours}h ${String(minutes).padStart(2, '0')}min`;
  return (
    <div className={`crm-countdown ${late ? 'is-late' : 'is-ok'}`}>{late ? `−${text}` : text}</div>
  );
}

function NextPanel({ data, canWrite }: { data: LoadedLead; canWrite: boolean }) {
  const update = useUpdateTask(data.lead.id);
  const open = data.tasks
    .filter((task) => !task.doneAt)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const first = open.find((task) => task.kind === 'first_contact');
  const owner = data.lead.work.ownerName;
  return (
    <>
      {first && (
        <section className="crm-panel">
          <h2>Primeiro contato</h2>
          <Countdown dueAt={first.dueAt} />
          <div className="crm-sub">
            {isPast(first.dueAt) ? 'Prazo vencido' : 'Prazo'} · {dueLabel(first.dueAt)} ·{' '}
            {first.assigneeName ?? '—'}
          </div>
          {canWrite && (
            <button
              type="button"
              className="crm-btn is-small"
              disabled={update.isPending}
              onClick={() => update.mutate({ taskId: first.id, done: true })}
            >
              Contato feito
            </button>
          )}
        </section>
      )}
      <section className="crm-panel">
        <h2>Próximas tarefas</h2>
        {open.filter((task) => task.id !== first?.id).length === 0 && (
          <p className="crm-muted">Nenhuma tarefa aberta.</p>
        )}
        {open
          .filter((task) => task.id !== first?.id)
          .map((task) => (
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
      <section className="crm-panel">
        <h2>Dono</h2>
        <div className="crm-task-line">
          <span className={`crm-avatar${owner ? '' : ' is-empty'}`}>{initialsOf(owner)}</span>
          <span>{owner ?? 'Sem dono'}</span>
        </div>
      </section>
    </>
  );
}
