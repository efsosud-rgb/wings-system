import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { WA_BULK_BROWSER_ZIP_MAX, conversationFilesOf, exportTextOf } from './whatsapp.js';

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

/**
 * "Importar em lote" opens what the Admin picked into conversations: a `.txt` or a phone's `.zip`
 * is one conversation; a `.zip` of many exports is opened in the browser, one file per export.
 */
describe('conversationFilesOf', () => {
  const OTHER = '[19/10/2026 10:00:00] Contato Teste: Bom dia';
  const SIZE_MESSAGE =
    'Lote.zip passa de 1 GB: escolha as conversas soltas, ou mande a pasta para o CLI.';

  const names = (files: File[]) => files.map((f) => f.name);

  it('keeps a .txt as the one conversation it is', async () => {
    const file = new File([CHAT], 'Conversa do WhatsApp com Contato Teste.txt', {
      type: 'text/plain',
    });
    const [only, ...rest] = await conversationFilesOf(file);
    expect(only).toBe(file);
    expect(rest).toHaveLength(0);
  });

  it.each(['foto.jpg', 'planilha.csv', 'leia-me', 'conversa.txt.bak'])(
    'drops "%s": neither a .txt nor a .zip',
    async (name) => {
      expect(await conversationFilesOf(new File(['x'], name))).toEqual([]);
    },
  );

  it('keeps an iPhone export zip (_chat.txt next to its media) as one conversation', async () => {
    const file = zip({ '_chat.txt': CHAT, '00000012-PHOTO-2026-10-19-09-12-30.jpg': photo });
    expect(await conversationFilesOf(file)).toEqual([file]);
  });

  it('keeps a single Android export zip (the chat file plus media) as one conversation', async () => {
    const file = zip({
      'Conversa do WhatsApp com Contato Teste.txt': CHAT,
      'IMG-20261019-WA0001.jpg': photo,
    });
    expect(await conversationFilesOf(file)).toEqual([file]);
  });

  it('opens a bundle of .txt exports into one File per export, named by the file in the zip', async () => {
    const bundle = zip({
      'export/primeira.txt': CHAT,
      'export/segunda.txt': OTHER,
      'export/foto.jpg': photo,
    });
    const files = await conversationFilesOf(bundle);

    expect(names(files).sort()).toEqual(['primeira.txt', 'segunda.txt']);
    expect(files.every((f) => f.type === 'text/plain')).toBe(true);
    const text = Object.fromEntries(
      await Promise.all(files.map(async (f) => [f.name, await f.text()])),
    );
    expect(text).toEqual({ 'primeira.txt': CHAT, 'segunda.txt': OTHER });
  });

  it('opens a bundle of .zip exports, each one still a zip with its media inside', async () => {
    const inner = zipSync({ '_chat.txt': strToU8(CHAT), 'IMG-1.jpg': photo });
    const bundle = zip({ 'a/Conversa A.zip': inner, 'a/Conversa B.zip': inner });
    const files = await conversationFilesOf(bundle);

    expect(names(files).sort()).toEqual(['Conversa A.zip', 'Conversa B.zip']);
    expect(files.every((f) => f.type === 'application/zip')).toBe(true);
    // Each one can then be read like a single export.
    for (const file of files) expect(await exportTextOf(file)).toBe(CHAT);
  });

  it('ignores the Mac junk in a bundle (__MACOSX and files starting with a dot)', async () => {
    const bundle = zip({
      'Conversa A.txt': CHAT,
      'Conversa B.txt': OTHER,
      '__MACOSX/Conversa A.txt': 'junk',
      '__MACOSX/._Conversa B.txt': 'junk',
      '._Conversa A.txt': 'junk',
      '.oculta.txt': 'junk',
    });
    expect(names(await conversationFilesOf(bundle)).sort()).toEqual([
      'Conversa A.txt',
      'Conversa B.txt',
    ]);
  });

  it('reads the extension in any case (.ZIP, .TXT)', async () => {
    const lone = new File([CHAT], 'CONVERSA.TXT');
    expect(await conversationFilesOf(lone)).toEqual([lone]);
    const bundle = zip({ 'A.TXT': CHAT, 'B.TXT': OTHER }, 'LOTE.ZIP');
    expect(names(await conversationFilesOf(bundle)).sort()).toEqual(['A.TXT', 'B.TXT']);
  });

  it('gives nothing for a .zip that holds only media', async () => {
    expect(await conversationFilesOf(zip({ 'IMG-1.jpg': photo }))).toEqual([]);
  });

  it('refuses a .zip over 1 GB with the Portuguese message, without reading it', async () => {
    const big = zip({ 'A.txt': CHAT }, 'Lote.zip');
    Object.defineProperty(big, 'size', { value: WA_BULK_BROWSER_ZIP_MAX + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');

    await expect(conversationFilesOf(big)).rejects.toThrow(SIZE_MESSAGE);
    expect(read).not.toHaveBeenCalled();
  });

  it('opens a .zip of exactly 1 GB (the limit is "over")', async () => {
    const edge = zip({ 'A.txt': CHAT, 'B.txt': OTHER }, 'Lote.zip');
    Object.defineProperty(edge, 'size', { value: WA_BULK_BROWSER_ZIP_MAX });
    expect(names(await conversationFilesOf(edge)).sort()).toEqual(['A.txt', 'B.txt']);
  });

  it('does not apply the 1 GB limit to a .txt', async () => {
    const huge = new File([CHAT], 'Lote.txt');
    Object.defineProperty(huge, 'size', { value: WA_BULK_BROWSER_ZIP_MAX + 1 });
    expect(await conversationFilesOf(huge)).toEqual([huge]);
  });

  it('opens a bundle of several Android exports into one File each', async () => {
    const bundle = zip({
      'Conversa do WhatsApp com Contato Teste.txt': CHAT,
      'Conversa do WhatsApp com Outro Contato.txt': OTHER,
    });
    expect(await conversationFilesOf(bundle)).toHaveLength(2);
  });

  it('opens a bundle of folders, each with its own _chat.txt, into one File each', async () => {
    const bundle = zip({ 'A/_chat.txt': CHAT, 'B/_chat.txt': OTHER });
    expect(await conversationFilesOf(bundle)).toHaveLength(2);
  });
});
