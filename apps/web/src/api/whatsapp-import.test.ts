import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportTextOf } from './whatsapp.js';

/**
 * A phone's export reaches the browser as a `.txt` or as a `.zip` (chat plus its media). The text
 * is read here, so a zip full of photos never has to go through the API.
 */

const CHAT = '[19/10/2026 09:12:01] Elena Prado: Oi, tudo bem?\n[19/10/2026 09:13:40] Wings: Tudo!';
const NO_CHAT = 'O .zip não tem a conversa (.txt). Exporte de novo pelo WhatsApp.';

const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** A real zip, built the way the phones do: the chat file next to its media. */
const zip = (entries: Record<string, string | Uint8Array>, name = 'Conversa.zip') => {
  const files = Object.fromEntries(
    Object.entries(entries).map(([entry, body]) => [
      entry,
      typeof body === 'string' ? strToU8(body) : body,
    ]),
  );
  return new File([zipSync(files)], name, { type: 'application/zip' });
};

describe('exportTextOf', () => {
  it('returns the text of a .txt as it is', async () => {
    const file = new File([CHAT], 'Conversa do WhatsApp com Elena.txt', { type: 'text/plain' });
    expect(await exportTextOf(file)).toBe(CHAT);
  });

  it('returns the chat inside an iPhone zip (_chat.txt next to a photo)', async () => {
    const file = zip({ '_chat.txt': CHAT, '00000012-PHOTO-2026-10-19-09-12-30.jpg': photo });
    expect(await exportTextOf(file)).toBe(CHAT);
  });

  it('prefers _chat.txt over any other .txt in the zip, even in a folder', async () => {
    const file = zip({ 'Leia-me.txt': 'not the chat', 'export/_chat.txt': CHAT });
    expect(await exportTextOf(file)).toBe(CHAT);
  });

  it.each(['Conversa do WhatsApp com Elena.txt', 'WhatsApp Chat - Elena.txt'])(
    'finds the Android chat "%s" among other .txt files',
    async (chat) => {
      const file = zip({
        'Leia-me.txt': 'not the chat',
        [chat]: CHAT,
        'IMG-20261019-WA0001.jpg': photo,
      });
      expect(await exportTextOf(file)).toBe(CHAT);
    },
  );

  it('takes the only .txt when no name matches', async () => {
    expect(await exportTextOf(zip({ 'minha-conversa.txt': CHAT, 'IMG-1.jpg': photo }))).toBe(CHAT);
  });

  it('opens a zip by its type when the name does not say .zip', async () => {
    const file = zip({ '_chat.txt': CHAT }, 'exportacao');
    expect(await exportTextOf(file)).toBe(CHAT);
  });

  it('throws the Portuguese message when the zip has no .txt', async () => {
    const file = zip({ 'IMG-1.jpg': photo, 'AUD-1.opus': new Uint8Array([9, 9]) });
    await expect(exportTextOf(file)).rejects.toThrow(NO_CHAT);
  });
});
