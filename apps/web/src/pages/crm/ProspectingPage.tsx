import {
  ICP_WEIGHT_KEYS,
  ICP_WEIGHT_LABELS,
  PROSPECT_ENRICHMENT_KEYS,
  PROSPECT_MANUAL_STATUSES,
  PROSPECT_STATUS_LABELS,
  PROSPECT_STATUSES,
  prospectingIcpSchema,
  prospectingQuotaSchema,
  prospectLeadSchema,
  type IcpWeights,
  type Prospect,
  type ProspectEnrichment,
  type ProspectEnrichmentKey,
  type ProspectingIcp,
  type ProspectingQuota,
  type ProspectingUsage,
  type ProspectQuery,
  type ProspectRef,
  type ProspectSearchInput,
  type ProspectSearchItem,
  type ProspectSearchResponse,
  type ProspectStatus,
} from '@wings/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, permissionScope, useSession } from '../../api/auth.js';
import { useStages } from '../../api/leads.js';
import {
  useClaimProspect,
  useEnrichProspect,
  useParseProspectQuery,
  usePlaceDetails,
  useProspectingSettings,
  useProspectingStatus,
  useProspectingUsage,
  useProspectLead,
  useProspectOwners,
  useProspects,
  useProspectSearch,
  useSaveIcp,
  useSaveQuota,
  useUpdateProspect,
} from '../../api/prospecting.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { StudioLayout, StudioToolGroup } from '../../components/StudioLayout.js';
import { Modal } from './CreateDealModal.js';
import { formatDate } from './format.js';
import { googleFailure, MapsLink, PlaceFacts, ratingText, webUrl } from './GooglePlacePanel.js';

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md): companies found live on
 * Google Maps, reserved by a seller, and taken to the Formatação funnel after
 * the first contact. Google's answers live in this screen's state only; what
 * the system keeps is the place_id and our own notes. The AI only turns the
 * seller's sentence into the form's fields, and fills them on a click.
 */

const NO_KEY = 'Chave do Google não configurada.';
const NO_AI = 'A IA não está configurada neste ambiente.';

interface SearchForm {
  segment: string;
  /** One place per line or comma separated; more than one is a sweep. */
  places: string;
  minRating: string;
  minReviews: string;
  requireWebsite: boolean;
  onlyOperational: boolean;
}

const EMPTY_FORM: SearchForm = {
  segment: '',
  places: '',
  minRating: '',
  minReviews: '',
  requireWebsite: false,
  onlyOperational: true,
};

/** The places of the form, each once (the API counts one call per place, so does the confirm). */
export const placesOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((place) => place.trim())
      .filter(Boolean),
  ),
];

const numberOf = (text: string): number | null => (text.trim() === '' ? null : Number(text));

const formOf = (query: ProspectQuery): SearchForm => ({
  segment: query.segmento,
  places: query.locais.join('\n'),
  minRating: query.nota_min?.toString() ?? '',
  minReviews: query.avaliacoes_min?.toString() ?? '',
  requireWebsite: query.exige_site,
  onlyOperational: true,
});

const usageOrDash = (usage: ProspectingUsage | undefined) =>
  usage
    ? {
        today: `${usage.today.used} de ${usage.today.limit}`,
        searches: `${usage.month.searches} de ${usage.month.searchLimit}`,
        details: `${usage.month.details} de ${usage.month.detailsLimit}`,
      }
    : { today: '—', searches: '—', details: '—' };

/** "12 ocultos: 5 pela lista de exclusão, …", so the list never reads as all Google had. */
export function hiddenLine(hidden: ProspectSearchResponse['hidden']): string | null {
  const parts: [number, string][] = [
    [hidden.excluded, 'pela lista de exclusão'],
    [hidden.filtered, 'pelos filtros'],
    [hidden.heldByOthers, 'reservados por outros vendedores'],
    [hidden.repeated, 'repetidos entre os locais'],
  ];
  const shown = parts.filter(([count]) => count > 0);
  const total = shown.reduce((sum, [count]) => sum + count, 0);
  if (total === 0) return null;
  return `${total} ocultos: ${shown.map(([count, why]) => `${count} ${why}`).join(', ')}`;
}

const TABS = [
  { key: 'search', label: 'Busca' },
  { key: 'prospects', label: 'Meus prospects' },
  { key: 'settings', label: 'Ajustes' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function ProspectingPage() {
  const { data: user } = useSession();
  const canManage = permissionScope(user, 'prospecting.use') === 'all';
  const canConfigure = hasPermission(user, 'prospecting.configure');
  const canQuota = hasPermission(user, 'prospecting.quota');
  const status = useProspectingStatus();
  const usage = useProspectingUsage();
  const [tab, setTab] = useState<TabKey>('search');
  const [form, setForm] = useState<SearchForm>(EMPTY_FORM);
  const tabs = TABS.filter((item) => item.key !== 'settings' || canConfigure || canQuota);
  const counts = usageOrDash(usage.data);

  return (
    <StudioLayout
      title="Prospecção"
      subtitle="Empresas no Google Maps, ao vivo · só o place_id fica guardado"
      conversation={
        <ProspectChat
          aiConfigured={status.data?.aiConfigured}
          onUse={(query) => {
            setForm(formOf(query));
            setTab('search');
          }}
        />
      }
      workspace={
        <>
          <div className="studio-tabs" role="tablist" aria-label="Prospecção">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`prospect-tab-${item.key}`}
                aria-selected={tab === item.key}
                aria-controls={`prospect-panel-${item.key}`}
                className={`studio-tab ${tab === item.key ? 'studio-tab-active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.key === 'prospects' && canManage ? 'Prospects' : item.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`prospect-panel-${tab}`}
            aria-labelledby={`prospect-tab-${tab}`}
            className="crm-stack"
          >
            {/* Kept mounted: the results cost calls to Google, so another tab must not drop them. */}
            <div hidden={tab !== 'search'}>
              <div className="crm-stack">
                <SearchTab
                  form={form}
                  setForm={setForm}
                  configured={status.data?.configured}
                  usage={usage.data}
                  canManage={canManage}
                />
              </div>
            </div>
            {tab === 'prospects' && <ProspectsTab canManage={canManage} />}
            {tab === 'settings' && <SettingsTab canConfigure={canConfigure} canQuota={canQuota} />}
          </div>
        </>
      }
      tools={
        <>
          <StudioToolGroup title="Uso do Google">
            {usage.isError && !usage.data ? (
              <LoadFailure what="o uso" error={usage.error} onRetry={() => void usage.refetch()} />
            ) : (
              <>
                <p>
                  Uso do mês: {counts.searches} buscas · {counts.details} fichas
                </p>
                <p>Hoje: {counts.today}</p>
              </>
            )}
            <p className="field-hint">
              Cada busca e cada ficha é uma chamada ao Google. A cota fica dentro do que o Google dá
              de graça.
            </p>
          </StudioToolGroup>
          <StudioToolGroup title="Chave do Google">
            {status.isError && !status.data ? (
              <LoadFailure
                what="o estado da chave"
                error={status.error}
                onRetry={() => void status.refetch()}
              />
            ) : status.data ? (
              <p>{status.data.configured ? 'Configurada no servidor.' : `— ${NO_KEY}`}</p>
            ) : (
              <p className="muted">Carregando…</p>
            )}
          </StudioToolGroup>
        </>
      }
    />
  );
}

// --- conversation ---------------------------------------------------------------

type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; query: ProspectQuery }
  | { role: 'assistant'; failure: string };

function ProspectChat({
  aiConfigured,
  onUse,
}: {
  aiConfigured: boolean | undefined;
  onUse: (query: ProspectQuery) => void;
}) {
  const parse = useParseProspectQuery();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const add = (message: ChatMessage) => setMessages((current) => [...current, message]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const sentence = text.trim();
    if (sentence.length < 3 || parse.isPending) return;
    add({ role: 'user', text: sentence });
    setText('');
    parse.mutate(sentence, {
      onSuccess: (query) => add({ role: 'assistant', query }),
      onError: (error) => add({ role: 'assistant', failure: googleFailure(error) }),
    });
  };

  return (
    <div className="agent-chat">
      <h2 className="agent-chat-title">Quem você procura?</h2>
      <p className="field-hint">
        A IA só transforma a sua frase nos filtros da busca. Nenhum dado do Google vai para a IA, e
        nada é buscado sem o seu clique.
      </p>
      <div className="agent-messages" role="log" aria-label="Mensagens">
        {messages.length === 0 && (
          <p className="muted agent-empty">
            Ex.: “hamburguerias em Icaraí e Santa Rosa, Niterói, nota 4,5 ou mais, com site”.
          </p>
        )}
        {/* Messages are only ever appended, so the position is a stable key. */}
        {messages.map((message, index) => (
          <div key={index} className={`agent-message agent-message-${message.role}`}>
            <span className="agent-author">{message.role === 'user' ? 'Você' : 'IA'}</span>
            {'text' in message && <p className="agent-text">{message.text}</p>}
            {'failure' in message && <p className="agent-text">— {message.failure}</p>}
            {'query' in message && (
              <>
                <dl className="crm-kv">
                  <dt>Segmento</dt>
                  <dd>{message.query.segmento}</dd>
                  <dt>Locais</dt>
                  <dd>{message.query.locais.join(', ') || '—'}</dd>
                  <dt>Nota mínima</dt>
                  <dd>{ratingText(message.query.nota_min)}</dd>
                  <dt>Avaliações</dt>
                  <dd>{message.query.avaliacoes_min ?? '—'}</dd>
                  <dt>Só com site</dt>
                  <dd>{message.query.exige_site ? 'Sim' : 'Não'}</dd>
                </dl>
                <button
                  type="button"
                  className="crm-btn is-small"
                  onClick={() => onUse(message.query)}
                >
                  Usar no formulário
                </button>
              </>
            )}
          </div>
        ))}
        {parse.isPending && <p className="muted agent-consulting">Lendo o pedido…</p>}
      </div>
      {aiConfigured === false ? (
        <p className="muted">— {NO_AI} O formulário ao lado funciona sem ela.</p>
      ) : (
        <form className="agent-form" onSubmit={send}>
          <label className="field-label" htmlFor="prospect-chat">
            Pedido
          </label>
          <textarea
            id="prospect-chat"
            className="control agent-input"
            rows={2}
            maxLength={500}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="agent-form-actions">
            <button
              type="submit"
              className="crm-btn is-primary"
              disabled={parse.isPending || text.trim().length < 3}
            >
              Enviar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// --- Busca ----------------------------------------------------------------------

interface Results {
  input: Partial<ProspectSearchInput>;
  answer: ProspectSearchResponse;
}

const TAKEN_OVER: readonly ProspectStatus[] = ['descartado', 'sem_interesse'];
const CLOSED: readonly ProspectStatus[] = ['virou_lead', 'nao_contatar'];

function SearchTab({
  form,
  setForm,
  configured,
  usage,
  canManage,
}: {
  form: SearchForm;
  setForm: (next: SearchForm) => void;
  configured: boolean | undefined;
  usage: ProspectingUsage | undefined;
  canManage: boolean;
}) {
  const search = useProspectSearch();
  const [results, setResults] = useState<Results | null>(null);
  const set = <K extends keyof SearchForm>(key: K, value: SearchForm[K]) =>
    setForm({ ...form, [key]: value });
  const places = placesOf(form.places);

  const run = (input: Partial<ProspectSearchInput>, more: boolean) =>
    search.mutate(input, {
      onSuccess: (answer) =>
        setResults((current) =>
          more && current
            ? {
                input,
                answer: {
                  ...answer,
                  items: [...current.answer.items, ...answer.items],
                  hidden: {
                    excluded: current.answer.hidden.excluded + answer.hidden.excluded,
                    filtered: current.answer.hidden.filtered + answer.hidden.filtered,
                    heldByOthers: current.answer.hidden.heldByOthers + answer.hidden.heldByOthers,
                    repeated: current.answer.hidden.repeated + answer.hidden.repeated,
                  },
                },
              }
            : { input, answer },
        ),
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (places.length > 1) {
      const counts = usageOrDash(usage);
      const ok = window.confirm(
        `A varredura vai gastar ${places.length} chamadas ao Google (uma por local). Hoje: ${counts.today} · Mês: ${counts.searches} buscas. Continuar?`,
      );
      if (!ok) return;
    }
    // A new search: the last answer goes, so a failure never sits over results of other filters.
    setResults(null);
    run(
      {
        segment: form.segment.trim(),
        places,
        minRating: numberOf(form.minRating),
        minReviews: numberOf(form.minReviews),
        requireWebsite: form.requireWebsite,
        onlyOperational: form.onlyOperational,
        ...(places.length > 1 ? { confirmCalls: places.length } : {}),
      },
      false,
    );
  };

  const patch = (placeId: string, change: Partial<ProspectSearchItem>) =>
    setResults(
      (current) =>
        current && {
          ...current,
          answer: {
            ...current.answer,
            items: current.answer.items.map((item) =>
              item.placeId === placeId ? { ...item, ...change } : item,
            ),
          },
        },
    );

  const blocked = configured === false ? NO_KEY : null;
  const answer = results?.answer;
  const hidden = answer ? hiddenLine(answer.hidden) : null;

  return (
    <>
      <form className="crm-panel" onSubmit={submit} aria-label="Busca">
        <div className="crm-form-grid">
          <label className="crm-field">
            <span>Segmento</span>
            <input
              className="crm-input"
              value={form.segment}
              maxLength={80}
              required
              placeholder="hamburgueria"
              onChange={(event) => set('segment', event.target.value)}
            />
          </label>
          <label className="crm-field">
            <span>Cidade ou bairros</span>
            <textarea
              className="crm-input"
              rows={2}
              value={form.places}
              required
              placeholder="Um por linha, ou separados por vírgula"
              onChange={(event) => set('places', event.target.value)}
            />
          </label>
          <label className="crm-field">
            <span>Nota mínima</span>
            <input
              className="crm-input"
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={form.minRating}
              onChange={(event) => set('minRating', event.target.value)}
            />
          </label>
          <label className="crm-field">
            <span>Avaliações mínimas</span>
            <input
              className="crm-input"
              type="number"
              min={0}
              step={1}
              value={form.minReviews}
              onChange={(event) => set('minReviews', event.target.value)}
            />
          </label>
          <label className="crm-checkbox">
            <input
              type="checkbox"
              checked={form.requireWebsite}
              onChange={(event) => set('requireWebsite', event.target.checked)}
            />{' '}
            Só com site
          </label>
          <label className="crm-checkbox">
            <input
              type="checkbox"
              checked={form.onlyOperational}
              onChange={(event) => set('onlyOperational', event.target.checked)}
            />{' '}
            Só em funcionamento
          </label>
        </div>
        <div className="crm-form-actions">
          {blocked && <span className="crm-error">— {blocked}</span>}
          {places.length > 1 && (
            <span className="crm-sub">Varredura: {places.length} chamadas, uma por local.</span>
          )}
          <button
            type="submit"
            className="crm-btn is-primary"
            disabled={configured !== true || search.isPending}
            title={blocked ?? undefined}
          >
            {search.isPending ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
      </form>

      {search.isError && (
        <p className="load-failure" role="alert">
          — {googleFailure(search.error)}
        </p>
      )}

      {answer && (
        <section className="crm-panel" aria-label="Resultados">
          <h2>
            Resultados do Google Maps
            <span className="crm-sub">
              {answer.items.length} empresas · {answer.callsSpent} chamadas nesta busca
            </span>
          </h2>
          {hidden && <p className="crm-sub">{hidden}</p>}
          {answer.items.length === 0 ? (
            <p className="crm-sub">Nenhuma empresa encontrada com esses filtros.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Contato</th>
                    <th className="is-num">Nota</th>
                    <th className="is-num">ICP</th>
                    <th>Etiquetas</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {answer.items.map((item) => (
                    <ResultRow
                      key={item.placeId}
                      item={item}
                      canManage={canManage}
                      onChange={(change) => patch(item.placeId, change)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="crm-sub">Dados: Google Maps, consultados agora e não guardados.</p>
          {answer.nextPageToken && (
            <div>
              <button
                type="button"
                className="crm-btn"
                disabled={search.isPending}
                title="Gasta mais 1 chamada ao Google"
                onClick={() =>
                  run(
                    {
                      ...results.input,
                      pageToken: answer.nextPageToken ?? undefined,
                      page: answer.page + 1,
                    },
                    true,
                  )
                }
              >
                Mais resultados
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

const prospectRefOf = (prospect: Prospect): ProspectRef => ({
  id: prospect.id,
  status: prospect.status,
  ownerEmployeeId: prospect.ownerEmployeeId,
  ownerName: prospect.ownerName,
  mine: prospect.mine,
});

function ResultRow({
  item,
  canManage,
  onChange,
}: {
  item: ProspectSearchItem;
  canManage: boolean;
  onChange: (change: Partial<ProspectSearchItem>) => void;
}) {
  const claim = useClaimProspect();
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');
  const [enrichment, setEnrichment] = useState<ProspectEnrichment>({});
  const [leadOpen, setLeadOpen] = useState(false);
  const prospect = item.prospect;
  const status = prospect?.status;
  const mine = prospect?.mine === true;
  const site = webUrl(item.website);
  const canReserve = !prospect || TAKEN_OVER.includes(prospect.status);
  const closed = status !== undefined && CLOSED.includes(status);
  const canDiscard = (!prospect || mine || canManage) && !closed && status !== 'descartado';
  const open = mine && !closed;

  const act = (action: 'reserve' | 'discard') =>
    claim.mutate(
      { placeId: item.placeId, action, reason: action === 'discard' ? reason : undefined },
      {
        onSuccess: (saved) => {
          setDiscarding(false);
          onChange({ prospect: prospectRefOf(saved) });
        },
      },
    );

  return (
    <>
      <tr>
        <td>
          <b>{item.name ?? '—'}</b>
          <div className="crm-sub">{item.address ?? '—'}</div>
          <div className="crm-sub">
            <MapsLink uri={item.mapsUri} />
          </div>
        </td>
        <td>
          {item.phone ?? '—'}
          <div className="crm-sub">
            {site ? (
              <a href={site} target="_blank" rel="noopener noreferrer nofollow">
                {site.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
              </a>
            ) : (
              'sem site'
            )}
          </div>
        </td>
        <td className="is-num">
          {ratingText(item.rating)}
          <div className="crm-sub">{item.reviews ?? '—'} avaliações</div>
        </td>
        <td className="is-num" title={item.icp.reasons.join('\n') || 'Nenhum critério contou'}>
          {item.icp.score}
        </td>
        <td>
          {item.tags.map((tag) => (
            <span key={`${tag.kind}-${tag.text}`} className="crm-badge">
              {tag.text}
            </span>
          ))}
          {item.leadId && (
            <div>
              <Link to={`/crm-vendas/negociacoes/${item.leadId}`}>Abrir negociação</Link>
            </div>
          )}
        </td>
        <td>
          <div className="crm-quick-row">
            {canReserve && (
              <button
                type="button"
                className="crm-btn is-small"
                disabled={claim.isPending}
                onClick={() => act('reserve')}
              >
                Reservar
              </button>
            )}
            {canDiscard && (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setDiscarding((v) => !v)}
              >
                Descartar
              </button>
            )}
            {mine && site && prospect && (
              <EnrichButton
                prospectId={prospect.id}
                website={site}
                onDone={(answer) => setEnrichment(answer.prospect.enrichment)}
              />
            )}
            {open && (
              <button type="button" className="crm-btn is-small" onClick={() => setLeadOpen(true)}>
                Criar lead
              </button>
            )}
          </div>
          {mine && <div className="crm-sub">Reservado por você</div>}
          {claim.isError && <div className="crm-error">— {googleFailure(claim.error)}</div>}
          {/* Inside the cell: a modal is a div, which a table body cannot hold. */}
          {leadOpen && prospect && (
            <LeadModal
              prospectId={prospect.id}
              enrichment={enrichment}
              onClose={() => setLeadOpen(false)}
              onCreated={(leadId) => {
                setLeadOpen(false);
                onChange({ leadId, prospect: { ...prospect, status: 'virou_lead' } });
              }}
            />
          )}
        </td>
      </tr>
      {(discarding || Object.keys(enrichment).length > 0) && (
        <tr>
          <td colSpan={6}>
            {discarding && (
              <form
                className="crm-quick-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  act('discard');
                }}
              >
                <label className="crm-field">
                  <span>Motivo do descarte</span>
                  <input
                    className="crm-input"
                    value={reason}
                    maxLength={300}
                    required
                    autoFocus
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="crm-btn is-small"
                  disabled={!reason.trim() || claim.isPending}
                >
                  Confirmar descarte
                </button>
              </form>
            )}
            <EnrichmentList enrichment={enrichment} />
          </td>
        </tr>
      )}
    </>
  );
}

// --- shared pieces ----------------------------------------------------------------

const ENRICHMENT_LABELS: Record<ProspectEnrichmentKey, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  whatsapp: 'WhatsApp do site',
  email: 'E-mail',
};

/** What the company's own site said, each value with where and when; shown as text, never a link. */
function EnrichmentList({ enrichment }: { enrichment: ProspectEnrichment }) {
  const found = PROSPECT_ENRICHMENT_KEYS.flatMap((key) => {
    const value = enrichment[key];
    return value ? [{ key, ...value }] : [];
  });
  if (found.length === 0) return null;
  return (
    <dl className="crm-kv">
      {found.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          <dt>{ENRICHMENT_LABELS[item.key]}</dt>
          <dd>
            {item.value}{' '}
            <span className="crm-sub">
              ({item.source}, {formatDate(item.at)})
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EnrichButton({
  prospectId,
  website,
  onDone,
}: {
  prospectId: string;
  website: string;
  onDone: (answer: { prospect: Prospect }) => void;
}) {
  const enrich = useEnrichProspect();
  const skipped = enrich.data?.skipped ?? [];
  return (
    <span>
      <button
        type="button"
        className="crm-btn is-small"
        disabled={enrich.isPending}
        title="Lê a página inicial e a de contato do site da empresa"
        onClick={() => enrich.mutate({ id: prospectId, website }, { onSuccess: onDone })}
      >
        {enrich.isPending ? 'Lendo o site…' : 'Enriquecer'}
      </button>
      {enrich.data && (
        <span className="crm-sub">
          {' '}
          {enrich.data.pagesRead} {enrich.data.pagesRead === 1 ? 'página lida' : 'páginas lidas'}
          {skipped.length > 0 && `; ${skipped.join('; ')}`}
        </span>
      )}
      {enrich.isError && <span className="crm-error"> — {googleFailure(enrich.error)}</span>}
    </span>
  );
}

/** Criar lead, after the first contact: what the company said, never what Google shows. */
function LeadModal({
  prospectId,
  enrichment,
  onClose,
  onCreated,
}: {
  prospectId: string;
  enrichment: ProspectEnrichment;
  onClose: () => void;
  onCreated: (leadId: string) => void;
}) {
  const create = useProspectLead();
  const stages = useStages('formatacao');
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    contactRole: '',
    phone: '',
    email: enrichment.email?.value ?? '',
    instagram: enrichment.instagram?.value ?? '',
    notes: '',
    stageId: '',
  });
  const [optIn, setOptIn] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const field = (key: keyof typeof form, label: string, extra: { wide?: boolean } = {}) => (
    <label className={`crm-field${extra.wide ? ' is-wide' : ''}`}>
      <span>{label}</span>
      <input
        className="crm-input"
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
      />
    </label>
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = prospectLeadSchema.safeParse({ ...form, whatsappOptIn: optIn ?? undefined });
    if (!parsed.success)
      return setProblem(parsed.error.issues[0]?.message ?? 'Confira o formulário.');
    setProblem(null);
    create.mutate(
      { id: prospectId, ...parsed.data },
      { onSuccess: (answer) => onCreated(answer.leadId) },
    );
  };

  return (
    <Modal title="Criar lead no funil Formatação" onClose={onClose}>
      <form className="crm-stack" onSubmit={submit}>
        <p className="crm-sub">
          Preencha com o que a empresa disse no primeiro contato. Nada do Google vai para o lead.
        </p>
        <div className="crm-form-grid">
          {field('companyName', 'Empresa')}
          {field('contactName', 'Contato')}
          {field('contactRole', 'Cargo')}
          {field('phone', 'Telefone')}
          {field('email', 'E-mail')}
          {field('instagram', 'Instagram')}
          <label className="crm-field">
            <span>Etapa</span>
            <select
              className="crm-select"
              value={form.stageId}
              onChange={(event) => setForm((c) => ({ ...c, stageId: event.target.value }))}
            >
              <option value="">Primeira etapa do funil</option>
              {(stages.data?.stages ?? [])
                .filter((stage) => stage.active)
                .map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
            </select>
          </label>
          <fieldset className="crm-field">
            <legend>Aceitou receber WhatsApp?</legend>
            <label className="crm-checkbox">
              <input
                type="radio"
                name="opt-in"
                checked={optIn === true}
                onChange={() => setOptIn(true)}
              />{' '}
              Sim
            </label>
            <label className="crm-checkbox">
              <input
                type="radio"
                name="opt-in"
                checked={optIn === false}
                onChange={() => setOptIn(false)}
              />{' '}
              Não
            </label>
          </fieldset>
          <label className="crm-field is-wide">
            <span>Observações</span>
            <textarea
              className="crm-input"
              rows={3}
              value={form.notes}
              onChange={(event) => setForm((c) => ({ ...c, notes: event.target.value }))}
            />
          </label>
        </div>
        {stages.isError && <LoadFailure what="as etapas" error={stages.error} />}
        {(problem || create.isError) && (
          <p className="crm-error" role="alert">
            {problem ?? googleFailure(create.error)}
          </p>
        )}
        <div className="crm-form-actions">
          <button type="button" className="crm-btn is-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="crm-btn is-primary" disabled={create.isPending}>
            {create.isPending ? 'Criando…' : 'Criar lead'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Meus prospects ----------------------------------------------------------------

function ProspectsTab({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<ProspectStatus | ''>('');
  const [owner, setOwner] = useState('');
  const prospects = useProspects({ status, owner });
  const owners = useProspectOwners(canManage);

  return (
    <>
      <div className="crm-filters">
        <label className="crm-field">
          <span>Situação</span>
          <select
            className="crm-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProspectStatus | '')}
          >
            <option value="">Todas</option>
            {PROSPECT_STATUSES.map((item) => (
              <option key={item} value={item}>
                {PROSPECT_STATUS_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <label className="crm-field">
            <span>Vendedor</span>
            <select
              className="crm-select"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              disabled={!owners.data}
            >
              <option value="">Todos</option>
              {(owners.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {canManage && owners.isError && (
        <LoadFailure
          what="os vendedores"
          error={owners.error}
          onRetry={() => void owners.refetch()}
        />
      )}
      {prospects.isLoading ? (
        <p className="muted">Carregando…</p>
      ) : prospects.isError && !prospects.data ? (
        <LoadFailure
          what="os prospects"
          error={prospects.error}
          onRetry={() => void prospects.refetch()}
        />
      ) : prospects.data?.length === 0 ? (
        <p className="crm-sub">Nenhum prospect salvo com esse filtro.</p>
      ) : (
        (prospects.data ?? []).map((prospect) => (
          <ProspectCard
            key={prospect.id}
            prospect={prospect}
            canManage={canManage}
            owners={owners.data}
          />
        ))
      )}
    </>
  );
}

function ProspectCard({
  prospect,
  canManage,
  owners,
}: {
  prospect: Prospect;
  canManage: boolean;
  owners: { id: string; name: string }[] | undefined;
}) {
  const update = useUpdateProspect();
  const ficha = usePlaceDetails('prospects');
  const [draft, setDraft] = useState({
    status: prospect.status,
    reason: prospect.reason ?? '',
    notes: prospect.notes ?? '',
    owner: prospect.ownerEmployeeId ?? '',
  });
  const [enrichment, setEnrichment] = useState(prospect.enrichment);
  const [leadOpen, setLeadOpen] = useState(false);
  const editable = (prospect.mine || canManage) && !CLOSED.includes(prospect.status);
  const place = ficha.data?.found ? ficha.data.place : null;
  const site = place ? webUrl(place.website) : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({
      id: prospect.id,
      ...(draft.status !== prospect.status &&
      (PROSPECT_MANUAL_STATUSES as readonly string[]).includes(draft.status)
        ? { status: draft.status as (typeof PROSPECT_MANUAL_STATUSES)[number] }
        : {}),
      reason: draft.reason,
      notes: draft.notes,
      ...(canManage && draft.owner && draft.owner !== prospect.ownerEmployeeId
        ? { ownerEmployeeId: draft.owner }
        : {}),
    });
  };

  return (
    <section className="crm-panel" aria-label={place?.name ?? 'Prospect'}>
      <h2>
        <span>
          {place?.name ?? 'Empresa salva'}{' '}
          <span className="crm-badge">{PROSPECT_STATUS_LABELS[prospect.status]}</span>
        </span>
        <span className="crm-sub">
          {prospect.ownerName ?? 'Sem dono'} · desde {formatDate(prospect.createdAt)} · atualizado{' '}
          {formatDate(prospect.updatedAt)}
        </span>
      </h2>
      {prospect.leadId && (
        <Link to={`/crm-vendas/negociacoes/${prospect.leadId}`}>Abrir negociação</Link>
      )}
      <EnrichmentList enrichment={enrichment} />
      {place && <PlaceFacts place={place} />}
      {ficha.data && !ficha.data.found && <p className="crm-sub">— {ficha.data.message}</p>}
      {ficha.isError && (
        <p className="crm-sub" role="alert">
          — {googleFailure(ficha.error)}
        </p>
      )}
      <div className="crm-quick-row">
        <button
          type="button"
          className="crm-btn is-small"
          disabled={ficha.isPending}
          title="Consulta o Google agora: gasta 1 ficha da cota do mês"
          onClick={() => ficha.mutate(prospect.id)}
        >
          {ficha.isPending ? 'Carregando…' : 'Abrir ficha (1 ficha)'}
        </button>
        {prospect.mine && site && (
          <EnrichButton
            prospectId={prospect.id}
            website={site}
            onDone={(answer) => setEnrichment(answer.prospect.enrichment)}
          />
        )}
        {prospect.mine && !CLOSED.includes(prospect.status) && (
          <button type="button" className="crm-btn is-small" onClick={() => setLeadOpen(true)}>
            Criar lead
          </button>
        )}
      </div>
      {editable ? (
        <form className="crm-form-grid" onSubmit={save}>
          <label className="crm-field">
            <span>Situação</span>
            <select
              className="crm-select"
              value={draft.status}
              onChange={(event) =>
                setDraft((c) => ({ ...c, status: event.target.value as ProspectStatus }))
              }
            >
              {!(PROSPECT_MANUAL_STATUSES as readonly string[]).includes(prospect.status) && (
                <option value={prospect.status} disabled>
                  {PROSPECT_STATUS_LABELS[prospect.status]}
                </option>
              )}
              {PROSPECT_MANUAL_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {PROSPECT_STATUS_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Motivo</span>
            <input
              className="crm-input"
              value={draft.reason}
              maxLength={300}
              onChange={(event) => setDraft((c) => ({ ...c, reason: event.target.value }))}
            />
          </label>
          {canManage && (
            <label className="crm-field">
              <span>Dono</span>
              <select
                className="crm-select"
                value={draft.owner}
                disabled={!owners}
                onChange={(event) => setDraft((c) => ({ ...c, owner: event.target.value }))}
              >
                {!draft.owner && <option value="">Sem dono</option>}
                {draft.owner && !owners?.some((item) => item.id === draft.owner) && (
                  <option value={draft.owner}>{prospect.ownerName ?? 'Dono atual'}</option>
                )}
                {(owners ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="crm-field is-wide">
            <span>Observações</span>
            <textarea
              className="crm-input"
              rows={2}
              maxLength={2000}
              value={draft.notes}
              onChange={(event) => setDraft((c) => ({ ...c, notes: event.target.value }))}
            />
          </label>
          <div className="crm-form-actions is-wide">
            {update.isError && <span className="crm-error">— {googleFailure(update.error)}</span>}
            {update.isSuccess && <span className="crm-sub">Salvo.</span>}
            <button type="submit" className="crm-btn is-primary" disabled={update.isPending}>
              Salvar
            </button>
          </div>
        </form>
      ) : (
        <dl className="crm-kv">
          <dt>Motivo</dt>
          <dd>{prospect.reason ?? '—'}</dd>
          <dt>Observações</dt>
          <dd>{prospect.notes ?? '—'}</dd>
        </dl>
      )}
      {leadOpen && (
        <LeadModal
          prospectId={prospect.id}
          enrichment={enrichment}
          onClose={() => setLeadOpen(false)}
          onCreated={() => setLeadOpen(false)}
        />
      )}
    </section>
  );
}

// --- Ajustes ----------------------------------------------------------------------

function SettingsTab({ canConfigure, canQuota }: { canConfigure: boolean; canQuota: boolean }) {
  const settings = useProspectingSettings();
  if (settings.isLoading) return <p className="muted">Carregando…</p>;
  if (!settings.data)
    return (
      <LoadFailure
        what="os ajustes"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  return (
    <>
      {canConfigure && <IcpForm key={settings.data.updatedAt} initial={settings.data.icp} />}
      {canQuota && <QuotaForm key={settings.data.updatedAt} initial={settings.data.quota} />}
    </>
  );
}

function SaveRow({
  problem,
  saving,
  saved,
}: {
  problem: string | null;
  saving: boolean;
  saved: boolean;
}): ReactNode {
  return (
    <div className="crm-form-actions">
      {problem && (
        <span className="crm-error" role="alert">
          — {problem}
        </span>
      )}
      {saved && !problem && <span className="crm-sub">Salvo.</span>}
      <button type="submit" className="crm-btn is-primary" disabled={saving}>
        Salvar
      </button>
    </div>
  );
}

function IcpForm({ initial }: { initial: ProspectingIcp }) {
  const save = useSaveIcp();
  const [weights, setWeights] = useState<Record<string, string>>(() =>
    Object.fromEntries(ICP_WEIGHT_KEYS.map((key) => [key, String(initial.weights[key])])),
  );
  const [excluded, setExcluded] = useState(initial.excludedNames.join('\n'));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = prospectingIcpSchema.safeParse({
      weights: Object.fromEntries(
        ICP_WEIGHT_KEYS.map((key) => [key, Number(weights[key])]),
      ) as IcpWeights,
      excludedNames: excluded
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    });
    if (!parsed.success)
      return setProblem(parsed.error.issues[0]?.message ?? 'Confira os valores.');
    setProblem(null);
    save.mutate(parsed.data, { onError: (error) => setProblem(googleFailure(error)) });
  };

  return (
    <form className="crm-panel" onSubmit={submit} aria-label="Nota ICP">
      <h2>Nota ICP</h2>
      <p className="crm-sub">Pontos de cada critério (0 a 10). A nota é calculada a cada busca.</p>
      <div className="crm-form-grid">
        {ICP_WEIGHT_KEYS.map((key) => (
          <label key={key} className="crm-field">
            <span>{ICP_WEIGHT_LABELS[key]}</span>
            <input
              className="crm-input"
              type="number"
              min={0}
              max={10}
              step={1}
              value={weights[key]}
              onChange={(event) => setWeights((c) => ({ ...c, [key]: event.target.value }))}
            />
          </label>
        ))}
        <label className="crm-field is-wide">
          <span>Lista de exclusão (redes já franqueadas, uma por linha)</span>
          <textarea
            className="crm-input"
            rows={6}
            value={excluded}
            onChange={(event) => setExcluded(event.target.value)}
          />
        </label>
      </div>
      <SaveRow problem={problem} saving={save.isPending} saved={save.isSuccess} />
    </form>
  );
}

const QUOTA_FIELDS: [keyof ProspectingQuota, string][] = [
  ['perUserDaily', 'Chamadas por vendedor por dia'],
  ['monthlySearches', 'Buscas no mês (todos)'],
  ['monthlyDetails', 'Fichas no mês (todos)'],
];

function QuotaForm({ initial }: { initial: ProspectingQuota }) {
  const save = useSaveQuota();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(QUOTA_FIELDS.map(([key]) => [key, String(initial[key])])),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = prospectingQuotaSchema.safeParse(
      Object.fromEntries(QUOTA_FIELDS.map(([key]) => [key, Number(values[key])])),
    );
    if (!parsed.success)
      return setProblem(parsed.error.issues[0]?.message ?? 'Confira os valores.');
    setProblem(null);
    save.mutate(parsed.data, { onError: (error) => setProblem(googleFailure(error)) });
  };

  return (
    <form className="crm-panel" onSubmit={submit} aria-label="Cota do Google">
      <h2>Cota do Google</h2>
      <p className="crm-sub">Acima de 1.000 chamadas de cada tipo no mês o Google cobra.</p>
      <div className="crm-form-grid">
        {QUOTA_FIELDS.map(([key, label]) => (
          <label key={key} className="crm-field">
            <span>{label}</span>
            <input
              className="crm-input"
              type="number"
              min={0}
              max={1000}
              step={1}
              value={values[key]}
              onChange={(event) => setValues((c) => ({ ...c, [key]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      <SaveRow problem={problem} saving={save.isPending} saved={save.isSuccess} />
    </form>
  );
}
