import type {
  AgendaCalendar,
  AgendaCalendarKey,
  AgendaEvent,
  AgendaEventColor,
  AgendaOverview,
} from '@wings/shared';
import { addDays } from '@wings/shared';
import { dayOf, dayStart, daysBetween } from './time.js';

/**
 * Where events go on the screen: which copy of an event is shown, the days it
 * touches, its slice of each day, and the packing that puts overlapping
 * events side by side. Pure functions, unit-tested in layout.test.ts.
 */

const DAY_MS = 86_400_000;

/** A shown event's identity on the screen (the API names an event by calendar and id). */
export const eventKey = (event: Pick<AgendaEvent, 'calendar' | 'id'>) =>
  `${event.calendar}:${event.id}`;

/**
 * The events of the visible calendars, each once. The same event can come
 * from both calendars (a meeting on the person's calendar and on Wings
 * Company's): one copy is kept, the one the person can change if any, else
 * the one on their own calendar.
 */
export function visibleEvents(
  events: AgendaEvent[],
  visible: ReadonlySet<AgendaCalendarKey>,
): AgendaEvent[] {
  const chosen = new Map<string, AgendaEvent>();
  const rank = (event: AgendaEvent) =>
    (event.canEdit ? 2 : 0) + (event.calendar === 'mine' ? 1 : 0);
  for (const event of events) {
    if (!visible.has(event.calendar)) continue;
    const key = `${event.uid}|${event.start}`;
    const current = chosen.get(key);
    if (!current || rank(event) > rank(current)) chosen.set(key, event);
  }
  return [...chosen.values()];
}

/** The inclusive last day of an all-day event (Google's end is the day after). */
export const lastDayOf = (exclusiveEnd: string) => addDays(exclusiveEnd, -1);
/** Google's exclusive end from the last day the event covers. */
export const exclusiveEndOf = (lastDay: string) => addDays(lastDay, 1);

/** All-day events and timed ones of a day or more go in the lane above the hours. */
export function inAllDayLane(event: AgendaEvent): boolean {
  if (event.allDay) return true;
  return Date.parse(event.end) - Date.parse(event.start) >= DAY_MS;
}

/** The first and last São Paulo day an event covers. */
export function eventDaySpan(event: AgendaEvent): { first: string; last: string } {
  if (event.allDay) {
    const last = lastDayOf(event.end);
    return { first: event.start, last: last < event.start ? event.start : last };
  }
  const start = Date.parse(event.start);
  const end = Math.max(start, Date.parse(event.end) - 1);
  return { first: dayOf(start), last: dayOf(end) };
}

export function touchesDay(event: AgendaEvent, day: string): boolean {
  const { first, last } = eventDaySpan(event);
  return first <= day && day <= last;
}

/** Order inside a day: the lane's events first, then by start, the longer first. */
export function compareEvents(a: AgendaEvent, b: AgendaEvent): number {
  const laneA = inAllDayLane(a);
  const laneB = inAllDayLane(b);
  if (laneA !== laneB) return laneA ? -1 : 1;
  const startA = a.allDay ? dayStart(a.start).getTime() : Date.parse(a.start);
  const startB = b.allDay ? dayStart(b.start).getTime() : Date.parse(b.start);
  if (startA !== startB) return startA - startB;
  const endA = a.allDay ? dayStart(a.end).getTime() : Date.parse(a.end);
  const endB = b.allDay ? dayStart(b.end).getTime() : Date.parse(b.end);
  if (endA !== endB) return endB - endA;
  return a.title.localeCompare(b.title, 'pt-BR');
}

/** The events that touch a day, in the order a cell or the list shows them. */
export const eventsOfDay = (events: AgendaEvent[], day: string) =>
  events.filter((event) => touchesDay(event, day)).sort(compareEvents);

/** A timed event's slice of one day column: minutes from that day's 00:00. */
export interface DaySegment {
  event: AgendaEvent;
  day: string;
  startMinute: number;
  endMinute: number;
  /** The event began on an earlier day / goes on past midnight. */
  fromBefore: boolean;
  toAfter: boolean;
}

/** Timed events (not the lane's) cut at each midnight, one slice per day column. */
export function daySegments(events: AgendaEvent[], days: string[]): DaySegment[] {
  const segments: DaySegment[] = [];
  for (const event of events) {
    if (inAllDayLane(event)) continue;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    for (const day of days) {
      const from = dayStart(day).getTime();
      const to = dayStart(addDays(day, 1)).getTime();
      const sliceStart = Math.max(start, from);
      const sliceEnd = Math.min(end, to);
      // A zero-length event still shows, at its start.
      const pointInDay = start === end && start >= from && start < to;
      if (sliceEnd <= sliceStart && !pointInDay) continue;
      segments.push({
        event,
        day,
        startMinute: Math.round((sliceStart - from) / 60_000),
        endMinute: Math.round((sliceEnd - from) / 60_000),
        fromBefore: start < from,
        toAfter: end > to,
      });
    }
  }
  return segments;
}

export interface Placement {
  column: number;
  columns: number;
}

/**
 * Overlapping events side by side, as the Google Agenda draws them: events
 * that overlap (directly or through a chain) form a cluster; inside it each
 * event takes the first column free at its start, and every event of the
 * cluster is 1/columns wide. `minLength` is the shortest block drawn, so two
 * short events that would touch on screen are packed too.
 */
export function packOverlaps(
  items: Array<{ key: string; start: number; end: number }>,
  minLength = 0,
): Map<string, Placement> {
  const sorted = items
    .map((item) => ({ ...item, end: Math.max(item.end, item.start + minLength) }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  const placements = new Map<string, Placement>();
  let cluster: Array<{ key: string; column: number }> = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    for (const member of cluster) {
      placements.set(member.key, { column: member.column, columns: columnEnds.length });
    }
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    if (item.start >= clusterEnd) close();
    let column = columnEnds.findIndex((end) => end <= item.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.end);
    } else {
      columnEnds[column] = item.end;
    }
    cluster.push({ key: item.key, column });
    clusterEnd = cluster.length === 1 ? item.end : Math.max(clusterEnd, item.end);
  }
  close();
  return placements;
}

/** A bar in the all-day lane: from column `start` for `span` columns, on `row`. */
export interface LaneBar {
  event: AgendaEvent;
  start: number;
  span: number;
  row: number;
  fromBefore: boolean;
  toAfter: boolean;
}

/** The lane's bars for a run of day columns, each on the first row free across its days. */
export function laneBars(events: AgendaEvent[], days: string[]): { bars: LaneBar[]; rows: number } {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return { bars: [], rows: 0 };
  const lane = events
    .filter(inAllDayLane)
    .map((event) => ({ event, ...eventDaySpan(event) }))
    .filter((item) => item.first <= last && item.last >= first)
    .sort((a, b) => a.first.localeCompare(b.first) || b.last.localeCompare(a.last));
  const rowEnds: string[] = [];
  const bars: LaneBar[] = [];
  for (const item of lane) {
    const from = item.first < first ? first : item.first;
    const to = item.last > last ? last : item.last;
    let row = rowEnds.findIndex((end) => end < from);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(to);
    } else {
      rowEnds[row] = to;
    }
    bars.push({
      event: item.event,
      start: days.indexOf(from),
      span: daysBetween(from, addDays(to, 1)).length,
      row,
      fromBefore: item.first < first,
      toAfter: item.last > last,
    });
  }
  return { bars, rows: rowEnds.length };
}

/** The colours an event is drawn in: its own colour, else its calendar's. */
export function colorsOf(
  event: AgendaEvent,
  overview: Pick<AgendaOverview, 'eventColors' | 'calendars'>,
): AgendaEventColor | null {
  const own = event.colorId ? overview.eventColors[event.colorId] : undefined;
  if (own) return own;
  const calendar = overview.calendars.find((item) => item.key === event.calendar);
  return calendar
    ? { background: calendar.backgroundColor, foreground: calendar.foregroundColor }
    : null;
}

export const calendarOf = (calendars: AgendaCalendar[], key: AgendaCalendarKey) =>
  calendars.find((calendar) => calendar.key === key);
