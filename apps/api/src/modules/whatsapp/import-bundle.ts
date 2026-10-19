import { strFromU8, unzipSync } from 'fflate';

/**
 * The conversations in what the Admin hands over for "Importar em lote": a `.txt` export, a phone's
 * `.zip` export (the chat and its media), or one `.zip` holding many of those. Each conversation
 * keeps its own file, the one that goes to the deal with its media inside. Used by the CLI; the
 * screen does the same in the browser.
 */

export interface BundleConversation {
  /** The export's own name ("Conversa do WhatsApp com Maria.zip"): it names the contact. */
  fileName: string;
  bytes: Uint8Array;
  text: string;
}

const isTxt = (name: string) => /\.txt$/i.test(name);
const isZip = (name: string) => /\.zip$/i.test(name);
const baseName = (path: string) => path.split('/').pop() ?? path;
const ignored = (path: string) => /(^|\/)__MACOSX\//.test(path) || baseName(path).startsWith('.');

/** The chat inside a phone's `.zip`: `_chat.txt` on the iPhone, "Conversa do WhatsApp com …" on Android. */
function chatOf(entries: Record<string, Uint8Array>): string | null {
  const names = Object.keys(entries).filter((name) => isTxt(name) && !ignored(name));
  const name =
    names.find((n) => /(^|\/)_chat\.txt$/i.test(n)) ??
    names.find((n) => /(^|\/)(conversa do whatsapp|whatsapp chat)/i.test(baseName(n))) ??
    (names.length === 1 ? names[0] : undefined);
  return name ? strFromU8(entries[name]!) : null;
}

/** One file as the Admin gave it: zero, one or many conversations. */
export function conversationsOf(fileName: string, bytes: Uint8Array): BundleConversation[] {
  if (isTxt(fileName)) return [{ fileName, bytes, text: strFromU8(bytes) }];
  if (!isZip(fileName)) return [];
  const entries = unzipSync(bytes);
  const chat = chatOf(entries);
  // A phone's export: the chat at its top, maybe with media beside it.
  if (chat !== null && !Object.keys(entries).some((name) => isZip(name) && !ignored(name)))
    return [{ fileName, bytes, text: chat }];
  // A bundle: every export inside it is a conversation of its own.
  return Object.entries(entries)
    .filter(([name]) => !ignored(name) && (isTxt(name) || isZip(name)))
    .flatMap(([name, inner]) =>
      isZip(name)
        ? conversationsOf(baseName(name), inner)
        : [{ fileName: baseName(name), bytes: inner, text: strFromU8(inner) }],
    );
}
