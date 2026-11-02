import { createHash } from 'node:crypto';

/**
 * E-mail and phone as each platform asks them normalised before SHA-256
 * (docs/ads/fechar-ciclo.md, "Hash"). Run in memory at send time only: the
 * result is never written to a table, a log or an answer.
 */

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Meta `em`: trimmed and lower-cased. */
export function metaEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

/** Meta `ph`: digits only, with the country code, no leading zeros. */
export function metaPhone(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return null;
  // Our leads keep 55 + DDD + number; a bare DDD + number (10 or 11 digits) is Brazilian.
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
}

/**
 * Google: every space removed and lower-cased; in gmail.com and googlemail.com the dots before the @
 * and anything from a "+" are removed too.
 */
export function googleEmail(email: string | null | undefined): string | null {
  const value = email?.replace(/\s/g, '').toLowerCase();
  if (!value || !value.includes('@')) return null;
  const at = value.lastIndexOf('@');
  const domain = value.slice(at + 1);
  let local = value.slice(0, at);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0]!.replace(/\./g, '');
  }
  return local ? `${local}@${domain}` : null;
}

/** Google: E.164, a "+" and the country code. */
export function googlePhone(phone: string | null | undefined): string | null {
  const digits = metaPhone(phone);
  return digits ? `+${digits}` : null;
}
