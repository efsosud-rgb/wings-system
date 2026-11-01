import {
  WA_CALL_PERMISSION_LABELS,
  WA_CALL_STATUS_LABELS,
  type WaCall,
  type WaCallStatus,
} from '@wings/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  useCallPermission,
  useCallRequestPreview,
  useRequestCallPermission,
  useRingingCalls,
  useWhatsAppThread,
  whatsappCalls,
} from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import {
  answerOffer,
  applyAnswer,
  makeOffer,
  MicrophoneError,
  openCallMedia,
  type CallMedia,
} from '../../lib/whatsapp-call.js';
import { formatDateTime, formatPhone } from './format.js';

/**
 * WhatsApp voice calls in the system (Calling API): one call at a time per
 * browser, kept above every screen so changing page never drops it. A call
 * coming in rings for whoever sees the deal (the first to pick up takes it);
 * a call going out starts from the call panel of a deal. The audio is the
 * browser's own; the server only relays the descriptions and keeps the
 * record, and a finished call goes on the deal by itself.
 */

interface ActiveCall {
  id: string | null;
  direction: 'in' | 'out';
  name: string | null;
  phone: string | null;
  status: WaCallStatus | 'starting';
  connectedAt: number | null;
  error: string | null;
  muted: boolean;
}

interface CallCenter {
  /** Calling is on for the number (Meta's settings). */
  calling: boolean;
  active: ActiveCall | null;
  placeCall: (lead: { leadId: string; name: string | null; phone: string | null }) => void;
}

const CallContext = createContext<CallCenter | null>(null);

/** Null outside the provider (the panel then shows calling as off). */
export const useWhatsAppCallCenter = () => useContext(CallContext);

const messageOf = (error: unknown, fallback: string) =>
  error instanceof MicrophoneError || error instanceof ApiError ? error.message : fallback;

const ENDED: readonly string[] = ['completed', 'rejected', 'missed', 'failed'];

export function WhatsAppCallProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const allowed = hasPermission(session.data, 'leads.whatsapp');
  const ringing = useRingingCalls(allowed);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const media = useRef<CallMedia | null>(null);
  const follow = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopFollowing = () => {
    if (follow.current) clearInterval(follow.current);
    follow.current = null;
  };
  const finish = (status: WaCallStatus, error: string | null = null) => {
    stopFollowing();
    media.current?.close();
    media.current = null;
    setActive((current) => current && { ...current, status, error: error ?? current.error });
    setTimeout(
      () => setActive((current) => (current && ENDED.includes(current.status) ? null : current)),
      4_000,
    );
  };
  useEffect(
    () => () => {
      stopFollowing();
      media.current?.close();
    },
    [],
  );

  /** Follows the call on the server: Meta's answer (outgoing), its status, its end. */
  const track = (id: string) => {
    let answered = false;
    stopFollowing();
    follow.current = setInterval(() => {
      void whatsappCalls
        .get(id)
        .then(async ({ call }) => {
          if (call.answerSdp && !answered && media.current) {
            answered = true;
            await applyAnswer(media.current, call.answerSdp);
          }
          if (call.endedAt) return finish(call.status, call.error);
          setActive((current) =>
            current && current.id === id && current.status !== 'accepted'
              ? { ...current, status: call.status }
              : current,
          );
        })
        .catch(() => undefined);
    }, 1_000);
  };

  const watchMedia = (id: () => string | null) => {
    const pc = media.current?.pc;
    if (!pc) return;
    pc.onconnectionstatechange = () => {
      const callId = id();
      if (pc.connectionState === 'connected' && callId) {
        setActive(
          (current) => current && { ...current, status: 'accepted', connectedAt: Date.now() },
        );
        void whatsappCalls.connected(callId).catch(() => undefined);
      }
      if (pc.connectionState === 'failed' && callId) {
        void whatsappCalls.hangup(callId).catch(() => undefined);
        finish('failed', 'O áudio da ligação não conectou.');
      }
    };
  };

  const placeCall: CallCenter['placeCall'] = ({ leadId, name, phone }) => {
    if (active) return;
    let callId: string | null = null;
    setActive({
      id: null,
      direction: 'out',
      name,
      phone,
      status: 'starting',
      connectedAt: null,
      error: null,
      muted: false,
    });
    void (async () => {
      try {
        media.current = await openCallMedia();
        watchMedia(() => callId);
        const sdp = await makeOffer(media.current);
        const { call } = await whatsappCalls.start(leadId, sdp);
        callId = call.id;
        if (call.status === 'failed') return finish('failed', call.error);
        setActive((current) => current && { ...current, id: call.id, status: call.status });
        track(call.id);
      } catch (error) {
        finish('failed', messageOf(error, 'Não foi possível ligar.'));
      }
    })();
  };

  const pickUp = (call: WaCall) => {
    if (active) return;
    setActive({
      id: call.id,
      direction: 'in',
      name: call.name,
      phone: call.phone,
      status: 'ringing',
      connectedAt: null,
      error: null,
      muted: false,
    });
    void (async () => {
      try {
        const { offerSdp } = await whatsappCalls.pickup(call.id);
        media.current = await openCallMedia();
        watchMedia(() => call.id);
        const sdp = await answerOffer(media.current, offerSdp);
        const accepted = await whatsappCalls.accept(call.id, sdp);
        if (accepted.call.status === 'failed') return finish('failed', accepted.call.error);
        track(call.id);
      } catch (error) {
        // Leave nothing ringing on the person's phone when our side gave up.
        void whatsappCalls.hangup(call.id).catch(() => undefined);
        finish('failed', messageOf(error, 'Não foi possível atender.'));
      }
    })();
  };

  const hangUp = () => {
    const id = active?.id;
    if (!id) return finish('failed');
    void whatsappCalls
      .hangup(id)
      .then(({ call }) => finish(call.status))
      .catch(() => finish('completed'));
  };

  const toggleMute = () =>
    setActive((current) => {
      if (!current) return current;
      media.current?.setMuted(!current.muted);
      return { ...current, muted: !current.muted };
    });

  const calling = ringing.data?.calling ?? false;
  const incoming = (ringing.data?.calls ?? []).filter((c) => c.id !== active?.id);

  return (
    <CallContext.Provider value={{ calling, active, placeCall }}>
      {children}
      {(incoming.length > 0 || active) &&
        createPortal(
          <div className="crm-call-dock" role="region" aria-label="Ligações pelo WhatsApp">
            {!active &&
              incoming.slice(0, 1).map((call) => (
                <div key={call.id} className="crm-call-card is-ringing" role="alert">
                  <span className="crm-call-avatar" aria-hidden="true">
                    <Icon name="phone" size={18} />
                  </span>
                  <div className="crm-call-card-who">
                    <b>{call.name ?? formatPhone(call.phone)}</b>
                    <span className="crm-sub">
                      Ligação pelo WhatsApp · {formatPhone(call.phone)}
                    </span>
                  </div>
                  <div className="crm-call-card-actions">
                    <button
                      type="button"
                      className="crm-btn is-primary"
                      onClick={() => pickUp(call)}
                    >
                      Atender
                    </button>
                    <button
                      type="button"
                      className="crm-btn"
                      onClick={() => void whatsappCalls.reject(call.id).catch(() => undefined)}
                    >
                      Recusar
                    </button>
                  </div>
                </div>
              ))}
            {active && <ActiveCallCard call={active} onHangUp={hangUp} onMute={toggleMute} />}
          </div>,
          document.body,
        )}
    </CallContext.Provider>
  );
}

function ActiveCallCard({
  call,
  onHangUp,
  onMute,
}: {
  call: ActiveCall;
  onHangUp: () => void;
  onMute: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!call.connectedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [call.connectedAt]);
  const ended = ENDED.includes(call.status);
  const seconds = call.connectedAt ? Math.max(0, Math.floor((now - call.connectedAt) / 1000)) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const label =
    call.status === 'starting'
      ? 'Preparando o áudio…'
      : call.status === 'accepted' && call.connectedAt
        ? `Em ligação · ${clock}`
        : WA_CALL_STATUS_LABELS[call.status];
  return (
    <div className={`crm-call-card${ended ? ' is-ended' : ''}`} aria-live="polite">
      <span className="crm-call-avatar" aria-hidden="true">
        <Icon name="phone" size={18} />
      </span>
      <div className="crm-call-card-who">
        <b>{call.name ?? (call.phone ? formatPhone(call.phone) : 'Ligação')}</b>
        <span className="crm-sub">
          {call.direction === 'in' ? 'Recebida' : 'Feita'} pelo WhatsApp · {label}
        </span>
        {call.error && <span className="crm-error">{call.error}</span>}
      </div>
      {!ended && (
        <div className="crm-call-card-actions">
          <button type="button" className="crm-btn" onClick={onMute} aria-pressed={call.muted}>
            {call.muted ? 'Com som' : 'Mudo'}
          </button>
          <button type="button" className="crm-btn is-danger" onClick={onHangUp}>
            Desligar
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The WhatsApp part of a deal's call panel: whether calling is on, whether
 * the person allows calls (and asking them), and the button that calls.
 */
export function WhatsAppCallSection({
  center,
  leadId,
  name,
  phone,
  onCalling,
}: {
  center: CallCenter;
  leadId: string;
  name: string | null;
  phone: string | null;
  onCalling: () => void;
}) {
  const thread = useWhatsAppThread({ leadId });
  const on = Boolean(thread.data?.configured && thread.data.calling);
  const live = useCallPermission(leadId, on && Boolean(phone));
  const ask = useRequestCallPermission(leadId);
  const permission = live.data ?? thread.data?.callPermission ?? null;
  const granted = permission?.status === 'temporary' || permission?.status === 'permanent';
  // A "não me contate" on WhatsApp or the phone: no call and no request start from here.
  const blocked = thread.data?.callBlock.blocked ? thread.data.callBlock.reason : null;
  const canCall =
    on && Boolean(phone) && !center.active && !blocked && (granted || live.data?.canCall === true);
  const windowOpen = thread.data?.window.open ?? false;

  return (
    <div className="crm-call-wa">
      <button
        type="button"
        className="crm-btn is-primary"
        disabled={!canCall}
        onClick={() => {
          center.placeCall({ leadId, name, phone });
          onCalling();
        }}
      >
        <Icon name="message" size={15} /> Ligar pelo WhatsApp
      </button>
      {!thread.data ? (
        thread.isError ? (
          <LoadFailure
            what="as ligações pelo WhatsApp"
            error={thread.error}
            onRetry={() => void thread.refetch()}
          />
        ) : (
          <p className="crm-sub">Carregando…</p>
        )
      ) : !thread.data.configured ? (
        <p className="crm-sub">O WhatsApp oficial ainda não está ligado no sistema.</p>
      ) : !thread.data.calling ? (
        <p className="crm-sub">As ligações ainda não estão ligadas neste número do WhatsApp.</p>
      ) : !phone ? null : blocked ? (
        <p className="crm-error">Não me contate: {blocked}</p>
      ) : (
        <>
          <p className="crm-sub">
            {permission?.status
              ? WA_CALL_PERMISSION_LABELS[permission.status]
              : 'A pessoa ainda não disse se aceita ligações.'}
            {permission?.status === 'temporary' && permission.expiresAt
              ? ` até ${formatDateTime(permission.expiresAt)}`
              : ''}
          </p>
          {!granted &&
            (windowOpen ? (
              <button
                type="button"
                className="crm-btn"
                disabled={ask.isPending || live.data?.canRequest === false}
                onClick={() => ask.mutate(undefined)}
              >
                Pedir permissão para ligar
              </button>
            ) : (
              <CallRequestByTemplate
                leadId={leadId}
                ask={ask}
                disabled={live.data?.canRequest === false}
              />
            ))}
          {live.data?.canRequest === false && !granted && (
            <p className="crm-sub">A Meta só deixa pedir 1 vez por dia e 2 por semana.</p>
          )}
          {ask.isSuccess && <p className="crm-sub">Pedido enviado pelo WhatsApp.</p>}
          {ask.error && (
            <p className="crm-error">{messageOf(ask.error, 'Não foi possível pedir.')}</p>
          )}
          {live.error && (
            <p className="crm-error">{messageOf(live.error, 'A Meta não respondeu.')}</p>
          )}
        </>
      )}
      {center.active && <p className="crm-sub">Já há uma ligação em andamento neste navegador.</p>}
    </div>
  );
}

/**
 * Outside the 24 h the request goes by the approved call-request template the server picks
 * (Expansão for a brand's lead, Wings for the others): its preview first, then the click.
 */
function CallRequestByTemplate({
  leadId,
  ask,
  disabled,
}: {
  leadId: string;
  ask: ReturnType<typeof useRequestCallPermission>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = useCallRequestPreview(leadId, open);
  if (!open)
    return (
      <button
        type="button"
        className="crm-btn"
        disabled={disabled || ask.isPending}
        onClick={() => {
          ask.reset();
          setOpen(true);
        }}
      >
        Pedir pelo modelo
      </button>
    );
  const shown = preview.data?.preview;
  return (
    <div className="crm-call-request" aria-label="Pedido de ligação pelo modelo">
      {!shown ? (
        preview.error ? (
          <p className="crm-error">
            {messageOf(preview.error, 'Não foi possível montar a prévia.')}
          </p>
        ) : (
          <p className="crm-sub">Montando a prévia…</p>
        )
      ) : (
        <>
          <p className={`crm-wa-mode ${shown.charged ? 'is-charged' : 'is-free'}`}>
            {shown.sendAs === 'template'
              ? `Fora das 24 h: vai o modelo aprovado ${shown.version}${shown.charged ? ', cobrado pela Meta' : ''}.`
              : 'Vai o pedido de ligação da Meta, sem custo.'}
          </p>
          {shown.notices.map((notice) => (
            <p key={notice} className="crm-wa-notice">
              {notice}
            </p>
          ))}
          <div className="crm-wa-card" aria-label="Prévia da mensagem">
            <p className="crm-wa-preview">{shown.text}</p>
          </div>
          {!shown.ready && (
            <p className="crm-sub">
              Falta um campo do modelo: envie pela conversa, em "Usar modelo", e preencha.
            </p>
          )}
        </>
      )}
      <div className="crm-call-card-actions">
        <button
          type="button"
          className="crm-btn is-primary"
          disabled={!shown?.ready || ask.isPending}
          onClick={() =>
            shown &&
            ask.mutate(
              {
                template: {
                  params: shown.fields.map((field) => field.value),
                  expect: { sendAs: shown.sendAs, charged: shown.charged },
                },
              },
              { onSuccess: () => setOpen(false) },
            )
          }
        >
          Enviar pedido
        </button>
        <button type="button" className="crm-btn" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
