import { instagramUsernameOf } from '@wings/shared/instagram';

/**
 * The approved form's rules (landing v3, Eric): every field but the site is
 * required, the button stays off until everything is filled, and the line
 * under it says what is still missing. Pure, so the page and the tests share it.
 */

/** `(21) 99999-9999` as the person types; at most 11 digits. */
export function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  let out = d;
  if (d.length > 2) out = '(' + d.slice(0, 2) + ') ' + d.slice(2);
  if (d.length > 7) out = '(' + d.slice(0, 2) + ') ' + d.slice(2, d.length - 4) + '-' + d.slice(-4);
  return out;
}

export const phoneDigitsOf = (value: string): string => value.replace(/\D/g, '');

/** Accepts `@marca`, `marca` or the profile address; the username is what is kept. */
export const instagramOk = (value: string): boolean => instagramUsernameOf(value) !== null;

/** Optional: empty is fine; otherwise a host with a dot and a top-level domain. */
export function siteOk(value: string): boolean {
  const s = value.trim();
  if (!s) return true;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    return /\.[a-z]{2,}$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** The site as sent: `https://` added when missing; undefined when empty. */
export function siteUrlOf(value: string): string | undefined {
  const s = value.trim();
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

export interface FieldRule {
  /** The input's id. */
  id: string;
  /** The id of the error line under it. */
  errorId: string;
  /** How the missing line names it; null for an optional field. */
  label: string | null;
  ok: (value: string) => boolean;
  message: string;
}

export const FIELD_RULES: readonly FieldRule[] = [
  {
    id: 'f-nome',
    errorId: 'e-nome',
    label: 'nome',
    ok: (v) => v.trim().length >= 3,
    message: 'Escreva o seu nome.',
  },
  {
    id: 'f-tel',
    errorId: 'e-tel',
    label: 'WhatsApp',
    ok: (v) => {
      const d = phoneDigitsOf(v);
      return d.length >= 10 && d.length <= 11;
    },
    message: 'Informe um WhatsApp com DDD.',
  },
  {
    id: 'f-email',
    errorId: 'e-email',
    label: 'e-mail',
    ok: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
    message: 'Confira o e-mail.',
  },
  {
    id: 'f-empresa',
    errorId: 'e-empresa',
    label: 'empresa',
    ok: (v) => v.trim().length >= 2,
    message: 'Escreva o nome da empresa.',
  },
  {
    id: 'f-ig',
    errorId: 'e-ig',
    label: 'Instagram',
    ok: instagramOk,
    message: 'Informe o @ do Instagram da marca (só letras, números, ponto e sublinhado).',
  },
  {
    id: 'f-site',
    errorId: 'e-site',
    label: null,
    ok: siteOk,
    message: 'Confira o endereço do site.',
  },
  {
    id: 'f-int',
    errorId: 'e-int',
    label: 'o que você procura',
    ok: (v) => v !== '',
    message: 'Escolha uma opção.',
  },
];

export const CONSENT_LABEL = 'aceite da política';
export const CAPTCHA_LABEL = 'verificação antirrobô';
export const CONSENT_MESSAGE = 'Precisamos do seu aceite para responder.';
export const READY_TEXT = 'Tudo certo. Pode enviar.';

/** What is still missing, in the form's order, then the consent and the robot check. */
export function missingOf(
  values: Readonly<Record<string, string>>,
  consent: boolean,
  hasToken: boolean,
): string[] {
  const lacking: string[] = [];
  for (const rule of FIELD_RULES) {
    if (rule.label && !rule.ok(values[rule.id] ?? '')) lacking.push(rule.label);
  }
  if (!consent) lacking.push(CONSENT_LABEL);
  if (!hasToken) lacking.push(CAPTCHA_LABEL);
  return lacking;
}

/** The line under the button. */
export function missingLineOf(lacking: readonly string[]): { text: string; ready: boolean } {
  return lacking.length
    ? { text: 'Para enviar, falta: ' + lacking.join(', ') + '.', ready: false }
    : { text: READY_TEXT, ready: true };
}
