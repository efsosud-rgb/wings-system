import { siteFormSubmitSchema } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { siteFormSpecOf, submitResultOf } from './api.js';
import { qualifierAnswerOf, submitBodyOf, type FormValues } from './payload.js';

const VALUES: FormValues = {
  name: '  Pessoa de Teste ',
  phone: '(21) 90000-0000',
  email: ' pessoa@exemplo.com.br ',
  companyName: 'Empresa Exemplo',
  instagram: 'https://www.instagram.com/Marca.Exemplo/',
  siteUrl: 'www.exemplo.com.br',
  qualifierValue: 'nao-sei',
  qualifierText: 'Ainda não sei',
  monthlyRevenue: '100k-300k',
  website: '',
};

const SPEC = siteFormSpecOf({
  qualifier: {
    question: 'O que você procura?',
    options: ['Transformar meu negócio em franquia', 'Ainda não sei'],
  },
  qualifierValues: [
    { value: 'formatacao', option: 'Transformar meu negócio em franquia' },
    { value: 'nao-sei', option: 'Ainda não sei' },
  ],
  requiredFields: ['email', 'companyName', 'instagram', 'qualifierAnswer', 'cnpj'],
  privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
  thankYou: { title: 't', body: 'b', buttonText: 'x', buttonUrl: 'https://wingscompany.com.br/' },
});

/** The POST body's keys, as the API contract names them. */
const CONTRACT_KEYS = [
  'name',
  'phone',
  'email',
  'companyName',
  'instagram',
  'siteUrl',
  'qualifierAnswer',
  'monthlyRevenue',
  'consent',
  'page',
  'tracking',
  'turnstileToken',
  'website',
];

describe('submitBodyOf', () => {
  const body = submitBodyOf({
    values: VALUES,
    tracking: { utm_source: 'meta', referrer: 'https://www.google.com/' },
    turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
    href: 'https://fale.wingscompany.com.br/?utm_source=meta#formulario',
    form: SPEC,
  });

  it('uses the API’s names and sends what the person typed, cleaned', () => {
    expect(body).toEqual({
      name: 'Pessoa de Teste',
      phone: '21900000000',
      email: 'pessoa@exemplo.com.br',
      companyName: 'Empresa Exemplo',
      instagram: 'marca.exemplo',
      siteUrl: 'https://www.exemplo.com.br',
      qualifierAnswer: 'nao-sei',
      monthlyRevenue: '100k-300k',
      consent: true,
      page: 'https://fale.wingscompany.com.br/?utm_source=meta',
      tracking: { utm_source: 'meta', referrer: 'https://www.google.com/' },
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      website: '',
    });
    expect(Object.keys(body).every((key) => CONTRACT_KEYS.includes(key))).toBe(true);
  });

  it('passes the shared schema the API parses with', () => {
    expect(siteFormSubmitSchema.safeParse(body).success).toBe(true);
  });

  it('leaves the site out when empty and sends the honeypot as it is', () => {
    const robot = submitBodyOf({
      values: { ...VALUES, siteUrl: ' ', website: 'http://spam.example' },
      tracking: {},
      turnstileToken: 't',
      href: 'https://fale.wingscompany.com.br/',
    });
    expect(robot).not.toHaveProperty('siteUrl');
    expect(
      submitBodyOf({
        ...{ tracking: {}, turnstileToken: 't', href: 'https://x.test/' },
        values: { ...VALUES, monthlyRevenue: '' },
      }),
    ).not.toHaveProperty('monthlyRevenue');
    expect(robot).not.toHaveProperty('tracking');
    expect(robot.website).toBe('http://spam.example');
  });
});

describe('qualifierAnswerOf', () => {
  it('sends the value when the API maps values, else the option text it knows', () => {
    expect(qualifierAnswerOf('nao-sei', 'Ainda não sei', SPEC)).toBe('nao-sei');
    const textOnly = siteFormSpecOf({
      qualifier: { question: 'O que você procura?', options: ['Ainda não sei'] },
    });
    expect(qualifierAnswerOf('nao-sei', 'Ainda não sei', textOnly)).toBe('Ainda não sei');
    expect(qualifierAnswerOf('nao-sei', 'Ainda não sei', null)).toBe('nao-sei');
    expect(qualifierAnswerOf('', '', SPEC)).toBeUndefined();
  });

  it('reads the spec defensively', () => {
    expect(SPEC?.requiredFields).toEqual(['email', 'companyName', 'instagram', 'qualifierAnswer']);
    expect(siteFormSpecOf(null)).toBeNull();
    expect(siteFormSpecOf({ qualifierValues: 'x' })?.qualifierValues).toBeUndefined();
  });
});

describe('submitResultOf', () => {
  it('maps the contract’s answers', () => {
    expect(
      submitResultOf(200, { ok: true, whatsappUrl: 'https://wa.me/550000000000?text=AB' }),
    ).toEqual({
      kind: 'ok',
      whatsappUrl: 'https://wa.me/550000000000?text=AB',
    });
    expect(submitResultOf(200, { ok: true, whatsappUrl: 'javascript:alert(1)' })).toEqual({
      kind: 'ok',
      whatsappUrl: null,
    });
    expect(
      submitResultOf(400, { error: 'invalid_request', message: 'Informe o seu e-mail.' }),
    ).toEqual({ kind: 'invalid', message: 'Informe o seu e-mail.' });
    expect(submitResultOf(403, { error: 'captcha_refused' })).toEqual({ kind: 'captcha_refused' });
    expect(submitResultOf(429, null)).toEqual({ kind: 'rate_limited' });
    expect(submitResultOf(503, { error: 'captcha_unavailable' })).toEqual({ kind: 'unavailable' });
    expect(submitResultOf(404, { error: 'not_found' })).toEqual({ kind: 'unavailable' });
  });
});
