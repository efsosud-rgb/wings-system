import { LEAD_PIPELINE_LABELS, type CrmContact, type CrmRelatedLead } from '@wings/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { CompanyLink } from '../../components/CompanyLink.js';
import { ApiError } from '../../api/client.js';
import {
  useContact,
  useContacts,
  useCreateContact,
  useMergeContacts,
  useUpdateContact,
} from '../../api/crm.js';
import { LoadFailure, Unavailable } from '../../components/LoadFailure.js';
import { formatDate, formatPhone, money } from './format.js';
import { useCreateFromQuery } from '../../components/useCreateFromQuery.js';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

export function RelatedDeals({ leads }: { leads: CrmRelatedLead[] }) {
  if (leads.length === 0) return <p className="crm-muted">Nenhuma negociação.</p>;
  return (
    <table className="crm-table">
      <thead>
        <tr>
          <th>Negociação</th>
          <th>Funil</th>
          <th>Etapa</th>
          <th className="is-num">Valor</th>
          <th>Dono</th>
          <th>Criada</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((lead) => (
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
            <td>
              {lead.pipeline ? LEAD_PIPELINE_LABELS[lead.pipeline] : '—'}
              {lead.brand ? <div className="crm-sub">{lead.brand}</div> : null}
            </td>
            <td>{lead.stage ?? '—'}</td>
            <td className="is-num">{money(lead.valueCents)}</td>
            <td>{lead.ownerName ?? '—'}</td>
            <td>{formatDate(lead.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** CRM Vendas → Contatos: search, the person's record with their deals, and the duplicates to merge. */
export function ContactsPage() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <ContactRecord id={id} />;
  return <ContactList />;
}

function ContactList() {
  const session = useSession();
  const canWrite = hasPermission(session.data, 'leads.write');
  const canManage = hasPermission(session.data, 'crm.manage');
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'list' | 'duplicates'>('list');
  const contacts = useContacts(q, mode === 'duplicates');
  const create = useCreateContact();
  const merge = useMergeContacts();
  const [creating, setCreating] = useState(false);
  useCreateFromQuery(() => setCreating(true));
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    jobTitle: '',
    companyName: '',
  });
  const rows = contacts.data?.contacts ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Contatos</h1>
        <span className="crm-head-spacer" />
        {canManage && (
          <div className="crm-segment" role="group">
            <button
              type="button"
              className={mode === 'list' ? 'is-active' : ''}
              onClick={() => setMode('list')}
            >
              Todos
            </button>
            <button
              type="button"
              className={mode === 'duplicates' ? 'is-active' : ''}
              onClick={() => setMode('duplicates')}
            >
              Possíveis duplicados
            </button>
          </div>
        )}
        {canWrite && (
          <button
            type="button"
            className="crm-btn is-primary"
            onClick={() => setCreating((open) => !open)}
          >
            + Contato
          </button>
        )}
      </header>
      <div className="crm-page-scroll">
        {creating && (
          <form
            className="crm-panel"
            style={{ marginBottom: 'var(--space-4)' }}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(
                { ...form, companyName: form.companyName || undefined },
                { onSuccess: (answer) => navigate(`/crm-vendas/contatos/${answer.contact.id}`) },
              );
            }}
          >
            <div className="crm-form-grid">
              <label className="crm-field">
                <span>Nome</span>
                <input
                  className="crm-input"
                  value={form.name}
                  autoFocus
                  onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
                />
              </label>
              <label className="crm-field">
                <span>Telefone</span>
                <input
                  className="crm-input"
                  value={form.phone}
                  onChange={(e) => setForm((c) => ({ ...c, phone: e.target.value }))}
                />
              </label>
              <label className="crm-field">
                <span>E-mail</span>
                <input
                  className="crm-input"
                  value={form.email}
                  onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))}
                />
              </label>
              <label className="crm-field">
                <span>Cargo</span>
                <input
                  className="crm-input"
                  value={form.jobTitle}
                  onChange={(e) => setForm((c) => ({ ...c, jobTitle: e.target.value }))}
                />
              </label>
              <label className="crm-field">
                <span>Empresa</span>
                <input
                  className="crm-input"
                  value={form.companyName}
                  onChange={(e) => setForm((c) => ({ ...c, companyName: e.target.value }))}
                />
              </label>
            </div>
            {create.error && (
              <p className="crm-error">
                {errorText(create.error, 'Não foi possível criar o contato.')}
              </p>
            )}
            <div className="crm-form-actions">
              <button type="button" className="crm-btn is-quiet" onClick={() => setCreating(false)}>
                Cancelar
              </button>
              <button
                type="submit"
                className="crm-btn is-primary"
                disabled={create.isPending || (!form.phone && !form.email)}
              >
                Salvar contato
              </button>
            </div>
          </form>
        )}
        {mode === 'list' && (
          <>
            <div className="crm-toolbar">
              <input
                className="crm-input crm-search"
                placeholder="Buscar por nome, e-mail, telefone ou empresa"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <span className="crm-muted">
                {contacts.data ? `${rows.length} contato(s)` : null}
                {!contacts.data && contacts.isError ? <Unavailable error={contacts.error} /> : null}
              </span>
            </div>
            {contacts.isError && (
              <LoadFailure
                what="os contatos"
                error={contacts.error}
                onRetry={() => void contacts.refetch()}
              />
            )}
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Telefone</th>
                  <th>E-mail</th>
                  <th>Empresa</th>
                  <th className="is-num">Negociações</th>
                </tr>
              </thead>
              <tbody>
                {contacts.isLoading && (
                  <tr>
                    <td colSpan={5} className="crm-muted">
                      Carregando…
                    </td>
                  </tr>
                )}
                {contacts.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="crm-muted">
                      Nenhum contato encontrado.
                    </td>
                  </tr>
                )}
                {rows.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <Link to={`/crm-vendas/contatos/${contact.id}`}>
                        {contact.name ?? 'Sem nome'}
                      </Link>
                      {contact.jobTitle ? <div className="crm-sub">{contact.jobTitle}</div> : null}
                    </td>
                    <td>{formatPhone(contact.phone)}</td>
                    <td>{contact.email ?? '—'}</td>
                    <td>
                      {contact.companyId ? (
                        <CompanyLink id={contact.companyId}>{contact.companyName}</CompanyLink>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="is-num">
                      {contact.openLeads}/{contact.leads}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {mode === 'duplicates' && (
          <>
            <p className="crm-sub">
              Pares com o mesmo nome. Escolha qual fica: o outro é juntado a ele e as negociações
              passam para o que fica.
            </p>
            {merge.error && (
              <p className="crm-error">{errorText(merge.error, 'Não foi possível mesclar.')}</p>
            )}
            {contacts.isLoading && <p className="crm-muted">Carregando…</p>}
            {contacts.isError && (
              <LoadFailure
                what="os contatos"
                error={contacts.error}
                onRetry={() => void contacts.refetch()}
              />
            )}
            {contacts.isSuccess && (contacts.data?.duplicates ?? []).length === 0 && (
              <p className="crm-muted">Nenhum duplicado encontrado.</p>
            )}
            {(contacts.data?.duplicates ?? []).map((pair) => (
              <div key={`${pair.a.id}-${pair.b.id}`} className="crm-pair">
                <DuplicateSide
                  contact={pair.a}
                  onKeep={() => merge.mutate({ fromId: pair.b.id, intoId: pair.a.id })}
                  busy={merge.isPending}
                />
                <span className="crm-muted">⇄</span>
                <DuplicateSide
                  contact={pair.b}
                  onKeep={() => merge.mutate({ fromId: pair.a.id, intoId: pair.b.id })}
                  busy={merge.isPending}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function DuplicateSide({
  contact,
  onKeep,
  busy,
}: {
  contact: CrmContact;
  onKeep: () => void;
  busy: boolean;
}) {
  return (
    <div className="crm-stack" style={{ gap: 4 }}>
      <Link to={`/crm-vendas/contatos/${contact.id}`}>
        <b>{contact.name ?? 'Sem nome'}</b>
      </Link>
      <span className="crm-sub">
        {formatPhone(contact.phone)} · {contact.email ?? '—'} ·{' '}
        {contact.companyName ?? 'sem empresa'} · {contact.leads} negociação(ões)
      </span>
      <button type="button" className="crm-btn is-small" disabled={busy} onClick={onKeep}>
        Manter este
      </button>
    </div>
  );
}

function ContactRecord({ id }: { id: string }) {
  const session = useSession();
  const canWrite = hasPermission(session.data, 'leads.write');
  const loaded = useContact(id);
  const update = useUpdateContact();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    jobTitle: '',
    companyName: '',
  });
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
              what="o contato"
              error={loaded.error}
              onRetry={() => void loaded.refetch()}
            />
          ) : (
            <span>Contato não encontrado.</span>
          )}
          <Link className="crm-btn" to="/crm-vendas/contatos">
            Voltar
          </Link>
        </div>
      </div>
    );
  const { contact, leads } = loaded.data;
  return (
    <div className="crm-page">
      <header className="crm-head">
        <Link className="crm-btn is-quiet is-small" to="/crm-vendas/contatos">
          ‹ Contatos
        </Link>
        <h1>{contact.name ?? 'Sem nome'}</h1>
        <span className="crm-head-spacer" />
        {canWrite && !editing && (
          <button
            type="button"
            className="crm-btn"
            onClick={() => {
              setForm({
                name: contact.name ?? '',
                phone: contact.phone ?? '',
                email: contact.email ?? '',
                jobTitle: contact.jobTitle ?? '',
                companyName: '',
              });
              setEditing(true);
            }}
          >
            Editar
          </button>
        )}
      </header>
      {/* A refresh failed: what was loaded stays on screen, with the reason above it. */}
      {loaded.isError && (
        <div style={{ padding: 'var(--space-2) var(--space-5)' }}>
          <LoadFailure
            what="o contato"
            error={loaded.error}
            onRetry={() => void loaded.refetch()}
          />
        </div>
      )}
      <div className="crm-page-scroll crm-two">
        <section className="crm-panel">
          <h2>Dados</h2>
          {!editing ? (
            <dl className="crm-kv">
              <dt>Telefone</dt>
              <dd>
                {contact.phone ? (
                  <span className="crm-call-number-inline">{formatPhone(contact.phone)}</span>
                ) : (
                  '—'
                )}
              </dd>
              <dt>E-mail</dt>
              <dd>
                {contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : '—'}
              </dd>
              <dt>Cargo</dt>
              <dd>{contact.jobTitle ?? '—'}</dd>
              <dt>Empresa</dt>
              <dd>
                {contact.companyId ? (
                  <CompanyLink id={contact.companyId}>{contact.companyName}</CompanyLink>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Desde</dt>
              <dd>{formatDate(contact.createdAt)}</dd>
            </dl>
          ) : (
            <form
              className="crm-record-form"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate(
                  { id: contact.id, ...form, companyName: form.companyName || undefined },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              <input
                className="crm-input"
                placeholder="Nome"
                value={form.name}
                onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
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
              <input
                className="crm-input"
                placeholder={
                  contact.companyName
                    ? `Empresa: ${contact.companyName} (digite para trocar)`
                    : 'Empresa'
                }
                value={form.companyName}
                onChange={(e) => setForm((c) => ({ ...c, companyName: e.target.value }))}
              />
              {update.error && (
                <span className="crm-error">
                  {errorText(update.error, 'Não foi possível salvar.')}
                </span>
              )}
              <div className="crm-quick-row">
                <button
                  type="button"
                  className="crm-btn is-quiet"
                  onClick={() => setEditing(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="crm-btn is-primary" disabled={update.isPending}>
                  Salvar
                </button>
              </div>
            </form>
          )}
        </section>
        <section className="crm-panel">
          <h2>Negociações</h2>
          <RelatedDeals leads={leads} />
        </section>
      </div>
    </div>
  );
}
