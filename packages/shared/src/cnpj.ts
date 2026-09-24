/**
 * CNPJ helpers, for the API and the browser alike. Since July 2026 the Receita
 * also issues alphanumeric CNPJs (IN RFB 2.229/2024): the first twelve
 * characters may be letters or digits, the two check digits stay digits, and
 * every character counts as its ASCII code minus 48. Numeric CNPJs are the
 * same rule with digits only, so one function checks both.
 */

/** Strips formatting and upper-cases, leaving the 14 characters. */
export function normalizeCnpj(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const WEIGHTS_FIRST = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const WEIGHTS_SECOND = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(body: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (body.charCodeAt(i) - 48) * (weights[i] as number);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCnpj(value: string): boolean {
  const cnpj = normalizeCnpj(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const first = checkDigit(cnpj.slice(0, 12), WEIGHTS_FIRST);
  const second = checkDigit(cnpj.slice(0, 12) + first, WEIGHTS_SECOND);
  return cnpj.endsWith(`${first}${second}`);
}

/** 12345678000195 -> 12.345.678/0001-95 */
export function formatCnpj(value: string): string {
  const cnpj = normalizeCnpj(value);
  if (cnpj.length !== 14) return value;
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/** Digits of a CEP: 01310-100 -> 01310100. */
export function normalizeCep(value: string): string {
  return value.replace(/\D/g, '');
}

/** 01310100 -> 01310-100 */
export function formatCep(value: string): string {
  const cep = normalizeCep(value);
  return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : value;
}
