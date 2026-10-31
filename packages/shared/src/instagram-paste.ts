import { normalizeInstagram } from './lead-fields.js';

/**
 * Prospecção Instagram, parte 2 (docs/prospeccao/instagram.md §4): the seller copies the comments
 * of a competitor's post by hand and pastes the text; this reads it. Pure: no network, no AI, and
 * the pasted text is never kept (the API drops it with the request).
 */

export const INSTAGRAM_PASTE_FORMATS = [
  'web_computador',
  'web_celular',
  'manual',
  'misto',
] as const;
export type InstagramPasteFormat = (typeof INSTAGRAM_PASTE_FORMATS)[number];

/** Whole lines of Instagram's interface, ignored and counted by kind. */
export const PASTE_IGNORED_KINDS = [
  'tempo',
  'curtidas',
  'responder',
  'traducao',
  'respostas',
  'carregar_mais',
  'adicionar_comentario',
  'publicar',
  'rotulo',
] as const;
export type PasteIgnoredKind = (typeof PASTE_IGNORED_KINDS)[number];

export const PASTE_IGNORED_LABELS: Record<PasteIgnoredKind, string> = {
  tempo: 'tempo solto',
  curtidas: 'curtidas',
  responder: '"Responder"',
  traducao: '"Ver tradução"',
  respostas: '"Ver respostas"',
  carregar_mais: '"Carregar mais comentários"',
  adicionar_comentario: '"Adicione um comentário"',
  publicar: '"Publicar"',
  rotulo: 'rótulos (Verificado, Autor…)',
};

/** Comments read but not kept. */
export const PASTE_DISCARD_KINDS = ['dono_do_post', 'wings', 'vazio', 'repetido'] as const;
export type PasteDiscardKind = (typeof PASTE_DISCARD_KINDS)[number];

export const PASTE_DISCARD_LABELS: Record<PasteDiscardKind, string> = {
  dono_do_post: 'do dono do post (legenda e respostas)',
  wings: 'da própria Wings',
  vazio: 'sem texto',
  repetido: 'repetidos na colagem',
};

/** How many unrecognized lines the preview shows the seller. */
export const PASTE_UNRECOGNIZED_SHOWN = 20;

export interface PastedComment {
  /** The commenter's @, lower case, without the arroba. */
  username: string;
  text: string;
  /** The time marker as Instagram wrote it ("2 sem", "há 2 dias", "12/10"), or null. */
  when: string | null;
  format: Exclude<InstagramPasteFormat, 'misto'>;
}

export interface InstagramPasteReading {
  chars: number;
  linesTotal: number;
  comments: PastedComment[];
  ignored: Record<PasteIgnoredKind, number>;
  linesIgnored: number;
  discarded: Record<PasteDiscardKind, number>;
  /** The first PASTE_UNRECOGNIZED_SHOWN lines that fit no format. */
  unrecognized: string[];
  linesUnrecognized: number;
  format: InstagramPasteFormat | null;
  /** The post's owner: as typed, else from the caption or the "Autor" label. */
  postOwner: string | null;
}

export type InstagramPasteParse =
  { ok: true; reading: InstagramPasteReading } | { ok: false; error: 'colagem_grande' };

const fold = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const TIME_UNIT = '(?:s|seg|m|min|h|d|sem|w|a|y)';
const MONTHS = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const TIME_LINE = [
  new RegExp(`^\\d+ ?${TIME_UNIT}$`),
  /^ha \d+ (?:segundos?|minutos?|horas?|dias?|semanas?|mes|meses|anos?)$/,
  new RegExp(`^\\d{1,2} de (?:${MONTHS.join('|')})(?: de \\d{4})?$`),
  /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/,
];

const INTERFACE: [Exclude<PasteIgnoredKind, 'tempo'>, RegExp][] = [
  ['curtidas', /^\d+(?:[.,]\d+)? ?(?:mil )?(?:curtidas?|likes?)$/],
  ['responder', /^(?:responder|reply)$/],
  ['traducao', /^(?:ver traducao|see translation)$/],
  [
    'respostas',
    /^[—–-]* ?(?:ver respostas(?: \(\d+\))?|ver todas as \d+ respostas|ocultar respostas|view replies(?: \(\d+\))?|view all \d+ replies|hide replies)$/,
  ],
  [
    'carregar_mais',
    /^(?:carregar mais comentarios|load more comments|ver todos os \d+ comentarios|view all \d+ comments)$/,
  ],
  ['adicionar_comentario', /^(?:adicione um comentario|add a comment)[.…]*$/],
  ['publicar', /^publicar$/],
  [
    'rotulo',
    /^(?:verificado|verified|autor|author|criador|creator|fixado|pinned|editado|edited|curtido pelo autor|liked by author|seguir|follow|patrocinado|sponsored|•|·)$/,
  ],
];
const OWNER_LABEL = /^(?:autor|author|criador|creator)$/;

const isTime = (folded: string) => TIME_LINE.some((pattern) => pattern.test(folded));
const interfaceKind = (folded: string) =>
  INTERFACE.find(([, pattern]) => pattern.test(folded))?.[0];

/**
 * Cuts the time and the interface words from the end of a one-line comment ("top 4 d 1 curtida
 * Responder" → "top", "4 d"). The time is what tells a comment line from loose text.
 */
function peelTail(text: string): { text: string; when: string | null } {
  const tokens = text.split(/\s+/);
  let when: string | null = null;
  for (;;) {
    const last = fold(tokens.at(-1) ?? '');
    const lastTwo = fold(tokens.slice(-2).join(' '));
    if (tokens.length > 1 && /^(?:responder|reply)$/.test(last)) tokens.pop();
    else if (tokens.length > 2 && /^(?:ver traducao|see translation)$/.test(lastTwo))
      tokens.splice(-2);
    else if (tokens.length > 2 && /^\d+ (?:curtidas?|likes?)$/.test(lastTwo)) tokens.splice(-2);
    else if (!when && tokens.length > 1 && new RegExp(`^\\d+${TIME_UNIT}$`).test(last))
      when = tokens.pop() ?? null;
    else if (!when && tokens.length > 2 && new RegExp(`^\\d+ ${TIME_UNIT}$`).test(lastTwo))
      when = tokens.splice(-2).join(' ');
    else break;
  }
  return { text: tokens.join(' ').trim(), when };
}

const MANUAL = /^@([A-Za-z0-9._]{1,30})\s*(?:[:\-–—]\s*|\s+)(.+)$/;

interface Block {
  username: string;
  text: string[];
  when: string | null;
  closed: boolean;
  replied: boolean;
  ownerLabel: boolean;
  /** No comment was read before it: a first block without "Responder" is the caption. */
  first: boolean;
}

/** Reads the pasted text (docs/prospeccao/instagram.md §4.2). */
export function parseInstagramPaste(
  raw: string,
  options: { postOwner?: string | null; wingsUsername?: string | null; maxChars: number },
): InstagramPasteParse {
  if (raw.length > options.maxChars) return { ok: false, error: 'colagem_grande' };
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[​-‍﻿]/g, '').trim())
    .filter(Boolean);

  const ignored = Object.fromEntries(PASTE_IGNORED_KINDS.map((k) => [k, 0])) as Record<
    PasteIgnoredKind,
    number
  >;
  const unrecognized: string[] = [];
  const items: (PastedComment & { block?: Block })[] = [];
  let block: Block | null = null;
  let linesUnrecognized = 0;

  for (const line of lines) {
    const folded = fold(line);
    if (isTime(folded)) {
      if (block && !block.closed) {
        block.when = line;
        block.closed = true;
      } else if (block && !block.when) block.when = line;
      else ignored.tempo += 1;
      continue;
    }
    const kind = interfaceKind(folded);
    if (kind) {
      ignored[kind] += 1;
      if (kind === 'responder' && block) {
        block.replied = true;
        block.closed = true;
      }
      if (block && !block.closed && block.text.length === 0 && OWNER_LABEL.test(folded))
        block.ownerLabel = true;
      continue;
    }
    if (block && !block.closed) {
      block.text.push(line);
      continue;
    }
    const manual = line.match(MANUAL);
    const manualUser = manual ? normalizeInstagram(manual[1]!) : null;
    if (manual && manualUser) {
      const peeled = peelTail(manual[2]!);
      items.push({
        username: manualUser,
        text: peeled.text || manual[2]!.trim(),
        when: peeled.text ? peeled.when : null,
        format: 'manual',
      });
      continue;
    }
    const [head = '', ...rest] = line.split(/\s+/);
    const user = normalizeInstagram(head);
    if (user && rest.length > 0) {
      const peeled = peelTail(rest.join(' '));
      if (peeled.when && peeled.text) {
        items.push({ username: user, text: peeled.text, when: peeled.when, format: 'web_celular' });
        continue;
      }
    }
    if (user && rest.length === 0 && !head.includes('/')) {
      block = {
        username: user,
        text: [],
        when: null,
        closed: false,
        replied: false,
        ownerLabel: false,
        first: items.length === 0,
      };
      items.push({ username: user, text: '', when: null, format: 'web_computador', block });
      continue;
    }
    linesUnrecognized += 1;
    if (unrecognized.length < PASTE_UNRECOGNIZED_SHOWN) unrecognized.push(line);
  }

  const typedOwner = options.postOwner ? normalizeInstagram(options.postOwner) : null;
  const owners = new Set<string>(typedOwner ? [typedOwner] : []);
  let detectedOwner: string | null = null;
  const isCaption = (b: Block) => b.first && !b.replied;
  for (const item of items) {
    const b = item.block;
    if (b && (isCaption(b) || b.ownerLabel)) {
      owners.add(b.username);
      detectedOwner ??= b.username;
    }
  }
  const wings = options.wingsUsername ? normalizeInstagram(options.wingsUsername) : null;
  const discarded = Object.fromEntries(PASTE_DISCARD_KINDS.map((k) => [k, 0])) as Record<
    PasteDiscardKind,
    number
  >;
  const seen = new Set<string>();
  const comments: PastedComment[] = [];
  for (const item of items) {
    const text = (item.block ? item.block.text.join('\n') : item.text).trim();
    const when = item.block ? item.block.when : item.when;
    const key = `${item.username}\n${fold(text)}`;
    if (owners.has(item.username)) discarded.dono_do_post += 1;
    else if (wings && item.username === wings) discarded.wings += 1;
    else if (!text) discarded.vazio += 1;
    else if (seen.has(key)) discarded.repetido += 1;
    else {
      seen.add(key);
      comments.push({ username: item.username, text, when, format: item.format });
    }
  }
  const formats = new Set(items.map((item) => item.format));
  return {
    ok: true,
    reading: {
      chars: raw.length,
      linesTotal: lines.length,
      comments,
      ignored,
      linesIgnored: PASTE_IGNORED_KINDS.reduce((sum, k) => sum + ignored[k], 0),
      discarded,
      unrecognized,
      linesUnrecognized,
      format: formats.size === 0 ? null : formats.size > 1 ? 'misto' : [...formats][0]!,
      postOwner: typedOwner ?? detectedOwner,
    },
  };
}

// --- the comment's date (§4.3) ---------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  seg: 1_000,
  segundo: 1_000,
  m: 60_000,
  min: 60_000,
  minuto: 60_000,
  h: 3_600_000,
  hora: 3_600_000,
  d: 86_400_000,
  dia: 86_400_000,
  sem: 7 * 86_400_000,
  w: 7 * 86_400_000,
  semana: 7 * 86_400_000,
  mes: 30 * 86_400_000,
  a: 365 * 86_400_000,
  y: 365 * 86_400_000,
  ano: 365 * 86_400_000,
};

/** Noon in São Paulo of that day, so the calendar day is the same in every time zone used here. */
const dayAt = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 15));

/**
 * When the comment was written, from Instagram's marker: always approximate (Instagram rounds),
 * and the paste time when there is none or it makes no sense (a future date).
 */
export function commentOccurredAt(when: string | null, pastedAt: Date): Date {
  const folded = when ? fold(when) : '';
  const ago = folded.match(/^(?:ha )?(\d+) ?([a-z]+)$/);
  if (ago) {
    const unit = ago[2]!.replace(/(?:es|s)$/, '') || ago[2]!;
    const ms = UNIT_MS[ago[2]!] ?? UNIT_MS[unit];
    if (ms) return new Date(pastedAt.getTime() - Number(ago[1]) * ms);
  }
  const named = folded.match(/^(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?$/);
  const numeric = folded.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  const parts = named
    ? { day: Number(named[1]), month: MONTHS.indexOf(named[2]!), year: named[3] }
    : numeric
      ? { day: Number(numeric[1]), month: Number(numeric[2]) - 1, year: numeric[3] }
      : null;
  if (parts && parts.month >= 0 && parts.month < 12 && parts.day >= 1 && parts.day <= 31) {
    const thisYear = pastedAt.getUTCFullYear();
    const year = parts.year
      ? Number(parts.year.length === 2 ? `20${parts.year}` : parts.year)
      : thisYear;
    let date = dayAt(year, parts.month, parts.day);
    if (!parts.year && date > pastedAt) date = dayAt(year - 1, parts.month, parts.day);
    if (date.getUTCDate() === parts.day && date <= pastedAt) return date;
  }
  return pastedAt;
}

/** "há cerca de 2 semanas": the screen never shows an approximate date as exact. */
export function approximateAgoText(occurredAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - occurredAt.getTime()) / 86_400_000);
  if (days < 1) return 'há menos de um dia';
  if (days < 7) return `há cerca de ${days} ${days === 1 ? 'dia' : 'dias'}`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return `há cerca de ${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`;
  }
  if (days < 365) return `há cerca de ${Math.round(days / 30)} meses`;
  const years = Math.round(days / 365);
  return `há cerca de ${years} ${years === 1 ? 'ano' : 'anos'}`;
}

// --- data written in the comment (§4.4) ------------------------------------------------------

const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/gi;
const LINK =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|me|ly|link|app|site|online|store)(?:\.br)?(?:\/\S*)?/gi;
/** A phone: 8 or more digits, with the usual separators between them. */
const PHONE = /\+?\(?\d(?:[\d\s().-]{6,}\d)/g;
const MENTION = /@[a-z0-9._]{1,30}/gi;

/**
 * The excerpt kept of a comment: e-mail, link, phone and other people's @ masked, so none of them
 * is ever kept or turned into a field of the prospect or the lead.
 */
export function maskCommentText(text: string): string {
  return text
    .replace(EMAIL, '[e-mail]')
    .replace(LINK, '[link]')
    .replace(PHONE, (match) => (match.replace(/\D/g, '').length >= 8 ? '[número]' : match))
    .replace(MENTION, '[@]');
}

/** The stored excerpt: masked and cut at 280 characters. */
export const INSTAGRAM_EXCERPT_MAX = 280;
export const instagramExcerpt = (text: string) =>
  maskCommentText(text).slice(0, INSTAGRAM_EXCERPT_MAX);

// --- the post's link -------------------------------------------------------------------------

/**
 * The public link of a post or reel in one form (`https://www.instagram.com/p/<code>/`), without
 * the query string; null when it is not one.
 */
export function normalizeInstagramPostUrl(raw: string): string | null {
  const match = raw
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#].*)?$/i,
    );
  if (!match) return null;
  const kind = match[1]!.toLowerCase() === 'p' || match[1]!.toLowerCase() === 'tv' ? 'p' : 'reel';
  return `https://www.instagram.com/${kind}/${match[2]}/`;
}
