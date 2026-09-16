/**
 * CPF helpers that carry no secrets, so both the API and the browser can use
 * them. Encryption and the blind index live in the API only.
 */

/** Strips formatting, leaving digits. */
export function normalizeCpf(value: string): string {
  return value.replace(/\D/g, '');
}

/** Validates a CPF using the two official check digits. */
export function isValidCpf(value: string): boolean {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return false;
  // Reject known invalid sequences such as 111.111.111-11.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number) as number[];
  for (const position of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < position; i++) {
      sum += (digits[i] as number) * (position + 1 - i);
    }
    const remainder = (sum * 10) % 11;
    const expected = remainder === 10 ? 0 : remainder;
    if (expected !== digits[position]) return false;
  }
  return true;
}

/** 12345678909 -> 123.456.789-09 */
export function formatCpf(value: string): string {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return value;
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/**
 * Default rendering everywhere in the UI: 123.456.789-09 -> ***.456.789-**
 * The full value is only returned to callers holding `employees.pii.view`,
 * and every reveal is written to the audit log.
 */
export function maskCpf(value: string): string {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return '***.***.***-**';
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}
