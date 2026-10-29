/**
 * Dates as WhatsApp Desktop writes them: today by the clock, then "Ontem", the
 * weekday within the last week, and the date after that. The inbox's times and
 * the conversation's day marks share it. Days are the browser's own.
 */

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** "Hoje", "Ontem", "Segunda-feira" (within the last week), else "13/10/2026". */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
  // A clock a little ahead of ours is still today.
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) {
    const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' });
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** The inbox's time: the clock for today, otherwise the day as `dayLabel` says it. */
export function listTimeOf(iso: string, now = new Date()): string {
  const label = dayLabel(iso, now);
  return label === 'Hoje'
    ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : label;
}
