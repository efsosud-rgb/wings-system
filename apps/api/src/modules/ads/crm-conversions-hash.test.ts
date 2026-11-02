import { describe, expect, it } from 'vitest';
import {
  googleEmail,
  googlePhone,
  metaEmail,
  metaPhone,
  sha256Hex,
} from './crm-conversions-hash.js';

// Made-up contacts. The expected hashes were computed apart, with `printf '<value>' | sha256sum`.
describe('normalisation before the hash (official rules, read on 02/11/2026)', () => {
  it('Meta e-mail: trimmed and lower-cased, dots and "+" kept', () => {
    expect(metaEmail('  Ana.Souza+Promo@Gmail.com ')).toBe('ana.souza+promo@gmail.com');
    expect(sha256Hex(metaEmail(' Ana.Souza+Promo@GMAIL.com')!)).toBe(
      'b66bb81101b6f215c1c1ce7e334e2566e8784ff57814840d8c99c1bce2159e79',
    );
    expect(metaEmail('   ')).toBeNull();
  });

  it('Meta phone: digits only, country code, no leading zeros', () => {
    expect(metaPhone('+55 (11) 98765-4321')).toBe('5511987654321');
    expect(metaPhone('011 98765-4321')).toBe('5511987654321');
    expect(metaPhone('(11) 98765-4321')).toBe('5511987654321');
    expect(sha256Hex(metaPhone('5511987654321')!)).toBe(
      '029c7290f14c4516673508635f0519db95f7daf42057fd0e4ad1de84c5408a66',
    );
    expect(metaPhone('')).toBeNull();
  });

  it('Google e-mail: no spaces, lower-cased; gmail drops dots and the "+" part', () => {
    expect(googleEmail(' Ana.Souza+Promo@Gmail.com')).toBe('anasouza@gmail.com');
    expect(googleEmail('ana.souza+promo@googlemail.com')).toBe('anasouza@googlemail.com');
    expect(sha256Hex(googleEmail('Ana.Souza+Promo@gmail.com')!)).toBe(
      '5ae7ac33d3d097ee92132b1700c11137af7b26e58626df4f5dda7fd284143d43',
    );
    // Any other domain keeps its dots and its "+".
    expect(googleEmail('Pessoa.Teste+x@Exemplo.com.br')).toBe('pessoa.teste+x@exemplo.com.br');
    expect(googleEmail('sem-arroba')).toBeNull();
  });

  it('Google phone: E.164 with the "+"', () => {
    expect(googlePhone('5511987654321')).toBe('+5511987654321');
    expect(sha256Hex(googlePhone('(11) 98765-4321')!)).toBe(
      '38225ec3dccec4189659c110ddc4f3dc9c27539850cb6a9ddae31ae03a5cf441',
    );
  });

  it('hashes as lower-case hex', () => {
    expect(sha256Hex('pessoa.teste@exemplo.com.br')).toBe(
      '013e14b1a9aa3ef12e98fc20a1b4285be2a53c82dd4f202dfbc8a7bcfa4ff623',
    );
  });
});
