import {
  WA_NUMBER_STATUS_LABELS,
  type WaNumber,
  type WaSignupConfig,
  type WaSyncState,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useSellers } from '../../api/leads.js';
import {
  useConnectWhatsAppNumber,
  useRetryWhatsAppNumber,
  useWhatsAppNumbers,
  type ConnectAnswer,
} from '../../api/whatsapp-numbers.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import {
  loadFacebookSdk,
  runEmbeddedSignup,
  type SignupOutcome,
} from '../../lib/embedded-signup.js';
import { formatDateTime } from './format.js';

/**
 * CRM Vendas → WhatsApp → Números (docs/whatsapp/conectar-numero.md): the sellers' own WhatsApp
 * Business numbers, mirrored by coexistence. An Admin Master connects each one through Meta's
 * window with the seller's phone in hand; the contacts and the history are asked for once, in
 * the first 24 hours, and the list shows how far the history came.
 */

const SYNC_LABELS: Record<WaSyncState, string> = {
  requested: 'Pedido',
  failed: 'Falhou',
  unknown: 'Sem resposta da Meta',
};

const syncLabel = (state: WaSyncState | null) => (state ? SYNC_LABELS[state] : 'Não pedido');

const SIGNUP_FAILURES: Record<Exclude<SignupOutcome, { ok: true }>['reason'], string> = {
  cancelled: 'A janela da Meta foi fechada antes do fim. Nada foi conectado.',
  meta_error: 'A Meta mostrou um erro na janela. Nada foi conectado.',
  other_flow:
    'A Meta terminou outro tipo de conexão. Na janela, escolha usar o número que já está no app WhatsApp Business.',
  no_account: 'A Meta não disse qual conta do WhatsApp foi compartilhada. Conecte de novo.',
  no_code: 'A Meta não devolveu o código da conexão. Conecte de novo.',
};

/** Whether a step can still be tried: connected, inside the 24 hours, and one that did not go. */
function canRetry(number: WaNumber, now = Date.now()) {
  if (number.status !== 'connected' || Date.parse(number.syncDeadline) < now) return false;
  return (
    !number.webhooksSubscribed ||
    number.contactsSync === null ||
    number.contactsSync === 'failed' ||
    number.historySync === null ||
    number.historySync === 'failed'
  );
}

function stepsText({ steps }: ConnectAnswer): string {
  if (steps.webhooks === 'failed')
    return 'Número salvo, mas a Meta recusou mandar os avisos dele para o sistema. Contatos e histórico não foram pedidos: use "Tentar de novo" dentro de 24 horas.';
  if (steps.contacts === 'requested' && steps.history === 'requested')
    return 'Número conectado. Contatos e histórico pedidos à Meta: deixe o WhatsApp Business aberto no celular até o histórico chegar a 100%.';
  return `Número conectado. Contatos: ${stepLabel(steps.contacts)}. Histórico: ${stepLabel(steps.history)}.`;
}

const stepLabel = (step: ConnectAnswer['steps']['contacts']) =>
  step === 'skipped' ? 'não pedido' : syncLabel(step).toLowerCase();

const reasonOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Não foi possível falar com o sistema agora.';

export function WhatsAppNumbersPage() {
  const view = useWhatsAppNumbers();
  const numbers = view.data?.numbers ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Números dos vendedores</h1>
        <span className="crm-sub">
          O WhatsApp Business de cada vendedor, espelhado no sistema. A conversa continua no
          celular.
        </span>
      </header>
      <div className="crm-page-scroll crm-stack">
        {view.isLoading && <p className="crm-sub">Carregando…</p>}
        {view.isError && (
          <LoadFailure what="os números" error={view.error} onRetry={() => void view.refetch()} />
        )}
        {view.data &&
          (view.data.signup ? (
            <ConnectPanel signup={view.data.signup} />
          ) : (
            <section className="crm-panel" aria-labelledby="wa-connect-title">
              <h2 id="wa-connect-title">Conectar um número</h2>
              <p className="crm-sub">
                — A conexão ainda não está configurada neste ambiente. Falta:{' '}
                {view.data.missing.join(', ')}.
              </p>
            </section>
          ))}
        {view.isSuccess && (
          <section className="crm-panel" aria-labelledby="wa-numbers-title">
            <h2 id="wa-numbers-title">Conectados</h2>
            {numbers.length === 0 ? (
              <p className="crm-sub">Nenhum número conectado ainda.</p>
            ) : (
              <NumbersTable numbers={numbers} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

type Phase = 'idle' | 'meta' | 'saving';

function ConnectPanel({ signup }: { signup: WaSignupConfig }) {
  const sellers = useSellers();
  const connect = useConnectWhatsAppNumber();
  const [owner, setOwner] = useState('');
  const [sdk, setSdk] = useState<Awaited<ReturnType<typeof loadFacebookSdk>> | 'failed' | null>(
    null,
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    loadFacebookSdk(signup.appId, signup.graphVersion).then(
      (fb) => alive && setSdk(fb),
      () => alive && setSdk('failed'),
    );
    return () => {
      alive = false;
    };
  }, [signup.appId, signup.graphVersion]);

  const active = (sellers.data?.sellers ?? []).filter((seller) => seller.active);
  const ready = sdk !== null && sdk !== 'failed' && owner !== '' && phase === 'idle';

  // Straight from the click: a popup opened after an await is blocked by the browser.
  const start = () => {
    if (!sdk || sdk === 'failed') return;
    setResult(null);
    setPhase('meta');
    void runEmbeddedSignup(sdk, signup.configId).then(async (outcome) => {
      if (!outcome.ok) {
        setPhase('idle');
        setResult({ ok: false, text: SIGNUP_FAILURES[outcome.reason] });
        return;
      }
      setPhase('saving');
      try {
        const answer = await connect.mutateAsync({
          code: outcome.code,
          wabaId: outcome.wabaId,
          ...(outcome.phoneNumberId ? { phoneNumberId: outcome.phoneNumberId } : {}),
          ownerEmployeeId: owner,
        });
        setResult({ ok: answer.steps.webhooks === 'ok', text: stepsText(answer) });
      } catch (error) {
        setResult({ ok: false, text: reasonOf(error) });
      } finally {
        setPhase('idle');
      }
    });
  };

  return (
    <section className="crm-panel" aria-labelledby="wa-connect-title">
      <h2 id="wa-connect-title">Conectar um número</h2>
      <ol className="crm-sub">
        <li>Escolha de quem é o número.</li>
        <li>Tenha o celular do vendedor na mão, com o WhatsApp Business aberto.</li>
        <li>
          Clique em Conectar pela Meta. Na janela, entre com a conta que administra o portfólio,
          escolha usar o número que já está no app WhatsApp Business, leia o QR code no celular e
          aceite compartilhar o histórico.
        </li>
      </ol>
      <p className="crm-sub">
        A Meta manda os contatos e o histórico só uma vez, nas primeiras 24 horas. O sistema pede os
        dois assim que o número conecta.
      </p>
      <div className="crm-form-grid">
        <label className="crm-field">
          <span>Dono do número</span>
          <select
            className="crm-select"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            disabled={phase !== 'idle'}
          >
            <option value="">Escolha o vendedor</option>
            {active.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sellers.isError && (
        <LoadFailure
          what="os vendedores"
          error={sellers.error}
          onRetry={() => void sellers.refetch()}
        />
      )}
      {sdk === 'failed' && (
        <p className="crm-error" role="alert">
          Não foi possível carregar o SDK da Meta (connect.facebook.net). Confira se o navegador
          bloqueia o site e recarregue a página.
        </p>
      )}
      <div className="crm-form-actions">
        <button type="button" className="crm-btn is-primary" disabled={!ready} onClick={start}>
          {phase === 'meta'
            ? 'Esperando a janela da Meta…'
            : phase === 'saving'
              ? 'Salvando a conexão…'
              : 'Conectar pela Meta'}
        </button>
      </div>
      {result && (
        <p className={result.ok ? 'crm-ok' : 'crm-error'} role="status">
          {result.text}
        </p>
      )}
    </section>
  );
}

function NumbersTable({ numbers }: { numbers: WaNumber[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="crm-table">
        <thead>
          <tr>
            <th>Número</th>
            <th>Dono</th>
            <th>Situação</th>
            <th>Contatos</th>
            <th>Histórico</th>
            <th>Pedir até</th>
            <th>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {numbers.map((number) => (
            <NumberRow key={number.id} number={number} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberRow({ number }: { number: WaNumber }) {
  const retry = useRetryWhatsAppNumber();
  const history =
    number.historyProgress === null
      ? syncLabel(number.historySync)
      : number.historyProgress >= 100
        ? 'Completo'
        : `${number.historyProgress}%`;
  return (
    <tr>
      <td>
        {number.displayPhone ?? number.phoneNumberId}
        {number.verifiedName && <div className="crm-sub">{number.verifiedName}</div>}
      </td>
      <td>{number.ownerName ?? '—'}</td>
      <td>
        {WA_NUMBER_STATUS_LABELS[number.status]}
        {number.status === 'disconnected' && number.disconnectReason && (
          <div className="crm-sub">{number.disconnectReason}</div>
        )}
        {number.status === 'connected' && !number.webhooksSubscribed && (
          <div className="crm-sub">Avisos da Meta ainda não assinados</div>
        )}
      </td>
      <td>{syncLabel(number.contactsSync)}</td>
      <td>{history}</td>
      <td>{canRetry(number) ? formatDateTime(number.syncDeadline) : '—'}</td>
      <td>
        {canRetry(number) && (
          <button
            type="button"
            className="crm-btn is-small"
            disabled={retry.isPending}
            onClick={() => retry.mutate(number.id)}
          >
            Tentar de novo
          </button>
        )}
        {retry.isError && (
          <div className="crm-error" role="alert">
            {reasonOf(retry.error)}
          </div>
        )}
      </td>
    </tr>
  );
}
