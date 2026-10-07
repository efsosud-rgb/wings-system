import {
  WA_KIND_LABELS,
  WA_STATUS_LABELS,
  type DealWhatsApp,
  type WaMessage,
  type WaTemplate,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  useRefreshWhatsAppTemplates,
  useSendWhatsAppTemplate,
  useSendWhatsAppText,
  useWhatsAppTemplates,
  whatsappMediaUrl,
  type WhatsAppThread,
} from '../../api/whatsapp.js';
import { formatDateTime } from './format.js';

/**
 * The conversation itself, for a deal or for one no deal took yet: the
 * messages with their status, the 24-hour window, and the field to answer —
 * free text inside the window, an approved template outside it (the server
 * checks both again).
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function WhatsAppChat({
  thread,
  data,
  canSend,
}: {
  thread: WhatsAppThread;
  data: DealWhatsApp;
  canSend: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const last = data.messages.at(-1)?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [last]);
  const [useTemplate, setUseTemplate] = useState(false);
  const templateMode = useTemplate || !data.window.open;

  return (
    <section className="crm-wa-chat" aria-label="Conversa">
      {data.speaksFor && (
        <p className="crm-wa-window is-brand">
          Lead de franquia: você fala pelo time de expansão da {data.speaksFor}. Não cite a Wings
          nas mensagens nem nos modelos.
        </p>
      )}
      <WindowNotice data={data} />
      <div className={`crm-wa-messages${data.messages.length > 0 ? ' has-messages' : ''}`}>
        {data.messages.length === 0 ? (
          <p className="crm-wa-empty">
            {data.configured
              ? 'Nenhuma mensagem ainda. Para falar primeiro, mande um modelo aprovado.'
              : 'Nenhuma mensagem ainda. A conversa aparece aqui quando a API oficial do WhatsApp estiver ligada.'}
          </p>
        ) : (
          <ol className="crm-wa-list">
            {data.messages.map((message) => (
              <Bubble key={message.id} message={message} />
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      {canSend && data.configured && data.phone ? (
        templateMode ? (
          <TemplateCompose
            thread={thread}
            optedOut={data.optedOut}
            windowOpen={data.window.open}
            onText={() => setUseTemplate(false)}
          />
        ) : (
          <TextCompose thread={thread} onTemplate={() => setUseTemplate(true)} />
        )
      ) : (
        <p className="crm-wa-off">
          {!data.configured
            ? 'O envio liga quando a API oficial do WhatsApp estiver ligada no sistema.'
            : !data.phone
              ? 'A negociação não tem telefone.'
              : 'Você não pode enviar por esta conversa.'}
        </p>
      )}
    </section>
  );
}

function WindowNotice({ data }: { data: DealWhatsApp }) {
  if (!data.configured) return null;
  if (data.optedOut)
    return (
      <p className="crm-wa-window is-closed">
        A pessoa pediu para não receber mensagens. Só dá para responder quando ela escrever.
      </p>
    );
  return data.window.open && data.window.expiresAt ? (
    <p className="crm-wa-window is-open">
      Janela de 24 h aberta até {formatDateTime(data.window.expiresAt)}: dá para escrever livre.
    </p>
  ) : (
    <p className="crm-wa-window is-closed">
      Fora das 24 h desde a última mensagem da pessoa: só vai modelo aprovado pela Meta.
    </p>
  );
}

function Bubble({ message }: { message: WaMessage }) {
  const out = message.direction === 'out';
  const failed = message.status === 'failed' || (message.status === 'pending' && message.error);
  return (
    <li
      className={`crm-wa-bubble ${out ? 'is-out' : 'is-in'}${message.bySofia ? ' is-sofia' : ''}${failed ? ' is-failed' : ''}`}
    >
      {message.template && <span className="crm-wa-tag">Modelo · {message.template.name}</span>}
      {message.media && (
        <a
          className="crm-wa-media"
          href={whatsappMediaUrl(message.id)}
          target="_blank"
          rel="noreferrer"
        >
          {message.kind === 'image' || message.kind === 'sticker' ? 'Abrir ' : 'Baixar '}
          {WA_KIND_LABELS[message.kind].toLowerCase()}
          {message.media.filename ? ` · ${message.media.filename}` : ''}
        </a>
      )}
      {message.text ? (
        <span className="crm-wa-text">{message.text}</span>
      ) : (
        !message.media && (
          <span className="crm-wa-text is-muted">{WA_KIND_LABELS[message.kind]}</span>
        )
      )}
      <span className="crm-wa-meta">
        {out && message.bySofia ? 'Sofia (IA) · ' : ''}
        {out && message.authorName ? `${message.authorName} · ` : ''}
        <time dateTime={message.at} title={formatDateTime(message.at)}>
          {timeOf(message.at)}
        </time>
        {out && message.status && !failed && ` · ${WA_STATUS_LABELS[message.status]}`}
      </span>
      {out && message.error && <span className="crm-wa-error">{message.error}</span>}
    </li>
  );
}

function TextCompose({ thread, onTemplate }: { thread: WhatsAppThread; onTemplate: () => void }) {
  const send = useSendWhatsAppText(thread);
  const [text, setText] = useState('');
  const submit = () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    send.mutate({ text: body }, { onSuccess: () => setText('') });
  };
  return (
    <form
      className="crm-wa-compose"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="crm-input"
        aria-label="Mensagem"
        placeholder="Escreva uma mensagem (Enter envia, Shift+Enter quebra a linha)"
        rows={2}
        maxLength={4096}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="crm-wa-compose-actions">
        <button
          type="submit"
          className="crm-btn is-primary"
          disabled={send.isPending || text.trim().length === 0}
        >
          Enviar
        </button>
        <button type="button" className="crm-btn is-quiet is-small" onClick={onTemplate}>
          Usar modelo
        </button>
      </div>
      {send.error && (
        <p className="crm-error">{errorText(send.error, 'Não foi possível enviar.')}</p>
      )}
    </form>
  );
}

function TemplateCompose({
  thread,
  optedOut,
  windowOpen,
  onText,
}: {
  thread: WhatsAppThread;
  optedOut: boolean;
  windowOpen: boolean;
  onText: () => void;
}) {
  const templates = useWhatsAppTemplates(true);
  const refresh = useRefreshWhatsAppTemplates();
  const send = useSendWhatsAppTemplate(thread);
  const list = templates.data?.templates ?? [];
  const [chosen, setChosen] = useState('');
  const template: WaTemplate | undefined = list.find((t) => `${t.name}|${t.language}` === chosen);
  const [params, setParams] = useState<string[]>([]);
  const paramCount = template?.paramCount ?? 0;
  useEffect(() => setParams(Array.from({ length: paramCount }, () => '')), [chosen, paramCount]);
  const preview = useMemo(
    () =>
      template?.body?.replace(
        /\{\{\s*(\d+)\s*\}\}/g,
        (all, n: string) => params[Number(n) - 1] || all,
      ),
    [template, params],
  );
  const ready = template && params.every((p) => p.trim().length > 0);
  const syncError = refresh.data?.syncError ?? templates.data?.syncError;

  if (optedOut && !windowOpen)
    return <p className="crm-wa-off">Envio pausado: a pessoa pediu para não receber mensagens.</p>;
  return (
    <form
      className="crm-wa-compose is-template"
      aria-label="Enviar modelo"
      onSubmit={(event) => {
        event.preventDefault();
        if (!template || !ready) return;
        send.mutate(
          { name: template.name, language: template.language, params: params.map((p) => p.trim()) },
          { onSuccess: () => setChosen('') },
        );
      }}
    >
      <div className="crm-row">
        <select
          className="crm-select"
          aria-label="Modelo"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">
            {templates.isLoading ? 'Carregando modelos…' : 'Escolha um modelo aprovado'}
          </option>
          {list.map((t) => (
            <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
              {t.name} ({t.language})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="crm-btn is-quiet is-small"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          Atualizar lista
        </button>
      </div>
      {!templates.isLoading && list.length === 0 && (
        <p className="crm-sub">
          Nenhum modelo aprovado ainda. Os modelos são criados no WhatsApp Manager.
        </p>
      )}
      {syncError && <p className="crm-error">{syncError}</p>}
      {template &&
        params.map((value, index) => (
          <input
            key={index}
            className="crm-input"
            aria-label={`Campo ${index + 1} do modelo`}
            placeholder={`Campo {{${index + 1}}}`}
            maxLength={1024}
            value={value}
            onChange={(event) =>
              setParams((current) => current.map((p, i) => (i === index ? event.target.value : p)))
            }
          />
        ))}
      {preview && <p className="crm-wa-preview">{preview}</p>}
      <div className="crm-wa-compose-actions">
        <button type="submit" className="crm-btn is-primary" disabled={!ready || send.isPending}>
          Enviar modelo
        </button>
        {windowOpen && (
          <button type="button" className="crm-btn is-quiet is-small" onClick={onText}>
            Escrever livre
          </button>
        )}
      </div>
      {send.error && (
        <p className="crm-error">{errorText(send.error, 'Não foi possível enviar o modelo.')}</p>
      )}
    </form>
  );
}
