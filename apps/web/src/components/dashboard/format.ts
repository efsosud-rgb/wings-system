import { formatBrl, type CockpitStatusSummary, type SpendUnit } from '@wings/shared';

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

/** "16/09/2026". */
export function formatDateFull(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** "às 16:00" on the same São Paulo day as `now`, "23/09 07:00" otherwise. */
export function formatWhen(iso: string, now = Date.now()): string {
  const day = (value: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(value);
  const time = new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return day(new Date(iso).getTime()) === day(now) ? `às ${time}` : formatDateTime(iso);
}

/** Millionths of a dollar → "US$ 0,04". */
export function formatUsdMicro(micro: number): string {
  return `US$ ${(micro / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/**
 * "2 de 4 com status ativo; 2 encerradas em 05/10": the status a person set
 * against what is really delivering. Null when the two agree.
 */
export function statusSummaryText(summary: CockpitStatusSummary): string | null {
  if (summary.withStatus === summary.delivering) return null;
  const parts = [`${summary.delivering} de ${summary.withStatus} com status ativo`];
  if (summary.ended.length > 0) {
    const days = [...new Set(summary.ended.map((campaign) => formatDayShort(campaign.endDate)))];
    parts.push(
      `${summary.ended.length} ${summary.ended.length === 1 ? 'encerrada' : 'encerradas'} em ${days.join(' e ')}`,
    );
  }
  if (summary.notDelivering > 0) parts.push(`${summary.notDelivering} sem entregar`);
  return parts.join('; ');
}
