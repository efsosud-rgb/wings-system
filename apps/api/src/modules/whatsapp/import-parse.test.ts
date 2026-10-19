import { describe, expect, it } from 'vitest';
import {
  guessOurSide,
  kindOfFile,
  parseWhatsAppExport,
  participantsOf,
  type ExportMessage,
} from './import-parse.js';

/** The reader of a phone's "Exportar conversa" (pt-BR), fed made-up chats. No database. */

const LRM = '\u200e';

const ANDROID = [
  '19/10/2026 14:00 - As mensagens e as chamadas são protegidas com a criptografia de ponta a ponta.',
  '19/10/2026 14:05 - Wings Company: Olá! Vi o seu interesse.',
  'Segue a proposta:',
  '- item um',
  '- item dois',
  '19/10/2026 14:06 - Cliente Teste: Obrigado',
].join('\n');

const parsed = (text: string) => {
  const result = parseWhatsAppExport(text);
  if (!result) throw new Error('not an export');
  return result;
};
const first = (text: string): ExportMessage => parsed(text).messages[0]!;

describe('Android export', () => {
  it('reads dated lines, joins the lines without a date into the message above and counts app notices', () => {
    const result = parsed(ANDROID);
    expect(result.platform).toBe('android');
    expect(result.skipped).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      author: 'Wings Company',
      kind: 'text',
      text: 'Olá! Vi o seu interesse.\nSegue a proposta:\n- item um\n- item dois',
      file: null,
      omitted: false,
    });
    expect(result.messages[1]).toMatchObject({ author: 'Cliente Teste', text: 'Obrigado' });
  });

  it('turns the phone local time (UTC-3) into UTC', () => {
    expect(first(ANDROID).at.toISOString()).toBe('2026-10-19T17:05:00.000Z');
  });

  it('reads a message sent after 21:00 local, when the UTC date is already the next day', () => {
    const result = parsed(
      ['19/10/2026 20:59 - Ana: antes', '19/10/2026 22:30 - Ana: boa noite'].join('\n'),
    );
    expect(result.messages.map((m) => m.text)).toEqual(['antes', 'boa noite']);
    expect(result.messages[1]?.at.toISOString()).toBe('2026-10-20T01:30:00.000Z');
  });

  it('reads a two-digit year, with or without a comma after the date', () => {
    expect(first('19/10/26 14:05 - Ana: oi').at.toISOString()).toBe('2026-10-19T17:05:00.000Z');
    expect(first('19/10/26, 14:05 - Ana: oi').at.toISOString()).toBe('2026-10-19T17:05:00.000Z');
  });

  it('reads CRLF lines and a leading byte-order mark', () => {
    const text = `\ufeff${ANDROID.split('\n').join('\r\n')}\r\n`;
    const result = parsed(text);
    expect(result.platform).toBe('android');
    expect(result.messages.map((m) => m.text)).toEqual([
      'Olá! Vi o seu interesse.\nSegue a proposta:\n- item um\n- item dois',
      'Obrigado',
    ]);
  });

  it('takes an impossible date (31/02) as a continuation line, not a new message', () => {
    const result = parsed(
      ['19/10/2026 14:05 - Ana: primeira', '31/02/2026 14:06 - Ana: segunda'].join('\n'),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('primeira\n31/02/2026 14:06 - Ana: segunda');
  });

  it('rejects 31/04 and 29/02 of a common year, and reads 29/02 of a leap year', () => {
    const lines = (date: string) => [
      `19/10/2026 14:05 - Ana: antes`,
      `${date} 14:06 - Ana: depois`,
    ];
    expect(parsed(lines('31/04/2026').join('\n')).messages).toHaveLength(1);
    expect(parsed(lines('29/02/2026').join('\n')).messages).toHaveLength(1);
    const leap = parsed(lines('29/02/2028').join('\n')).messages;
    expect(leap).toHaveLength(2);
    expect(leap[1]?.at.toISOString()).toBe('2028-02-29T17:06:00.000Z');
  });

  it('rolls the year over for a message of the last evening of the year', () => {
    expect(first('31/12/2026 22:30 - Ana: feliz ano novo').at.toISOString()).toBe(
      '2027-01-01T01:30:00.000Z',
    );
  });

  it('keeps an attachment with the caption on the next line', () => {
    const message = first(
      [
        '19/10/2026 14:10 - Cliente Teste: IMG-20261019-WA0001.jpg (arquivo anexado)',
        'Fachada',
      ].join('\n'),
    );
    expect(message).toMatchObject({
      kind: 'image',
      file: 'IMG-20261019-WA0001.jpg',
      text: 'Fachada',
      omitted: false,
    });
  });

  it('keeps an attachment with no caption as media with no text', () => {
    const message = first(
      '19/10/2026 14:10 - Cliente Teste: PTT-20261019-WA0002.opus (arquivo anexado)',
    );
    expect(message).toMatchObject({ kind: 'audio', file: 'PTT-20261019-WA0002.opus', text: null });
  });

  it('marks <Mídia oculta> as an omitted media of an unsupported kind', () => {
    expect(first('19/10/2026 14:11 - Cliente Teste: <Mídia oculta>')).toMatchObject({
      kind: 'unsupported',
      omitted: true,
      text: null,
      file: null,
    });
  });

  it('returns null for text that is not an export', () => {
    expect(parseWhatsAppExport('Oi, tudo bem?\nSó uma anotação qualquer.')).toBeNull();
    expect(parseWhatsAppExport('')).toBeNull();
  });
});

describe('iPhone export', () => {
  const NOTICE = `${LRM}[19/10/2026 14:00:01] Contato Teste: ${LRM}As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.`;
  const IOS = [
    NOTICE,
    `${LRM}[19/10/2026 14:05:33] Wings Company: Bom dia!`,
    `${LRM}[19/10/2026 14:06:10] Cliente Teste: ${LRM}<anexado: 00000012-PHOTO-2026-10-19-14-05-33.jpg>`,
    `${LRM}[19/10/2026 14:07:00] Cliente Teste: ${LRM}imagem ocultada`,
    `${LRM}[19/10/2026 14:07:30] Cliente Teste: ${LRM}áudio ocultado`,
    `${LRM}[19/10/2026 14:08:00] Cliente Teste: Quero saber mais`,
  ].join('\n');

  it('reads seconds and ignores the direction marks before the bracket and the attachment', () => {
    const result = parsed(IOS);
    expect(result.platform).toBe('ios');
    expect(result.messages[0]).toMatchObject({ author: 'Wings Company', text: 'Bom dia!' });
    expect(result.messages[0]?.at.toISOString()).toBe('2026-10-19T17:05:33.000Z');
    expect(result.messages[1]).toMatchObject({
      author: 'Cliente Teste',
      kind: 'image',
      file: '00000012-PHOTO-2026-10-19-14-05-33.jpg',
      text: null,
      omitted: false,
    });
    expect(result.messages[4]).toMatchObject({ kind: 'text', text: 'Quero saber mais' });
  });

  it('marks "imagem ocultada" and "áudio ocultado" as omitted media of that kind', () => {
    const [, , image, audio] = parsed(IOS).messages;
    expect(image).toMatchObject({ kind: 'image', omitted: true, text: null, file: null });
    expect(audio).toMatchObject({ kind: 'audio', omitted: true, text: null, file: null });
  });

  it("skips and counts the app's own notice the phone files under a contact's name", () => {
    const result = parsed(IOS);
    expect(result.skipped).toBe(1);
    expect(result.messages).toHaveLength(5);
    expect(result.messages.map((m) => m.text).join(' ')).not.toContain('criptografia');
    expect(participantsOf(result).map((p) => p.name)).toEqual(['Cliente Teste', 'Wings Company']);
  });

  it('skips any other line the app marks as its own, such as a deleted message, with its continuation', () => {
    const result = parsed(
      [
        `${LRM}[19/10/2026 14:05:33] Cliente Teste: Oi`,
        `${LRM}[19/10/2026 14:06:00] Cliente Teste: ${LRM}Esta mensagem foi apagada.`,
        'segunda linha do aviso',
        `${LRM}[19/10/2026 14:07:00] Cliente Teste: Voltei`,
      ].join('\n'),
    );
    expect(result.skipped).toBe(1);
    expect(result.messages.map((m) => m.text)).toEqual(['Oi', 'Voltei']);
  });

  it('keeps a plain line the app did not mark, even when it is about the encryption', () => {
    const result = parsed(`[19/10/2026 14:00:01] Cliente Teste: As mensagens são protegidas`);
    expect(result.skipped).toBe(0);
    expect(result.messages.map((m) => m.text)).toEqual(['As mensagens são protegidas']);
  });

  it('leaves Android alone: a mark in front of the text does not make a notice', () => {
    const result = parsed(`19/10/2026 14:05 - Cliente Teste: ${LRM}Oi`);
    expect(result.skipped).toBe(0);
    expect(result.messages.map((m) => m.text)).toEqual(['Oi']);
  });
});

describe('hashes', () => {
  const REPEATED = [
    '19/10/2026 14:05 - Ana: ok',
    '19/10/2026 14:05 - Ana: ok',
    '19/10/2026 14:05 - Bruno: ok',
  ].join('\n');

  it('gives two identical lines of the same minute different hashes', () => {
    const hashes = parsed(REPEATED).messages.map((m) => m.hash);
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(3);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it('gives the same hashes every time the same text is read', () => {
    expect(parsed(REPEATED).messages.map((m) => m.hash)).toEqual(
      parsed(REPEATED).messages.map((m) => m.hash),
    );
  });

  it('keeps the hashes of the first lines when a longer export of the same chat is read', () => {
    const longer = `${REPEATED}\n19/10/2026 14:06 - Ana: ok\n19/10/2026 14:07 - Bruno: fechado`;
    const before = parsed(REPEATED).messages.map((m) => m.hash);
    const after = parsed(longer).messages.map((m) => m.hash);
    expect(after.slice(0, 3)).toEqual(before);
    expect(after).toHaveLength(5);
    expect(new Set(after).size).toBe(5);
  });

  it('tells apart the same text sent at another minute or by another person', () => {
    const a = first('19/10/2026 14:05 - Ana: ok').hash;
    expect(first('19/10/2026 14:06 - Ana: ok').hash).not.toBe(a);
    expect(first('19/10/2026 14:05 - Bruno: ok').hash).not.toBe(a);
  });
});

describe('participantsOf and guessOurSide', () => {
  it('lists who wrote by message count, ties by name', () => {
    const result = parsed(
      [
        '19/10/2026 14:05 - Wings Company: um',
        '19/10/2026 14:06 - Wings Company: dois',
        '19/10/2026 14:07 - Wings Company: três',
        '19/10/2026 14:08 - Bruno: a',
        '19/10/2026 14:09 - Ana: b',
      ].join('\n'),
    );
    expect(participantsOf(result)).toEqual([
      { name: 'Wings Company', messages: 3 },
      { name: 'Ana', messages: 1 },
      { name: 'Bruno', messages: 1 },
    ]);
  });

  it('picks the one name that contains "Wings"', () => {
    expect(guessOurSide(['Cliente Teste', 'Wings Company'])).toBe('Wings Company');
    expect(guessOurSide(['wings tráfego', 'Cliente Teste'])).toBe('wings tráfego');
  });

  it('picks nothing when no name or two names contain "Wings"', () => {
    expect(guessOurSide(['Ana', 'Bruno'])).toBeNull();
    expect(guessOurSide(['Wings Company', 'Wings Company - Tráfego'])).toBeNull();
    expect(guessOurSide([])).toBeNull();
  });
});

describe('kindOfFile', () => {
  it('maps the extension to the message kind', () => {
    expect(kindOfFile('IMG-20261019-WA0001.jpg')).toBe('image');
    expect(kindOfFile('FOTO.JPG')).toBe('image');
    expect(kindOfFile('PTT-20261019-WA0002.opus')).toBe('audio');
    expect(kindOfFile('VID-20261019-WA0003.mp4')).toBe('video');
    expect(kindOfFile('STK-20261019-WA0004.webp')).toBe('sticker');
    expect(kindOfFile('proposta.pdf')).toBe('document');
  });

  it('calls a file with an unknown extension, or none, a document', () => {
    expect(kindOfFile('planilha.xlsx')).toBe('document');
    expect(kindOfFile('semextensao')).toBe('document');
  });
});
