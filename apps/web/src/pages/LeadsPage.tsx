import {
  INACTIVE_OWNER,
  INACTIVE_OWNER_LABEL,
  LEAD_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_LEGAL_BASES,
  LEAD_LEGAL_BASIS_LABELS,
  LEAD_NAME_MAX,
  LEAD_OUTCOMES,
  LEAD_OUTCOME_LABELS,
  LEAD_PIPELINES,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  type FunnelSummary,
  type LeadChannel,
  type LeadLegalBasis,
  type LeadListItem,
} from '@wings/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useClients } from '../api/clients.js';
import { useCreateLead, useFunnelSummary, useLeads, type LeadFilter } from '../api/leads.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';

/**
 * CRM Vendas → Funil. Every lead that came in, where it came from and how the
 * research went. Part 1 is intake only: the SDR handoff (Sofia) is part 2.
 */

export const RESEARCH_LABELS: Record<LeadListItem['researchState'], string> = {
  none: 'Sem pesquisa',
  pending: 'Na fila',
  running: 'Pesquisando…',
  done: 'Pesquisado',
  failed: 'Falhou',
};

export function formatPhone(phone: string | null): string {
  if (!phone) return '—';
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** "há 3 dias", "há 5 h", "há 12 min". */
export function sinceLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} dias`;
}

function ScorePill({
  score,
  state,
}: {
  score: number | null;
  state: LeadListItem['researchState'];
}) {
  if (state === 'pending' || state === 'running')
    return <span className="status status-on_leave">{RESEARCH_LABELS[state]}</span>;
  if (state === 'failed') return <span className="status status-inactive">Pesquisa falhou</span>;
  if (score === null) return <span className="muted">—</span>;
  const tone = score >= 70 ? 'active' : score >= 40 ? 'on_leave' : 'inactive';
  return <span className={`status status-${tone}`}>{score}/100</span>;
}

function NewLeadForm({ onDone }: { onDone: (id: string) => void }) {
  const clients = useClients();
  const create = useCreateLead();
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    clientId: '',
    channel: '' as LeadChannel | '',
    legalBasis: 'consent' as LeadLegalBasis,
    consentText: '',
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <form
      className="block lead-new"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          {
            name: form.name,
            email: form.email || undefined,
            phone: form.phone || undefined,
            clientId: form.clientId || undefined,
            channel: form.channel || undefined,
            legalBasis: form.legalBasis,
            consentText: form.consentText,
          },
          { onSuccess: (answer) => onDone(answer.lead.id) },
        );
      }}
    >
      <div className="grid-2">
        <Field label="Nome" required>
          <Input value={form.name} maxLength={LEAD_NAME_MAX} onChange={set('name')} required />
        </Field>
        <Field label="Telefone (WhatsApp)" hint="Com DDD. É preciso telefone ou e-mail.">
          <Input
            value={form.phone}
            onChange={set('phone')}
            inputMode="tel"
            placeholder="(11) 99999-8888"
          />
        </Field>
        <Field label="E-mail">
          <Input value={form.email} onChange={set('email')} type="email" />
        </Field>
        <Field label="Cliente (franqueadora de interesse)">
          <Select value={form.clientId} onChange={set('clientId')}>
            <option value="">Ainda não sei</option>
            {(clients.data?.clients ?? [])
              .filter((client) => client.active)
              .map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Canal">
          <Select value={form.channel} onChange={set('channel')}>
            <option value="">Não informado</option>
            {LEAD_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {LEAD_CHANNEL_LABELS[channel]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base legal (LGPD)" required>
          <Select value={form.legalBasis} onChange={set('legalBasis')}>
            {LEAD_LEGAL_BASES.map((basis) => (
              <option key={basis} value={basis}>
                {LEAD_LEGAL_BASIS_LABELS[basis]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Onde e quando a pessoa autorizou o contato"
        required
        hint="Fica registrado no lead, com a data de hoje."
      >
        <Input
          value={form.consentText}
          onChange={set('consentText')}
          maxLength={500}
          placeholder="Ex.: feira de franquias em 20/09, formulário de papel"
        />
      </Field>
      {create.error && (
        <Alert kind="error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível cadastrar o lead.'}
        </Alert>
      )}
      <div className="form-actions">
        <Button
          type="submit"
          disabled={
            create.isPending || form.name.trim().length < 2 || form.consentText.trim().length < 5
          }
        >
          Cadastrar e pesquisar
        </Button>
      </div>
    </form>
  );
}

function StaleCell({ lead }: { lead: LeadListItem }) {
  if (lead.won === true) return <span className="status status-active">Ganho</span>;
  if (lead.won === false) return <span className="status status-inactive">Perdido</span>;
  if (!lead.stageChangedAt) return <span className="muted">—</span>;
  const days = Math.floor((Date.now() - new Date(lead.stageChangedAt).getTime()) / 86_400_000);
  return (
    <span
      className={days > 30 ? 'status status-inactive' : days > 7 ? 'status status-on_leave' : ''}
    >
      {days} d
    </span>
  );
}

function MiniFunnel({
  summary,
  days,
  onDays,
}: {
  summary: FunnelSummary | undefined;
  days: 30 | 90;
  onDays: (days: 30 | 90) => void;
}) {
  const rows = summary?.rows ?? [];
  return (
    <section className="block">
      <div className="page-header-row">
        <h2>Por marca, últimos {days} dias</h2>
        <div className="segmented" role="group" aria-label="Janela">
          {([30, 90] as const).map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === days ? 'primary' : 'ghost'}
              onClick={() => onDays(option)}
            >
              {option} dias
            </Button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Funil</th>
              <th>Marca</th>
              <th title="Leads que chegaram na janela (data de criação do negócio no RD, ou da chegada)">
                Chegaram
              </th>
              <th title="Saíram da primeira etapa do funil, ou foram fechados">Trabalhados</th>
              <th title='Em "Reunião realizada" ou depois, ou ganhos (o RD não guarda o histórico dos perdidos)'>
                Reunião
              </th>
              <th>Venda</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nenhum lead com funil nesta janela.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.pipeline}|${row.label}`}>
                <td>{LEAD_PIPELINE_LABELS[row.pipeline]}</td>
                <td>{row.label}</td>
                <td>{row.arrived}</td>
                <td>{row.worked}</td>
                <td>{row.meeting}</td>
                <td>{row.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {summary?.syncedAt
          ? `Etapas lidas do RD CRM ${sinceLabel(summary.syncedAt)}.`
          : 'Etapas ainda não lidas do RD CRM.'}{' '}
        O trabalho continua no RD CRM; mudar a etapa aqui ainda não é possível.
      </p>
    </section>
  );
}

export function LeadsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const clients = useClients();
  const [filter, setFilter] = useState<LeadFilter>({});
  const [days, setDays] = useState<30 | 90>(30);
  const [creating, setCreating] = useState(false);
  const leads = useLeads(filter);
  const summary = useFunnelSummary(days);
  const canWrite = hasPermission(session.data, 'leads.write');
  const list = leads.data?.leads ?? [];
  const total = leads.data?.total ?? 0;
  const set = (key: keyof LeadFilter) => (event: { target: { value: string } }) =>
    setFilter((current) => ({
      ...current,
      [key]: event.target.value,
      ...(key === 'pipeline' ? { stage: '' } : {}),
    }));
  const stages = (summary.data?.stages ?? []).filter(
    (stage) => !filter.pipeline || stage.pipeline === filter.pipeline,
  );

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Funil</h1>
          <p>
            Leads das landing pages, dos links do WhatsApp, do Meta Lead Ads e os negócios de
            Expansão e Formatação do RD CRM, com marca, etapa e dono. A etapa é lida do RD CRM, onde
            a equipe trabalha até a virada.
          </p>
        </div>
        {canWrite && (
          <Button
            type="button"
            variant={creating ? 'ghost' : 'primary'}
            onClick={() => setCreating((open) => !open)}
          >
            {creating ? 'Fechar' : 'Novo lead'}
          </Button>
        )}
      </header>

      {creating && canWrite && (
        <NewLeadForm
          onDone={(id) => {
            setCreating(false);
            navigate(`/crm-vendas/funil/${id}`);
          }}
        />
      )}

      <MiniFunnel summary={summary.data} days={days} onDays={setDays} />

      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span className="field-label">Buscar</span>
          <input
            className="control"
            value={filter.q ?? ''}
            placeholder="Nome, e-mail ou telefone"
            onChange={set('q')}
          />
        </label>
        <label className="field">
          <span className="field-label">Funil</span>
          <select className="control" value={filter.pipeline ?? ''} onChange={set('pipeline')}>
            <option value="">Todos</option>
            {LEAD_PIPELINES.map((pipeline) => (
              <option key={pipeline} value={pipeline}>
                {LEAD_PIPELINE_LABELS[pipeline]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Etapa</span>
          <select className="control" value={filter.stage ?? ''} onChange={set('stage')}>
            <option value="">Todas</option>
            {stages.map((stage) => (
              <option key={`${stage.pipeline}|${stage.stage}`} value={stage.stage}>
                {filter.pipeline
                  ? stage.stage
                  : `${LEAD_PIPELINE_LABELS[stage.pipeline]} · ${stage.stage}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Dono</span>
          <select className="control" value={filter.owner ?? ''} onChange={set('owner')}>
            <option value="">Todos</option>
            <option value={INACTIVE_OWNER}>
              {INACTIVE_OWNER_LABEL}
              {summary.data ? ` (${summary.data.inactiveOwnerOpen} em andamento)` : ''}
            </option>
            {(summary.data?.owners ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Situação</span>
          <select className="control" value={filter.outcome ?? ''} onChange={set('outcome')}>
            <option value="">Todas</option>
            {LEAD_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {LEAD_OUTCOME_LABELS[outcome]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Parados há mais de</span>
          <select className="control" value={filter.staleDays ?? ''} onChange={set('staleDays')}>
            <option value="">—</option>
            {['7', '15', '30', '60', '90'].map((value) => (
              <option key={value} value={value}>
                {value} dias
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Cliente</span>
          <select className="control" value={filter.clientId ?? ''} onChange={set('clientId')}>
            <option value="">Todos</option>
            {(clients.data?.clients ?? []).map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Origem</span>
          <select className="control" value={filter.source ?? ''} onChange={set('source')}>
            <option value="">Todas</option>
            {LEAD_SOURCES.map((item) => (
              <option key={item} value={item}>
                {LEAD_SOURCE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
      </form>

      {leads.isError && <Alert kind="error">Não foi possível carregar os leads.</Alert>}
      {total > list.length && (
        <p className="muted">
          Mostrando os {list.length} mais recentes de {total}. Use os filtros para achar os outros.
        </p>
      )}
      {filter.staleDays && (
        <p className="muted">
          "Parados" conta só os leads em andamento cuja data de entrada na etapa já foi lida do RD.
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Contato</th>
              <th>Marca / cliente</th>
              <th>Funil · etapa</th>
              <th>Dono</th>
              <th title="Dias desde a entrada na etapa atual (lido do RD CRM)">Parado há</th>
              <th>Origem</th>
              <th>Perfil</th>
              <th>Chegou em</th>
            </tr>
          </thead>
          <tbody>
            {leads.isLoading && (
              <tr>
                <td colSpan={9} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!leads.isLoading && list.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  Nenhum lead com esses filtros. Os negócios do RD CRM entram pela importação;
                  conversões novas, pelas landing pages, links rastreáveis e formulários do Meta.
                </td>
              </tr>
            )}
            {list.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link to={`/crm-vendas/funil/${lead.id}`}>{lead.name ?? 'Sem nome'}</Link>
                </td>
                <td>
                  <div>{formatPhone(lead.phone)}</div>
                  {lead.email && <div className="cell-sub">{lead.email}</div>}
                </td>
                <td>
                  {lead.clientMapped ? lead.clientName : (lead.brand ?? lead.clientName)}
                  {!lead.clientMapped && <span className="tag">sem regra</span>}
                </td>
                <td>
                  <div>{lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}</div>
                  {lead.stage && <div className="cell-sub">{lead.stage}</div>}
                </td>
                <td>
                  {lead.ownerInactive ? (
                    <span className="muted">{INACTIVE_OWNER_LABEL}</span>
                  ) : (
                    (lead.ownerName ?? '—')
                  )}
                </td>
                <td>
                  <StaleCell lead={lead} />
                </td>
                <td>
                  <div>{LEAD_SOURCE_LABELS[lead.source]}</div>
                  {lead.channel && (
                    <div className="cell-sub">{LEAD_CHANNEL_LABELS[lead.channel]}</div>
                  )}
                </td>
                <td>
                  <ScorePill score={lead.score} state={lead.researchState} />
                </td>
                <td>{formatDateTime(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
