import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { conversationsOf } from './import-bundle.js';

/** What the Admin hands over for "Importar em lote": .txt, a phone's .zip, or a .zip of many. No database. */

const CHAT = (who: string) =>
  [
    '19/10/2026 14:05 - Wings Company: Olá!',
    `19/10/2026 14:06 - ${who}: Oi, tudo bem?`,
    `19/10/2026 14:07 - ${who}: IMG-20261019-WA0001.jpg (arquivo anexado)`,
  ].join('\n');

const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

const zip = (entries: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([name, data]) => [
        name,
        typeof data === 'string' ? strToU8(data) : data,
      ]),
    ),
  );

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const namesOf = (list: { fileName: string }[]) => list.map((c) => c.fileName);

describe('a .txt export', () => {
  it('is one conversation with its own name, bytes and text', () => {
    const bytes = strToU8(CHAT('Contato Teste'));
    const result = conversationsOf('Conversa do WhatsApp com Contato Teste.txt', bytes);
    expect(result).toHaveLength(1);
    expect(result[0]?.fileName).toBe('Conversa do WhatsApp com Contato Teste.txt');
    expect(result[0]?.bytes).toBe(bytes);
    expect(result[0]?.text).toBe(CHAT('Contato Teste'));
  });

  it('reads accents as UTF-8 and takes the extension in any case', () => {
    const [only] = conversationsOf('CHAT.TXT', strToU8('19/10/2026 14:05 - Ana: Olá, ação!'));
    expect(only?.text).toBe('19/10/2026 14:05 - Ana: Olá, ação!');
  });
});

describe('a phone .zip export', () => {
  it('Android: the chat and its media are one conversation, and the file stays the whole .zip', () => {
    const bytes = zip({
      'Conversa do WhatsApp com Contato Teste.txt': CHAT('Contato Teste'),
      'IMG-20261019-WA0001.jpg': IMAGE,
    });
    const result = conversationsOf('Conversa do WhatsApp com Contato Teste.zip', bytes);
    expect(result).toHaveLength(1);
    expect(result[0]?.fileName).toBe('Conversa do WhatsApp com Contato Teste.zip');
    expect(result[0]?.text).toBe(CHAT('Contato Teste'));
    // The media goes to the deal inside the very same bytes.
    expect(result[0]?.bytes).toBe(bytes);
    expect(unzipSync(result[0]!.bytes)['IMG-20261019-WA0001.jpg']).toEqual(IMAGE);
  });

  it('iPhone: the chat is _chat.txt', () => {
    const bytes = zip({
      '_chat.txt': '[19/10/2026 14:06:10] Contato Teste: Oi',
      '00000001-PHOTO-2026-10-19-14-07-00.jpg': IMAGE,
    });
    const result = conversationsOf('WhatsApp Chat - Contato Teste.zip', bytes);
    expect(namesOf(result)).toEqual(['WhatsApp Chat - Contato Teste.zip']);
    expect(result[0]?.text).toBe('[19/10/2026 14:06:10] Contato Teste: Oi');
  });

  it('finds the chat inside a folder of the .zip', () => {
    const result = conversationsOf(
      'WhatsApp Chat - Contato Teste.zip',
      zip({ 'WhatsApp Chat - Contato Teste/_chat.txt': CHAT('Contato Teste') }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe(CHAT('Contato Teste'));
  });

  it('takes _chat.txt, or the "Conversa do WhatsApp" file, before any other .txt beside it', () => {
    const ios = conversationsOf(
      'a.zip',
      zip({ 'leiame.txt': 'nada', '_chat.txt': CHAT('Contato Teste') }),
    );
    expect(ios).toHaveLength(1);
    expect(ios[0]?.text).toBe(CHAT('Contato Teste'));
    const android = conversationsOf(
      'b.zip',
      zip({ 'leiame.txt': 'nada', 'Conversa do WhatsApp com X.txt': CHAT('X') }),
    );
    expect(android).toHaveLength(1);
    expect(android[0]?.text).toBe(CHAT('X'));
  });

  it('takes the only .txt as the chat, whatever its name', () => {
    const result = conversationsOf(
      'a.zip',
      zip({ 'exportacao.txt': CHAT('Contato Teste'), 'a.jpg': IMAGE }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.fileName).toBe('a.zip');
  });

  it('is still one conversation when macOS junk comes along, even a junk .zip', () => {
    const result = conversationsOf(
      'Conversa do WhatsApp com Contato Teste.zip',
      zip({
        'Conversa do WhatsApp com Contato Teste.txt': CHAT('Contato Teste'),
        'IMG-20261019-WA0001.jpg': IMAGE,
        '__MACOSX/._Conversa do WhatsApp com Contato Teste.txt': 'lixo',
        '__MACOSX/._IMG-20261019-WA0001.jpg': 'lixo',
        '__MACOSX/._anexos.zip': 'lixo',
        '.DS_Store': 'lixo',
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe(CHAT('Contato Teste'));
  });
});

describe('a bundle .zip of many exports', () => {
  const inner = zip({
    'Conversa do WhatsApp com Dois.txt': CHAT('Dois'),
    'IMG-20261019-WA0002.jpg': IMAGE,
  });

  it('gives one conversation per .txt, named by the .txt, when they have generic names', () => {
    const result = conversationsOf(
      'lote.zip',
      zip({ 'conversas/um.txt': CHAT('Um'), 'conversas/dois.txt': CHAT('Dois') }),
    );
    expect(namesOf(result).sort()).toEqual(['dois.txt', 'um.txt']);
    expect(result.find((c) => c.fileName === 'um.txt')?.text).toBe(CHAT('Um'));
  });

  it('gives one conversation per inner .zip, keeping that .zip as the file', () => {
    const result = conversationsOf(
      'lote.zip',
      zip({
        'Conversa do WhatsApp com Um.txt': CHAT('Um'),
        'pasta/Conversa do WhatsApp com Dois.zip': inner,
        'pasta/WhatsApp Chat - Tres.zip': zip({ '_chat.txt': CHAT('Tres') }),
      }),
    );
    expect(namesOf(result).sort()).toEqual([
      'Conversa do WhatsApp com Dois.zip',
      'Conversa do WhatsApp com Um.txt',
      'WhatsApp Chat - Tres.zip',
    ]);
    expect(result.find((c) => c.fileName.endsWith('Dois.zip'))?.text).toBe(CHAT('Dois'));
    expect(result.find((c) => c.fileName.endsWith('Tres.zip'))?.text).toBe(CHAT('Tres'));
    expect(result.find((c) => c.fileName.endsWith('Um.txt'))?.text).toBe(CHAT('Um'));
  });

  it('keeps the inner export with its own bytes, media inside', () => {
    const [only] = conversationsOf('lote.zip', zip({ 'Conversa do WhatsApp com Dois.zip': inner }));
    expect(only?.fileName).toBe('Conversa do WhatsApp com Dois.zip');
    expect(same(only!.bytes, inner)).toBe(true);
    expect(unzipSync(only!.bytes)['IMG-20261019-WA0002.jpg']).toEqual(IMAGE);
  });

  it('opens a bundle inside a bundle', () => {
    const result = conversationsOf(
      'tudo.zip',
      zip({
        'lote-a.zip': zip({ 'a.zip': zip({ '_chat.txt': CHAT('A') }), 'b.txt': CHAT('B') }),
        'c.txt': CHAT('C'),
      }),
    );
    expect(namesOf(result).sort()).toEqual(['a.zip', 'b.txt', 'c.txt']);
  });

  it('ignores __MACOSX and dot files, including junk .txt and .zip', () => {
    const result = conversationsOf(
      'lote.zip',
      zip({
        'um.txt': CHAT('Um'),
        'Conversa do WhatsApp com Dois.zip': inner,
        '__MACOSX/._um.txt': 'lixo',
        '__MACOSX/pasta/um.txt': 'lixo',
        '__MACOSX/._Conversa do WhatsApp com Dois.zip': 'lixo',
        '.DS_Store': 'lixo',
        'pasta/._tres.txt': 'lixo',
        'pasta/.oculto.zip': 'lixo',
        'foto.jpg': IMAGE,
        'leiame.pdf': IMAGE,
      }),
    );
    expect(namesOf(result).sort()).toEqual(['Conversa do WhatsApp com Dois.zip', 'um.txt']);
  });

  it('gives an empty list for a .zip with no chat in it', () => {
    expect(conversationsOf('fotos.zip', zip({ 'a.jpg': IMAGE, 'b.jpg': IMAGE }))).toEqual([]);
    expect(conversationsOf('vazio.zip', zip({}))).toEqual([]);
    expect(
      conversationsOf('lixo.zip', zip({ '__MACOSX/._a.txt': 'lixo', '.DS_Store': 'x' })),
    ).toEqual([]);
  });

  it('gives one conversation per Android .txt of a zipped folder of exports', () => {
    const result = conversationsOf(
      'lote.zip',
      zip({
        'Conversa do WhatsApp com Um.txt': CHAT('Um'),
        'Conversa do WhatsApp com Dois.txt': CHAT('Dois'),
      }),
    );
    expect(namesOf(result).sort()).toEqual([
      'Conversa do WhatsApp com Dois.txt',
      'Conversa do WhatsApp com Um.txt',
    ]);
  });

  it('gives one conversation per _chat.txt of a zipped folder of iPhone exports', () => {
    const result = conversationsOf(
      'lote.zip',
      zip({
        'WhatsApp Chat - Um/_chat.txt': CHAT('Um'),
        'WhatsApp Chat - Dois/_chat.txt': CHAT('Dois'),
      }),
    );
    expect(result).toHaveLength(2);
  });
});

describe('what is neither a .txt nor a .zip', () => {
  it('gives no conversation', () => {
    expect(conversationsOf('foto.jpg', IMAGE)).toEqual([]);
    expect(conversationsOf('conversa.pdf', strToU8(CHAT('Um')))).toEqual([]);
    expect(conversationsOf('conversa.txt.bak', strToU8(CHAT('Um')))).toEqual([]);
    expect(conversationsOf('conversa.zipx', zip({ '_chat.txt': CHAT('Um') }))).toEqual([]);
    expect(conversationsOf('semextensao', strToU8(CHAT('Um')))).toEqual([]);
  });
});
