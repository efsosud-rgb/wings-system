import {
  AD_PLATFORM_LABEL,
  KAIROGEN_PLANS,
  KAIROGEN_PLAN_LABEL,
  KAIROGEN_STATE_LABEL,
  MEDIA_BILLING_LABEL,
  formatBrl,
  type AdAccountBudgetCapView,
  type KairogenPlan,
  type KairogenStatus,
  type MediaProviderStatus,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAdAccountBudgetCaps, useSetBudgetCap } from '../api/ads.js';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useDealSources } from '../api/crm.js';
import { useMetaLeadsStatus, usePollMetaLeads, useTestMetaConnection } from '../api/leads.js';
import { ago } from './crm/format.js';
import {
  useConnectKairogen,
  useDisconnectKairogen,
  useKairogenStatus,
  usePollKairogen,
} from '../api/integrations.js';
import {
  useExpansionLandingPages,
  useLinkRdUser,
  useMarkRdUserDeparted,
  useRdUsers,
  useRecoveryState,
  useStartRecovery,
  useRemoveLandingPage,
  useSaveLandingPage,
} from '../api/expansion.js';
import { useMediaProviders, useSaveKairogenPlan } from '../api/media.js';
import { providerHolding } from '../components/media-studio/ProviderStrip.js';
import { Alert, Button, Field, Input } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Configurações → Integrações. One card per external service the SYSTEM is
 * connected to. The browser never holds a token: it sees a state, and for the
 * device flow the code a person types at Kairogen.
 */

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Kairogen prices by plan and does not say which plan the account is on, so an
 * Admin Master states it here. Every estimate is made against this value.
 */
function PlanField({ plan }: { plan: KairogenPlan }) {
  const save = useSaveKairogenPlan();
  const [chosen, setChosen] = useState<KairogenPlan>(plan);
  useEffect(() => setChosen(plan), [plan]);

  return (
    <form
      className="integration-plan"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(chosen);
      }}
    >
      <label className="field">
        <span className="field-label">Plano contratado</span>
        <select
          className="control"
          value={chosen}
          onChange={(event) => setChosen(event.target.value as KairogenPlan)}
        >
          {KAIROGEN_PLANS.map((item) => (
            <option key={item} value={item}>
              {KAIROGEN_PLAN_LABEL[item]}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="ghost" disabled={save.isPending || chosen === plan}>
        Salvar plano
      </Button>
      <p className="field-hint">
        Usado para estimar o custo de cada geração. Confira o plano na sua conta do Kairogen.
      </p>
      {save.isSuccess && chosen === plan && (
        <p className="field-hint" role="status">
          Plano salvo.
        </p>
      )}
      {save.error && (
        <p className="field-error" role="alert">
          {save.error instanceof ApiError ? save.error.message : 'Não foi possível salvar o plano.'}
        </p>
      )}
    </form>
  );
}

function KairogenCard() {
  const status = useKairogenStatus();
  const connect = useConnectKairogen();
  const poll = usePollKairogen();
  const disconnect = useDisconnectKairogen();
  const [params, setParams] = useSearchParams();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const current: KairogenStatus | undefined = status.data?.status;
  const pending = current?.pending ?? null;
  const returned = params.get('kairogen');

  // Device flow: while the code is on screen, ask the server to check — at the
  // pace the server was given, which it enforces on its side as well.
  const { mutate: check } = poll;
  const waiting = current?.state === 'pending' && pending?.flow === 'device';
  const interval = Math.max(pending?.intervalSeconds ?? 5, 3);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => check(), interval * 1000);
    return () => clearInterval(timer);
  }, [waiting, interval, check]);

  if (status.isLoading) {
    return (
      <p className="muted" role="status">
        Carregando…
      </p>
    );
  }
  if (!current) return <Alert kind="error">Não foi possível ler o estado da integração.</Alert>;

  const problem = [connect.error, poll.error, disconnect.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );
  const deviceRefused = problem?.code === 'device_flow_refused';
  const busy = connect.isPending || disconnect.isPending;

  return (
    <section className="integration-card" aria-labelledby="kairogen-title">
      <header className="integration-card-head">
        <div>
          <h2 id="kairogen-title">Kairogen</h2>
          <p className="muted">Geração e edição de imagens e vídeos para o Marketing.</p>
        </div>
        <span className={`integration-state integration-state-${current.state}`} role="status">
          {KAIROGEN_STATE_LABEL[current.state]}
        </span>
      </header>

      {returned && (
        <Alert kind={returned === 'ok' ? 'success' : 'error'}>
          {returned === 'ok'
            ? 'Conta do Kairogen conectada.'
            : 'O Kairogen não concluiu a autorização. Tente conectar de novo.'}{' '}
          <button type="button" className="link-button" onClick={() => setParams({})}>
            Fechar
          </button>
        </Alert>
      )}
      {current.detail && (
        <div className="alert alert-warning" role="status">
          {current.detail}
        </div>
      )}
      {problem && <Alert kind="error">{problem.message}</Alert>}

      {current.state === 'connected' && (
        <dl className="integration-facts">
          <div>
            <dt>Saldo</dt>
            <dd className="mono">
              {current.credits?.balance != null
                ? `${current.credits.balance.toLocaleString('pt-BR')} créditos`
                : (current.credits?.raw ?? 'não informado')}
            </dd>
          </div>
          <div>
            <dt>Conectado por</dt>
            <dd>
              {current.connectedByName ?? '—'}
              {current.connectedAt && ` em ${formatDateTime(current.connectedAt)}`}
            </dd>
          </div>
          <div>
            <dt>Permissões concedidas</dt>
            <dd className="mono">{current.scopes.join(' · ') || '—'}</dd>
          </div>
        </dl>
      )}

      {current.state !== 'not_configured' && <PlanField plan={current.plan} />}

      {waiting && pending && (
        <div className="integration-device" aria-live="polite">
          <p>
            Abra o Kairogen, entre com a conta da Wings e digite este código. Esta página percebe
            sozinha quando a autorização sair.
          </p>
          <p className="integration-code mono" aria-label="Código de autorização">
            {pending.userCode}
          </p>
          <div className="integration-actions">
            <a
              className="btn btn-primary btn-inline"
              href={pending.verificationUriComplete ?? pending.verificationUri ?? '#'}
              target="_blank"
              rel="noreferrer noopener"
            >
              Abrir o Kairogen
            </a>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(pending.userCode ?? '')
                  .then(() => setCopied(true));
              }}
            >
              {copied ? 'Código copiado' : 'Copiar código'}
            </Button>
            <Button type="button" variant="ghost" disabled={poll.isPending} onClick={() => check()}>
              Já autorizei
            </Button>
          </div>
          <p className="field-hint">
            O código vale até {formatDateTime(pending.expiresAt)}. Endereço:{' '}
            {pending.verificationUri}
          </p>
        </div>
      )}

      {current.state === 'pending' && pending?.flow === 'code' && pending.authorizationUrl && (
        <div className="integration-device">
          <p>Autorize no Kairogen. Ao terminar, ele traz você de volta para esta página.</p>
          <a className="btn btn-primary btn-inline" href={pending.authorizationUrl}>
            Continuar no Kairogen
          </a>
        </div>
      )}

      <div className="integration-actions">
        {current.state === 'not_configured' ? null : current.state === 'connected' ? (
          confirming ? (
            <>
              <span>Desconectar para de gerar mídia até alguém conectar de novo.</span>
              <Button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={() =>
                  disconnect.mutate(undefined, { onSettled: () => setConfirming(false) })
                }
              >
                Desconectar agora
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Manter conectado
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
              Desconectar
            </Button>
          )
        ) : (
          <>
            <Button type="button" disabled={busy} onClick={() => connect.mutate('device')}>
              {current.state === 'pending' ? 'Gerar outro código' : 'Conectar'}
            </Button>
            {(deviceRefused || current.state === 'pending') && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => connect.mutate('code')}
              >
                Conectar pelo navegador
              </Button>
            )}
            {current.state === 'pending' && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => disconnect.mutate()}
              >
                Cancelar
              </Button>
            )}
          </>
        )}
      </div>

      {current.state === 'connected' && current.tools.length > 0 && (
        <details className="integration-tools">
          <summary>
            Ferramentas oferecidas pelo Kairogen ({current.tools.length})
            {current.protocolVersion && ` · protocolo ${current.protocolVersion}`}
          </summary>
          <ul>
            {current.tools.map((tool) => (
              <li key={tool.name}>
                <strong className="mono">{tool.name}</strong>
                {tool.description && <span className="muted"> {tool.description}</span>}
                <pre className="integration-schema">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const CAPABILITY_LABEL: Record<MediaProviderStatus['capabilities'][number], string> = {
  generate_image: 'imagem',
  generate_video: 'vídeo',
  animate: 'animar',
  upscale: 'ampliar',
};

/**
 * One card per media provider set up by environment variable: the browser
 * sees whether the key is present, never the key. Kairogen keeps its own card
 * above, because its connection is made here, not in the environment.
 */
function MediaProviderCard({ status }: { status: MediaProviderStatus }) {
  const holding = providerHolding(status);
  return (
    <section className="provider-card" aria-labelledby={`provider-${status.id}`}>
      <header className="integration-card-head">
        <div>
          <h3 id={`provider-${status.id}`}>{status.name}</h3>
          <p className="muted">
            {MEDIA_BILLING_LABEL[status.billing]} ·{' '}
            {status.capabilities.map((item) => CAPABILITY_LABEL[item]).join(', ')}
          </p>
        </div>
        <span
          className={`integration-state integration-state-${status.available ? 'connected' : 'not_configured'}`}
          role="status"
        >
          {status.available ? 'Disponível' : status.configured ? 'Indisponível' : 'Sem chave'}
        </span>
      </header>
      <dl className="integration-facts">
        <div>
          <dt>Chave no ambiente</dt>
          <dd>{status.configured ? 'presente' : 'ausente'}</dd>
        </div>
        <div>
          <dt>{status.quota ? 'Cota do dia' : 'Saldo'}</dt>
          <dd className="mono">{holding ?? '—'}</dd>
        </div>
        <div>
          <dt>Gasto no mês</dt>
          <dd className="mono">{formatBrl(status.usedThisMonthBrlCents)}</dd>
        </div>
      </dl>
      {status.reason && status.configured && (
        <div className="alert alert-warning" role="status">
          {status.reason}
        </div>
      )}
      {!status.verified && (
        <p className="field-hint">
          Ainda não verificado com uma geração real: o formato das respostas vem da documentação
          pública.
        </p>
      )}
    </section>
  );
}

function MediaProviderCards() {
  const providers = useMediaProviders();
  if (providers.isLoading) return null;
  if (!providers.data || !Array.isArray(providers.data.providers)) {
    return <Alert kind="error">Não foi possível ler os provedores de mídia.</Alert>;
  }
  const others = providers.data.providers.filter((status) => status.id !== 'kairogen');
  return (
    <section aria-labelledby="media-providers-title">
      <h2 id="media-providers-title">Provedores de mídia</h2>
      <p className="muted">
        Ligados por variáveis de ambiente no Coolify. Teto mensal de todos juntos:{' '}
        {formatBrl(providers.data.spend.usedThisMonthBrlCents)} de{' '}
        {formatBrl(providers.data.spend.monthlyLimitBrlCents)} este mês.
      </p>
      <div className="provider-cards">
        {others.map((status) => (
          <MediaProviderCard key={status.id} status={status} />
        ))}
      </div>
    </section>
  );
}

function platformLabel(platform: AdAccountBudgetCapView['platform']): string {
  return platform === 'meta' || platform === 'google' ? AD_PLATFORM_LABEL[platform] : platform;
}

/**
 * One account's cap: current figures plus the edit form. Reused for Meta and
 * Google alike — same shape, same write (`openPeriod`), only the account id
 * differs.
 */
function BudgetCapCard({ account }: { account: AdAccountBudgetCapView }) {
  const setCap = useSetBudgetCap(account.accountId);
  const [capReais, setCapReais] = useState(
    account.capCents !== null ? (account.capCents / 100).toFixed(2) : '',
  );
  const [usablePercent, setUsablePercent] = useState(
    account.usablePercent !== null ? String(account.usablePercent) : '70',
  );
  const [reason, setReason] = useState('');

  useEffect(() => {
    setCapReais(account.capCents !== null ? (account.capCents / 100).toFixed(2) : '');
    setUsablePercent(account.usablePercent !== null ? String(account.usablePercent) : '70');
  }, [account.capCents, account.usablePercent]);

  const capCents = Math.round(Number(capReais.replace(',', '.')) * 100);
  const percent = Number(usablePercent);
  const canSubmit =
    Number.isFinite(capCents) &&
    capCents > 0 &&
    Number.isInteger(percent) &&
    percent >= 1 &&
    percent <= 100 &&
    reason.trim().length >= 3;

  return (
    <section className="integration-card" aria-labelledby={`budget-cap-${account.accountId}`}>
      <header className="integration-card-head">
        <div>
          <h3 id={`budget-cap-${account.accountId}`}>
            {platformLabel(account.platform)} — {account.name}
          </h3>
          <p className="muted">
            {account.capCents !== null && account.usableCents !== null
              ? `Teto de ${formatBrl(account.capCents)}, ${account.usablePercent}% utilizável (${formatBrl(account.usableCents)}).`
              : 'Sem período aberto este mês — nenhum pedido é aceito até um teto ser salvo.'}
          </p>
        </div>
      </header>
      <form
        className="integration-plan"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          setCap.mutate(
            { capCents, usablePercent: percent, reason: reason.trim() },
            { onSuccess: () => setReason('') },
          );
        }}
      >
        <Field label="Teto do mês (R$)">
          <Input
            type="text"
            inputMode="decimal"
            value={capReais}
            onChange={(event) => setCapReais(event.target.value)}
          />
        </Field>
        <Field
          label="Utilizável (%)"
          hint="Parcela do teto que pode ser planejada; o resto absorve sobreentrega."
        >
          <Input
            type="number"
            min={1}
            max={100}
            value={usablePercent}
            onChange={(event) => setUsablePercent(event.target.value)}
          />
        </Field>
        <Field label="Motivo" hint="Registrado no histórico de alterações do teto.">
          <Input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ex.: recarga combinada com o Eric"
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={!canSubmit || setCap.isPending}>
          Salvar teto
        </Button>
        {setCap.isSuccess && (
          <p className="field-hint" role="status">
            Teto salvo.
          </p>
        )}
        {setCap.error && (
          <p className="field-error" role="alert">
            {setCap.error instanceof ApiError
              ? setCap.error.message
              : 'Não foi possível salvar o teto.'}
          </p>
        )}
      </form>
    </section>
  );
}

/**
 * Administração → Integrações: the internal cap per ad account, editable only
 * by an Admin Master — the same write `openPeriod` has always made from the
 * CLI (`ingest-cli --seed`, `verify-live`), now reachable from a screen.
 */
function BudgetCapsSection() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'ads.budget_caps.manage');
  const accounts = useAdAccountBudgetCaps(canManage);

  if (!canManage) return null;
  if (accounts.isLoading) return null;
  if (!accounts.data || !Array.isArray(accounts.data.accounts)) {
    return <Alert kind="error">Não foi possível ler os tetos de orçamento.</Alert>;
  }

  return (
    <section aria-labelledby="budget-caps-title">
      <h2 id="budget-caps-title">Teto interno de orçamento de tráfego pago</h2>
      <p className="muted">
        O teto que o guardião de orçamento usa para recusar pedidos — nunca acima do que a própria
        plataforma permite. Cada alteração fica registrada, com quem mudou e por quê.
      </p>
      <div className="provider-cards">
        {accounts.data.accounts.map((account) => (
          <BudgetCapCard key={account.accountId} account={account} />
        ))}
      </div>
    </section>
  );
}

/**
 * Entrada de leads de Expansão: which RD Marketing landing pages belong to
 * client brands. A conversion on an active one becomes a deal in the
 * "Expansão" funnel ("Tentando contato"); the job reads this list every pass.
 */
function ExpansionIntakeSection() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'integrations.manage');
  const pages = useExpansionLandingPages();
  const save = useSaveLandingPage();
  const remove = useRemoveLandingPage();
  const [identifier, setIdentifier] = useState('');
  const [brand, setBrand] = useState('');

  if (!canManage || pages.isLoading) return null;
  if (!pages.data) return <Alert kind="error">Não foi possível ler as páginas de Expansão.</Alert>;

  return (
    <section aria-labelledby="expansion-intake-title">
      <h2 id="expansion-intake-title">Entrada de leads de Expansão</h2>
      <p className="muted">
        Toda conversão nestas páginas de marcas-clientes vira um negócio no funil Expansão, etapa
        &ldquo;Tentando contato&rdquo;, se o contato ainda não tiver negócio aberto. A conferência
        roda a cada 5 minutos
        {pages.data.enabled
          ? '.'
          : ' e está desligada neste ambiente (EXPANSION_INTAKE_ENABLED).'}{' '}
        O formulário do site (wings-company-form-site) vai para o funil Formatação e não fica nesta
        lista.
      </p>
      <ul>
        {pages.data.landingPages.map((page) => (
          <li key={page.identifier}>
            <strong>{page.brand}</strong> <code>{page.identifier}</code>{' '}
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => save.mutate({ ...page, active: !page.active })}
            >
              {page.active ? 'Desativar' : 'Ativar'}
            </Button>{' '}
            <Button
              type="button"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(page.identifier)}
            >
              Remover
            </Button>
            {!page.active && <span className="muted"> (desativada)</span>}
          </li>
        ))}
      </ul>
      <form
        className="integration-plan"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { identifier: identifier.trim(), brand: brand.trim(), active: true },
            {
              onSuccess: () => {
                setIdentifier('');
                setBrand('');
              },
            },
          );
        }}
      >
        <Field
          label="Identificador da conversão no RD"
          hint="Exatamente como aparece no RD Marketing"
        >
          <Input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            required
          />
        </Field>
        <Field label="Marca">
          <Input value={brand} onChange={(event) => setBrand(event.target.value)} required />
        </Field>
        <Button type="submit" disabled={save.isPending}>
          Adicionar página
        </Button>
        {save.error && <Alert kind="error">Não foi possível salvar.</Alert>}
      </form>
    </section>
  );
}

/**
 * Recuperar conversões vazadas: two steps, in this order. "Simular" reads RD
 * and creates nothing; only then can the same screen create exactly the
 * number it showed. Counts and deal ids only, never a person.
 */
function RecoverySection() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'integrations.manage');
  const recovery = useRecoveryState(canManage);
  const start = useStartRecovery();
  if (!canManage) return null;
  const state = recovery.data;
  const busy = start.isPending || state?.state === 'running';
  const asText = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([name, n]) => `${name}: ${n}`)
      .join(' · ') || 'nenhum';

  return (
    <section aria-labelledby="recovery-title">
      <h2 id="recovery-title">Recuperar conversões sem negócio (30 dias)</h2>
      <p className="muted">
        Formulários de Formatação (wings-company-form-site, lp-formatacao-whatsapp, Formulário
        Simplificado. -02) viram negócio em Formatação / Sem contato; o Calçadão do Frango
        (lp-calcadao-do-frango), em Expansão / Novo Contato, com o dono da Expansão. Quem já tem
        negócio aberto, ou negócio criado depois da conversão, não recebe outro. O fluentform_3 só é
        listado. Primeiro simule; só depois dá para criar.
      </p>
      <Button
        type="button"
        disabled={busy}
        onClick={() => start.mutate({ dryRun: true, days: 30 })}
      >
        Simular (não cria nada)
      </Button>
      {start.error && (
        <Alert kind="error">
          {start.error instanceof ApiError && start.error.code === 'already_running'
            ? 'Já existe uma varredura em andamento.'
            : 'Não foi possível iniciar.'}
        </Alert>
      )}
      {state?.state === 'running' && (
        <p className="muted">
          Lendo o RD ({state.mode === 'dry' ? 'simulação' : 'criação'}).{' '}
          {state.progress
            ? `${state.progress.done} de ${state.progress.total} contatos lidos.`
            : 'Listando os contatos com conversão.'}{' '}
          Leva alguns minutos; não faça deploy enquanto isso.
        </p>
      )}
      {state?.state === 'interrupted' && (
        <Alert kind="warning">
          A {state.mode === 'dry' ? 'simulação' : 'criação'} iniciada em{' '}
          {new Date(state.startedAt).toLocaleString('pt-BR')} foi interrompida (o servidor
          reiniciou) e não terminou. Nada foi criado por ela. Simule de novo.
        </Alert>
      )}
      {state?.state === 'failed' && <Alert kind="error">Falhou: {state.error}</Alert>}
      {state?.state === 'done' && (
        <div className="integration-plan">
          <p>
            <strong>
              {state.mode === 'dry'
                ? `Simulação: criaria ${state.result.wouldCreate} negócio(s).`
                : `Criados: ${state.result.wouldCreate} negócio(s).`}
            </strong>{' '}
            {asText(state.result.created)}
          </p>
          <ul className="muted">
            <li>Conversões lidas: {state.result.conversionsSeen}</li>
            <li>Já tinham negócio: {state.result.existingDeal}</li>
            <li>Já decididas antes: {state.result.alreadyDecided}</li>
            <li>Recentes demais (15 min): {state.result.settling}</li>
            <li>Sem e-mail nem telefone: {state.result.noContactData}</li>
            <li>
              Falhas: {state.result.failed} · sem contato/origem na leitura:{' '}
              {state.result.unverified} · tarefas recusadas: {state.result.taskFailed}
            </li>
            <li>Só listado: {asText(state.result.listOnly)}</li>
            <li>Outras páginas, deixadas como estão: {asText(state.result.ignored)}</li>
          </ul>
          {state.mode === 'real' && state.result.createdDealIds.length > 0 && (
            <p>
              Ids dos negócios: <code>{state.result.createdDealIds.join(', ')}</code>
            </p>
          )}
          {state.mode === 'dry' && state.result.wouldCreate > 0 && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                start.mutate({
                  dryRun: false,
                  planId: state.planId,
                  expectedCreated: state.result.wouldCreate,
                })
              }
            >
              Criar {state.result.wouldCreate} negócio(s)
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function RdUsersSection() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'integrations.manage');
  const users = useRdUsers(canManage);
  const link = useLinkRdUser();
  const departed = useMarkRdUserDeparted();
  if (!canManage || users.isLoading) return null;
  if (!users.data) return <Alert kind="error">Não foi possível ler os usuários do RD CRM.</Alert>;
  const list = users.data.users;

  return (
    <section aria-labelledby="rd-users-title">
      <h2 id="rd-users-title">Usuários do RD CRM</h2>
      <p className="muted">
        Quem é cada usuário do RD CRM aqui dentro, para o dono de cada negócio aparecer no Funil. A
        lista vem da importação do RD; a ligação automática usa o e-mail (ou o nome completo, quando
        é único). Sem ligação, inativo no RD ou marcado como &ldquo;saiu da empresa&rdquo;, os
        negócios contam como &ldquo;dono inativo&rdquo; no Funil. Nenhum negócio é redistribuído.
      </p>
      {link.isError && <Alert kind="error">Não foi possível salvar a ligação.</Alert>}
      {departed.isError && <Alert kind="error">Não foi possível salvar a saída.</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Usuário do RD</th>
              <th>Funcionário</th>
              <th>Saiu da empresa</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Nenhum usuário ainda: a lista aparece depois da primeira importação do RD CRM.
                </td>
              </tr>
            )}
            {list.map((user) => (
              <tr key={user.rdUserId}>
                <td>
                  {user.rdName}
                  {!user.rdActive && <span className="tag">inativo no RD</span>}
                  {user.departedAt && <span className="tag">saiu da empresa</span>}
                </td>
                <td>
                  <select
                    className="control"
                    aria-label={`Funcionário de ${user.rdName}`}
                    value={user.employeeId ?? ''}
                    disabled={link.isPending}
                    onChange={(event) =>
                      link.mutate({
                        rdUserId: user.rdUserId,
                        employeeId: event.target.value || null,
                      })
                    }
                  >
                    <option value="">— sem ligação</option>
                    {users.data.employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${user.rdName} saiu da empresa`}
                    checked={user.departedAt !== null}
                    disabled={departed.isPending}
                    onChange={(event) =>
                      departed.mutate({ rdUserId: user.rdUserId, departed: event.target.checked })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Meta Lead Ads, under the sources: how it runs, and the two buttons (totals only, never a person). */
function MetaLeadAdsActions() {
  const session = useSession();
  const canManage = hasPermission(session.data, 'integrations.manage');
  const status = useMetaLeadsStatus(true);
  const test = useTestMetaConnection();
  const poll = usePollMetaLeads();
  const polling = status.data?.polling;
  const failedCount = (failed: Record<string, string> | undefined) =>
    Object.keys(failed ?? {}).length;
  return (
    <div className="crm-stack" style={{ marginTop: 'var(--space-3)' }}>
      <p className="crm-sub">
        Meta Lead Ads:{' '}
        {polling?.enabled
          ? `ligada, a cada ${polling.everyMinutes} min${status.data?.webhookConfigured ? ', e na hora pelo webhook' : ''}.`
          : status.data?.webhookConfigured
            ? 'só pelo webhook; falta a chave de leitura para buscar a cada 5 min.'
            : 'desligada: falta a chave da Meta (META_LEADS_ACCESS_TOKEN).'}
        {polling?.lastOkAt ? ` Última busca completa há ${ago(polling.lastOkAt)}.` : ''}
        {polling && polling.forms > 0
          ? ` ${polling.forms} formulários${polling.formsWithError > 0 ? `, ${polling.formsWithError} com erro` : ''}.`
          : ''}
      </p>
      {canManage ? (
        <div className="crm-quick-row" style={{ justifyContent: 'flex-start' }}>
          <Button
            variant="ghost"
            type="button"
            disabled={test.isPending || !status.data?.tokenConfigured}
            onClick={() => test.mutate()}
          >
            {test.isPending ? 'Testando…' : 'Testar conexão'}
          </Button>
          <Button
            type="button"
            disabled={poll.isPending || !polling?.enabled}
            onClick={() => poll.mutate()}
          >
            {poll.isPending ? 'Buscando…' : 'Buscar agora'}
          </Button>
        </div>
      ) : null}
      {test.data ? (
        <p role="status">
          A chave enxerga {test.data.pages} {test.data.pages === 1 ? 'página' : 'páginas'},{' '}
          {test.data.forms} {test.data.forms === 1 ? 'formulário' : 'formulários'} e{' '}
          {test.data.truncated ? 'pelo menos ' : ''}
          {test.data.leads} {test.data.leads === 1 ? 'lead' : 'leads'} dos últimos 90 dias.
          {failedCount(test.data.failed) > 0
            ? ` ${failedCount(test.data.failed)} leitura(s) falharam (${[...new Set(Object.values(test.data.failed))].join(', ')}).`
            : ''}
        </p>
      ) : null}
      {poll.data ? (
        <p role="status">
          Busca feita: {poll.data.forms} formulários, {poll.data.queued} leads novos,{' '}
          {poll.data.alreadyKnown} já conhecidos.
          {failedCount(poll.data.failed) > 0
            ? ` ${failedCount(poll.data.failed)} leitura(s) falharam.`
            : ''}
        </p>
      ) : null}
      {test.error || poll.error ? (
        <Alert kind="error">
          {(() => {
            const error = test.error ?? poll.error;
            return error instanceof ApiError ? error.message : 'Não foi possível falar com a Meta.';
          })()}
        </Alert>
      ) : null}
    </div>
  );
}

/** "Fontes de negócios": where deals arrive from and whether each door is open, in plain words. */
function DealSourcesSection() {
  const sources = useDealSources();
  if (!Array.isArray(sources.data?.sources)) return null;
  return (
    <section
      aria-labelledby="deal-sources-title"
      className="crm-panel"
      style={{ marginBottom: 'var(--space-5)' }}
    >
      <h2 id="deal-sources-title">Fontes de negócios</h2>
      <div className="crm-sources">
        {sources.data.sources.map((source) => (
          <div key={source.key} className="crm-source">
            <span
              className={`crm-source-dot${source.state === 'on' ? ' is-on' : source.state === 'off' ? ' is-warn' : ''}`}
              aria-hidden="true"
            />
            <span>
              <b>{source.name}</b>
              <span className="crm-sub">
                {' '}
                ·{' '}
                {source.state === 'on'
                  ? 'ligada'
                  : source.state === 'off'
                    ? 'desligada'
                    : 'em breve'}
              </span>
              <div className="crm-sub">{source.note}</div>
            </span>
            <span className="crm-sub" style={{ textAlign: 'right' }}>
              {source.last30} nos últimos 30 dias
              <div>{source.lastAt ? `última há ${ago(source.lastAt)}` : 'nenhuma ainda'}</div>
            </span>
          </div>
        ))}
      </div>
      <MetaLeadAdsActions />
    </section>
  );
}

export function IntegrationsPage() {
  return (
    <>
      <PageHeader
        title="Integrações"
        subtitle="Contas de serviços externos ligadas ao sistema. A conexão é uma só, da Wings, e vale para todos os módulos que usam o serviço."
      />
      <KairogenCard />
      <MediaProviderCards />
      <DealSourcesSection />
      <ExpansionIntakeSection />
      <RdUsersSection />
      <RecoverySection />
      <BudgetCapsSection />
    </>
  );
}
