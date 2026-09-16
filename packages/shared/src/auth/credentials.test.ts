import { describe, expect, it } from 'vitest';
import { passwordLooksPersonal, passwordSchema } from './credentials.js';

const EMAIL = 'joao.silva@wingscompany.com.br';

describe('password policy', () => {
  it('requires at least 12 characters', () => {
    expect(passwordSchema.safeParse('curta1').success).toBe(false);
    expect(passwordSchema.safeParse('doze-caracter').success).toBe(true);
  });

  it('rejects leading or trailing whitespace', () => {
    expect(passwordSchema.safeParse(' senha-longa-2026').success).toBe(false);
    expect(passwordSchema.safeParse('senha-longa-2026 ').success).toBe(false);
  });

  it('rejects passwords built from the account name', () => {
    expect(passwordLooksPersonal('joao.silva-2026', EMAIL)).toBe(true);
    expect(passwordLooksPersonal('JOAO.SILVA-abcdefgh', EMAIL)).toBe(true);
  });

  it('rejects obvious guesses', () => {
    expect(passwordLooksPersonal('senha', EMAIL)).toBe(true);
    expect(passwordLooksPersonal('senha123', EMAIL)).toBe(true);
    expect(passwordLooksPersonal('wings2026', EMAIL)).toBe(true);
    expect(passwordLooksPersonal('abc123456def', EMAIL)).toBe(true);
    expect(passwordLooksPersonal('qwertyuiop', EMAIL)).toBe(true);
  });

  it('accepts a real passphrase that merely contains a common word', () => {
    // "senha" appears inside, but the password is long and unguessable.
    expect(passwordLooksPersonal('minha-senha-bem-longa-2026', EMAIL)).toBe(false);
    expect(passwordLooksPersonal('cadeira-verde-melancia-77', EMAIL)).toBe(false);
  });
});
