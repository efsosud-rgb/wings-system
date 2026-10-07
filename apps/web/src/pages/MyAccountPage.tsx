import type { GoogleWorkspaceStatus } from '@wings/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useConnectGoogle, useDisconnectGoogle, useGoogleStatus } from '../api/google.js';
import { PageHeader } from '../components/PageHeader.js';
import { Alert, Button } from '../components/ui.js';

const STATE_LABEL: Record<GoogleWorkspaceStatus['state'], string> = {
  disconnected: 'Não conectado',
  pending: 'Aguardando o Google',
  connected: 'Conectado',
  needs_reconnect: 'Precisa conectar de novo',
};

const ERROR_TEXT: Record<string, string> = {
  denied: 'Você não autorizou o acesso na tela do Google.',
  state_mismatch: 'A resposta do Google não bate com o pedido desta conta. Tente de novo.',
  no_refresh_token:
    'O Google não entregou a chave de longa duração. Remova o Wings System em myaccount.google.com → Segurança → Conexões de terceiros e conecte de novo.',
  not_configured: 'O sistema ainda não tem o cliente OAuth do Google (passo do Eric).',
  invalid_grant: 'O Google cancelou a autorização (senha trocada ou acesso removido).',
};

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/**
 * The person's own Google Workspace connection. Connecting sends the browser
 * to Google's consent screen; Google brings it back here with ?google=ok|erro.
 * What the connection allows: events with Meet and invitations on the
 * person's calendar or on Wings Company's, and e-mails to leads from the
 * person's own address.
 */
export function GoogleAccountCard() {
  const status = useGoogleStatus();
  const connect = useConnectGoogle();
  const disconnect = useDisconnectGoogle();
  const [params, setParams] = useSearchParams();
  const [confirming, setConfirming] = useState(false);
  const returned = params.get('google');
  const reason = params.get('motivo');

  const current = status.data?.status;
  if (status.isPending) {
    return (
      <p className="muted" role="status">
        Carregando…
      </p>
    );
  }
  if (!current) return <Alert kind="error">Não foi possível ler a conexão com o Google.</Alert>;

  const goToGoogle = () =>
    connect.mutate(undefined, {
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
    });
  const busy = connect.isPending || disconnect.isPending;
  const wings = current.calendars.wings;

  return (
    <section className="integration-card" aria-labelledby="google-title">
      <header className="integration-card-head">
        <div>
          <h2 id="google-title">Google Agenda, Meet e Gmail</h2>
          <p className="muted">
            Com a sua conta conectada, "Agendar reunião" cria o evento e o Meet na sua agenda ou na
            da Wings Company, convida o lead, e o e-mail ao lead sai do seu endereço.
          </p>
        </div>
        <span className={`integration-state integration-state-${current.state}`} role="status">
          {STATE_LABEL[current.state]}
        </span>
      </header>

      {returned && (
        <Alert kind={returned === 'ok' ? 'success' : 'error'}>
          {returned === 'ok'
            ? 'Conta Google conectada.'
            : (ERROR_TEXT[reason ?? ''] ??
              'O Google não concluiu a autorização. Tente de novo.')}{' '}
          <button type="button" className="link-button" onClick={() => setParams({})}>
            Fechar
          </button>
        </Alert>
      )}
      {!current.configured && (
        <Alert kind="warning">
          O sistema ainda não tem o cliente OAuth do Google configurado
          (GOOGLE_WORKSPACE_CLIENT_ID). É um passo do Eric; até lá a reunião é marcada com o link
          colado.
        </Alert>
      )}
      {current.state === 'needs_reconnect' && (
        <Alert kind="warning">
          {ERROR_TEXT[current.lastError ?? ''] ?? 'O Google parou de aceitar a sua conexão.'}{' '}
          Conecte de novo.
        </Alert>
      )}
      {connect.isError && (
        <Alert kind="error">{errorText(connect.error, 'Não deu para começar.')}</Alert>
      )}
      {disconnect.isError && (
        <Alert kind="error">{errorText(disconnect.error, 'Não deu para desconectar.')}</Alert>
      )}

      {current.state === 'connected' && (
        <dl className="integration-facts">
          <div>
            <dt>Conta</dt>
            <dd className="mono">{current.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Minha agenda</dt>
            <dd>{current.calendars.mine ? current.calendars.mine.name : 'não encontrada'}</dd>
          </div>
          <div>
            <dt>Agenda Wings Company</dt>
            <dd>
              {!current.wingsCalendarConfigured
                ? 'não configurada no sistema (GOOGLE_WORKSPACE_WINGS_CALENDAR_ID)'
                : wings?.access === 'writer'
                  ? `${wings.name} — você pode criar eventos`
                  : wings?.access === 'reader'
                    ? `${wings.name} — só leitura: peça à Thais "Fazer alterações nos eventos"`
                    : 'não compartilhada com você: peça à Thais'}
            </dd>
          </div>
          {current.lastError && current.lastError.startsWith('calendar_') && (
            <div>
              <dt>Aviso</dt>
              <dd>Não deu para ler as suas agendas agora ({current.lastError}).</dd>
            </div>
          )}
        </dl>
      )}

      <div className="integration-actions">
        {!current.configured ? null : current.state === 'connected' ? (
          confirming ? (
            <>
              <span>
                Desconectar apaga a sua chave aqui; reuniões já marcadas continuam no Google.
              </span>
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
          <Button type="button" disabled={busy} onClick={goToGoogle}>
            {current.state === 'needs_reconnect'
              ? 'Conectar de novo'
              : 'Conectar minha conta Google'}
          </Button>
        )}
      </div>
    </section>
  );
}

export function MyAccountPage() {
  const session = useSession();
  const user = session.data;
  return (
    <>
      <PageHeader
        title="Minha conta"
        subtitle={
          user ? `${user.fullName} · ${user.email}` : 'As conexões são suas: ninguém mais as usa.'
        }
      />
      <GoogleAccountCard />
    </>
  );
}
