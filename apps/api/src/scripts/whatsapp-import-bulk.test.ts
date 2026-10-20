import { describe, expect, it } from 'vitest';
import { pairsOf } from './whatsapp-import-bulk.js';

/** The `--pares` file of the "Importar em lote" CLI: `posicao;<id da negociação>` or `posicao;pular`. */

const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';

describe('pairsOf', () => {
  it('reads "position;deal id" and "position;pular"', () => {
    expect(pairsOf(`1;${ONE}\n2;pular\n3;${TWO}`)).toEqual(
      new Map([
        [1, ONE],
        [2, 'pular'],
        [3, TWO],
      ]),
    );
  });

  it('takes a comma or a tab as the separator, with spaces around it', () => {
    expect(pairsOf(`1,${ONE}\n2\tpular\n3 ; ${TWO}\n  4  ,  pular  `)).toEqual(
      new Map([
        [1, ONE],
        [2, 'pular'],
        [3, TWO],
        [4, 'pular'],
      ]),
    );
  });

  it('reads CRLF lines and leaves the id in lower case', () => {
    const upper = ONE.toUpperCase();
    expect(pairsOf(`1;${upper}\r\n2;PULAR\r\n`)).toEqual(
      new Map([
        [1, ONE],
        [2, 'pular'],
      ]),
    );
  });

  it('reads a position written with leading zeros', () => {
    expect(pairsOf(`007;${ONE}`).get(7)).toBe(ONE);
  });

  it('lets the later line win when a position appears twice', () => {
    expect(pairsOf(`1;pular\n1;${ONE}`)).toEqual(new Map([[1, ONE]]));
    expect(pairsOf(`1;${ONE}\n1;pular`)).toEqual(new Map([[1, 'pular']]));
  });

  it('skips a header, blank lines and junk', () => {
    const csv = [
      'posicao;negociacao',
      '',
      '   ',
      'abc',
      '1;',
      ';pular',
      'x;pular',
      '-1;pular',
      '1.5;pular',
      `5;${ONE.slice(0, 35)}`,
      `6;${ONE}0`,
      '7;talvez',
      `8;${ONE};extra`,
      '9 pular',
      `10|${ONE}`,
      `11:${ONE}`,
      `12;${TWO}`,
    ].join('\n');
    expect(pairsOf(csv)).toEqual(new Map([[12, TWO]]));
  });

  it('gives an empty map for an empty file', () => {
    expect(pairsOf('')).toEqual(new Map());
  });
});
