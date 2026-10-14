import type { AgendaEvent, AgendaEventColor } from '@wings/shared';
import type { CSSProperties } from 'react';
import { lastDayOf } from './layout.js';
import { dayLongLabel, dayOf, MONTH_LONG, partsOf, timeLabel } from './time.js';

/** The words the Agenda writes about an event. */

export const titleOf = (event: Pick<AgendaEvent, 'title'>) => event.title.trim() || '(Sem título)';

/** "09:00 – 10:00" for a timed event. */
export const timeRangeOf = (event: Pick<AgendaEvent, 'start' | 'end'>) =>
  `${timeLabel(event.start)} – ${timeLabel(event.end)}`;

/** "14 de outubro" / "30 de setembro – 2 de outubro" / "14 – 16 de outubro". */
function dayRangeLabel(first: string, last: string): string {
  const a = partsOf(first);
  const b = partsOf(last);
  if (first === last) return dayLongLabel(first);
  if (a.year === b.year && a.month === b.month) {
    return `${a.day} – ${b.day} de ${MONTH_LONG[b.month - 1]}`;
  }
  if (a.year === b.year) {
    return `${a.day} de ${MONTH_LONG[a.month - 1]} – ${b.day} de ${MONTH_LONG[b.month - 1]}`;
  }
  return `${a.day} de ${MONTH_LONG[a.month - 1]} de ${a.year} – ${b.day} de ${MONTH_LONG[b.month - 1]} de ${b.year}`;
}

/** The details card's "when": "quarta-feira, 14 de outubro · 09:00 – 10:00". */
export function whenOf(event: AgendaEvent): string {
  if (event.allDay) return dayRangeLabel(event.start, lastDayOf(event.end));
  const first = dayOf(event.start);
  const last = dayOf(Math.max(Date.parse(event.start), Date.parse(event.end) - 1));
  if (first === last) return `${dayLongLabel(first)} · ${timeRangeOf(event)}`;
  return `${dayLongLabel(first)}, ${timeLabel(event.start)} – ${dayLongLabel(last)}, ${timeLabel(event.end)}`;
}

/** What a screen reader hears for an event button. */
export function ariaLabelOf(event: AgendaEvent, calendarName: string): string {
  if (event.allDay) {
    return `${titleOf(event)}, ${whenOf(event)}, dia inteiro, agenda ${calendarName}`;
  }
  return `${titleOf(event)}, ${dayLongLabel(dayOf(event.start))}, ${timeLabel(event.start)} a ${timeLabel(event.end)}, agenda ${calendarName}`;
}

/** The colours from the data, as custom properties the stylesheet reads. */
export function colorStyle(colors: AgendaEventColor | null): CSSProperties {
  if (!colors) return {};
  return { '--ev-bg': colors.background, '--ev-fg': colors.foreground } as CSSProperties;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+)/g;

/** Plain text cut into text and http(s) links; a trailing stop or bracket stays text. */
export function linkify(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  text.split(URL_PATTERN).forEach((piece, index) => {
    if (!piece) return;
    if (index % 2 === 0) {
      parts.push({ text: piece });
      return;
    }
    const trail = /[.,;:!?)\]]+$/.exec(piece)?.[0] ?? '';
    const href = trail ? piece.slice(0, -trail.length) : piece;
    parts.push({ text: href, href });
    if (trail) parts.push({ text: trail });
  });
  return parts;
}

/** The address when it is plain https, else null: a link from Google opens only then. */
export function httpsOnly(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
