import { formatBrl, type SpendUnit } from '@wings/shared';

/**
 * Number formatting for the dashboard. One rule everywhere: a figure that is
 * `null` renders as "—", because "not knowable" must never look like zero.
 */

export const DASH = '—';

export { formatBrl };

export function formatMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? DASH : formatBrl(cents);
}

export function formatAmount(value: number | null | undefined, unit: SpendUnit): string {
  if (value === null || value === undefined) return DASH;
  return unit === 'brl' ? formatBrl(value) : `${formatInt(value)} cr.`;
}

export function formatInt(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : value.toLocaleString('pt-BR');
}

/** Large counts compacted for a tile: 12,9 mil · 1,2 mi. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return value.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
}

/** Percentage x1000 → "1,43%". */
export function formatPercentMilli(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return DASH;
  return `${(milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

/** A x1000 ratio such as frequency → "1,27". */
export function formatMilli(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return DASH;
  return (milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

export function formatSignedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return `${value > 0 ? '+' : ''}${value.toLocaleString('pt-BR')}%`;
}

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** "2026-09-01" → "setembro de 2026". */
export function formatMonth(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} de ${year}`;
}

/** "2026-09-16" → "16/09". */
export function formatDayShort(day: string): string {
  const [, month, date] = day.split('-');
  return `${date}/${month}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "há 40 min", "há 3 h", "há 2 dias". */
export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'nunca';
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}
