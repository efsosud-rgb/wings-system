import { createHash } from 'node:crypto';
import type { WaMessageKind } from '@wings/shared';

/**
 * Reads the text of WhatsApp's "Exportar conversa" (docs/whatsapp/importar-conversa.md),
 * pt-BR dates, from either phone:
 *   Android  `19/10/2026 14:05 - Nome: texto`
 *   iPhone   `[19/10/2026 14:05:33] Nome: texto`
 * A line without the date continues the message above. A dated line with no
 * "Nome: " is the app's own notice (encryption, someone joined) and is skipped.
 * Pure: no database, no log, so the tests feed it made-up chats.
 */

export type ExportPlatform = 'android' | 'ios';

export interface ExportMessage {
  at: Date;
  author: string;
  text: string | null;
  kind: WaMessageKind;
  /** The media file the line names (`IMG-…jpg`), when it names one. */
  file: string | null;
  /** The media was left out of the export ("<Mídia oculta>"). */
  omitted: boolean;
  /** SHA-256 of time, author, text and how many identical lines came before: the import's dedupe key. */
  hash: string;
}

export interface ParsedExport {
  platform: ExportPlatform;
  messages: ExportMessage[];
  /** Dated lines that were the app's notices, not messages. */
  skipped: number;
}

const ANDROID =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? - ([\s\S]*)$/;
const IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\] ([\s\S]*)$/;

// Marks the phones put around names and attachments (left-to-right, isolates) and their odd spaces.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;

const ANDROID_FILE = /^(.+?\.[A-Za-z0-9]{2,5}) \((?:arquivo anexado|file attached)\)$/;
const IOS_FILE = /<(?:anexado|attached): ([^>]+)>/;
const OMITTED = /^<(?:Mídia oculta|Media omitted)>$/i;
const IOS_OMITTED =
  /^(imagem|image|foto|photo|vídeo|video|áudio|audio|figurinha|sticker|documento|document|gif|cartão de contato|contact card)\s+(?:ocultad[oa]|omitid[oa]|omitted)$/i;

const OMITTED_KIND: Record<string, WaMessageKind> = {
  imagem: 'image',
  image: 'image',
  foto: 'image',
  photo: 'image',
  vídeo: 'video',
  video: 'video',
  gif: 'video',
  áudio: 'audio',
  audio: 'audio',
  figurinha: 'sticker',
  sticker: 'sticker',
  documento: 'document',
  document: 'document',
  'cartão de contato': 'contacts',
  'contact card': 'contacts',
};

const KIND_BY_EXTENSION: Record<string, WaMessageKind> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  heic: 'image',
  heif: 'image',
  bmp: 'image',
  webp: 'sticker',
  opus: 'audio',
  ogg: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  amr: 'audio',
  wav: 'audio',
  mp4: 'video',
  '3gp': 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  vcf: 'contacts',
};

export const kindOfFile = (file: string): WaMessageKind =>
  KIND_BY_EXTENSION[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'document';

/**
 * The phone's local time. shortcut: fixed UTC-3 (Brasília has had no summer
 * time since 2019); a chat from before 2019 may be off by an hour in summer.
 */
function timeOf(match: RegExpMatchArray): Date | null {
  const [day, month, year, hour, minute, second] = match.slice(1, 7).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return null;
  const at = new Date(Date.UTC(fullYear, month - 1, day, hour + 3, minute, second));
  // 31/02 rolls into March: not a real date, so not a message line.
  return at.getUTCDate() === new Date(Date.UTC(fullYear, month - 1, day)).getUTCDate() ? at : null;
}

interface Draft {
  at: Date;
  author: string;
  lines: string[];
}

function messageOf(draft: Draft): Omit<ExportMessage, 'hash'> {
  const raw = draft.lines.join('\n');
  const [first = '', ...rest] = draft.lines;
  const caption = (lines: string[]) => lines.join('\n').trim() || null;
  const android = first.trim().match(ANDROID_FILE);
  if (android)
    return {
      at: draft.at,
      author: draft.author,
      text: caption(rest),
      kind: kindOfFile(android[1]!),
      file: android[1]!,
      omitted: false,
    };
  const ios = raw.match(IOS_FILE);
  if (ios)
    return {
      at: draft.at,
      author: draft.author,
      text: caption([raw.replace(IOS_FILE, '')]),
      kind: kindOfFile(ios[1]!.trim()),
      file: ios[1]!.trim(),
      omitted: false,
    };
  const trimmed = raw.trim();
  if (OMITTED.test(trimmed))
    return {
      at: draft.at,
      author: draft.author,
      text: null,
      kind: 'unsupported',
      file: null,
      omitted: true,
    };
  const iosOmitted = trimmed.match(IOS_OMITTED);
  if (iosOmitted)
    return {
      at: draft.at,
      author: draft.author,
      text: null,
      kind: OMITTED_KIND[iosOmitted[1]!.toLowerCase()] ?? 'unsupported',
      file: null,
      omitted: true,
    };
  return {
    at: draft.at,
    author: draft.author,
    text: trimmed || null,
    kind: 'text',
    file: null,
    omitted: false,
  };
}

/** Null when no line of the text looks like an export (wrong file). */
export function parseWhatsAppExport(input: string): ParsedExport | null {
  const lines = input
    .replace(INVISIBLE, '')
    .replace(/[  ]/g, ' ')
    .split(/\r\n|\r|\n/);
  let platform: ExportPlatform | null = null;
  const drafts: Draft[] = [];
  let skipped = 0;
  let current: Draft | null = null;
  for (const line of lines) {
    if (platform === null) {
      if (ANDROID.test(line)) platform = 'android';
      else if (IOS.test(line)) platform = 'ios';
    }
    const match = platform ? line.match(platform === 'android' ? ANDROID : IOS) : null;
    const at = match ? timeOf(match) : null;
    if (!match || !at) {
      // Text before the first message (or a broken date) has nowhere to go.
      if (current) current.lines.push(line);
      continue;
    }
    const rest = match[7] ?? '';
    const colon = rest.indexOf(': ');
    if (colon <= 0) {
      skipped += 1;
      current = null;
      continue;
    }
    current = { at, author: rest.slice(0, colon).trim(), lines: [rest.slice(colon + 2)] };
    drafts.push(current);
  }
  if (platform === null) return null;

  const seen = new Map<string, number>();
  const messages = drafts.map((draft) => {
    const message = messageOf(draft);
    const key = [
      message.at.toISOString(),
      message.author,
      message.kind,
      message.file ?? '',
      message.text ?? '',
    ].join('\u0000');
    const repeat = seen.get(key) ?? 0;
    seen.set(key, repeat + 1);
    return {
      ...message,
      hash: createHash('sha256').update(`${key}\u0000${repeat}`).digest('hex'),
    };
  });
  return { platform, messages, skipped };
}

/** Who wrote, by message count, most first: the screen asks which one is Wings. */
export function participantsOf(parsed: ParsedExport): { name: string; messages: number }[] {
  const counts = new Map<string, number>();
  for (const message of parsed.messages)
    counts.set(message.author, (counts.get(message.author) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, messages]) => ({ name, messages }))
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
}

/** The business profile's name is the Wings side ("Wings Company", "Wings Company - Tráfego"). */
export const guessOurSide = (names: string[]): string | null => {
  const ours = names.filter((name) => /wings/i.test(name));
  return ours.length === 1 ? ours[0]! : null;
};
