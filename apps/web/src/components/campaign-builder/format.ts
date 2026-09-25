/** Formatting helpers for the campaign builder. Money is integer cents. */

export function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * What an operator types for money -> cents. NaN when it is not money, so the
 * schema reports it instead of a silent zero.
 *
 * Both decimal marks are accepted, because a phone's numeric keypad often only
 * offers a dot: "20", "20,5", "20.50", "R$ 20,00", "1.250" and "1.250,00" all
 * mean what a person would read. A dot is a decimal mark only when one or two
 * digits follow it and there is no comma; "1.250" stays one thousand.
 */
export function parseBrlToCents(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const cleaned = value.replace(/[R$\s]/g, '');

  let normalised: string;
  if (cleaned.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(cleaned)) return Number.NaN;
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+\.\d{1,2}$/.test(cleaned)) {
    normalised = cleaned;
  } else if (/^\d{1,3}(\.\d{3})+$|^\d+$/.test(cleaned)) {
    normalised = cleaned.replace(/\./g, '');
  } else {
    return Number.NaN;
  }
  return Math.round(Number(normalised) * 100);
}

/** Today in the ad account's timezone, as YYYY-MM-DD. */
export function todayInSaoPaulo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

export function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}/${month}/${year}` : '—';
}

/** "atualizado há 3 min" from an ISO instant; "nunca sincronizado" when null. */
export function agoLabel(iso: string | null): string {
  if (!iso) return 'nunca sincronizado';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'atualizado agora mesmo';
  if (minutes < 60) return `atualizado há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `atualizado há ${hours}h`;
}
