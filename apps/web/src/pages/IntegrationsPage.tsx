import {
  KAIROGEN_PLANS,
  KAIROGEN_PLAN_LABEL,
  KAIROGEN_STATE_LABEL,
  MEDIA_BILLING_LABEL,
  formatBrl,
  type KairogenPlan,
  type KairogenStatus,
  type MediaProviderStatus,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useConnectKairogen,
  useDisconnectKairogen,
  useKairogenStatus,
  usePollKairogen,
} from '../api/integrations.js';
import { useMediaProviders, useSaveKairogenPlan } from '../api/media.js';
import { providerHolding } from '../components/media-studio/ProviderStrip.js';
import { Alert, Button } from '../components/ui.js';

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

export function IntegrationsPage() {
  return (
    <>
      <header className="page-header">
        <h1>Integrações</h1>
        <p>
          Contas de serviços externos ligadas ao sistema. A conexão é uma só, da Wings, e vale para
          todos os módulos que usam o serviço.
        </p>
      </header>
      <KairogenCard />
      <MediaProviderCards />
    </>
  );
}
