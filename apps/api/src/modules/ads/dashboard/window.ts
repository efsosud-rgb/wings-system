import type { DashboardWindow } from '@wings/shared';

/**
 * Calendar arithmetic for the dashboard, on YYYY-MM-DD strings in the
 * account's timezone. Dates never become local `Date`s here: a server in UTC
 * would otherwise file a São Paulo evening under tomorrow.
 */

export const SAO_PAULO = 'America/Sao_Paulo';

/** Today as YYYY-MM-DD in the given timezone. */
export function dayIn(now: Date, timeZone = SAO_PAULO): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** Every day from `since` to `until`, both inclusive. */
export function daysBetween(since: string, until: string): string[] {
  const days: string[] = [];
  for (let day = since; day <= until; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface DateWindow {
  days: DashboardWindow;
  since: string;
  until: string;
  previousSince: string;
  previousUntil: string;
  /** Last day of the first half, for before/after comparisons inside the window. */
  midpoint: string;
}

/** The last `days` days ending today, and the same span immediately before. */
export function windowOf(days: DashboardWindow, now: Date, timeZone = SAO_PAULO): DateWindow {
  const until = dayIn(now, timeZone);
  const since = addDays(until, -(days - 1));
  return {
    days,
    since,
    until,
    previousSince: addDays(since, -days),
    previousUntil: addDays(since, -1),
    midpoint: addDays(since, Math.floor(days / 2) - 1),
  };
}

export interface MonthWindow {
  periodMonth: string;
  today: string;
  /** Days elapsed including today in proportion to the hours gone. */
  elapsedDays: number;
  totalDays: number;
}

export function monthOf(now: Date, timeZone = SAO_PAULO): MonthWindow {
  const today = dayIn(now, timeZone);
  const [year, month, date] = today.split('-').map(Number) as [number, number, number];
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now),
  );
  return {
    periodMonth: `${today.slice(0, 7)}-01`,
    today,
    elapsedDays: Math.round((date - 1 + hour / 24) * 10) / 10,
    totalDays,
  };
}

/** Straight-line projection of what was spent so far to the whole month. */
export function forecastOf(spent: number, month: MonthWindow): number | null {
  if (month.elapsedDays < 1) return null;
  return Math.round((spent / month.elapsedDays) * month.totalDays);
}
