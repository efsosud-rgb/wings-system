/**
 * Just enough cron to answer "when is the next run?".
 *
 * Five fields (minute, hour, day of month, month, day of week) with `*`,
 * `*\/n`, `a-b`, `a-b/n` and lists. No names, no `L`, no `W`: the Coolify
 * task is written with digits. The expression is read in the given timezone,
 * because the task runs on São Paulo's clock and the API runs on UTC.
 */

interface Field {
  matches(value: number): boolean;
}

function parseField(text: string, min: number, max: number): Field | null {
  const allowed = new Set<number>();
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (rangeText === '*') {
      from = min;
      to = max;
    } else if (rangeText?.includes('-')) {
      const [a, b] = rangeText.split('-').map(Number);
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b))
        return null;
      from = a;
      to = b;
    } else {
      const value = Number(rangeText);
      if (!Number.isInteger(value)) return null;
      from = value;
      // A single value with a step (`5/10`) means "from 5 on, every 10".
      to = stepText === undefined ? value : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) allowed.add(value);
  }
  // Sunday is both 0 and 7.
  if (min === 0 && max === 7 && allowed.has(7)) allowed.add(0);
  return { matches: (value) => allowed.has(value) };
}

export interface CronSchedule {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  /** Whether the day fields restrict anything; when both do, either may match (cron's rule). */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

export function parseCron(expression: string): CronSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const parsed = {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12),
    dayOfWeek: parseField(dayOfWeek, 0, 7),
  };
  if (!parsed.minute || !parsed.hour || !parsed.dayOfMonth || !parsed.month || !parsed.dayOfWeek) {
    return null;
  }
  return {
    minute: parsed.minute,
    hour: parsed.hour,
    dayOfMonth: parsed.dayOfMonth,
    month: parsed.month,
    dayOfWeek: parsed.dayOfWeek,
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  };
}

/** The wall-clock parts of an instant in a timezone. */
function partsIn(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? 'Sun'),
  };
}

function matches(schedule: CronSchedule, instant: Date, timeZone: string): boolean {
  const at = partsIn(instant, timeZone);
  if (!schedule.minute.matches(at.minute) || !schedule.hour.matches(at.hour)) return false;
  if (!schedule.month.matches(at.month)) return false;
  const dom = schedule.dayOfMonth.matches(at.day);
  const dow = schedule.dayOfWeek.matches(at.weekday);
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true;
  if (schedule.anyDayOfMonth) return dow;
  if (schedule.anyDayOfWeek) return dom;
  return dom || dow;
}

const MINUTE_MS = 60_000;
/** Walking minute by minute for a year is the ceiling of the search. */
const MAX_MINUTES = 366 * 24 * 60;

/**
 * The first instant strictly after `after` that the expression matches, or
 * null when the expression is invalid or nothing matches within a year.
 */
export function nextCronRun(expression: string, after: Date, timeZone: string): Date | null {
  const schedule = parseCron(expression);
  if (!schedule) return null;
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_MINUTES; step += 1) {
    const candidate = new Date(start + step * MINUTE_MS);
    if (matches(schedule, candidate, timeZone)) return candidate;
  }
  return null;
}

/** The last instant at or before `at` that the expression matches, or null. */
export function previousCronRun(expression: string, at: Date, timeZone: string): Date | null {
  const schedule = parseCron(expression);
  if (!schedule) return null;
  const start = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let step = 0; step < MAX_MINUTES; step += 1) {
    const candidate = new Date(start - step * MINUTE_MS);
    if (matches(schedule, candidate, timeZone)) return candidate;
  }
  return null;
}
