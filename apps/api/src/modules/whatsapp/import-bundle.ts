import { waExportChatOf } from '@wings/shared';
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

/** One file as the Admin gave it: zero, one or many conversations. */
export function conversationsOf(fileName: string, bytes: Uint8Array): BundleConversation[] {
  if (isTxt(fileName)) return [{ fileName, bytes, text: strFromU8(bytes) }];
  if (!isZip(fileName)) return [];
  const entries = unzipSync(bytes);
  // A phone's export: one chat, maybe with media beside it.
  const chat = waExportChatOf(Object.keys(entries));
  if (chat) return [{ fileName, bytes, text: strFromU8(entries[chat]!) }];
  // A bundle: every export inside it is a conversation of its own.
  return Object.entries(entries)
    .filter(([name]) => !ignored(name) && (isTxt(name) || isZip(name)))
    .flatMap(([name, inner]) =>
      isZip(name)
        ? conversationsOf(baseName(name), inner)
        : [{ fileName: baseName(name), bytes: inner, text: strFromU8(inner) }],
    );
}
