/** Formatting helpers for the campaign builder. Money is integer cents. */

export function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * "20", "20,5", "1.250,00" and "R$ 20,00" -> cents. NaN when it is not money,
 * so the schema reports it instead of a silent zero.
 */
export function parseBrlToCents(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const cleaned = value
    .replace(/[R$\s]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/** Today in the ad account's timezone, as YYYY-MM-DD. */
export function todayInSaoPaulo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

export function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}/${month}/${year}` : '—';
}
