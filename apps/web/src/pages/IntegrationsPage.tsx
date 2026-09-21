import { KAIROGEN_STATE_LABEL, type KairogenStatus } from '@wings/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useConnectKairogen,
  useDisconnectKairogen,
  useKairogenStatus,
  usePollKairogen,
} from '../api/integrations.js';
import { Alert, Button } from '../components/ui.js';

/**
 * Configurações → Integrações. One card per external service the SYSTEM is
 * connected to. The browser never holds a token: it sees a state, and for the
 * device flow the code a person types at Kairogen.
 */

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
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
    </>
  );
}
