import { canonicalWhatsAppPhone } from '@wings/shared';
import type { ParsedExport } from './import-parse.js';

/**
 * "Importar em lote" (docs/whatsapp/importar-conversa.md): who a conversation is with, and the clues
 * that lead to its deal. The file name names the contact but never the number ("Conversa do WhatsApp
 * com Maria.txt"); the number shows only when the phone had no contact saved (the author is the
 * number) or when someone wrote it in a message. Pure: the database half is in `import-bulk.ts`.
 */

const FILE_NAME =
  /^(?:conversa do whatsapp com|whatsapp chat with|whatsapp chat -|chat de whatsapp con)\s+(.+?)(?:\s*\(\d+\))?\.(?:txt|zip)$/i;

// A Brazilian number as people write it: +55 21 99999-0001, (21) 99999-0001, 21999990001.
const PHONE_IN_TEXT = /(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/g;

const looksLikePhone = (name: string) => /^\+?[\d\s().-]{10,}$/.test(name.trim());

/** Case, accents, emoji and punctuation left out: "Maria  Souza 🌸" and "maria souza" are the same. */
export const normalizeName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A Brazilian number in the CRM's form (55 + DDD + number), or null when it is not one. */
export function phoneOf(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  return /^55\d{10,11}$/.test(full) ? canonicalWhatsAppPhone(full) : null;
}

/** The contact as the file name gives it, else the one other person who wrote. */
export function contactNameOf(
  fileName: string,
  participants: string[],
  ourName: string | null,
): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const named = FILE_NAME.exec(base)?.[1]?.trim();
  if (named) return named;
  const others = participants.filter((name) => name !== ourName && !looksLikePhone(name));
  return others.length === 1 ? others[0]! : null;
}

/**
 * The contact's numbers in the chat: authors that are a number (strong: it is the person), and the
 * numbers the other side wrote in messages (weaker: it may be someone else's). Ours are left out,
 * since the Wings writes its own number.
 */
export function chatPhonesOf(
  parsed: ParsedExport,
  ourName: string | null,
): { authors: string[]; written: string[] } {
  const authors = new Set<string>();
  const written = new Set<string>();
  for (const message of parsed.messages) {
    if (message.author === ourName) continue;
    if (looksLikePhone(message.author)) {
      const phone = phoneOf(message.author);
      if (phone) authors.add(phone);
    }
    for (const match of message.text?.matchAll(PHONE_IN_TEXT) ?? []) {
      const phone = phoneOf(match[0]);
      if (phone) written.add(phone);
    }
  }
  return { authors: [...authors], written: [...written] };
}

/**
 * The optional `.csv` of name and phone: one pair per line, `;`, `,` or a tab between them, a header
 * or a line without a valid number skipped. A name given two different numbers is left out (a tie is
 * never guessed).
 */
export function parseNameMap(csv: string): Record<string, string> {
  const map = new Map<string, string>();
  const clashing = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const pair = /^(.*?)[;,\t]\s*([^;,\t]+?)\s*$/.exec(line.trim());
    if (!pair) continue;
    const name = normalizeName(pair[1]!.replace(/^"|"$/g, ''));
    const phone = phoneOf(pair[2]!);
    if (!name || !phone) continue;
    const known = map.get(name);
    if (known && known !== phone) clashing.add(name);
    else map.set(name, phone);
  }
  for (const name of clashing) map.delete(name);
  return Object.fromEntries(map);
}
