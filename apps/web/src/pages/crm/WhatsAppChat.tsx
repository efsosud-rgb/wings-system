import {
  mentionsWings,
  WA_CAPTION_MAX,
  WA_KIND_LABELS,
  WA_STATUS_LABELS,
  waTemplateFamily,
  WA_MESSAGES_PAGE,
  type BrandArticle,
  type DealWhatsApp,
  type WaMessage,
  type WaQuote,
  type WaTemplate,
  type WaTemplatePreview,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import {
  NO_DEAL_FOR_FILES,
  olderWhatsAppMessages,
  useRefreshWhatsAppTemplates,
  useSendWhatsAppFile,
  useSendWhatsAppTemplate,
  useSendWhatsAppText,
  useTemplatePreview,
  useWhatsAppArt,
  useWhatsAppSoon,
  useWhatsAppTemplates,
  whatsappMediaUrl,
  WHATSAPP_SOON_TEXT,
  type WhatsAppThread,
} from '../../api/whatsapp.js';
import { Icon } from '../../components/Icon.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDateTime, formatPhone } from './format.js';
import { AttachTray, EmojiButton, pickedOf, type Picked } from './WhatsAppAttach.js';
import { dayLabel } from './whatsapp-time.js';

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
  notice,
  heldBy,
  onTyping,
}: {
  thread: WhatsAppThread;
  data: DealWhatsApp;
  canSend: boolean;
  /** Shown above the conversation: why what is on screen may be out of date. */
  notice?: ReactNode;
  /** Someone else holds the conversation: the reader takes it before answering (the API refuses). */
  heldBy?: string | null;
  /** The reader is typing: "está respondendo" for the others. */
  onTyping?: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const last = data.messages.at(-1)?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [last]);
  const [useTemplate, setUseTemplate] = useState(false);
  // A work number's chat (docs/whatsapp/central.md): free text and files only, inside its 24 h.
  const onNumber = Boolean(data.number);
  const templateMode = !onNumber && (useTemplate || !data.window.open);
  const older = useOlder(thread, data.messages);
  // The seller's "em breve" is the official number's; a work number is live once connected.
  const soon = useWhatsAppSoon() && !onNumber;
  // One composer per conversation: what was typed or chosen in one never goes to the next opened.
  const composerKey = 'leadId' in thread ? thread.leadId : thread.conversationId;

  return (
    <section className="crm-wa-chat" aria-label="Conversa">
      {notice}
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
            {older.more && (
              <li className="crm-wa-older">
                <button
                  type="button"
                  className="crm-btn is-small"
                  disabled={older.loading}
                  onClick={older.load}
                >
                  {older.loading ? 'Carregando…' : 'Mostrar mensagens anteriores'}
                </button>
                {older.error && <span className="crm-wa-error">{older.error}</span>}
              </li>
            )}
            {withDays([
              ...placedReactionsOut(older.messages),
              ...placedReactionsOut(data.messages),
            ]).map((item) =>
              'day' in item ? (
                <li key={item.key} className="crm-wa-day" role="separator">
                  <span>{item.day}</span>
                </li>
              ) : (
                <Bubble key={item.id} message={item} />
              ),
            )}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      {canSend && !soon && data.configured && data.phone ? (
        heldBy ? (
          <p className="crm-wa-off">
            Esta conversa está com {heldBy}. Para responder, assuma a conversa ({heldBy} recebe um
            aviso).
          </p>
        ) : onNumber && !data.window.open ? (
          <p className="crm-wa-off">
            Fora das 24 h da última mensagem da pessoa para este número: só dá para responder quando
            ela escrever de novo. Para falar primeiro, use o número oficial e um modelo aprovado.
          </p>
        ) : templateMode ? (
          <TemplateCompose
            key={composerKey}
            thread={thread}
            optedOut={data.optedOut}
            windowOpen={data.window.open}
            onText={() => setUseTemplate(false)}
          />
        ) : (
          <TextCompose
            key={composerKey}
            thread={thread}
            leadId={data.leadId}
            onTemplate={onNumber ? undefined : () => setUseTemplate(true)}
            onTyping={onTyping}
          />
        )
      ) : (
        <p className="crm-wa-off">
          {!data.configured
            ? onNumber
              ? 'Este número não está conectado ao sistema agora: o envio volta quando ele for conectado de novo.'
              : 'O envio liga quando a API oficial do WhatsApp estiver ligada no sistema.'
            : !canSend
              ? 'Você não pode enviar por esta conversa.'
              : soon
                ? WHATSAPP_SOON_TEXT
                : 'A negociação não tem telefone.'}
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
  ) : data.number ? null : (
    <p className="crm-wa-window is-closed">
      Fora das 24 h desde a última mensagem da pessoa: só vai modelo aprovado pela Meta.
    </p>
  );
}

/**
 * The deal's messages before the ones the refresh keeps on screen (the last
 * WA_MESSAGES_PAGE), a page per click: a long chat imported from the phone
 * reads back to its start. Kept apart from the refresh, which never drops them.
 */
function useOlder(thread: WhatsAppThread, shown: WaMessage[]) {
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leadId = 'leadId' in thread ? thread.leadId : null;
  useEffect(() => {
    setMessages([]);
    setEnded(false);
    setError(null);
  }, [leadId]);
  const oldest = messages[0] ?? shown[0];
  const more =
    'leadId' in thread && !ended && oldest !== undefined && shown.length >= WA_MESSAGES_PAGE;
  const load = () => {
    if (!('leadId' in thread) || !oldest) return;
    setLoading(true);
    setError(null);
    olderWhatsAppMessages(thread.leadId, oldest.id)
      .then((page) => {
        const known = new Set([...messages, ...shown].map((m) => m.id));
        setMessages([...page.filter((m) => !known.has(m.id)), ...messages]);
        if (page.length < WA_MESSAGES_PAGE) setEnded(true);
      })
      .catch((failure: unknown) =>
        setError(errorText(failure, 'Não deu para carregar as anteriores.')),
      )
      .finally(() => setLoading(false));
  };
  return { messages, more, load, loading, error };
}

/**
 * A file inside the balloon: a photo or a sticker shown, an audio or a video
 * with the browser's player (fetched only on play), anything else a download.
 * The address answers from our storage once a received file is copied (from
 * Meta before that), and from the deal's Arquivos for one the team sent.
 */
const UNPLAYABLE = new Set(['audio/amr', 'video/3gpp']);

function MediaBody({ message }: { message: WaMessage }) {
  const [broken, setBroken] = useState(false);
  const url = whatsappMediaUrl(message.id);
  const label = WA_KIND_LABELS[message.kind];
  const download = (
    <a className="crm-wa-media" href={url} target="_blank" rel="noreferrer">
      {message.kind === 'image' || message.kind === 'sticker' ? 'Abrir ' : 'Baixar '}
      {label.toLowerCase()}
      {message.media?.filename ? ` · ${message.media.filename}` : ''}
    </a>
  );
  if (broken)
    return (
      <span className="crm-wa-media-failed">
        — {label}: não abriu aqui. Tente pelo link; se a mensagem tem mais de 30 dias e o arquivo
        não foi guardado, ele já saiu da Meta. {download}
      </span>
    );
  const fail = () => setBroken(true);
  // Browsers do not play these: the file goes as a download (the API serves it so).
  if (UNPLAYABLE.has(message.media?.mimeType?.split(';')[0]?.trim() ?? '')) return download;
  if (message.kind === 'image' || message.kind === 'sticker')
    return (
      <a className="crm-wa-shot" href={url} target="_blank" rel="noreferrer">
        <img
          className={message.kind === 'sticker' ? 'is-sticker' : undefined}
          src={url}
          alt={`${label} ${message.direction === 'out' ? 'enviada' : 'recebida'} pelo WhatsApp`}
          loading="lazy"
          onError={fail}
        />
      </a>
    );
  if (message.kind === 'audio')
    return (
      <audio className="crm-wa-player" src={url} controls preload="none" onError={fail}>
        {download}
      </audio>
    );
  if (message.kind === 'video')
    return (
      <video className="crm-wa-player is-video" src={url} controls preload="none" onError={fail}>
        {download}
      </video>
    );
  return download;
}

/** Why a quoted or reacted-to message is not in this conversation (the API looks only here). */
const NOT_HERE =
  'é de antes de o número entrar no sistema, está em outra negociação desta pessoa, ou ficou só no celular.';

/** The message a reply quotes, at the top of the balloon, as WhatsApp shows it. */
function Quote({ quote }: { quote: WaQuote }) {
  if (!quote.found)
    return (
      <span className="crm-wa-quote is-missing">
        — A mensagem respondida não está aqui: {NOT_HERE}
      </span>
    );
  return (
    <span className="crm-wa-quote">
      <strong>{quote.direction === 'out' ? 'Equipe' : 'Cliente'}</strong>
      <span className="crm-wa-quote-text">{quote.text ?? WA_KIND_LABELS[quote.kind]}</span>
    </span>
  );
}

const sideOf = (direction: 'in' | 'out') => (direction === 'out' ? 'da equipe' : 'do cliente');

/**
 * A reaction whose message is not on this list: a line saying what it was for. One whose message
 * is on the list shows on that balloon instead (`placedReactionsOut`).
 */
function ReactionLine({ message }: { message: WaMessage }) {
  const who = message.direction === 'out' ? 'Equipe' : 'Cliente';
  const what = message.text ? `${who} reagiu com ${message.text}` : `${who} tirou a reação`;
  const to = message.reactionTo;
  return (
    <li className={`crm-wa-reaction-line ${message.direction === 'out' ? 'is-out' : 'is-in'}`}>
      {to?.found ? (
        <>
          {what} {message.text ? 'a' : 'de'}: <q>{to.text ?? WA_KIND_LABELS[to.kind]}</q>
        </>
      ) : (
        `${what}. — A mensagem da reação não está aqui: ${NOT_HERE}`
      )}{' '}
      <time dateTime={message.at} title={formatDateTime(message.at)}>
        {timeOf(message.at)}
      </time>
    </li>
  );
}

/**
 * Leaves out each reaction whose message is on the same list: that balloon came in the same
 * answer (or an older page loaded after it) and already shows it. A reaction to a balloon of
 * another list stays a line, so a new one to an older page's message is never missed.
 */
function placedReactionsOut(list: WaMessage[]) {
  const ids = new Set(list.map((m) => m.id));
  return list.filter(
    (m) => !(m.kind === 'reaction' && m.reactionTo?.found && ids.has(m.reactionTo.id)),
  );
}

/** The messages with a mark before the first of each day ("Hoje", "Ontem", ...), as WhatsApp shows them. */
function withDays(messages: WaMessage[]) {
  const now = new Date();
  const items: Array<WaMessage | { day: string; key: string }> = [];
  let last = '';
  for (const message of messages) {
    const key = new Date(message.at).toDateString();
    // Keyed by the run's first message: a late message can bring a day back further down.
    if (key !== last) items.push({ day: dayLabel(message.at, now), key: `day-${message.id}` });
    last = key;
    items.push(message);
  }
  return items;
}

/** A contact card: each contact's name and numbers, or "—" and why something is missing. */
function ContactCards({ message }: { message: WaMessage }) {
  if (!message.contacts)
    return (
      <span className="crm-wa-contacts">
        {message.text && <strong>{message.text}</strong>}
        <span className="crm-wa-media-failed">
          — Cartão de contato sem o número: chegou antes de o sistema guardar os números dos
          cartões.
        </span>
      </span>
    );
  if (message.contacts.length === 0)
    return (
      <span className="crm-wa-media-failed">
        — Cartão de contato vazio: o WhatsApp não mandou nome nem número.
      </span>
    );
  return (
    <span className="crm-wa-contacts">
      {message.contacts.map((card, index) => (
        <span key={index} className="crm-wa-contact">
          <strong>{card.name ?? '— Sem nome no cartão'}</strong>
          {card.phones.length > 0 ? (
            card.phones.map((phone, i) => <span key={i}>{formatPhone(phone)}</span>)
          ) : (
            <span className="crm-wa-media-failed">— Sem número no cartão.</span>
          )}
        </span>
      ))}
    </span>
  );
}

/** A location: the place's name and address, and the point opened in Google Maps. */
function Place({ message }: { message: WaMessage }) {
  const place = message.location;
  const point =
    place && place.latitude !== null && place.longitude !== null
      ? `${place.latitude},${place.longitude}`
      : null;
  return (
    <span className="crm-wa-place">
      <strong>{place?.name ?? WA_KIND_LABELS.location}</strong>
      {place?.address && <span>{place.address}</span>}
      {point ? (
        <a
          className="crm-wa-media"
          href={`https://www.google.com/maps/search/?api=1&query=${point}`}
          target="_blank"
          rel="noreferrer"
        >
          Abrir no mapa
        </a>
      ) : (
        <span className="crm-wa-media-failed">
          — Sem o ponto no mapa: o WhatsApp não mandou as coordenadas.
        </span>
      )}
    </span>
  );
}

function Bubble({ message }: { message: WaMessage }) {
  const out = message.direction === 'out';
  const failed = message.status === 'failed' || (message.status === 'pending' && message.error);
  if (message.kind === 'reaction') return <ReactionLine message={message} />;
  return (
    <li
      className={`crm-wa-bubble ${out ? 'is-out' : 'is-in'}${message.bySofia ? ' is-sofia' : ''}${failed ? ' is-failed' : ''}`}
    >
      {message.replyTo && <Quote quote={message.replyTo} />}
      {message.template && (
        <span className="crm-wa-tag">
          Modelo · {message.template.name}
          {message.withArt ? ' · com arte' : ''}
        </span>
      )}
      {message.fromTemplate && (
        <span className="crm-wa-tag">
          Do modelo {message.fromTemplate}, como mensagem comum
          {message.withArt ? ' · com arte' : ''}
        </span>
      )}
      {message.media && <MediaBody message={message} />}
      {message.imported && (
        <span className="crm-wa-tag">
          Do celular
          {message.imported.file
            ? ` · ${WA_KIND_LABELS[message.kind]} ${message.imported.file}, dentro do arquivo exportado`
            : message.imported.omitted
              ? ' · mídia que não veio na exportação'
              : ''}
        </span>
      )}
      {message.kind === 'contacts' && !message.imported ? (
        <ContactCards message={message} />
      ) : message.kind === 'location' ? (
        <Place message={message} />
      ) : message.text ? (
        <span className="crm-wa-text">{message.text}</span>
      ) : (
        !message.media &&
        !message.imported?.file &&
        !message.imported?.omitted && (
          <span className="crm-wa-text is-muted">{WA_KIND_LABELS[message.kind]}</span>
        )
      )}
      {message.reactions && message.reactions.length > 0 && (
        <span className="crm-wa-reactions">
          {message.reactions.map((reaction) => (
            <span
              key={reaction.direction}
              role="img"
              aria-label={`Reação ${sideOf(reaction.direction)}: ${reaction.emoji}`}
              title={`Reação ${sideOf(reaction.direction)}`}
            >
              {reaction.emoji}
            </span>
          ))}
        </span>
      )}
      <span className="crm-wa-meta">
        {out && message.bySofia ? 'Sofia (IA) · ' : ''}
        {out && message.authorName ? `${message.authorName} · ` : ''}
        {out && message.fromPhone ? 'Pelo celular · ' : ''}
        <time dateTime={message.at} title={formatDateTime(message.at)}>
          {timeOf(message.at)}
        </time>
        {out && message.status && !failed && ` · ${WA_STATUS_LABELS[message.status]}`}
      </span>
      {out && message.error && <span className="crm-wa-error">{message.error}</span>}
    </li>
  );
}

/** Why the 📎 is off for this reader (null: it is on). The file goes up to the deal's Arquivos first. */
function attachOffOf(leadId: string | null, canEditDeal: boolean) {
  if (!leadId) return NO_DEAL_FOR_FILES;
  if (!canEditDeal)
    return 'Para anexar, é preciso poder editar a negociação: o arquivo fica nos arquivos dela.';
  return null;
}

/**
 * Free text inside the window, with emoji, or one file of the deal (photo, video, document,
 * audio) with the text as its caption. The file goes up to the deal's Arquivos, then by its id.
 */
function TextCompose({
  thread,
  leadId,
  onTemplate,
  onTyping,
}: {
  thread: WhatsAppThread;
  leadId: string | null;
  /** Absent on a work number's chat: its templates come later. */
  onTemplate?: () => void;
  onTyping?: () => void;
}) {
  const send = useSendWhatsAppText(thread);
  const sendFile = useSendWhatsAppFile(thread, leadId);
  const session = useSession();
  const attachOff = attachOffOf(leadId, hasPermission(session.data, 'leads.write'));
  const field = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // Why the 📎 is off, or why the chosen file cannot go: shown under the field.
  const [note, setNote] = useState<string | null>(null);
  const captionless = picked?.kind === 'audio';

  const pick = (file: File | undefined) => {
    if (!file) return;
    sendFile.reset();
    const next = pickedOf(file);
    setPicked(typeof next === 'string' ? null : next);
    setNote(typeof next === 'string' ? `${file.name}: ${next}` : null);
  };

  const sendPicked = (over: { uploaded: string | null; file?: File }) => {
    if (!picked || sendFile.isPending) return;
    const caption = captionless ? '' : text.trim();
    // Checked before the upload: the API would refuse it only after the file went up.
    if (caption.length > WA_CAPTION_MAX)
      return setNote(`Legenda de até ${WA_CAPTION_MAX} caracteres: encurte o texto para enviar.`);
    setNote(null);
    const file = over.file ?? picked.file;
    if (over.file) setPicked({ ...picked, file, taken: null, renameWhy: null });
    sendFile.mutate(
      {
        file,
        uploaded: over.uploaded,
        caption,
        onProgress: setProgress,
        onUploaded: (fileId) => setPicked((now) => now && { ...now, uploaded: fileId }),
      },
      {
        onSuccess: () => {
          setPicked(null);
          // An audio went without the text: it stays for the next message.
          if (!captionless) setText('');
        },
        onError: (error) => {
          if (!(error instanceof ApiError)) return;
          const existing =
            error.code === 'name_taken'
              ? (error.body as { existingFileId?: unknown }).existingFileId
              : undefined;
          // A name that cannot go is a choice in the tray (another name), not an error line.
          const renameWhy =
            typeof existing === 'string'
              ? 'Já existe um arquivo com este nome nos arquivos da negociação.'
              : error.code === 'file_not_found' && picked.taken && over.uploaded === picked.taken
                ? // The file the name belongs to was taken off the deal (it stays in its folder).
                  'O arquivo com este nome não está mais nos arquivos da negociação: envie este com outro nome.'
                : error.code === 'brand_voice' &&
                    !mentionsWings(caption) &&
                    mentionsWings(file.name)
                  ? error.message
                  : null;
          if (renameWhy)
            setPicked(
              (now) =>
                now && {
                  ...now,
                  uploaded: null,
                  taken: typeof existing === 'string' ? existing : null,
                  renameWhy,
                },
            );
        },
        onSettled: () => setProgress(null),
      },
    );
  };

  const submit = () => {
    // A name the deal already has waits for the choice in the tray.
    if (picked) return picked.renameWhy ? undefined : sendPicked({ uploaded: picked.uploaded });
    const body = text.trim();
    if (!body || send.isPending) return;
    send.mutate({ text: body }, { onSuccess: () => setText('') });
  };

  /** The emoji goes where the cursor is, and the cursor after it. */
  const insert = (emoji: string) => {
    const el = field.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const busy = send.isPending || sendFile.isPending;
  const status =
    progress !== null && progress < 1
      ? `Subindo para os arquivos da negociação… ${Math.round(progress * 100)}%`
      : sendFile.isPending
        ? 'Enviando…'
        : null;
  // A name that cannot go is not a failure: the tray says why and offers another name.
  const failure = picked?.renameWhy
    ? null
    : sendFile.error
      ? sendFile.error instanceof TypeError
        ? // No answer: the request may have arrived, so nothing is claimed either way.
          'Sem resposta do servidor. Confira a conexão e, antes de tentar de novo, veja se o arquivo já aparece na conversa.'
        : // The upload's own words too (the storage refused, the connection fell).
          sendFile.error.message || 'Não foi possível enviar o arquivo.'
      : send.error && errorText(send.error, 'Não foi possível enviar.');
  return (
    <form
      className="crm-wa-compose"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {picked && (
        <AttachTray
          picked={picked}
          status={status}
          busy={busy}
          onRemove={() => {
            setPicked(null);
            sendFile.reset();
          }}
          onUseExisting={() => picked.taken && sendPicked({ uploaded: picked.taken })}
          onRename={(name) =>
            sendPicked({
              uploaded: null,
              file: new File([picked.file], name, { type: picked.file.type }),
            })
          }
        />
      )}
      <div className="crm-wa-compose-tools">
        <EmojiButton onPick={insert} />
        <input
          ref={chooser}
          type="file"
          hidden
          aria-label="Escolher o arquivo"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="crm-wa-tool"
          aria-label="Anexar arquivo"
          title={attachOff ?? 'Anexar foto, vídeo, documento ou áudio'}
          aria-disabled={attachOff !== null || busy}
          onClick={() => {
            if (busy) return;
            if (attachOff) setNote(attachOff);
            else chooser.current?.click();
          }}
        >
          <Icon name="paperclip" size={20} />
        </button>
      </div>
      <textarea
        ref={field}
        className="crm-input"
        aria-label={picked ? 'Legenda' : 'Mensagem'}
        placeholder={
          captionless
            ? 'Áudio vai sem legenda: o texto fica para a próxima mensagem'
            : picked
              ? 'Legenda (opcional)'
              : 'Escreva uma mensagem (Enter envia, Shift+Enter quebra a linha)'
        }
        rows={2}
        maxLength={picked ? WA_CAPTION_MAX : 4096}
        disabled={captionless}
        // What goes is what was there on the click: no edit while it goes, none lost after.
        readOnly={busy}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onTyping?.();
        }}
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
          disabled={busy || (picked ? picked.renameWhy !== null : text.trim().length === 0)}
        >
          {picked ? 'Enviar arquivo' : 'Enviar'}
        </button>
        {onTemplate && (
          <button type="button" className="crm-btn is-quiet is-small" onClick={onTemplate}>
            Usar modelo
          </button>
        )}
      </div>
      {note && <p className="crm-wa-note">{note}</p>}
      {failure && <p className="crm-error">{failure}</p>}
    </form>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  MARKETING: 'marketing',
  UTILITY: 'utilidade',
  AUTHENTICATION: 'autenticação',
};

/** The value after the person stopped typing for a moment (the preview asks the server then). */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** What goes out: a common message inside the window, or the approved template, and its cost. */
export function sendModeText(preview: WaTemplatePreview): string {
  if (preview.sendAs === 'free')
    return `Mensagem comum, sem custo${
      preview.windowExpiresAt ? ` (janela aberta até ${timeOf(preview.windowExpiresAt)})` : ''
    }`;
  const category = preview.category
    ? (CATEGORY_LABELS[preview.category] ?? preview.category.toLowerCase())
    : null;
  return `Modelo aprovado (${category ? `${category}: ` : ''}${
    preview.charged ? 'cobrado pela Meta' : 'sem custo dentro da janela'
  })`;
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
  // What the seller typed, for this template only: switching templates starts from the server's values.
  const [draft, setDraft] = useState<{ key: string; params: string[] } | null>(null);
  const [companyArticle, setCompanyArticle] = useState<BrandArticle>('a');
  useEffect(() => setCompanyArticle('a'), [chosen]);
  const typed = draft?.key === chosen ? draft.params : null;
  const settledParams = useSettled(typed);
  const input = useMemo(
    () =>
      template
        ? {
            name: template.name,
            language: template.language,
            // Empty: the server fills what it knows (lead, seller, brand, company).
            params: settledParams ?? [],
            companyArticle,
          }
        : null,
    [template, settledParams, companyArticle],
  );
  const previewQuery = useTemplatePreview(thread, input);
  const data = previewQuery.data?.preview;
  // The last preview of the chosen template: its fields stay on screen, and keep the focus, while
  // the next one loads (the seller typing the company lost it at every pause, 26/10).
  const shown =
    template &&
    data &&
    data.family === waTemplateFamily(template.name) &&
    data.language === template.language
      ? data
      : undefined;
  // Only a fresh preview can be sent, never the previous one shown while this one loads.
  const preview = shown && !previewQuery.isPlaceholderData ? shown : undefined;
  const { refetch } = previewQuery;
  // When the window closes, what goes changes (a common message becomes a paid template): ask again.
  const closesAt = preview?.windowExpiresAt ? new Date(preview.windowExpiresAt).getTime() : null;
  useEffect(() => {
    if (closesAt === null) return;
    const timer = setTimeout(() => void refetch(), Math.max(0, closesAt - Date.now()) + 1_000);
    return () => clearTimeout(timer);
  }, [closesAt, refetch]);
  const art = useWhatsAppArt(thread, Boolean(shown?.withArt));
  const values = shown
    ? shown.fields.map((field, i) => (field.locked ? field.value : (typed?.[i] ?? field.value)))
    : [];
  const ready =
    preview !== undefined &&
    preview.fields.every((field, i) => (field.locked ? true : (values[i] ?? '').trim() !== ''));
  const syncError = refresh.data?.syncError ?? templates.data?.syncError;

  if (optedOut)
    return (
      <div className="crm-wa-compose is-template">
        <p className="crm-wa-off">
          Modelos pausados: a pessoa pediu para não receber mensagens.{' '}
          {windowOpen ? 'Responda escrevendo livre.' : 'Só dá para responder quando ela escrever.'}
        </p>
        {windowOpen && (
          <div className="crm-wa-compose-actions">
            <button type="button" className="crm-btn is-quiet is-small" onClick={onText}>
              Escrever livre
            </button>
          </div>
        )}
      </div>
    );
  return (
    <form
      className="crm-wa-compose is-template"
      aria-label="Enviar modelo"
      onSubmit={(event) => {
        event.preventDefault();
        if (!template || !preview || !ready || send.isPending) return;
        send.mutate(
          {
            name: template.name,
            language: template.language,
            params: values.map((value) => value.trim()),
            companyArticle,
            // What the screen showed: if it changed (the window closed), the server asks again.
            expect: { sendAs: preview.sendAs, charged: preview.charged },
          },
          {
            onSuccess: () => {
              setChosen('');
              setDraft(null);
            },
            onError: (error) => {
              if (error instanceof ApiError && error.code === 'send_mode_changed') void refetch();
            },
          },
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
              {t.name} ({t.language}){t.artVersion ? ' · com arte' : ''}
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
      {templates.isError && (
        <LoadFailure
          what="os modelos"
          error={templates.error}
          onRetry={() => void templates.refetch()}
        />
      )}
      {templates.isSuccess && list.length === 0 && (
        <p className="crm-sub">
          Nenhum modelo aprovado ainda. Os modelos são criados no WhatsApp Manager.
        </p>
      )}
      {syncError && <p className="crm-error">{syncError}</p>}
      {template && previewQuery.isError && (
        <p className="crm-error">
          {errorText(previewQuery.error, 'Não deu para montar a prévia deste modelo.')}
        </p>
      )}
      {template && !shown && !previewQuery.isError && <p className="crm-sub">Montando a prévia…</p>}
      {shown && (
        <>
          {shown.fields.length > 0 && (
            <div className="crm-wa-fields">
              {shown.fields.map((field, index) => (
                <label key={field.index}>
                  {field.label}
                  <input
                    className="crm-input"
                    aria-label={`${field.label} ({{${field.index}}})`}
                    maxLength={1024}
                    value={field.locked ? field.value : (values[index] ?? '')}
                    disabled={field.locked}
                    title={field.locked ? 'A marca desta conversa' : undefined}
                    onChange={(event) =>
                      setDraft({
                        key: chosen,
                        params: values.map((value, i) =>
                          i === index ? event.target.value : value,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {shown.usesCompanyArticle && (
            <fieldset className="crm-wa-article">
              <legend className="sr-only">Artigo da empresa</legend>
              <span>Empresa:</span>
              <label>
                <input
                  type="radio"
                  name="company-article"
                  checked={companyArticle === 'a'}
                  onChange={() => setCompanyArticle('a')}
                />{' '}
                a (da Padaria)
              </label>
              <label>
                <input
                  type="radio"
                  name="company-article"
                  checked={companyArticle === 'o'}
                  onChange={() => setCompanyArticle('o')}
                />{' '}
                o (do Bar)
              </label>
            </fieldset>
          )}
          <p className={`crm-wa-mode ${shown.charged ? 'is-charged' : 'is-free'}`}>
            {sendModeText(shown)}
          </p>
          {shown.reason && <p className="crm-wa-reason">Por que vai como modelo: {shown.reason}</p>}
          {shown.notices.map((notice) => (
            <p key={notice} className="crm-wa-notice">
              {notice}
            </p>
          ))}
          {shown.withArt && art.isError && (
            <LoadFailure
              what="a arte do cabeçalho"
              error={art.error}
              onRetry={() => void art.refetch()}
            />
          )}
          <div className="crm-wa-card" aria-label="Prévia da mensagem">
            {shown.withArt && art.data && <img src={art.data.url} alt="Arte do cabeçalho" />}
            <p className="crm-wa-preview">{shown.text}</p>
            {shown.footer && <span className="crm-wa-card-footer">{shown.footer}</span>}
            {shown.buttons.length > 0 && (
              <div className="crm-wa-card-buttons">
                {shown.buttons.map((title) => (
                  <span key={title}>{title}</span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <div className="crm-wa-compose-actions">
        <button type="submit" className="crm-btn is-primary" disabled={!ready || send.isPending}>
          {shown?.sendAs === 'free' ? 'Enviar mensagem' : 'Enviar modelo'}
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
