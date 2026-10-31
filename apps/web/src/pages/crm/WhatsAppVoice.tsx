import { WA_VOICE_MAX_SECONDS, WA_VOICE_UPLOAD_MAX_BYTES } from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon.js';

/**
 * A voice note recorded in the conversation (docs/whatsapp/cloud-api.md, "Gravar áudio"): the
 * browser's own MediaRecorder, the microphone asked for only on the click, a timer that stops at
 * the limit, then listen, delete or send. The API converts the recording to a WhatsApp voice
 * message and keeps it in the deal's Arquivos.
 */

export type VoiceState =
  | { step: 'idle' }
  | { step: 'asking' }
  | { step: 'recording'; seconds: number }
  | { step: 'recorded'; blob: Blob; url: string; seconds: number };

/** What each browser records in, best first: WebM (Chrome, Edge), OGG (Firefox), MP4 (Safari). */
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

export const NO_RECORDING_TEXT =
  'Este navegador não grava áudio aqui. Use o Chrome, o Edge, o Firefox ou o Safari atualizados.';

/** Why the microphone did not open, and how to let it. */
export function micErrorText(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'O navegador não liberou o microfone. Para liberar: clique no cadeado ao lado do endereço do site, em "Microfone" escolha "Permitir" e clique no microfone de novo. No celular, libere também o microfone para o navegador nos ajustes do aparelho.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Nenhum microfone encontrado. Conecte um microfone e clique de novo.';
  if (name === 'NotReadableError')
    return 'O microfone está em uso por outro programa. Feche o outro programa e clique de novo.';
  return 'Não deu para abrir o microfone. Clique de novo.';
}

/** "1:05" */
export const clockOf = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function useVoiceRecorder() {
  const [state, setState] = useState<VoiceState>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const live = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const url = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      live.current?.cancel();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, []);

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
      return setError(NO_RECORDING_TEXT);
    setState({ step: 'asking' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (failure) {
      if (!mounted.current) return;
      setState({ step: 'idle' });
      return setError(micErrorText(failure));
    }
    const release = () => stream.getTracks().forEach((track) => track.stop());
    // The conversation closed while the browser asked: the microphone goes off at once.
    if (!mounted.current) return release();
    const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: 64_000,
    });
    const chunks: Blob[] = [];
    const started = Date.now();
    let discard = false;
    const elapsed = () => Math.min(WA_VOICE_MAX_SECONDS, Math.floor((Date.now() - started) / 1000));
    const stop = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    // Stops on its own at the limit: what was recorded stays to listen to and send.
    const timer = window.setInterval(() => {
      if (elapsed() >= WA_VOICE_MAX_SECONDS) stop();
      else setState({ step: 'recording', seconds: elapsed() });
    }, 250);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      window.clearInterval(timer);
      release();
      live.current = null;
      if (discard || !mounted.current) return setState({ step: 'idle' });
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      url.current = URL.createObjectURL(blob);
      setState({ step: 'recorded', blob, url: url.current, seconds: Math.max(1, elapsed()) });
    };
    live.current = {
      stop,
      cancel: () => {
        discard = true;
        stop();
      },
    };
    recorder.start(1000);
    setState({ step: 'recording', seconds: 0 });
  };

  /** Deletes what was recorded (or stops and deletes what is being recorded). */
  const discard = () => {
    live.current?.cancel();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setError(null);
    setState({ step: 'idle' });
  };

  return { state, error, setError, start, stop: () => live.current?.stop(), discard };
}

/** The recording above the field: the time while it records, then the player, delete and send. */
export function VoiceTray({
  state,
  busy,
  status,
  onStop,
  onDiscard,
  onSend,
}: {
  state: Exclude<VoiceState, { step: 'idle' }>;
  busy: boolean;
  status: string | null;
  onStop: () => void;
  onDiscard: () => void;
  onSend: () => void;
}) {
  const tooBig = state.step === 'recorded' && state.blob.size > WA_VOICE_UPLOAD_MAX_BYTES;
  return (
    <div className="crm-wa-attach crm-wa-voice" role="group" aria-label="Áudio gravado">
      <span className="crm-wa-attach-icon" aria-hidden="true">
        <Icon name="mic" size={20} />
      </span>
      <span className="crm-wa-attach-main">
        {state.step === 'asking' ? (
          <span role="status">Esperando a permissão do microfone…</span>
        ) : state.step === 'recording' ? (
          <strong role="status" aria-live="off">
            <span className="crm-wa-voice-dot" aria-hidden="true" /> Gravando{' '}
            <span aria-label="Tempo gravado">{clockOf(state.seconds)}</span> de{' '}
            {clockOf(WA_VOICE_MAX_SECONDS)}
          </strong>
        ) : (
          <>
            <audio controls src={state.url} aria-label="Ouvir a gravação" preload="metadata" />
            <span className="crm-sub">
              {clockOf(state.seconds)} · vai como mensagem de voz e fica nos arquivos da negociação
            </span>
          </>
        )}
        {tooBig && (
          <span className="crm-wa-error">
            A gravação ficou grande demais: grave uma mais curta.
          </span>
        )}
        {status && (
          <span className="crm-sub" role="status">
            {status}
          </span>
        )}
      </span>
      <div className="crm-wa-compose-actions">
        {state.step === 'recording' && (
          <button type="button" className="crm-btn is-small" onClick={onStop}>
            Parar
          </button>
        )}
        <button
          type="button"
          className="crm-btn is-quiet is-small"
          disabled={busy}
          onClick={onDiscard}
        >
          {state.step === 'recorded' ? 'Apagar' : 'Cancelar'}
        </button>
        {state.step === 'recorded' && (
          <button
            type="button"
            className="crm-btn is-primary is-small"
            disabled={busy || tooBig}
            onClick={onSend}
          >
            Enviar áudio
          </button>
        )}
      </div>
    </div>
  );
}
