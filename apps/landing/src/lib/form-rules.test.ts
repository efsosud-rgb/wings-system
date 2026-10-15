import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_LABEL,
  READY_TEXT,
  maskPhone,
  missingLineOf,
  missingOf,
  siteOk,
  siteUrlOf,
} from './form-rules.js';

const FILLED = {
  'f-nome': 'Pessoa de Teste',
  'f-tel': '(21) 90000-0000',
  'f-email': 'pessoa@exemplo.com.br',
  'f-empresa': 'Empresa Exemplo',
  'f-ig': '@marca.exemplo',
  'f-site': '',
  'f-int': 'formatacao',
};

describe('missingOf', () => {
  it('lists every required item of an empty form, the robot check last', () => {
    const lacking = missingOf({}, false, false);
    expect(lacking).toEqual([
      'nome',
      'WhatsApp',
      'e-mail',
      'empresa',
      'Instagram',
      'o que você procura',
      'aceite da política',
      CAPTCHA_LABEL,
    ]);
    expect(missingLineOf(lacking).text).toBe(
      'Para enviar, falta: nome, WhatsApp, e-mail, empresa, Instagram, o que você procura, aceite da política, verificação antirrobô.',
    );
  });

  it('is empty when everything is filled, ticked and checked (the site is optional)', () => {
    expect(missingOf(FILLED, true, true)).toEqual([]);
    expect(missingLineOf([])).toEqual({ text: READY_TEXT, ready: true });
  });

  it('asks for the robot check while there is no token', () => {
    expect(missingOf(FILLED, true, false)).toEqual([CAPTCHA_LABEL]);
  });

  it('accepts the Instagram as @, username or profile address', () => {
    for (const instagram of ['@marca', 'marca', 'https://www.instagram.com/marca/?hl=pt']) {
      expect(missingOf({ ...FILLED, 'f-ig': instagram }, true, true)).toEqual([]);
    }
    expect(missingOf({ ...FILLED, 'f-ig': 'marca..x' }, true, true)).toEqual(['Instagram']);
  });

  it('wants a WhatsApp with area code', () => {
    expect(missingOf({ ...FILLED, 'f-tel': '90000-0000' }, true, true)).toEqual(['WhatsApp']);
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
