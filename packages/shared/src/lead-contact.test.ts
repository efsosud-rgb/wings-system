import { describe, expect, it } from 'vitest';
import { checkLeadContactUpdate, validLeadEmail, validLeadPhone } from './lead-contact.js';

describe('validLeadPhone', () => {
  it('accepts a mask, spaces, +55 and a trunk 0, and stores digits with 55', () => {
    expect(validLeadPhone('(11) 91234-5678')).toBe('5511912345678');
    expect(validLeadPhone('11 91234 5678')).toBe('5511912345678');
    expect(validLeadPhone('+55 (21) 3333-4444')).toBe('552133334444');
    expect(validLeadPhone('5511912345678')).toBe('5511912345678');
    expect(validLeadPhone('011 91234-5678')).toBe('5511912345678');
  });

  it('gives an old 8-digit mobile its 9th digit', () => {
    expect(validLeadPhone('(11) 8123-4567')).toBe('5511981234567');
  });

  it('refuses a missing DDD, an unknown DDD, a short number and placeholders', () => {
    expect(validLeadPhone('91234-5678')).toBeNull();
    expect(validLeadPhone('(10) 91234-5678')).toBeNull();
    expect(validLeadPhone('(11) 1234-5678')).toBeNull();
    expect(validLeadPhone('(11) 71234-5678')).toBeNull();
    expect(validLeadPhone('11111111111')).toBeNull();
    expect(validLeadPhone('abc')).toBeNull();
    expect(validLeadPhone('5511912345678999')).toBeNull();
  });
});

describe('validLeadEmail', () => {
  it('lower-cases and trims a good address', () => {
    expect(validLeadEmail('  Fulano.Teste@Exemplo.COM.br ')).toBe('fulano.teste@exemplo.com.br');
  });

  it('refuses what is not an address', () => {
    for (const bad of [
      'sem-arroba',
      'a@b',
      'a@@b.com',
      'a b@c.com',
      'a..b@c.com',
      '.a@c.com',
      'a@c..com',
    ])
      expect(validLeadEmail(bad), bad).toBeNull();
  });
});

describe('checkLeadContactUpdate', () => {
  it('normalises every field', () => {
    const checked = checkLeadContactUpdate({
      name: 'Pessoa Teste',
      phone: '(11) 91234-5678',
      email: 'A@B.CO',
      instagram: '@Perfil.Teste',
      website: 'exemplo.com.br',
    });
    expect(checked).toEqual({
      ok: true,
      patch: {
        name: 'Pessoa Teste',
        phone: '5511912345678',
        email: 'a@b.co',
        instagram: 'perfil.teste',
        website: 'https://exemplo.com.br/',
      },
    });
  });

  it('empty or null clears phone, e-mail, Instagram and site; the name cannot be cleared', () => {
    expect(
      checkLeadContactUpdate({ phone: '', email: null, instagram: ' ', website: null }),
    ).toEqual({
      ok: true,
      patch: { phone: null, email: null, instagram: null, website: null },
    });
    expect(checkLeadContactUpdate({ name: '' })).toMatchObject({ ok: false, field: 'name' });
  });

  it('names the field that is wrong', () => {
    expect(checkLeadContactUpdate({ phone: '123' })).toMatchObject({ ok: false, field: 'phone' });
    expect(checkLeadContactUpdate({ email: 'x' })).toMatchObject({ ok: false, field: 'email' });
    expect(checkLeadContactUpdate({ instagram: 'a b c' })).toMatchObject({
      ok: false,
      field: 'instagram',
    });
    expect(checkLeadContactUpdate({ website: 'não tenho' })).toMatchObject({
      ok: false,
      field: 'website',
    });
    expect(checkLeadContactUpdate({})).toMatchObject({ ok: false, field: null });
  });
});
