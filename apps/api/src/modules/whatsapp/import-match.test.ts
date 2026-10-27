import { describe, expect, it } from 'vitest';
import { parseWhatsAppExport } from './import-parse.js';
import {
  chatPhonesOf,
  contactNameOf,
  normalizeName,
  parseNameMap,
  phoneOf,
} from './import-match.js';

/** Who a conversation is with ("Importar em lote"): names, numbers and the name/phone map. No database. */

const parsed = (...lines: string[]) => {
  const result = parseWhatsAppExport(lines.join('\n'));
  if (!result) throw new Error('not an export');
  return result;
};

describe('normalizeName', () => {
  it('ignores case, accents, emoji, punctuation and repeated spaces', () => {
    expect(normalizeName('Maria  Souza 🌸')).toBe('maria souza');
    expect(normalizeName('MARIA SOUZA')).toBe('maria souza');
    expect(normalizeName('  José-Carlos   D’Ávila. ')).toBe('jose carlos d avila');
    expect(normalizeName('João Çedilha')).toBe('joao cedilha');
  });

  it('makes the same name from the file name and from the contact book', () => {
    expect(normalizeName('Contato Teste')).toBe(normalizeName('  contato   TESTE 😀'));
  });

  it('keeps digits and gives an empty string for a name with no letter or digit', () => {
    expect(normalizeName('Contato 2')).toBe('contato 2');
    expect(normalizeName('🌸 -- ()')).toBe('');
    expect(normalizeName('')).toBe('');
  });
});

describe('phoneOf', () => {
  it('reads a number with +55, with the 9th digit and any punctuation', () => {
    expect(phoneOf('+55 11 90000-0001')).toBe('5511900000001');
    expect(phoneOf('+55 (11) 90000-0001')).toBe('5511900000001');
    expect(phoneOf('55 11 90000 0001')).toBe('5511900000001');
    expect(phoneOf('5511900000001')).toBe('5511900000001');
  });

  it('adds the 55 when the number is written with the DDD only', () => {
    expect(phoneOf('11 90000-0001')).toBe('5511900000001');
    expect(phoneOf('(11) 90000-0001')).toBe('5511900000001');
    expect(phoneOf('11900000001')).toBe('5511900000001');
  });

  it('gives a mobile written without the 9th digit its 9th digit back', () => {
    expect(phoneOf('11 8000-0001')).toBe('5511980000001');
    expect(phoneOf('+55 11 8000-0001')).toBe('5511980000001');
    expect(phoneOf('551180000001')).toBe('5511980000001');
  });

  it('leaves a landline as it is (it has only one form)', () => {
    expect(phoneOf('(11) 3000-0001')).toBe('551130000001');
    expect(phoneOf('+55 11 3000-0001')).toBe('551130000001');
  });

  it('gives the same number whatever way it was written', () => {
    const forms = ['+55 11 90000-0001', '11 90000-0001', '(11)900000001', '5511900000001'];
    expect(new Set(forms.map(phoneOf)).size).toBe(1);
    expect(phoneOf('+55 11 8000-0001')).toBe(phoneOf('11 98000-0001'));
  });

  it('refuses what is not a Brazilian number', () => {
    expect(phoneOf('')).toBeNull();
    expect(phoneOf('Telefone')).toBeNull();
    expect(phoneOf('123')).toBeNull();
    expect(phoneOf('11 9000-001')).toBeNull();
    expect(phoneOf('+55 11 90000-00012')).toBeNull();
    expect(phoneOf('+44 20 7946 0958')).toBeNull();
  });

  it('refuses a number that names another country code', () => {
    expect(phoneOf('+1 415 555 0100')).toBeNull();
  });
});

describe('contactNameOf', () => {
  it('takes the contact from the Android file name', () => {
    expect(contactNameOf('Conversa do WhatsApp com Contato Teste.txt', [], null)).toBe(
      'Contato Teste',
    );
    expect(contactNameOf('Conversa do WhatsApp com Contato Teste.zip', [], null)).toBe(
      'Contato Teste',
    );
  });

  it('takes the contact from the English and iPhone file names', () => {
    expect(contactNameOf('WhatsApp Chat with Contato Teste.zip', [], null)).toBe('Contato Teste');
    expect(contactNameOf('WhatsApp Chat - Contato Teste.zip', [], null)).toBe('Contato Teste');
    expect(contactNameOf('Chat de WhatsApp con Contato Teste.txt', [], null)).toBe('Contato Teste');
  });

  it('ignores case, the copy number the system adds, and the folder', () => {
    expect(contactNameOf('CONVERSA DO WHATSAPP COM Contato Teste.TXT', [], null)).toBe(
      'Contato Teste',
    );
    expect(contactNameOf('Conversa do WhatsApp com Contato Teste (2).txt', [], null)).toBe(
      'Contato Teste',
    );
    expect(contactNameOf('pasta/sub/Conversa do WhatsApp com Contato Teste.txt', [], null)).toBe(
      'Contato Teste',
    );
    expect(contactNameOf('C:\\pasta\\WhatsApp Chat with Contato Teste.zip', [], null)).toBe(
      'Contato Teste',
    );
  });

  it('keeps a dot or a number that belongs to the name', () => {
    expect(contactNameOf('Conversa do WhatsApp com Dr. Teste.txt', [], null)).toBe('Dr. Teste');
    expect(contactNameOf('Conversa do WhatsApp com Contato 2.txt', [], null)).toBe('Contato 2');
  });

  it('falls back to the one other person who wrote when the file name says nothing', () => {
    expect(contactNameOf('_chat.txt', ['Wings Company', 'Contato Teste'], 'Wings Company')).toBe(
      'Contato Teste',
    );
    expect(contactNameOf('export.zip', ['Contato Teste'], null)).toBe('Contato Teste');
  });

  it('gives null when the other side is not one clear name', () => {
    // Two others (a group), none, or only a number (the phone had no contact saved).
    expect(
      contactNameOf('_chat.txt', ['Wings Company', 'Ana', 'Beto'], 'Wings Company'),
    ).toBeNull();
    expect(contactNameOf('_chat.txt', ['Wings Company'], 'Wings Company')).toBeNull();
    expect(
      contactNameOf('_chat.txt', ['Wings Company', '+55 11 90000-0001'], 'Wings Company'),
    ).toBeNull();
    expect(contactNameOf('_chat.txt', ['Ana', 'Beto'], null)).toBeNull();
  });

  it('prefers the file name to the participants', () => {
    expect(
      contactNameOf(
        'Conversa do WhatsApp com Contato Teste.txt',
        ['Wings Company', 'Outro Nome'],
        'Wings Company',
      ),
    ).toBe('Contato Teste');
  });
});

describe('chatPhonesOf', () => {
  const OUR = 'Wings Company';

  it('takes the author that is a number as the strong clue', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:05 - Wings Company: Olá, tudo bem?',
        '19/10/2026 14:06 - +55 11 90000-0001: Oi',
        '19/10/2026 14:07 - +55 11 90000-0001: Quero saber o preço',
      ),
      OUR,
    );
    expect(result).toEqual({ authors: ['5511900000001'], written: [] });
  });

  it('reads an author written without +55 or without the 9th digit as the same number', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:06 - 11 8000-0001: Oi',
        '19/10/2026 14:07 - +55 11 98000-0001: de novo',
      ),
      OUR,
    );
    expect(result.authors).toEqual(['5511980000001']);
  });

  it('collects the numbers the other side wrote in messages, in any way people write them', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:06 - Contato Teste: Meu WhatsApp é +55 11 90000-0002',
        '19/10/2026 14:07 - Contato Teste: ou (11) 90000-0003',
        '19/10/2026 14:08 - Contato Teste: ou 11900000004',
        '19/10/2026 14:09 - Contato Teste: o fixo é 11 8000-0005',
        '19/10/2026 14:10 - Contato Teste: ou 5511900000006',
      ),
      OUR,
    );
    expect(result.authors).toEqual([]);
    expect(result.written.sort()).toEqual([
      '5511900000002',
      '5511900000003',
      '5511900000004',
      '5511900000006',
      '5511980000005',
    ]);
  });

  it('lists a number once, however many times and ways it was written', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:06 - Contato Teste: 11 90000-0002',
        '19/10/2026 14:07 - Contato Teste: +55 11 90000-0002',
        '19/10/2026 14:08 - Contato Teste: 11 8000-0009',
        '19/10/2026 14:09 - Contato Teste: 11 98000-0009',
      ),
      OUR,
    );
    expect(result.written.sort()).toEqual(['5511900000002', '5511980000009']);
  });

  it('leaves out what the Wings side wrote, which is its own number', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:05 - Wings Company: Nosso número é +55 11 90000-0099',
        '19/10/2026 14:06 - Contato Teste: Oi',
      ),
      OUR,
    );
    expect(result).toEqual({ authors: [], written: [] });
  });

  it('leaves out nothing when our side is not known', () => {
    const result = chatPhonesOf(
      parsed('19/10/2026 14:05 - Wings Company: Nosso número é +55 11 90000-0099'),
      null,
    );
    expect(result.written).toEqual(['5511900000099']);
  });

  it('gives nothing for a chat with no number, and keeps going past a media line', () => {
    const result = chatPhonesOf(
      parsed(
        '19/10/2026 14:05 - Contato Teste: IMG-20261019-WA0001.jpg (arquivo anexado)',
        '19/10/2026 14:06 - Contato Teste: Obrigado!',
        '19/10/2026 14:07 - Contato Teste: são 3 itens, 12 caixas',
      ),
      OUR,
    );
    expect(result).toEqual({ authors: [], written: [] });
  });
});

describe('parseNameMap', () => {
  const MAP = { 'contato teste': '5511900000001' };

  it('reads a pair with ;  ,  or a tab between name and number', () => {
    expect(parseNameMap('Contato Teste;+55 11 90000-0001')).toEqual(MAP);
    expect(parseNameMap('Contato Teste,11900000001')).toEqual(MAP);
    expect(parseNameMap('Contato Teste\t(11) 90000-0001')).toEqual(MAP);
  });

  it('keys the map by the normalized name and gives the number in the CRM form', () => {
    expect(parseNameMap('JOÃO  Teste 🌸;11 8000-0002')).toEqual({ 'joao teste': '5511980000002' });
  });

  it('reads many lines, with CRLF, blank lines and a byte-order mark', () => {
    const csv =
      '\ufeffContato Um;11900000001\r\n\r\n  Contato Dois ; 11900000002 \r\nContato Três,11900000003\r\n';
    expect(parseNameMap(csv)).toEqual({
      'contato um': '5511900000001',
      'contato dois': '5511900000002',
      'contato tres': '5511900000003',
    });
  });

  it('skips a header and the lines without a name or a valid number', () => {
    const csv = [
      'Nome;Telefone',
      'name,phone',
      'sem separador nenhum',
      ';11900000001',
      'Sem Número;',
      'Número Ruim;123',
      'Estrangeiro;+44 20 7946 0958',
      '',
      'Contato Teste;11900000001',
    ].join('\n');
    expect(parseNameMap(csv)).toEqual(MAP);
  });

  it('reads a quoted name that has the separator inside it', () => {
    expect(parseNameMap('"Teste, Contato";11900000001')).toEqual({
      'teste contato': '5511900000001',
    });
  });

  it('keeps a duplicate pair, however the number is written', () => {
    const csv = ['Contato Teste;11900000001', 'contato teste;+55 11 90000-0001'].join('\n');
    expect(parseNameMap(csv)).toEqual(MAP);
    const noNine = ['Contato Teste;11 8000-0001', 'Contato Teste;11 98000-0001'].join('\n');
    expect(parseNameMap(noNine)).toEqual({ 'contato teste': '5511980000001' });
  });

  it('leaves out a name given two different numbers, and keeps the other names', () => {
    const csv = [
      'Contato Teste;11900000001',
      'Outro Contato;11900000002',
      'CONTATO TESTE;11900000003',
      'Contato Teste;11900000001',
    ].join('\n');
    expect(parseNameMap(csv)).toEqual({ 'outro contato': '5511900000002' });
  });

  it('gives an empty map for an empty file', () => {
    expect(parseNameMap('')).toEqual({});
    expect(parseNameMap('\n\n')).toEqual({});
  });
});
