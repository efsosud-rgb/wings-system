import {
  LEAD_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_LEGAL_BASES,
  LEAD_LEGAL_BASIS_LABELS,
  LEAD_NAME_MAX,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  type LeadChannel,
  type LeadLegalBasis,
  type LeadListItem,
  type LeadSource,
} from '@wings/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useClients } from '../api/clients.js';
import { useCreateLead, useLeads } from '../api/leads.js';
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

function ScorePill({ score, state }: { score: number | null; state: LeadListItem['researchState'] }) {
  if (state === 'pending' || state === 'running') return <span className="status status-on_leave">{RESEARCH_LABELS[state]}</span>;
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
          <Input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="(11) 99999-8888" />
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
      <Field label="Onde e quando a pessoa autorizou o contato" required hint="Fica registrado no lead, com a data de hoje.">
        <Input value={form.consentText} onChange={set('consentText')} maxLength={500} placeholder="Ex.: feira de franquias em 20/09, formulário de papel" />
      </Field>
      {create.error && (
        <Alert kind="error">{create.error instanceof ApiError ? create.error.message : 'Não foi possível cadastrar o lead.'}</Alert>
      )}
      <div className="form-actions">
        <Button type="submit" disabled={create.isPending || form.name.trim().length < 2 || form.consentText.trim().length < 5}>
          Cadastrar e pesquisar
        </Button>
      </div>
    </form>
  );
}

export function LeadsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const clients = useClients();
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState('');
  const [source, setSource] = useState<LeadSource | ''>('');
  const [creating, setCreating] = useState(false);
  const leads = useLeads({ q, clientId, source });
  const canWrite = hasPermission(session.data, 'leads.write');
  const list = leads.data?.leads ?? [];

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Funil</h1>
          <p>
            Leads captados pelas landing pages, pelos links rastreáveis do WhatsApp e pelo Meta Lead Ads, com a
            pesquisa de perfil de cada um. O repasse para a Sofia vem na parte 2.
          </p>
        </div>
        {canWrite && (
          <Button type="button" variant={creating ? 'ghost' : 'primary'} onClick={() => setCreating((open) => !open)}>
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

      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span className="field-label">Buscar</span>
          <input className="control" value={q} placeholder="Nome, e-mail ou telefone" onChange={(event) => setQ(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Cliente</span>
          <select className="control" value={clientId} onChange={(event) => setClientId(event.target.value)}>
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
          <select className="control" value={source} onChange={(event) => setSource(event.target.value as LeadSource | '')}>
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

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Contato</th>
              <th>Cliente</th>
              <th>Origem</th>
              <th>Perfil</th>
              <th>Chegou em</th>
            </tr>
          </thead>
          <tbody>
            {leads.isLoading && (
              <tr>
                <td colSpan={6} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!leads.isLoading && list.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nenhum lead ainda. Quando uma landing page, um link rastreável ou um formulário do Meta converter, ele aparece aqui.
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
                  {lead.clientName}
                  {!lead.clientMapped && <span className="tag">sem regra</span>}
                </td>
                <td>
                  <div>{LEAD_SOURCE_LABELS[lead.source]}</div>
                  {lead.channel && <div className="cell-sub">{LEAD_CHANNEL_LABELS[lead.channel]}</div>}
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
