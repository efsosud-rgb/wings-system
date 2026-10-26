import { type CrmCompany } from '@wings/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  useCompanies,
  useCompany,
  useCompanyToClient,
  useCreateCompany,
  useMergeCompanies,
  useUpdateCompany,
} from '../../api/crm.js';
import { LoadFailure, Unavailable } from '../../components/LoadFailure.js';
import { RelatedDeals } from './ContactsPage.js';
import { formatDate, formatPhone } from './format.js';
import { useCreateFromQuery } from '../../components/useCreateFromQuery.js';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/** CRM Vendas → Empresas: the companies of the deals; a won one becomes a client in one click. */
export function CompaniesPage() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <CompanyRecord id={id} />;
  return <CompanyList />;
}

const FIELDS = [
  ['name', 'Nome'],
  ['cnpj', 'CNPJ'],
  ['phone', 'Telefone'],
  ['email', 'E-mail'],
  ['website', 'Site'],
  ['city', 'Cidade'],
  ['state', 'UF'],
  ['segment', 'Segmento'],
] as const;
type Form = Record<(typeof FIELDS)[number][0], string>;
const empty = (): Form => ({
  name: '',
  cnpj: '',
  phone: '',
  email: '',
  website: '',
  city: '',
  state: '',
  segment: '',
});

function CompanyForm({
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initial: Form;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (form: Form) => void;
}) {
  const [form, setForm] = useState(initial);
  return (
    <form
      className="crm-panel"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="crm-form-grid">
        {FIELDS.map(([key, label]) => (
          <label key={key} className={`crm-field${key === 'name' ? ' is-wide' : ''}`}>
            <span>{label}</span>
            <input
              className="crm-input"
              value={form[key]}
              maxLength={key === 'state' ? 2 : 200}
              onChange={(e) => setForm((c) => ({ ...c, [key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      {error ? <p className="crm-error">{errorText(error, 'Não foi possível salvar.')}</p> : null}
      <div className="crm-form-actions">
        <button type="button" className="crm-btn is-quiet" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="submit"
          className="crm-btn is-primary"
          disabled={busy || form.name.trim().length < 2}
        >
          Salvar
        </button>
      </div>
    </form>
  );
}

function CompanyList() {
  const session = useSession();
  const canWrite = hasPermission(session.data, 'leads.write');
  const canManage = hasPermission(session.data, 'crm.manage');
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'list' | 'duplicates'>('list');
  const [creating, setCreating] = useState(false);
  useCreateFromQuery(() => setCreating(true));
  const companies = useCompanies(q, mode === 'duplicates');
  const create = useCreateCompany();
  const merge = useMergeCompanies();
  const rows = companies.data?.companies ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Empresas</h1>
        <span className="crm-head-spacer" />
        {canManage && (
          <div className="crm-segment" role="group">
            <button
              type="button"
              className={mode === 'list' ? 'is-active' : ''}
              onClick={() => setMode('list')}
            >
              Todas
            </button>
            <button
              type="button"
              className={mode === 'duplicates' ? 'is-active' : ''}
              onClick={() => setMode('duplicates')}
            >
              Possíveis duplicadas
            </button>
          </div>
        )}
        {canWrite && (
          <button
            type="button"
            className="crm-btn is-primary"
            onClick={() => setCreating((open) => !open)}
          >
            + Empresa
          </button>
        )}
      </header>
      <div className="crm-page-scroll">
        {creating && (
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <CompanyForm
              initial={empty()}
              busy={create.isPending}
              error={create.error}
              onCancel={() => setCreating(false)}
              onSubmit={(form) =>
                create.mutate(form, {
                  onSuccess: (answer) => navigate(`/crm-vendas/empresas/${answer.company.id}`),
                })
              }
            />
          </div>
        )}
        {mode === 'list' && (
          <>
            <div className="crm-toolbar">
              <input
                className="crm-input crm-search"
                placeholder="Buscar por nome, CNPJ ou e-mail"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <span className="crm-muted">
                {companies.data ? `${rows.length} empresa(s)` : null}
                {!companies.data && companies.isError ? (
                  <Unavailable error={companies.error} />
                ) : null}
              </span>
            </div>
            {companies.isError && (
              <LoadFailure
                what="as empresas"
                error={companies.error}
                onRetry={() => void companies.refetch()}
              />
            )}
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>CNPJ</th>
                  <th>Cidade</th>
                  <th>Contatos</th>
                  <th className="is-num">Negociações</th>
                  <th>Cliente</th>
                </tr>
              </thead>
              <tbody>
                {companies.isLoading && (
                  <tr>
                    <td colSpan={6} className="crm-muted">
                      Carregando…
                    </td>
                  </tr>
                )}
                {companies.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="crm-muted">
                      Nenhuma empresa encontrada.
                    </td>
                  </tr>
                )}
                {rows.map((company) => (
                  <tr key={company.id}>
                    <td>
                      <Link to={`/crm-vendas/empresas/${company.id}`}>{company.name}</Link>
                      {company.segment ? <div className="crm-sub">{company.segment}</div> : null}
                    </td>
                    <td>{company.cnpj ?? '—'}</td>
                    <td>{[company.city, company.state].filter(Boolean).join('/') || '—'}</td>
                    <td className="is-num">{company.contacts}</td>
                    <td className="is-num">
                      {company.openLeads}/{company.leads}
                    </td>
                    <td>
                      {company.clientId ? (
                        <span className="crm-status is-won">Cliente</span>
                      ) : (
                        <span className="crm-muted">—</span>
                      )}
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
              Pares com nomes parecidos. Escolha qual fica: a outra é juntada a ela, com contatos e
              negociações.
            </p>
            {merge.error && (
              <p className="crm-error">{errorText(merge.error, 'Não foi possível mesclar.')}</p>
            )}
            {companies.isLoading && <p className="crm-muted">Carregando…</p>}
            {companies.isError && (
              <LoadFailure
                what="as empresas"
                error={companies.error}
                onRetry={() => void companies.refetch()}
              />
            )}
            {companies.isSuccess && (companies.data?.duplicates ?? []).length === 0 && (
              <p className="crm-muted">Nenhuma duplicada encontrada.</p>
            )}
            {(companies.data?.duplicates ?? []).map((pair) => (
              <div key={`${pair.a.id}-${pair.b.id}`} className="crm-pair">
                <Side
                  company={pair.a}
                  busy={merge.isPending}
                  onKeep={() => merge.mutate({ fromId: pair.b.id, intoId: pair.a.id })}
                />
                <span className="crm-muted">⇄</span>
                <Side
                  company={pair.b}
                  busy={merge.isPending}
                  onKeep={() => merge.mutate({ fromId: pair.a.id, intoId: pair.b.id })}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Side({
  company,
  busy,
  onKeep,
}: {
  company: CrmCompany;
  busy: boolean;
  onKeep: () => void;
}) {
  return (
    <div className="crm-stack" style={{ gap: 4 }}>
      <Link to={`/crm-vendas/empresas/${company.id}`}>
        <b>{company.name}</b>
      </Link>
      <span className="crm-sub">
        {company.cnpj ?? 'sem CNPJ'} · {company.contacts} contato(s) · {company.leads}{' '}
        negociação(ões)
      </span>
      <button type="button" className="crm-btn is-small" disabled={busy} onClick={onKeep}>
        Manter esta
      </button>
    </div>
  );
}

function CompanyRecord({ id }: { id: string }) {
  const session = useSession();
  const canWrite = hasPermission(session.data, 'leads.write');
  const canClients = hasPermission(session.data, 'clients.manage');
  const loaded = useCompany(id);
  const update = useUpdateCompany();
  const toClient = useCompanyToClient();
  const [editing, setEditing] = useState(false);
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
              what="a empresa"
              error={loaded.error}
              onRetry={() => void loaded.refetch()}
            />
          ) : (
            <span>Empresa não encontrada.</span>
          )}
          <Link className="crm-btn" to="/crm-vendas/empresas">
            Voltar
          </Link>
        </div>
      </div>
    );
  const { company, leads, contacts } = loaded.data;
  const won = leads.some((lead) => lead.won === true);
  return (
    <div className="crm-page">
      <header className="crm-head">
        <Link className="crm-btn is-quiet is-small" to="/crm-vendas/empresas">
          ‹ Empresas
        </Link>
        <h1>{company.name}</h1>
        {company.clientId && <span className="crm-status is-won">Cliente da Wings</span>}
        <span className="crm-head-spacer" />
        {canClients && !company.clientId && (
          <button
            type="button"
            className={`crm-btn${won ? ' is-primary' : ''}`}
            disabled={toClient.isPending}
            title={
              won
                ? 'Negociação ganha: cadastre a empresa como cliente'
                : 'Cadastra a empresa no módulo Formatação → Clientes'
            }
            onClick={() => toClient.mutate({ id: company.id, relationship: 'formatacao' })}
          >
            {toClient.isPending ? 'Cadastrando…' : 'Virar cliente'}
          </button>
        )}
        {company.clientId && (
          <Link className="crm-btn" to={`/formatacao/clientes/${company.clientId}`}>
            Abrir a ficha do cliente
          </Link>
        )}
        {hasPermission(session.data, 'leads.whatsapp') && (
          // The Central's "Nova conversa", searching the company's phone, or its deals by name.
          <Link
            className="crm-btn"
            to={`/crm-vendas/whatsapp?nova=${encodeURIComponent(company.phone ?? company.name)}`}
          >
            WhatsApp
          </Link>
        )}
        {canWrite && !editing && (
          <button type="button" className="crm-btn" onClick={() => setEditing(true)}>
            Editar
          </button>
        )}
      </header>
      <div className="crm-page-scroll crm-stack">
        {/* A refresh failed: what was loaded stays on screen, with the reason above it. */}
        {loaded.isError && (
          <LoadFailure
            what="a empresa"
            error={loaded.error}
            onRetry={() => void loaded.refetch()}
          />
        )}
        {toClient.error && (
          <p className="crm-error">
            {errorText(toClient.error, 'Não foi possível cadastrar o cliente.')}
          </p>
        )}
        {toClient.data?.created && (
          <p className="crm-ok">Cliente cadastrado com número, pasta no Drive e projeto.</p>
        )}
        <div className="crm-two">
          {editing ? (
            <CompanyForm
              initial={{
                name: company.name,
                cnpj: company.cnpj ?? '',
                phone: company.phone ?? '',
                email: company.email ?? '',
                website: company.website ?? '',
                city: company.city ?? '',
                state: company.state ?? '',
                segment: company.segment ?? '',
              }}
              busy={update.isPending}
              error={update.error}
              onCancel={() => setEditing(false)}
              onSubmit={(form) =>
                update.mutate({ id: company.id, ...form }, { onSuccess: () => setEditing(false) })
              }
            />
          ) : (
            <section className="crm-panel">
              <h2>Dados</h2>
              <dl className="crm-kv">
                <dt>CNPJ</dt>
                <dd>{company.cnpj ?? '—'}</dd>
                <dt>Telefone</dt>
                <dd>{formatPhone(company.phone)}</dd>
                <dt>E-mail</dt>
                <dd>{company.email ?? '—'}</dd>
                <dt>Site</dt>
                <dd>
                  {company.website ? (
                    <a
                      href={
                        company.website.startsWith('http')
                          ? company.website
                          : `https://${company.website}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {company.website}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>Cidade</dt>
                <dd>{[company.city, company.state].filter(Boolean).join('/') || '—'}</dd>
                <dt>Segmento</dt>
                <dd>{company.segment ?? '—'}</dd>
                <dt>Desde</dt>
                <dd>{formatDate(company.createdAt)}</dd>
              </dl>
            </section>
          )}
          <section className="crm-panel">
            <h2>Contatos</h2>
            {contacts.length === 0 && <p className="crm-muted">Nenhum contato ligado.</p>}
            {contacts.map((contact) => (
              <div key={contact.id}>
                <Link to={`/crm-vendas/contatos/${contact.id}`}>{contact.name ?? 'Sem nome'}</Link>
                <div className="crm-sub">
                  {contact.jobTitle ? `${contact.jobTitle} · ` : ''}
                  {formatPhone(contact.phone)}
                  {contact.email ? ` · ${contact.email}` : ''}
                </div>
              </div>
            ))}
          </section>
        </div>
        <section className="crm-panel">
          <h2>Negociações</h2>
          <RelatedDeals leads={leads} />
        </section>
      </div>
    </div>
  );
}
