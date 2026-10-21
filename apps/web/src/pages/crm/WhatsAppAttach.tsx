import { WA_SEND_LIMITS, waSendKindOf, type WaSendKind } from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon.js';
import { formatBytes } from '../../components/drive/DriveParts.js';

/**
 * What the composer adds to a message (docs/whatsapp/cloud-api.md, "Enviar arquivo"): a file of
 * the deal, shown above the field with what it goes as, and a fixed grid of emoji. What a file
 * goes as is `waSendKindOf` in packages/shared, the rule the API checks again.
 */

export interface Picked {
  file: File;
  kind: WaSendKind;
  /** Its id once it is in the deal's Arquivos: a new try sends it without going up again. */
  uploaded: string | null;
  /** The id of the deal's file that already has this name. */
  taken: string | null;
}

/** The file as it would go, or why it cannot. */
export function pickedOf(file: File): Picked | string {
  const goes = waSendKindOf({
    mimeType: file.type || 'application/octet-stream',
    byteSize: file.size,
  });
  if (!goes) return 'O WhatsApp aceita arquivos de até 100 MB.';
  return { file, kind: goes.kind, uploaded: null, taken: null };
}

type Playable = Exclude<WaSendKind, 'document'>;
const NOUN: Record<Playable, string> = { image: 'foto', video: 'vídeo', audio: 'áudio' };
const FORMATS: Record<Playable, string> = {
  image: 'o WhatsApp só mostra JPG e PNG como foto',
  video: 'o WhatsApp só mostra MP4 e 3GP como vídeo',
  audio: 'formato de áudio que o WhatsApp não toca',
};

/** "vai como foto", or why a photo, a video or an audio goes as a document. */
export function goesText(picked: Picked): string {
  if (picked.kind === 'image') return 'vai como foto';
  if (picked.kind === 'video') return 'vai como vídeo';
  if (picked.kind === 'audio') return 'vai como áudio, sem legenda';
  const family = picked.file.type.split('/')[0];
  if (family !== 'image' && family !== 'video' && family !== 'audio') return 'vai como documento';
  const limit = WA_SEND_LIMITS[family];
  return picked.file.size > limit
    ? `vai como documento: ${NOUN[family]} acima de ${limit / 1_000_000} MB`
    : `vai como documento: ${FORMATS[family]}`;
}

const KIND_ICON: Record<WaSendKind, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'file-text',
};

/** "proposta (2).pdf": the name the deal does not have yet, offered when it has this one. */
const renamed = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (2)${name.slice(dot)}` : `${name} (2)`;
};

/** The file chosen, above the field: name, size, what it goes as, and the upload's progress. */
export function AttachTray({
  picked,
  status,
  busy,
  onRemove,
  onUseExisting,
  onRename,
}: {
  picked: Picked;
  status: string | null;
  busy: boolean;
  onRemove: () => void;
  onUseExisting: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => setName(null), [picked.taken]);
  return (
    <div className="crm-wa-attach" role="group" aria-label="Arquivo para enviar">
      <span className="crm-wa-attach-icon" aria-hidden="true">
        <Icon name={KIND_ICON[picked.kind]} size={20} />
      </span>
      <span className="crm-wa-attach-main">
        <strong className="crm-wa-attach-name">{picked.file.name}</strong>
        <span className="crm-sub">
          {formatBytes(picked.file.size)} · {goesText(picked)}
        </span>
        {status && (
          <span className="crm-sub" role="status">
            {status}
          </span>
        )}
      </span>
      <button
        type="button"
        className="crm-btn is-quiet is-small"
        disabled={busy}
        onClick={onRemove}
        aria-label="Tirar o arquivo"
      >
        <Icon name="x" size={16} />
      </button>
      {picked.taken && (
        <div className="crm-wa-attach-taken">
          <p>Já existe um arquivo com este nome nos arquivos da negociação.</p>
          {name === null ? (
            <div className="crm-wa-compose-actions">
              <button
                type="button"
                className="crm-btn is-small"
                disabled={busy}
                onClick={onUseExisting}
              >
                Enviar o que já está lá
              </button>
              <button
                type="button"
                className="crm-btn is-small"
                disabled={busy}
                onClick={() => setName(renamed(picked.file.name))}
              >
                Enviar com outro nome
              </button>
            </div>
          ) : (
            // Inside the composer's form: Enter here renames, it never sends the message.
            <div className="crm-wa-compose-actions">
              <input
                className="crm-input"
                aria-label="Novo nome do arquivo"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (name.trim() && !busy) onRename(name.trim());
                }}
              />
              <button
                type="button"
                className="crm-btn is-small is-primary"
                disabled={busy || !name.trim()}
                onClick={() => onRename(name.trim())}
              >
                Enviar com este nome
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The emoji a seller reaches for most; the computer's own emoji keyboard has the rest. */
// prettier-ignore
const EMOJIS = [
  '😊', '😀', '😄', '😁', '😅', '😂', '🙂', '😉',
  '😍', '🥰', '😘', '🤗', '🤩', '🤔', '😎', '😇',
  '😮', '😢', '🙏', '👍', '👏', '🙌', '💪', '🤝',
  '👋', '👌', '✌️', '🤞', '✅', '❤️', '💙', '🔥',
  '⭐', '🎉', '🥳', '🚀', '💼', '📈', '💰', '📍',
  '📅', '⏰', '📞', '📲', '✉️', '📄', '📎', '👀',
];

/** 😊 and a fixed grid that puts the emoji where the cursor is; Esc or a click outside closes it. */
export function EmojiButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="crm-wa-emoji" ref={box}>
      <button
        ref={button}
        type="button"
        className="crm-wa-tool"
        aria-label="Emojis"
        title="Emojis"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="smile" size={20} />
      </button>
      {open && (
        <div
          className="crm-wa-emoji-grid"
          role="group"
          aria-label="Escolha um emoji"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
        >
          {EMOJIS.map((emoji) => (
            <button key={emoji} type="button" onClick={() => onPick(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
