import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_LABEL,
  READY_TEXT,
  emailOk,
  instagramOk,
  maskPhone,
  missingLineOf,
  missingOf,
  siteOk,
  siteUrlOf,
} from './form-rules.js';

/** The four required answers alone. */
const SHORT = {
  'f-nome': 'Pessoa de Teste',
  'f-tel': '(21) 90000-0000',
  'f-int': 'formatacao',
  'f-fat': 'nao-informar',
};

const FILLED = {
  ...SHORT,
  'f-email': 'pessoa@exemplo.com.br',
  'f-empresa': 'Empresa Exemplo',
  'f-ig': '@marca.exemplo',
  'f-site': '',
};

describe('missingOf', () => {
  it('lists the required items of an empty form, the robot check last', () => {
    const lacking = missingOf({}, false, false);
    expect(lacking).toEqual([
      'nome',
      'WhatsApp',
      'o que você procura',
      'faturamento mensal',
      'aceite da política',
      CAPTCHA_LABEL,
    ]);
    expect(missingLineOf(lacking).text).toBe(
      'Para enviar, falta: nome, WhatsApp, o que você procura, faturamento mensal, aceite da política, verificação antirrobô.',
    );
  });

  it('is empty with the four answers, the consent and the robot check; the rest is optional', () => {
    expect(missingOf(SHORT, true, true)).toEqual([]);
    expect(missingOf(FILLED, true, true)).toEqual([]);
    expect(missingLineOf([])).toEqual({ text: READY_TEXT, ready: true });
  });

  it('asks for the robot check while there is no token', () => {
    expect(missingOf(FILLED, true, false)).toEqual([CAPTCHA_LABEL]);
  });

  it('never lists an optional field, even when what was typed is wrong', () => {
    expect(
      missingOf({ ...SHORT, 'f-email': 'sem-arroba', 'f-ig': 'marca..x' }, true, true),
    ).toEqual([]);
  });

  it('wants the monthly revenue, "Prefiro não informar" included', () => {
    expect(missingOf({ ...FILLED, 'f-fat': '' }, true, true)).toEqual(['faturamento mensal']);
  });

  it('wants a WhatsApp with area code', () => {
    expect(missingOf({ ...FILLED, 'f-tel': '90000-0000' }, true, true)).toEqual(['WhatsApp']);
  });
});

describe('optional fields are checked only when filled', () => {
  it('accepts the Instagram as @, username or profile address, or empty', () => {
    for (const instagram of [
      '',
      '  ',
      '@marca',
      'marca',
      'https://www.instagram.com/marca/?hl=pt',
    ]) {
      expect(instagramOk(instagram)).toBe(true);
    }
    expect(instagramOk('marca..x')).toBe(false);
  });

  it('accepts an empty e-mail and refuses one without @ or domain', () => {
    expect(emailOk('')).toBe(true);
    expect(emailOk(' pessoa@exemplo.com.br ')).toBe(true);
    expect(emailOk('sem-arroba')).toBe(false);
    expect(emailOk('pessoa@exemplo')).toBe(false);
  });
});

describe('phone mask and site', () => {
  it('formats as the person types', () => {
    expect(maskPhone('21')).toBe('21');
    expect(maskPhone('2190000')).toBe('(21) 90000');
    expect(maskPhone('21900000000999')).toBe('(21) 90000-0000');
    expect(maskPhone('2130000000')).toBe('(21) 3000-0000');
  });

  it('takes an empty site, adds https:// to a bare host and refuses a host without a domain', () => {
    expect(siteOk('')).toBe(true);
    expect(siteOk('www.exemplo.com.br')).toBe(true);
    expect(siteOk('exemplo')).toBe(false);
    expect(siteUrlOf('  ')).toBeUndefined();
    expect(siteUrlOf('www.exemplo.com.br')).toBe('https://www.exemplo.com.br');
    expect(siteUrlOf('http://exemplo.com')).toBe('http://exemplo.com');
  });
});
