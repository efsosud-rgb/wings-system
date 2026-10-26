import {
  AD_COPY_OBJECTIVE_LABEL,
  AD_COPY_OBJECTIVES,
  AD_COPY_PLATFORM_LABEL,
  AD_COPY_PLATFORMS,
  AD_PLATFORM_LABEL,
  AUDIT_CHECK_INFO,
  AUDIT_LEVEL_LABEL,
  AUDIT_STATUS_LABEL,
  CALL_TO_ACTION_LABEL,
  DASHBOARD_WINDOWS,
  type AdCopyDraft,
  type AdCopyObjective,
  type AdCopyPlatform,
  type AuditFinding,
  type AuditScope,
  type AuditStatus,
  type DashboardWindow,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useAuditRun,
  useAuditRuns,
  useCopyDrafts,
  useFindingAction,
  useGenerateCopy,
  useIntelligenceOverview,
  useRunAudit,
} from '../api/ads-intelligence.js';
import { hasPermission, useSession } from '../api/auth.js';
import { formatDateTime, formatInt, formatMoney } from '../components/dashboard/format.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { PageHeader } from '../components/PageHeader.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';
import { failureReason } from '../lib/failure.js';

/**
 * Marketing → Wings Ads Intelligence (docs/ads/intelligence.md).
 *
 * Three views over what the system already has: the overview (connections,
 * approvals, operations, alerts, the Conversions API), the audit with its
 * prioritised findings, and the AI ad packages. Nothing here reaches an ad
 * platform: "Criar pedido" makes a request that waits in Aprovações, and an
 * ad package is text to read, never a publication. Without data the screen
 * says "—" and why; without a connection it says "conexão pendente".
 */

const TABS = [
  { key: 'visao-geral', label: 'Visão geral' },
  { key: 'auditoria', label: 'Auditoria' },
  { key: 'anuncios-ia', label: 'Anúncios com IA' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const APPROVALS = '/marketing/trafego-pago-wings/aprovacoes';

const STATUS_CLASS: Record<AuditStatus, string> = {
  fail: 'state-bad',
  warn: 'state-attention',
  pass: 'state-good',
  unknown: 'state-unknown',
  not_applicable: 'state-unknown',
};

function StatePill({ status }: { status: AuditStatus }) {
  return <span className={`state-pill ${STATUS_CLASS[status]}`}>{AUDIT_STATUS_LABEL[status]}</span>;
}

export function AdsIntelligencePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('aba');
  const tab: TabKey = TABS.some((item) => item.key === raw) ? (raw as TabKey) : 'visao-geral';
  const { data: user } = useSession();
  const canRequest = hasPermission(user, 'ads.request');

  return (
    <>
      <PageHeader
        title="Wings Ads Intelligence"
        subtitle="Auditoria, recomendações e anúncios com IA · toda alteração passa por aprovação humana"
        tabs={TABS.map((item) => ({
          label: item.label,
          active: tab === item.key,
          onClick: () => setParams({ aba: item.key }),
        }))}
      />
      {tab === 'visao-geral' && <OverviewView />}
      {tab === 'auditoria' && <AuditView canRequest={canRequest} />}
      {tab === 'anuncios-ia' && <CopyView canRequest={canRequest} />}
    </>
  );
}

// --- overview -------------------------------------------------------------------

function OverviewView() {
  const query = useIntelligenceOverview();
  if (query.isLoading) return <p className="muted">Carregando…</p>;
  if (query.isError || !query.data) {
    return (
      <LoadFailure what="a visão geral" error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  const data = query.data;
  const capi = data.conversionsApi;
  return (
    <div className="intel-stack">
      <section className="cockpit-kpis" aria-label="Situação">
        <Link to={APPROVALS} className="kpi">
          <span className="kpi-label">Aprovações pendentes</span>
          <span className="kpi-value">{formatInt(data.pendingApprovals)}</span>
        </Link>
        <div className="kpi">
          <span className="kpi-label">Resultado desconhecido</span>
          <span className="kpi-value">{formatInt(data.unknownExecutions)}</span>
        </div>
        <Link to="/dashboard/marketing?aba=cockpit" className="kpi">
          <span className="kpi-label">Alertas abertos (críticos)</span>
          <span className="kpi-value">
            {formatInt(data.openAlerts.total)} ({formatInt(data.openAlerts.critical)})
          </span>
        </Link>
        <div className="kpi">
          <span className="kpi-label">Última ingestão</span>
          <span className="kpi-value" style={{ fontSize: 16 }}>
            {data.lastIngestAt ? formatDateTime(data.lastIngestAt) : '— nunca registrada'}
          </span>
        </div>
      </section>

      {data.ingestFailures.length > 0 && (
        <Alert kind="warning">
          A última ingestão falhou em:{' '}
          {data.ingestFailures.map((item) => `${item.step} (${item.platform})`).join('; ')}. Os
          números podem estar desatualizados.
        </Alert>
      )}

      <section className="card">
        <h2>Contas conectadas</h2>
        <ul className="intel-list">
          {(['meta', 'google'] as const).map((platform) => (
            <li key={platform}>
              <strong>{AD_PLATFORM_LABEL[platform]}:</strong>{' '}
              {data.credentials[platform] ? 'credenciais configuradas' : 'conexão pendente'}
            </li>
          ))}
        </ul>
        {data.accounts.length === 0 ? (
          <p className="muted">
            — Nenhuma conta espelhada: conecte em Administração → Integrações.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Conta</th>
                  <th>Plataforma</th>
                  <th>Última leitura</th>
                  <th>Trava</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {account.name} <span className="muted">{account.externalId}</span>
                    </td>
                    <td>{AD_PLATFORM_LABEL[account.platform]}</td>
                    <td>
                      {account.lastSyncedAt ? formatDateTime(account.lastSyncedAt) : '— nunca'}
                    </td>
                    <td>{account.killSwitchEngaged ? 'Acionada' : 'Livre'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>API de Conversões da Meta</h2>
        <p>
          <span className={`state-pill ${capi.enabled ? 'state-good' : 'state-bad'}`}>
            {capi.enabled ? 'Ligada' : 'Desligada'}
          </span>{' '}
          Pixel {capi.pixelId}
        </p>
        <p className="muted">
          Últimos 7 dias: {formatInt(capi.last7Days.sent)} enviado(s),{' '}
          {formatInt(capi.last7Days.skipped)} ignorado(s), {formatInt(capi.last7Days.failed)} com
          falha, {formatInt(capi.last7Days.pending)} na fila.
          {capi.lastSentAt && ` Último envio: ${formatDateTime(capi.lastSentAt)}.`}
          {capi.lastError && ` Último erro: ${capi.lastError}.`}
        </p>
        {!capi.enabled && (
          <p className="field-hint">
            Desligada por padrão. Só o Eric liga, seguindo o passo a passo em
            docs/ads/conversions-api.md (token do pixel, base legal e teste antes do envio real).
          </p>
        )}
      </section>

      <section className="card">
        <h2>Histórico de operações</h2>
        {data.operations.length === 0 ? (
          <p className="muted">Nenhum pedido de alteração registrado.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Pedido</th>
                  <th>Campanha</th>
                  <th>Quem pediu</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {data.operations.map((op) => (
                  <tr key={op.id}>
                    <td>{formatDateTime(op.createdAt)}</td>
                    <td>
                      {op.kind}
                      {op.suggestedByAgent && <span className="tag tag-agent">sugerido</span>}
                    </td>
                    <td>{op.campaignName ?? '—'}</td>
                    <td>{op.requestedByName ?? '—'}</td>
                    <td>
                      {op.approvalId ? (
                        <Link to={`${APPROVALS}/${op.approvalId}`}>{op.status}</Link>
                      ) : (
                        op.status
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="muted">
        Desempenho por campanha, criativo e público fica no{' '}
        <Link to="/dashboard/marketing">Dashboard de Marketing</Link>; os insights semanais da IA,
        na aba <Link to="/dashboard/marketing?aba=insights">Insights e sugestões</Link>.
      </p>
    </div>
  );
}

// --- audit ----------------------------------------------------------------------

function AuditView({ canRequest }: { canRequest: boolean }) {
  const runs = useAuditRuns();
  const run = useRunAudit();
  const [scope, setScope] = useState<AuditScope>('all');
  const [days, setDays] = useState<DashboardWindow>(14);
  const [selected, setSelected] = useState<string | null>(null);
  const runId = selected ?? run.data?.run.id ?? runs.data?.runs[0]?.id ?? null;
  const detail = useAuditRun(runId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate({ scope, days }, { onSuccess: (result) => setSelected(result.run.id) });
  };

  return (
    <div className="intel-stack">
      <form className="filters-row" onSubmit={submit} aria-label="Nova auditoria">
        <Select
          aria-label="Canal"
          value={scope}
          onChange={(event) => setScope(event.target.value as AuditScope)}
        >
          <option value="all">Todos os canais</option>
          <option value="meta">Meta Ads</option>
          <option value="google">Google Ads</option>
        </Select>
        <Select
          aria-label="Período"
          value={days}
          onChange={(event) => setDays(Number(event.target.value) as DashboardWindow)}
        >
          {DASHBOARD_WINDOWS.map((value) => (
            <option key={value} value={value}>
              Últimos {value} dias
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={run.isPending}>
          {run.isPending ? 'Auditando…' : 'Rodar auditoria'}
        </Button>
        {(runs.data?.runs.length ?? 0) > 0 && (
          <Select
            aria-label="Auditorias anteriores"
            value={runId ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            {runs.data?.runs.map((item) => (
              <option key={item.id} value={item.id}>
                {formatDateTime(item.createdAt)} · {item.scope === 'all' ? 'todos' : item.scope} ·{' '}
                {item.days} dias
              </option>
            ))}
          </Select>
        )}
      </form>
      <p className="field-hint">
        Lê só o que a ingestão já espelhou: não chama a Meta nem o Google e não gasta nada.
      </p>
      {run.isError && <Alert kind="error">Auditoria não rodou: {failureReason(run.error)}.</Alert>}
      {runs.isError && (
        <LoadFailure what="as auditorias" error={runs.error} onRetry={() => void runs.refetch()} />
      )}
      {runId === null && !runs.isLoading && !runs.isError && (
        <p className="muted">Nenhuma auditoria ainda. Rode a primeira acima.</p>
      )}
      {detail.isError && (
        <LoadFailure
          what="a auditoria"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      )}
      {detail.data && <AuditDetail detail={detail.data} canRequest={canRequest} />}
    </div>
  );
}

function AuditDetail({
  detail,
  canRequest,
}: {
  detail: NonNullable<ReturnType<typeof useAuditRun>['data']>;
  canRequest: boolean;
}) {
  const [onlyProblems, setOnlyProblems] = useState(true);
  const counts = detail.run.counts;
  const findings = onlyProblems
    ? detail.findings.filter(
        (finding) => finding.status !== 'pass' && finding.status !== 'not_applicable',
      )
    : detail.findings;
  return (
    <>
      <p>
        {detail.run.since} a {detail.run.until} · {counts.fail} problema(s), {counts.warn} atenção,{' '}
        {counts.pass} em ordem, {counts.unknown} sem dado
        {detail.run.requestedByName && ` · por ${detail.run.requestedByName}`}
      </p>
      {detail.run.comparison.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="muted">Período contra o período anterior de mesmo tamanho</caption>
            <thead>
              <tr>
                <th>Canal</th>
                <th className="num">Gasto</th>
                <th className="num">Gasto antes</th>
                <th className="num">Resultados</th>
                <th className="num">Resultados antes</th>
                <th className="num">CPL</th>
                <th className="num">CPL antes</th>
              </tr>
            </thead>
            <tbody>
              {detail.run.comparison.map((row) => (
                <tr key={row.platform}>
                  <td>{AD_PLATFORM_LABEL[row.platform]}</td>
                  <td className="num">{formatMoney(row.current.spendCents)}</td>
                  <td className="num">{formatMoney(row.previous.spendCents)}</td>
                  <td className="num">{formatInt(row.current.conversions)}</td>
                  <td className="num">{formatInt(row.previous.conversions)}</td>
                  <td className="num">{formatMoney(row.currentCplCents)}</td>
                  <td className="num">{formatMoney(row.previousCplCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={onlyProblems}
          onChange={(event) => setOnlyProblems(event.target.checked)}
        />{' '}
        Mostrar só o que pede atenção
      </label>
      <ol className="intel-list intel-stack" aria-label="Recomendações por prioridade">
        {findings.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            runId={detail.run.id}
            canRequest={canRequest}
          />
        ))}
      </ol>
    </>
  );
}

function FindingCard({
  finding,
  runId,
  canRequest,
}: {
  finding: AuditFinding;
  runId: string;
  canRequest: boolean;
}) {
  const act = useFindingAction(runId);
  const info = AUDIT_CHECK_INFO[finding.check];
  return (
    <li className="card">
      <p>
        <StatePill status={finding.status} />{' '}
        <span className="muted">
          {info.label}
          {finding.platform && ` · ${AD_PLATFORM_LABEL[finding.platform]}`} · prioridade{' '}
          {finding.priority}
        </span>
      </p>
      <h3>{finding.title}</h3>
      <p>{finding.detail}</p>
      {finding.recommendation && (
        <p>
          <strong>O que fazer:</strong> {finding.recommendation}
        </p>
      )}
      <p className="muted">
        Impacto {AUDIT_LEVEL_LABEL[finding.impact].toLowerCase()} · confiança{' '}
        {AUDIT_LEVEL_LABEL[finding.confidence].toLowerCase()} · esforço{' '}
        {AUDIT_LEVEL_LABEL[finding.effort].toLowerCase()} · fonte: {info.source}
      </p>
      {finding.state === 'requested' && (
        <p>
          Pedido criado e aguardando aprovação.{' '}
          {finding.approvalId && (
            <Link to={`${APPROVALS}/${finding.approvalId}`}>Ver aprovação</Link>
          )}
        </p>
      )}
      {finding.state === 'refused' && <p>O guardião de orçamento recusou o pedido.</p>}
      {finding.state === 'dismissed' && <p className="muted">Descartada.</p>}
      {finding.state === 'open' && finding.status !== 'pass' && canRequest && (
        <div className="form-actions">
          {finding.action && finding.requestable && (
            <Button
              type="button"
              disabled={act.isPending}
              onClick={() => act.mutate({ id: finding.id, action: 'request' })}
            >
              Criar pedido (
              {finding.action.kind === 'pause_campaign' ? 'pausar campanha' : 'mudar verba'})
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={act.isPending}
            onClick={() => act.mutate({ id: finding.id, action: 'dismiss' })}
          >
            Descartar
          </Button>
        </div>
      )}
      {finding.state === 'open' &&
        finding.action &&
        !finding.requestable &&
        finding.notRequestableReason && (
          <p className="field-hint">{finding.notRequestableReason}</p>
        )}
      {finding.action && finding.requestable && finding.state === 'open' && (
        <p className="field-hint">
          O pedido sai em seu nome, passa pelo teto do mês e espera aprovação de Admin Master ou
          Diretoria. Nada é executado por este botão.
        </p>
      )}
      {act.isError && <Alert kind="error">{failureReason(act.error)}</Alert>}
    </li>
  );
}

// --- AI ad packages -------------------------------------------------------------

function CopyView({ canRequest }: { canRequest: boolean }) {
  const overview = useIntelligenceOverview();
  const drafts = useCopyDrafts();
  const generate = useGenerateCopy();
  const [platform, setPlatform] = useState<AdCopyPlatform>('meta');
  const [objective, setObjective] = useState<AdCopyObjective>('leads');
  const [product, setProduct] = useState('');
  const [audience, setAudience] = useState('');
  const [facts, setFacts] = useState('');
  const [variations, setVariations] = useState(3);
  const aiConfigured = overview.data?.aiConfigured ?? true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    generate.mutate({
      platform,
      objective,
      product,
      audience: audience || undefined,
      facts: facts || undefined,
      variations,
    });
  };

  return (
    <div className="intel-stack">
      {!aiConfigured && (
        <Alert kind="warning">
          IA não configurada (falta a chave do OpenRouter): nada é gerado.
        </Alert>
      )}
      {!canRequest && (
        <Alert kind="info">Gerar anúncios exige a permissão de pedir campanhas.</Alert>
      )}
      <form className="card intel-stack" onSubmit={submit} aria-label="Novo pacote de anúncio">
        <div className="grid-2">
          <Field label="Plataforma">
            <Select
              value={platform}
              onChange={(event) => setPlatform(event.target.value as AdCopyPlatform)}
            >
              {AD_COPY_PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {AD_COPY_PLATFORM_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Objetivo">
            <Select
              value={objective}
              onChange={(event) => setObjective(event.target.value as AdCopyObjective)}
            >
              {AD_COPY_OBJECTIVES.map((value) => (
                <option key={value} value={value}>
                  {AD_COPY_OBJECTIVE_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="O que é anunciado" required>
          <Input
            value={product}
            minLength={3}
            maxLength={300}
            required
            onChange={(event) => setProduct(event.target.value)}
          />
        </Field>
        <Field label="Para quem" hint="Vazio: usa o cliente ideal salvo no studio.">
          <Input
            value={audience}
            maxLength={400}
            onChange={(event) => setAudience(event.target.value)}
          />
        </Field>
        <label className="field">
          <span className="field-label">Fatos autorizados</span>
          <textarea
            className="control"
            rows={3}
            maxLength={1200}
            aria-describedby="copy-facts-hint"
            value={facts}
            onChange={(event) => setFacts(event.target.value)}
          />
          <span className="field-hint" id="copy-facts-hint">
            Preços, condições, números e resultados só entram no anúncio se estiverem aqui. Texto
            com número que não veio daqui é recusado.
          </span>
        </label>
        <Field label="Variações">
          <Select
            value={variations}
            onChange={(event) => setVariations(Number(event.target.value))}
          >
            {[2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <div className="form-actions">
          <Button type="submit" disabled={!canRequest || !aiConfigured || generate.isPending}>
            {generate.isPending ? 'Gerando…' : 'Gerar pacote (usa IA)'}
          </Button>
        </div>
        {generate.isError && <Alert kind="error">{failureReason(generate.error)}</Alert>}
      </form>

      {drafts.isError && (
        <LoadFailure
          what="os rascunhos"
          error={drafts.error}
          onRetry={() => void drafts.refetch()}
        />
      )}
      {drafts.isLoading && <p className="muted">Carregando…</p>}
      {drafts.data && drafts.data.drafts.length === 0 && (
        <p className="muted">Nenhum rascunho seu ainda.</p>
      )}
      {drafts.data?.drafts.map((draft) => (
        <DraftCard key={draft.id} draft={draft} />
      ))}
    </div>
  );
}

const DRAFT_ERROR: Record<string, string> = {
  no_answer: 'A IA não devolveu o pacote.',
  all_refused: 'Todas as variações foram recusadas pelas regras.',
  invalid_answer: 'A resposta da IA veio incompleta.',
  provider_unavailable: 'O provedor de IA não respondeu.',
  provider_refused: 'O provedor de IA recusou o pedido.',
  aborted: 'A geração foi interrompida.',
};

function DraftCard({ draft }: { draft: AdCopyDraft }) {
  const pkg = draft.package;
  return (
    <article className="card intel-stack">
      <p className="muted">
        {formatDateTime(draft.createdAt)} · {AD_COPY_PLATFORM_LABEL[draft.request.platform]} ·{' '}
        {draft.request.product} · pré-visualização, nada foi publicado
      </p>
      {draft.error && <Alert kind="warning">{DRAFT_ERROR[draft.error] ?? draft.error}</Alert>}
      {pkg && (
        <>
          <div className="grid-2">
            {pkg.variations.map((item, index) => (
              <section key={index} className="kpi" aria-label={`Variação ${index + 1}`}>
                <span className="kpi-label">
                  Variação {index + 1} · {item.angle}
                </span>
                {item.primaryText && <p>{item.primaryText}</p>}
                <strong>{item.headline}</strong>
                {item.description && <p>{item.description}</p>}
                {item.callToAction && (
                  <span className="tag">{CALL_TO_ACTION_LABEL[item.callToAction]}</span>
                )}
              </section>
            ))}
          </div>
          <p>
            <strong>Briefing do criativo:</strong> {pkg.creativeBrief}
          </p>
          {pkg.videoScript.length > 0 && (
            <ol>
              {pkg.videoScript.map((scene, index) => (
                <li key={index}>
                  {scene.seconds}s · {scene.visual}
                  {scene.text && ` · texto: “${scene.text}”`}
                </li>
              ))}
            </ol>
          )}
          {pkg.audienceSuggestion && (
            <p>
              <strong>Público:</strong> {pkg.audienceSuggestion}
            </p>
          )}
          {pkg.structureSuggestion && (
            <p>
              <strong>Estrutura:</strong> {pkg.structureSuggestion}
            </p>
          )}
          {pkg.assumptions.length > 0 && (
            <p className="muted">Suposições da IA: {pkg.assumptions.join(' · ')}</p>
          )}
        </>
      )}
      {draft.refused.length > 0 && (
        <details>
          <summary>{draft.refused.length} variação(ões) recusada(s) pelas regras</summary>
          <ul>
            {draft.refused.map((item, index) => (
              <li key={index}>
                “{item.headline}”: {item.problems.join(' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="field-hint">
        Para usar, leve o texto ao construtor do studio: a campanha nasce pausada e passa pela
        aprovação.
      </p>
    </article>
  );
}
