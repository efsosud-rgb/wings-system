import {
  SECTORS,
  WA_NUMBER_CHECK_KEYS,
  WA_NUMBER_CHECKS,
  WA_NUMBER_ELIGIBILITIES,
  WA_NUMBER_ELIGIBILITY_LABELS,
  WA_NUMBER_STATUS_LABELS,
  WA_TOKEN_WARN_DAYS,
  type SectorSlug,
  type WaNumber,
  type WaNumberCheck,
  type WaNumberEligibility,
  type WaSignupConfig,
  type WaSyncState,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  useConnectWhatsAppNumber,
  useFailedWebhookEvents,
  useRegisterWhatsAppNumber,
  useRetryWebhookEvent,
  useRetryWhatsAppNumber,
  useUpdateWhatsAppNumber,
  useWhatsAppNumbers,
  type ConnectAnswer,
} from '../../api/whatsapp-numbers.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import {
  loadFacebookSdk,
  runEmbeddedSignup,
  type SignupOutcome,
} from '../../lib/embedded-signup.js';
import { formatDate, formatDateTime, formatPhone } from './format.js';

/**
 * CRM Vendas → WhatsApp → Números (docs/whatsapp/central.md, conectar-numero.md): the company's
 * work numbers. An Admin Master registers each one (owner, department, whether it may be connected,
 * the phone checks), and later connects it through Meta's window with the owner's phone in hand;
 * the contacts and the history are asked for once, in the first 24 hours. The list shows each
 * number's connection, its token's end and how far the history came, and below, the webhook
 * bodies the queue gave up on.
 */

const SYNC_LABELS: Record<WaSyncState, string> = {
  requested: 'Pedido',
  failed: 'Falhou',
  unknown: 'Sem resposta da Meta',
  declined: 'Recusado no celular',
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

const DAY_MS = 86_400_000;

/** The phone checks, short, for the table (the form shows them in full). */
const CHECK_SHORT: Record<WaNumberCheck, string> = {
  app: 'app 2.24.17+',
  work: 'número de trabalho',
  phone: 'celular na hora',
  history: 'histórico em 24 h',
};

/** Days until the token ends (negative: ended); null when Meta gave no end. */
const tokenDaysLeft = (number: WaNumber, now = Date.now()) =>
  number.tokenExpiresAt === null
    ? null
    : Math.floor((Date.parse(number.tokenExpiresAt) - now) / DAY_MS);

/**
 * Whether "Tentar de novo" has something to do: the subscription at any time, a sync that did not
 * go only inside the 24 hours.
 */
function canRetry(number: WaNumber, now = Date.now()) {
  if (number.status !== 'connected') return false;
  if (!number.webhooksSubscribed) return true;
  const owed = (state: WaSyncState | null) => state === null || state === 'failed';
  return (
    number.syncDeadline !== null &&
    Date.parse(number.syncDeadline) >= now &&
    (owed(number.contactsSync) || owed(number.historySync))
  );
}

function stepsText({ steps }: ConnectAnswer): string {
  if (steps.webhooks === 'failed')
    return 'Número salvo, mas a Meta recusou mandar os avisos dele para o sistema. Contatos e histórico não foram pedidos: use "Tentar de novo" (os avisos a qualquer hora; contatos e histórico só nas 24 horas).';
  if (steps.contacts === 'requested' && steps.history === 'requested')
    return 'Número conectado. Contatos e histórico pedidos à Meta: deixe o WhatsApp Business aberto no celular até o histórico chegar a 100%.';
  return `Número conectado. Contatos: ${stepLabel(steps.contacts)}. Histórico: ${stepLabel(steps.history)}.`;
}

const stepLabel = (step: ConnectAnswer['steps']['contacts']) =>
  step === 'skipped' ? 'não pedido' : syncLabel(step).toLowerCase();

const reasonOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Não foi possível falar com o sistema agora.';

const phoneOf = (number: WaNumber) =>
  number.phone ? formatPhone(number.phone) : (number.displayPhone ?? number.phoneNumberId ?? '—');

type Sdk = Awaited<ReturnType<typeof loadFacebookSdk>>;

export function WhatsAppNumbersPage() {
  const view = useWhatsAppNumbers();
  const numbers = view.data?.numbers ?? [];
  const signup = view.data?.signup ?? null;
  const [editing, setEditing] = useState<WaNumber | null>(null);
  const [sdk, setSdk] = useState<Sdk | 'failed' | null>(null);
  useEffect(() => {
    if (!signup) return;
    let alive = true;
    loadFacebookSdk(signup.appId, signup.graphVersion).then(
      (fb) => alive && setSdk(fb),
      () => alive && setSdk('failed'),
    );
    return () => {
      alive = false;
    };
  }, [signup?.appId, signup?.graphVersion]);
  const ending = numbers.filter((n) => {
    const left = tokenDaysLeft(n);
    return n.status === 'connected' && left !== null && left <= WA_TOKEN_WARN_DAYS;
  });
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Números de WhatsApp</h1>
        <span className="crm-sub">
          Os números de trabalho da empresa. A conversa continua no celular de cada um; conectado, o
          número traz para o sistema as mensagens, o que sai do celular e o histórico.
        </span>
      </header>
      <div className="crm-page-scroll crm-stack" style={{ alignContent: 'start' }}>
        {view.isLoading && <p className="crm-sub">Carregando…</p>}
        {view.isError && (
          <LoadFailure what="os números" error={view.error} onRetry={() => void view.refetch()} />
        )}
        {ending.length > 0 && (
          <p className="crm-error" role="alert">
            O acesso da Meta vence em breve (ou venceu) para:{' '}
            {ending.map((n) => `${n.label ?? phoneOf(n)} (${tokenText(n)})`).join(', ')}. Para
            renovar, conecte de novo pela Meta com o celular do dono (docs/whatsapp/central.md).
          </p>
        )}
        {view.data && !signup && (
          <p className="crm-sub">
            — A conexão pela Meta ainda não está configurada neste ambiente. Falta:{' '}
            {view.data.missing.join(', ')}. O cadastro funciona mesmo assim.
          </p>
        )}
        {sdk === 'failed' && (
          <p className="crm-error" role="alert">
            Não foi possível carregar o SDK da Meta (connect.facebook.net). Confira se o navegador
            bloqueia o site e recarregue a página.
          </p>
        )}
        {view.isSuccess && (
          <RegistryForm
            key={editing?.id ?? 'new'}
            people={view.data.people}
            editing={editing}
            onDone={() => setEditing(null)}
          />
        )}
        {view.isSuccess && (
          <section className="crm-panel" aria-labelledby="wa-numbers-title">
            <h2 id="wa-numbers-title">Números</h2>
            {numbers.length === 0 ? (
              <p className="crm-sub">Nenhum número cadastrado ainda.</p>
            ) : (
              <NumbersTable
                numbers={numbers}
                signup={signup}
                sdk={sdk === 'failed' ? null : sdk}
                onEdit={setEditing}
              />
            )}
          </section>
        )}
        {view.isSuccess && <FailedEvents />}
      </div>
    </div>
  );
}

function tokenText(number: WaNumber): string {
  const left = tokenDaysLeft(number);
  if (left === null) return number.status === 'connected' ? 'sem vencimento informado' : '—';
  if (left < 0) return `venceu em ${formatDate(number.tokenExpiresAt)}`;
  return `vence em ${formatDate(number.tokenExpiresAt)} (${left} ${left === 1 ? 'dia' : 'dias'})`;
}

const SECTOR_KEYS = Object.keys(SECTORS) as SectorSlug[];

/** The registry (Eric, 26/10): a new number, or the one being edited. */
function RegistryForm({
  people,
  editing,
  onDone,
}: {
  people: { id: string; name: string }[];
  editing: WaNumber | null;
  onDone: () => void;
}) {
  const register = useRegisterWhatsAppNumber();
  const update = useUpdateWhatsAppNumber();
  const [form, setForm] = useState({
    label: editing?.label ?? '',
    phone: editing?.phone ?? '',
    ownerEmployeeId: editing?.ownerEmployeeId ?? '',
    sector: (editing?.sector ?? '') as SectorSlug | '',
    eligibility: editing?.eligibility ?? ('a_confirmar' as WaNumberEligibility),
    eligibilityNotes: editing?.eligibilityNotes ?? '',
    checks: editing?.checks ?? ([] as WaNumberCheck[]),
  });
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = register.isPending || update.isPending;
  const phoneLocked = editing !== null && editing.status !== 'registered';

  const submit = async () => {
    setResult(null);
    const input = {
      label: form.label,
      ownerEmployeeId: form.ownerEmployeeId,
      sector: form.sector || null,
      eligibility: form.eligibility,
      eligibilityNotes: form.eligibilityNotes.trim() || null,
      checks: form.checks,
    };
    try {
      if (editing)
        await update.mutateAsync({
          id: editing.id,
          ...input,
          ...(phoneLocked ? {} : { phone: form.phone }),
        });
      else await register.mutateAsync({ ...input, phone: form.phone });
      setResult({ ok: true, text: editing ? 'Cadastro salvo.' : 'Número cadastrado.' });
      if (editing) onDone();
      else
        setForm({
          label: '',
          phone: '',
          ownerEmployeeId: '',
          sector: '',
          eligibility: 'a_confirmar',
          eligibilityNotes: '',
          checks: [],
        });
    } catch (error) {
      setResult({ ok: false, text: reasonOf(error) });
    }
  };

  return (
    <section className="crm-panel" aria-labelledby="wa-registry-title">
      <h2 id="wa-registry-title">{editing ? 'Editar número' : 'Cadastrar número'}</h2>
      <p className="crm-sub">
        Só número de trabalho. Número pessoal só com avaliação e autorização do Eric. O número
        oficial da Wings não entra aqui: ele já é o canal oficial do sistema.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="crm-form-grid">
          <label className="crm-field">
            <span>Nome do número</span>
            <input
              className="crm-input"
              value={form.label}
              maxLength={80}
              placeholder="Comercial Expansão"
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <label className="crm-field">
            <span>Número (DDD + número)</span>
            <input
              className="crm-input"
              value={form.phone}
              inputMode="tel"
              disabled={phoneLocked}
              title={phoneLocked ? 'O número conectado é o que a Meta mostrou.' : undefined}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </label>
          <label className="crm-field">
            <span>Dono do número</span>
            <select
              className="crm-select"
              value={form.ownerEmployeeId}
              onChange={(e) => setForm({ ...form, ownerEmployeeId: e.target.value })}
            >
              <option value="">Escolha a pessoa</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Departamento</span>
            <select
              className="crm-select"
              value={form.sector}
              onChange={(e) => setForm({ ...form, sector: e.target.value as SectorSlug | '' })}
            >
              <option value="">Sem departamento</option>
              {SECTOR_KEYS.map((slug) => (
                <option key={slug} value={slug}>
                  {SECTORS[slug].name}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span>Pode conectar?</span>
            <select
              className="crm-select"
              value={form.eligibility}
              onChange={(e) =>
                setForm({ ...form, eligibility: e.target.value as WaNumberEligibility })
              }
            >
              {WA_NUMBER_ELIGIBILITIES.map((key) => (
                <option key={key} value={key}>
                  {WA_NUMBER_ELIGIBILITY_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-field is-wide">
            <span>Anotações da checagem</span>
            <textarea
              className="crm-textarea"
              rows={2}
              maxLength={2000}
              value={form.eligibilityNotes}
              onChange={(e) => setForm({ ...form, eligibilityNotes: e.target.value })}
            />
          </label>
        </div>
        <fieldset className="crm-stack" style={{ border: 0, padding: 0, gap: 4 }}>
          <legend className="crm-sub">No celular do dono, antes de conectar</legend>
          {WA_NUMBER_CHECK_KEYS.map((key) => (
            <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={form.checks.includes(key)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    checks: e.target.checked
                      ? [...form.checks, key]
                      : form.checks.filter((done) => done !== key),
                  })
                }
              />
              <span>{WA_NUMBER_CHECKS[key]}</span>
            </label>
          ))}
        </fieldset>
        <div className="crm-form-actions">
          <button type="submit" className="crm-btn is-primary" disabled={busy}>
            {editing ? 'Salvar' : 'Cadastrar'}
          </button>
          {editing && (
            <button type="button" className="crm-btn" onClick={onDone}>
              Cancelar
            </button>
          )}
        </div>
        {result && (
          <p className={result.ok ? 'crm-ok' : 'crm-error'} role="status">
            {result.text}
          </p>
        )}
      </form>
    </section>
  );
}

function NumbersTable({
  numbers,
  signup,
  sdk,
  onEdit,
}: {
  numbers: WaNumber[];
  signup: WaSignupConfig | null;
  sdk: Sdk | null;
  onEdit: (number: WaNumber) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="crm-table">
        <thead>
          <tr>
            <th>Número</th>
            <th>Dono</th>
            <th>Departamento</th>
            <th>Pode conectar?</th>
            <th>Celular</th>
            <th>Conexão</th>
            <th>Acesso da Meta</th>
            <th>Contatos</th>
            <th>Histórico</th>
            <th>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {numbers.map((number) => (
            <NumberRow
              key={number.id}
              number={number}
              signup={signup}
              sdk={sdk}
              onEdit={() => onEdit(number)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Phase = 'idle' | 'meta' | 'saving';

function NumberRow({
  number,
  signup,
  sdk,
  onEdit,
}: {
  number: WaNumber;
  signup: WaSignupConfig | null;
  sdk: Sdk | null;
  onEdit: () => void;
}) {
  const retry = useRetryWhatsAppNumber();
  const connect = useConnectWhatsAppNumber();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const history =
    number.historyProgress === null
      ? syncLabel(number.historySync)
      : number.historyProgress >= 100
        ? 'Completo'
        : `${number.historyProgress}%`;
  const left = tokenDaysLeft(number);
  // Only a number the registry confirmed (the API refuses the others too).
  const mayConnect = signup !== null && sdk !== null && number.eligibility === 'confirmado';

  // Straight from the click: a popup opened after an await is blocked by the browser.
  const start = () => {
    if (!signup || !sdk) return;
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
          numberId: number.id,
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
    <tr>
      <td>
        <b>{number.label ?? '—'}</b>
        <div className="crm-sub">{phoneOf(number)}</div>
        {number.verifiedName && <div className="crm-sub">{number.verifiedName}</div>}
      </td>
      <td>{number.ownerName ?? '—'}</td>
      <td>{number.sector ? SECTORS[number.sector].name : '—'}</td>
      <td>
        {WA_NUMBER_ELIGIBILITY_LABELS[number.eligibility]}
        {number.eligibilityNotes && <div className="crm-sub">{number.eligibilityNotes}</div>}
      </td>
      <td>
        <span aria-label={`${number.checks.length} de ${WA_NUMBER_CHECK_KEYS.length} conferidos`}>
          {number.checks.length}/{WA_NUMBER_CHECK_KEYS.length}
        </span>
        <ul className="crm-sub" style={{ margin: 0, paddingLeft: 16 }}>
          {WA_NUMBER_CHECK_KEYS.filter((key) => !number.checks.includes(key)).map((key) => (
            <li key={key} title={WA_NUMBER_CHECKS[key]}>
              Falta: {CHECK_SHORT[key]}
            </li>
          ))}
        </ul>
      </td>
      <td>
        {WA_NUMBER_STATUS_LABELS[number.status]}
        {number.status === 'disconnected' && number.disconnectReason && (
          <div className="crm-sub">{number.disconnectReason}</div>
        )}
        {number.status === 'connected' && !number.webhooksSubscribed && (
          <div className="crm-sub">Avisos da Meta ainda não assinados</div>
        )}
        {number.connectedAt && (
          <div className="crm-sub">desde {formatDateTime(number.connectedAt)}</div>
        )}
      </td>
      <td>
        {left !== null && left <= WA_TOKEN_WARN_DAYS ? (
          <b style={{ color: 'var(--danger)' }}>{tokenText(number)}</b>
        ) : (
          tokenText(number)
        )}
      </td>
      <td>{number.status === 'registered' ? '—' : syncLabel(number.contactsSync)}</td>
      <td>
        {number.status === 'registered' ? '—' : history}
        {canRetry(number) && number.syncDeadline && (
          <div className="crm-sub">pedir até {formatDateTime(number.syncDeadline)}</div>
        )}
      </td>
      <td>
        <div className="crm-stack" style={{ gap: 4 }}>
          <button type="button" className="crm-btn is-small" onClick={onEdit}>
            Editar
          </button>
          {mayConnect && (
            <button
              type="button"
              className="crm-btn is-small"
              disabled={phase !== 'idle'}
              onClick={start}
            >
              {phase === 'meta'
                ? 'Esperando a janela da Meta…'
                : phase === 'saving'
                  ? 'Salvando a conexão…'
                  : number.status === 'connected'
                    ? 'Conectar de novo pela Meta'
                    : 'Conectar pela Meta'}
            </button>
          )}
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
        </div>
        {retry.isError && (
          <div className="crm-error" role="alert">
            {reasonOf(retry.error)}
          </div>
        )}
        {result && (
          <div className={result.ok ? 'crm-ok' : 'crm-error'} role="status">
            {result.text}
          </div>
        )}
      </td>
    </tr>
  );
}

/** What the queue gave up on (5 tries), for the Admin Master to send back: never the content. */
function FailedEvents() {
  const failed = useFailedWebhookEvents();
  const retry = useRetryWebhookEvent();
  const events = failed.data?.events ?? [];
  return (
    <section className="crm-panel" aria-labelledby="wa-failed-title">
      <h2 id="wa-failed-title">Avisos da Meta com falha</h2>
      <p className="crm-sub">
        Avisos que o sistema tentou processar 5 vezes, com intervalo crescente, sem conseguir. O
        conteúdo não aparece aqui; processar de novo é seguro (nada entra duas vezes).
      </p>
      {failed.isLoading && <p className="crm-sub">Carregando…</p>}
      {failed.isError && (
        <LoadFailure
          what="os avisos com falha"
          error={failed.error}
          onRetry={() => void failed.refetch()}
        />
      )}
      {failed.isSuccess && events.length === 0 && (
        <p className="crm-sub">Nenhum aviso com falha.</p>
      )}
      {events.length > 0 && (
        <table className="crm-table">
          <thead>
            <tr>
              <th>Recebido</th>
              <th>Tentativas</th>
              <th>Erro</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatDateTime(event.receivedAt)}</td>
                <td>{event.attempts}</td>
                <td>{event.lastError ?? '—'}</td>
                <td>
                  {event.hasPayload ? (
                    <button
                      type="button"
                      className="crm-btn is-small"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(event.id)}
                    >
                      Processar de novo
                    </button>
                  ) : (
                    <span className="crm-sub">Conteúdo já apagado (90 dias)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {retry.isError && (
        <p className="crm-error" role="alert">
          {reasonOf(retry.error)}
        </p>
      )}
    </section>
  );
}
