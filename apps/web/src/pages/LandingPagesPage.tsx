import {
  LEAD_PIPELINES,
  LEAD_PIPELINE_LABELS,
  LEAD_SOURCE_RULE_KIND_LABELS,
  utmLinksFor,
  type LandingPageItem,
  type LeadPipeline,
  type LeadSourceRuleKind,
} from '@wings/shared';
import { useState } from 'react';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useClients } from '../api/clients.js';
import {
  useArchiveLandingPage,
  useCreateLandingPage,
  useCreateSourceRule,
  useDeleteLandingPage,
  useDealSources,
  useDeleteSourceRule,
  useLandingPages,
  useSourceRules,
  useUpdateLandingPage,
} from '../api/leads.js';
import { Alert, Button } from '../components/ui.js';
import { formatDateTime } from './LeadsPage.js';

/**
 * CRM Vendas → Landing pages. Every page a lead can arrive by, with its client
 * and funnel, how it performs (only numbers that have a source; "—" and why
 * otherwise), a generator that makes a new page's address, rule and UTM
 * links, and archive / delete. The page itself is still published in RD
 * Station until the landing-page agent phase.
 */

const META_KINDS: LeadSourceRuleKind[] = ['meta_form', 'meta_campaign'];

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function UtmLinks({ url }: { url: string }) {
  const [campaign, setCampaign] = useState('');
  const [content, setContent] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const links = campaign.trim() ? utmLinksFor(url, { campaign, content }) : [];
  return (
    <div className="block">
      <div className="filters">
        <label className="field">
          <span className="field-label">Campanha</span>
          <input
            className="control"
            value={campaign}
            placeholder="Ex.: Expansão Out26"
            onChange={(event) => setCampaign(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Conteúdo (opcional)</span>
          <input
            className="control"
            value={content}
            placeholder="Ex.: video-1"
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
      </div>
      {links.length === 0 ? (
        <p className="muted">Informe a campanha para gerar um link por canal.</p>
      ) : (
        <ul className="lead-links">
          {links.map((link) => (
            <li key={link.key}>
              <strong>{link.label}</strong> <span className="mono lead-wrap">{link.url}</span>{' '}
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard?.writeText(link.url).then(() => setCopied(link.key))
                }
              >
                {copied === link.key ? 'Copiado' : 'Copiar'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewPage({ onCreated }: { onCreated: (page: LandingPageItem) => void }) {
  const clients = useClients();
  const create = useCreateLandingPage();
  const [clientId, setClientId] = useState('');
  const [pipeline, setPipeline] = useState<LeadPipeline>('expansao');
  const [slug, setSlug] = useState('');
  return (
    <section className="block">
      <h2>Nova página</h2>
      <p className="muted">
        Escolha o cliente e o funil: o sistema cria o endereço (a partir do nome do cliente),
        registra a regra de origem e gera os links com UTM. A página em si continua sendo publicada
        no RD Station com este mesmo endereço.
      </p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { clientId, pipeline, slug: slug.trim() || undefined },
            {
              onSuccess: (answer) => {
                setSlug('');
                onCreated(answer.page);
              },
            },
          );
        }}
      >
        <label className="field">
          <span className="field-label">Cliente da página</span>
          <select
            className="control"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">Escolha</option>
            {(clients.data?.clients ?? [])
              .filter((client) => client.active)
              .map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Funil da página</span>
          <select
            className="control"
            value={pipeline}
            onChange={(event) => setPipeline(event.target.value as LeadPipeline)}
          >
            {LEAD_PIPELINES.map((item) => (
              <option key={item} value={item}>
                {LEAD_PIPELINE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Endereço (opcional)</span>
          <input
            className="control"
            value={slug}
            placeholder="gerado pelo nome do cliente"
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={create.isPending || !clientId}>
          Criar endereço e regra
        </Button>
      </form>
      {create.error && (
        <Alert kind="error">{errorText(create.error, 'Não foi possível criar a página.')}</Alert>
      )}
    </section>
  );
}

function Performance({ page }: { page: LandingPageItem }) {
  const { performance } = page;
  return (
    <>
      <td title={performance.visitsReason ?? performance.visitsSource ?? undefined}>
        {performance.visits ?? '—'}
      </td>
      <td title={performance.conversionsReason ?? performance.conversionsSource ?? undefined}>
        {performance.conversions ?? '—'}
        {performance.conversionsSince && performance.conversions !== null && (
          <div className="cell-sub">
            desde {formatDateTime(performance.conversionsSince).split(' ')[0]}
          </div>
        )}
      </td>
      <td title={performance.rate === null ? 'Sem visitas com fonte, não há taxa.' : undefined}>
        {performance.rate === null ? '—' : `${(performance.rate * 100).toFixed(1)}%`}
      </td>
    </>
  );
}

/** The public address of a page's own form (T5): on this same site, `/lp/<slug>`. */
export const siteFormPath = (slug: string) => `/lp/${slug}`;

/**
 * A page's own form on/off and its "Origem": the RD CRM deal source the
 * intake gives the deals it makes from this page's NEW conversions. Deals
 * that already exist in RD are never changed.
 */
function PageSettings({ page, onDone }: { page: LandingPageItem; onDone: () => void }) {
  const update = useUpdateLandingPage();
  const sources = useDealSources(true);
  const [siteForm, setSiteForm] = useState(page.siteFormEnabled);
  const [dealSource, setDealSource] = useState(page.dealSource ?? '');
  const listId = `deal-sources-${page.id}`;
  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate(
          { id: page.id, siteFormEnabled: siteForm, dealSource: dealSource.trim() || null },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="field field-inline">
        <input
          type="checkbox"
          checked={siteForm}
          onChange={(event) => setSiteForm(event.target.checked)}
        />
        <span>Formulário próprio do Wings System</span>
      </label>
      <label className="field">
        <span className="field-label">Origem no RD CRM (só negócios novos)</span>
        <input
          className="control"
          list={listId}
          value={dealSource}
          maxLength={120}
          placeholder="Padrão: Referência | domínio da página, ou Contato pelo Site"
          onChange={(event) => setDealSource(event.target.value)}
        />
        <datalist id={listId}>
          {(sources.data?.sources ?? []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {sources.data?.sources === null && (
          <span className="field-hint">{sources.data.reason} Digite o nome exato da origem.</span>
        )}
        {sources.data?.sources &&
          dealSource.trim() &&
          !sources.data.sources.includes(dealSource.trim()) && (
            <span className="field-hint">
              O RD não tem uma origem com esse nome: os negócios novos ficam com a origem padrão.
            </span>
          )}
      </label>
      <Button type="submit" disabled={update.isPending}>
        Salvar
      </Button>
      {update.error && (
        <Alert kind="error">{errorText(update.error, 'Não foi possível salvar.')}</Alert>
      )}
    </form>
  );
}

function PageRow({ page, canManage }: { page: LandingPageItem; canManage: boolean }) {
  const archive = useArchiveLandingPage();
  const remove = useDeleteLandingPage();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const deletable = page.leads === 0 && (page.performance.conversions ?? 0) === 0;
  return (
    <>
      <tr>
        <td>
          <div className="mono">{page.pattern}</div>
          {page.url && (
            <a
              className="cell-sub lead-wrap"
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {page.url}
            </a>
          )}
          {page.siteFormEnabled && (
            <a
              className="cell-sub"
              href={siteFormPath(page.pattern)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Formulário próprio: {siteFormPath(page.pattern)}
            </a>
          )}
          {page.dealSource && <div className="cell-sub">Origem no RD: {page.dealSource}</div>}
        </td>
        <td>{page.clientName ?? (page.brand ? `${page.brand} (marca sem cadastro)` : '—')}</td>
        <td>{page.pipeline ? LEAD_PIPELINE_LABELS[page.pipeline] : '—'}</td>
        <td>{page.leads}</td>
        <Performance page={page} />
        <td>
          {page.active ? (
            <span className="status status-active">Ativa</span>
          ) : (
            <span className="status status-inactive">
              Arquivada
              {page.archivedAt ? ` em ${formatDateTime(page.archivedAt).split(' ')[0]}` : ''}
            </span>
          )}
        </td>
        <td>
          {page.url && (
            <Button type="button" variant="ghost" onClick={() => setOpen((value) => !value)}>
              {open ? 'Fechar links' : 'Links com UTM'}
            </Button>
          )}
          {canManage && (
            <>
              <Button type="button" variant="ghost" onClick={() => setSettings((value) => !value)}>
                {settings ? 'Fechar' : 'Formulário e origem'}
              </Button>
              <Button
                type="button"
                variant={page.active ? 'primary' : 'ghost'}
                disabled={archive.isPending}
                onClick={() => archive.mutate({ id: page.id, archive: page.active })}
              >
                {page.active ? 'Arquivar' : 'Reativar'}
              </Button>
              {deletable && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirming((value) => !value)}
                >
                  Excluir de vez
                </Button>
              )}
            </>
          )}
        </td>
      </tr>
      {settings && (
        <tr>
          <td colSpan={9}>
            <PageSettings page={page} onDone={() => setSettings(false)} />
          </td>
        </tr>
      )}
      {open && page.url && (
        <tr>
          <td colSpan={9}>
            <UtmLinks url={page.url} />
          </td>
        </tr>
      )}
      {confirming && (
        <tr>
          <td colSpan={9}>
            <form
              className="filters"
              onSubmit={(event) => {
                event.preventDefault();
                remove.mutate({ id: page.id, confirm: typed });
              }}
            >
              <label className="field">
                <span className="field-label">
                  Excluir de vez não tem volta. Digite <span className="mono">{page.pattern}</span>{' '}
                  para confirmar
                </span>
                <input
                  className="control"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={typed !== page.pattern || remove.isPending}>
                Confirmar exclusão
              </Button>
            </form>
            {remove.error && (
              <Alert kind="error">{errorText(remove.error, 'Não foi possível excluir.')}</Alert>
            )}
          </td>
        </tr>
      )}
      {archive.error && (
        <tr>
          <td colSpan={9}>
            <Alert kind="error">{errorText(archive.error, 'Não foi possível arquivar.')}</Alert>
          </td>
        </tr>
      )}
    </>
  );
}

function MetaRules() {
  const clients = useClients();
  const rules = useSourceRules();
  const create = useCreateSourceRule();
  const remove = useDeleteSourceRule();
  const [kind, setKind] = useState<LeadSourceRuleKind>('meta_form');
  const [pattern, setPattern] = useState('');
  const [clientId, setClientId] = useState('');
  const [pipeline, setPipeline] = useState<LeadPipeline | ''>('');
  const list = (rules.data?.rules ?? []).filter((rule) => META_KINDS.includes(rule.kind));
  return (
    <section className="block">
      <h2>Outras origens (Meta Lead Ads)</h2>
      <p className="muted">
        Formulário ou campanha do Meta → cliente e funil. Um lead sem regra fica na Wings, marcado
        "sem regra".
      </p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { kind, pattern, clientId, ...(pipeline ? { pipeline } : {}) },
            { onSuccess: () => setPattern('') },
          );
        }}
      >
        <label className="field">
          <span className="field-label">Tipo</span>
          <select
            className="control"
            value={kind}
            onChange={(event) => setKind(event.target.value as LeadSourceRuleKind)}
          >
            {META_KINDS.map((item) => (
              <option key={item} value={item}>
                {LEAD_SOURCE_RULE_KIND_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Id</span>
          <input
            className="control"
            value={pattern}
            placeholder="id numérico"
            onChange={(event) => setPattern(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Cliente da regra</span>
          <select
            className="control"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">Escolha</option>
            {(clients.data?.clients ?? [])
              .filter((client) => client.active)
              .map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Funil da regra</span>
          <select
            className="control"
            value={pipeline}
            onChange={(event) => setPipeline(event.target.value as LeadPipeline | '')}
          >
            <option value="">Não informado</option>
            {LEAD_PIPELINES.map((item) => (
              <option key={item} value={item}>
                {LEAD_PIPELINE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={create.isPending || pattern.trim().length < 2 || !clientId}>
          Adicionar regra
        </Button>
      </form>
      {create.error && (
        <Alert kind="error">{errorText(create.error, 'Não foi possível salvar a regra.')}</Alert>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Id</th>
            <th>Cliente</th>
            <th>Funil</th>
            <th>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nenhuma regra do Meta ainda.
              </td>
            </tr>
          )}
          {list.map((rule) => (
            <tr key={rule.id}>
              <td>{LEAD_SOURCE_RULE_KIND_LABELS[rule.kind].split(' (')[0]}</td>
              <td className="mono">{rule.pattern}</td>
              <td>{rule.clientName ?? rule.brand ?? '—'}</td>
              <td>{rule.pipeline ? LEAD_PIPELINE_LABELS[rule.pipeline] : '—'}</td>
              <td>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(rule.id)}
                >
                  Remover
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function LandingPagesPage() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'clients.manage');
  const pages = useLandingPages();
  const [pipeline, setPipeline] = useState<LeadPipeline | ''>('');
  const [client, setClient] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [created, setCreated] = useState<LandingPageItem | null>(null);
  const all = pages.data?.pages ?? [];
  const clientNames = [...new Set(all.map((page) => page.clientName ?? page.brand ?? '—'))].sort(
    (a, b) => a.localeCompare(b, 'pt-BR'),
  );
  const list = all.filter(
    (page) =>
      (showArchived || page.active) &&
      (!pipeline || page.pipeline === pipeline) &&
      (!client || (page.clientName ?? page.brand ?? '—') === client),
  );

  return (
    <>
      <header className="page-header">
        <h1>Landing pages</h1>
        <p>
          As páginas por onde os leads chegam, de qual cliente e de qual funil cada uma é, e como
          cada uma está indo. Só aparece número com fonte; sem fonte, "—" e o motivo (passe o
          mouse).
        </p>
      </header>

      {canManage && <NewPage onCreated={setCreated} />}
      {created?.url && (
        <section className="block">
          <h2>Links da página {created.pattern}</h2>
          <UtmLinks url={created.url} />
        </section>
      )}

      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span className="field-label">Cliente</span>
          <select
            className="control"
            value={client}
            onChange={(event) => setClient(event.target.value)}
          >
            <option value="">Todos</option>
            {clientNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Funil</span>
          <select
            className="control"
            value={pipeline}
            onChange={(event) => setPipeline(event.target.value as LeadPipeline | '')}
          >
            <option value="">Todos</option>
            {LEAD_PIPELINES.map((item) => (
              <option key={item} value={item}>
                {LEAD_PIPELINE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          <span>Mostrar arquivadas</span>
        </label>
      </form>

      {pages.isError && <Alert kind="error">Não foi possível carregar as páginas.</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Página</th>
              <th>Cliente</th>
              <th>Funil</th>
              <th title="Leads do Funil que chegaram por esta página">Leads</th>
              <th>Visitas</th>
              <th>Conversões</th>
              <th>Taxa</th>
              <th>Situação</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pages.isLoading && (
              <tr>
                <td colSpan={9} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!pages.isLoading && list.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  Nenhuma página com esses filtros.
                </td>
              </tr>
            )}
            {list.map((page) => (
              <PageRow key={page.id} page={page} canManage={canManage} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Conversões: RD Marketing, contadas pela entrada automática desde a data indicada. Visitas e
        taxa ficam "—" até haver uma fonte de visitas por página (GA4 ainda não conectado).
      </p>

      {canManage && <MetaRules />}
    </>
  );
}
