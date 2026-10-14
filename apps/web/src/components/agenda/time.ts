import { addDays, dateOnlyOf, instantOf, wallClockOf, weekdayOf } from '@wings/shared';

/**
 * The Agenda's calendar arithmetic, all of it in São Paulo wall-clock time
 * whatever zone the browser is in: a day is a 'YYYY-MM-DD' string, an instant
 * is a Date. Labels are built from `wallClockOf` (Intl with the São Paulo
 * zone), with fixed Portuguese names so every machine writes the same text.
 */

export type AgendaView = 'dia' | 'semana' | 'mes' | 'agenda';
export const AGENDA_VIEWS: { value: AgendaView; label: string; key: string }[] = [
  { value: 'dia', label: 'Dia', key: 'd' },
  { value: 'semana', label: 'Semana', key: 's' },
  { value: 'mes', label: 'Mês', key: 'm' },
  { value: 'agenda', label: 'Agenda', key: 'a' },
];
export const isAgendaView = (value: unknown): value is AgendaView =>
  AGENDA_VIEWS.some((view) => view.value === value);

/** Days the list view covers from its anchor, and the search window around today. */
export const LIST_DAYS = 30;
export const SEARCH_DAYS_BEFORE = 180;
export const SEARCH_DAYS_AFTER = 365;

export const WEEKDAY_SHORT = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
export const WEEKDAY_INITIAL = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
export const WEEKDAY_LONG = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];
export const MONTH_LONG = [
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
export const MONTH_SHORT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

const pad = (value: number) => String(value).padStart(2, '0');

export interface DayParts {
  year: number;
  month: number;
  day: number;
}

export function partsOf(day: string): DayParts {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return { year, month, day: date };
}

/** The São Paulo day an instant falls on. */
export const dayOf = (instant: Date | string | number) => dateOnlyOf(wallClockOf(instant));

/** The instant a São Paulo day starts (00:00 there). */
export const dayStart = (day: string) => instantOf(partsOf(day));

/** The instant of a wall-clock time on a São Paulo day. */
export const instantAt = (day: string, minutes: number) =>
  instantOf({ ...partsOf(day), hour: Math.floor(minutes / 60), minute: minutes % 60 });

/** "09:00", in 24 h. */
export function timeLabel(instant: Date | string | number): string {
  const wall = wallClockOf(instant);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Minutes since São Paulo midnight. */
export function minutesOf(instant: Date | string | number): number {
  const wall = wallClockOf(instant);
  return wall.hour * 60 + wall.minute;
}

/** "14 de outubro de 2026". */
export function dayLabel(day: string): string {
  const { year, month, day: date } = partsOf(day);
  return `${date} de ${MONTH_LONG[month - 1]} de ${year}`;
}

/** "quarta-feira, 14 de outubro". */
export function dayLongLabel(day: string): string {
  const { month, day: date } = partsOf(day);
  return `${WEEKDAY_LONG[weekdayOf(day)]}, ${date} de ${MONTH_LONG[month - 1]}`;
}

/** "14 OUT, QUA", the list view's day heading. */
export function listDayLabel(day: string): string {
  const { month, day: date } = partsOf(day);
  return `${date} ${MONTH_SHORT[month - 1]?.toUpperCase()}, ${WEEKDAY_SHORT[weekdayOf(day)]}`;
}

/** The Sunday that starts a day's week. */
export const weekStartOf = (day: string) => addDays(day, -weekdayOf(day));

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The first day of the month `delta` months from the one `day` is in. */
export function monthStart(day: string, delta = 0): string {
  const { year, month } = partsOf(day);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return dateOnlyOf({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 });
}

/** The same day of the month `delta` months away, clamped to that month's length. */
export function shiftMonths(day: string, delta: number): string {
  const first = partsOf(monthStart(day, delta));
  const wanted = partsOf(day).day;
  return dateOnlyOf({ ...first, day: Math.min(wanted, daysInMonth(first.year, first.month)) });
}

/** The days of a month's grid: Sunday first, whole weeks, at least five of them. */
export function monthGrid(day: string): string[] {
  const first = monthStart(day);
  const { year, month } = partsOf(first);
  const lead = weekdayOf(first);
  const weeks = Math.max(5, Math.ceil((lead + daysInMonth(year, month)) / 7));
  const start = addDays(first, -lead);
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
}

/** The visible period of a view, as days: `days` are the columns or cells, `end` exclusive. */
export interface Period {
  start: string;
  end: string;
  days: string[];
}

export function periodOf(view: AgendaView, anchor: string): Period {
  if (view === 'dia') return { start: anchor, end: addDays(anchor, 1), days: [anchor] };
  if (view === 'semana') {
    const start = weekStartOf(anchor);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    return { start, end: addDays(start, 7), days };
  }
  if (view === 'mes') {
    const days = monthGrid(anchor);
    const start = days[0] ?? anchor;
    return { start, end: addDays(start, days.length), days };
  }
  const days = Array.from({ length: LIST_DAYS }, (_, index) => addDays(anchor, index));
  return { start: anchor, end: addDays(anchor, LIST_DAYS), days };
}

/** The search window: about half a year back and a year ahead of today. */
export function searchPeriod(today: string): Period {
  const start = addDays(today, -SEARCH_DAYS_BEFORE);
  const end = addDays(today, SEARCH_DAYS_AFTER);
  return { start, end, days: daysBetween(start, end) };
}

export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day < end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The instants a period asks the API for: São Paulo midnight to São Paulo midnight. */
export function rangeOf(period: { start: string; end: string }): { from: string; to: string } {
  return { from: dayStart(period.start).toISOString(), to: dayStart(period.end).toISOString() };
}

/** Where "previous" and "next" go from an anchor. */
export function stepAnchor(view: AgendaView, anchor: string, direction: 1 | -1): string {
  if (view === 'dia') return addDays(anchor, direction);
  if (view === 'semana') return addDays(anchor, 7 * direction);
  if (view === 'mes') return shiftMonths(anchor, direction);
  return addDays(anchor, LIST_DAYS * direction);
}

export const STEP_LABELS: Record<AgendaView, { previous: string; next: string }> = {
  dia: { previous: 'Dia anterior', next: 'Próximo dia' },
  semana: { previous: 'Semana anterior', next: 'Próxima semana' },
  mes: { previous: 'Mês anterior', next: 'Próximo mês' },
  agenda: { previous: 'Período anterior', next: 'Próximo período' },
};

/** "outubro de 2026", "set – out de 2026", "dez de 2026 – jan de 2027", "14 de outubro de 2026". */
export function periodTitle(view: AgendaView, anchor: string): string {
  if (view === 'dia') return dayLabel(anchor);
  if (view === 'mes') {
    const { year, month } = partsOf(anchor);
    return `${MONTH_LONG[month - 1]} de ${year}`;
  }
  const period = periodOf(view, anchor);
  const first = partsOf(period.start);
  const last = partsOf(addDays(period.end, -1));
  if (first.year === last.year && first.month === last.month) {
    return `${MONTH_LONG[first.month - 1]} de ${first.year}`;
  }
  if (first.year === last.year) {
    return `${MONTH_SHORT[first.month - 1]} – ${MONTH_SHORT[last.month - 1]} de ${first.year}`;
  }
  return `${MONTH_SHORT[first.month - 1]} de ${first.year} – ${MONTH_SHORT[last.month - 1]} de ${last.year}`;
}
