import { randomUUID } from 'node:crypto';
import {
  AGENDA_TIME_ZONE,
  instantOf,
  type AgendaAttendee,
  type AgendaCalendarKey,
  type AgendaEvent,
  type AgendaEventColor,
  type AgendaEventInput,
  type AgendaEventPatch,
  type AgendaResponse,
} from '@wings/shared';
import { calendarRequest } from '../google-workspace/calendar.js';

/**
 * The Agenda's Calendar v3 calls (events.list, get, insert, patch, delete and
 * colors.get) and the pure rules around them: Google's raw event reduced to an
 * `AgendaEvent`, who may edit it, and the bodies sent on a create or an edit.
 * Event content (titles, descriptions, guests, places) is personal data: it is
 * answered to the person whose calendar it is and never reaches a log.
 */

export interface RawAttendee {
  email?: unknown;
  displayName?: unknown;
  responseStatus?: unknown;
  organizer?: unknown;
  self?: unknown;
  resource?: unknown;
  [key: string]: unknown;
}

interface RawWhen {
  date?: unknown;
  dateTime?: unknown;
  timeZone?: unknown;
}

export interface RawEvent {
  id?: unknown;
  status?: unknown;
  eventType?: unknown;
  iCalUID?: unknown;
  recurringEventId?: unknown;
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  htmlLink?: unknown;
  hangoutLink?: unknown;
  colorId?: unknown;
  guestsCanModify?: unknown;
  start?: RawWhen;
  end?: RawWhen;
  organizer?: { email?: unknown; displayName?: unknown; self?: unknown };
  attendees?: RawAttendee[];
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }>;
    createRequest?: { status?: { statusCode?: unknown } };
  };
}

/** What decides whether an event may be edited: the person's access on its calendar and the calendar's real id. */
export interface EditContext {
  accessRole: string;
  /** The calendar's Google id (the primary entry's id for `mine`, the configured id for `wings`). */
  calendarId: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const sameId = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export const isWriterRole = (accessRole: string) =>
  accessRole === 'owner' || accessRole === 'writer';

// --- reading -----------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

/** Google may keep a description as HTML: the Agenda shows it as plain text, never as HTML. */
export function descriptionToText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower]!;
      const code = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : lower.startsWith('#')
          ? Number.parseInt(lower.slice(1), 10)
          : Number.NaN;
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

const RESPONSES: Record<string, AgendaResponse> = {
  accepted: 'aceitou',
  declined: 'recusou',
  tentative: 'talvez',
  needsAction: 'sem_resposta',
};

/** Whether the screen gets the event at all: cancelled ones and working-location markers never do. */
export const isShownEvent = (raw: RawEvent) =>
  typeof raw.id === 'string' && raw.status !== 'cancelled' && raw.eventType !== 'workingLocation';

/**
 * Writer on its calendar, and the event is this calendar's own (organized by
 * the person, or by the calendar itself) or Google lets guests change it.
 * Birthdays and events Gmail made are Google's, never editable here. The CRM
 * rule (a deal's meeting) is applied on top by the service.
 */
export function canEditEvent(raw: RawEvent, ctx: EditContext): boolean {
  if (!isWriterRole(ctx.accessRole)) return false;
  if (raw.eventType === 'birthday' || raw.eventType === 'fromGmail') return false;
  return (
    raw.organizer?.self === true ||
    sameId(str(raw.organizer?.email), ctx.calendarId) ||
    raw.guestsCanModify === true
  );
}

function whenOf(when: RawWhen | undefined): { allDay: boolean; value: string } {
  const dateTime = str(when?.dateTime);
  if (dateTime) return { allDay: false, value: new Date(dateTime).toISOString() };
  return { allDay: true, value: str(when?.date) ?? '' };
}

/** An https address on meet.google.com: what the screen may label "Google Meet". */
function meetAddress(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'meet.google.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The event's Meet. Whoever organizes an event writes its conference data, an
 * outside sender included, so only a real Meet address passes; any other
 * conference link is left out rather than shown as a Meet.
 */
function meetUrlOf(raw: RawEvent): string | null {
  const video = raw.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  return meetAddress(video?.uri) ?? meetAddress(raw.hangoutLink);
}

function attendeesOf(raw: RawEvent): AgendaAttendee[] {
  return (raw.attendees ?? [])
    .filter((a) => typeof a.email === 'string' && a.resource !== true)
    .map((a) => ({
      email: String(a.email).toLowerCase(),
      name: str(a.displayName),
      response: RESPONSES[str(a.responseStatus) ?? ''] ?? 'sem_resposta',
      organizer: a.organizer === true,
      self: a.self === true,
    }));
}

/** Google's event as the screen gets it; `crm` is filled (and `canEdit` narrowed) by the service. */
export function toAgendaEvent(
  raw: RawEvent,
  calendar: AgendaCalendarKey,
  ctx: EditContext,
): AgendaEvent {
  const id = String(raw.id);
  const start = whenOf(raw.start);
  const end = whenOf(raw.end);
  const attendees = attendeesOf(raw);
  const ownCopy = raw.organizer?.self === true || sameId(str(raw.organizer?.email), ctx.calendarId);
  const organizer = raw.organizer
    ? {
        email: str(raw.organizer.email)?.toLowerCase() ?? null,
        name: str(raw.organizer.displayName),
        self: raw.organizer.self === true,
      }
    : null;
  return {
    calendar,
    id,
    uid: str(raw.iCalUID) ?? id,
    title: str(raw.summary) ?? '',
    allDay: start.allDay,
    start: start.value,
    end: end.value,
    location: str(raw.location) || null,
    description: descriptionToText(raw.description),
    meetUrl: meetUrlOf(raw),
    htmlLink: str(raw.htmlLink),
    colorId: str(raw.colorId),
    tentative: raw.status === 'tentative',
    organizer,
    attendees,
    recurring: Boolean(raw.recurringEventId),
    canEdit: canEditEvent(raw, ctx),
    guestsNotified: ownCopy && attendees.some((a) => !a.self && !a.organizer),
    crm: null,
  };
}

/** When an event starts, as an instant (all-day: midnight in São Paulo), to order a merged list. */
export function startTimeOf(event: AgendaEvent): number {
  if (!event.allDay) return Date.parse(event.start);
  const [year, month, day] = event.start.split('-').map(Number) as [number, number, number];
  return instantOf({ year, month, day }).getTime();
}

// --- writing -----------------------------------------------------------------------------------

const timed = (iso: string) => ({
  dateTime: new Date(iso).toISOString(),
  timeZone: AGENDA_TIME_ZONE,
});

/** Guests Google tells about a change: everyone but the person and the rooms. */
const notifiable = (attendees: RawAttendee[]) =>
  attendees.some((a) => a.self !== true && a.resource !== true);

export const sendUpdatesOf = (attendees: RawAttendee[]): 'all' | 'none' =>
  notifiable(attendees) ? 'all' : 'none';

export interface WriteRequest {
  body: Record<string, unknown>;
  query: Record<string, string>;
}

/** A new event: invitations only when there are guests, a Meet only when asked. */
export function insertRequestOf(input: AgendaEventInput): WriteRequest {
  const body: Record<string, unknown> = {
    summary: input.title,
    ...(input.location ? { location: input.location } : {}),
    ...(input.description?.trim() ? { description: input.description } : {}),
    start: input.allDay ? { date: input.start } : timed(input.start),
    end: input.allDay ? { date: input.end } : timed(input.end),
    attendees: input.attendees.map((email) => ({ email })),
    ...(input.colorId ? { colorId: input.colorId } : {}),
  };
  if (input.createMeet) {
    body.conferenceData = {
      createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  return {
    body,
    query: {
      ...(input.createMeet ? { conferenceDataVersion: '1' } : {}),
      sendUpdates: input.attendees.length ? 'all' : 'none',
    },
  };
}

/**
 * The guest list after an edit: the organizer, the person and rooms stay as
 * they were; guests still listed keep Google's record (their answer); new
 * e-mails come in bare; the rest leave.
 */
export function mergeAttendees(existing: RawAttendee[], emails: string[]): RawAttendee[] {
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const kept = existing.filter(
    (a) =>
      a.organizer === true ||
      a.self === true ||
      a.resource === true ||
      (typeof a.email === 'string' && wanted.has(a.email.toLowerCase())),
  );
  const present = new Set(
    existing.filter((a) => typeof a.email === 'string').map((a) => String(a.email).toLowerCase()),
  );
  return [
    ...kept,
    ...emails.filter((e) => !present.has(e.toLowerCase())).map((email) => ({ email })),
  ];
}

/** Only the fields the edit names; switching all-day ↔ timed clears the other kind of time. */
export function patchRequestOf(existing: RawEvent, patch: AgendaEventPatch): WriteRequest {
  const body: Record<string, unknown> = {};
  const query: Record<string, string> = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.allDay !== undefined && patch.start !== undefined && patch.end !== undefined) {
    const wasAllDay = !str(existing.start?.dateTime);
    const switching = wasAllDay !== patch.allDay;
    const when = (value: string) =>
      patch.allDay
        ? { date: value, ...(switching ? { dateTime: null, timeZone: null } : {}) }
        : { ...timed(value), ...(switching ? { date: null } : {}) };
    body.start = when(patch.start);
    body.end = when(patch.end);
  }
  if (patch.location !== undefined) body.location = patch.location ?? '';
  if (patch.description !== undefined) body.description = patch.description ?? '';
  if (patch.colorId !== undefined) body.colorId = patch.colorId;
  const before = existing.attendees ?? [];
  let after = before;
  if (patch.attendees !== undefined) {
    after = mergeAttendees(before, patch.attendees);
    body.attendees = after;
  }
  if (patch.createMeet === true && !existing.conferenceData) {
    body.conferenceData = {
      createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
    query.conferenceDataVersion = '1';
  }
  query.sendUpdates = notifiable(before) || notifiable(after) ? 'all' : 'none';
  return { body, query };
}

/** The Meet's state on an answer: null when none was asked for. */
export function meetStatusOf(raw: RawEvent): 'success' | 'pending' | 'failure' | null {
  const code = raw.conferenceData?.createRequest?.status?.statusCode;
  return code === 'success' || code === 'pending' || code === 'failure' ? code : null;
}

export const hasMeet = (raw: RawEvent) => meetUrlOf(raw) !== null;

// --- Calendar v3 -------------------------------------------------------------------------------

const encode = encodeURIComponent;
const eventsPath = (calendarId: string) => `/calendars/${encode(calendarId)}/events`;
const eventPath = (calendarId: string, eventId: string) =>
  `${eventsPath(calendarId)}/${encode(eventId)}`;

/** Pages read per calendar and request; past that the answer says `truncated`. */
export const MAX_PAGES = 3;

/** One calendar's events in the range, occurrences expanded, oldest first. */
export async function listEvents(
  transport: typeof fetch,
  token: string,
  calendarId: string,
  range: { from: string; to: string; q?: string },
): Promise<{ items: RawEvent[]; truncated: boolean }> {
  const items: RawEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = (await calendarRequest(transport, token, 'GET', eventsPath(calendarId), {
      timeMin: range.from,
      timeMax: range.to,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      timeZone: AGENDA_TIME_ZONE,
      showDeleted: 'false',
      ...(range.q ? { q: range.q } : {}),
      ...(pageToken ? { pageToken } : {}),
    })) as { items?: RawEvent[]; nextPageToken?: unknown } | null;
    items.push(...(answer?.items ?? []));
    pageToken = str(answer?.nextPageToken);
    if (!pageToken) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export async function getRawEvent(
  transport: typeof fetch,
  token: string,
  calendarId: string,
  eventId: string,
): Promise<RawEvent> {
  return ((await calendarRequest(transport, token, 'GET', eventPath(calendarId, eventId), {
    conferenceDataVersion: '1',
  })) ?? {}) as RawEvent;
}

export async function insertRawEvent(
  transport: typeof fetch,
  token: string,
  calendarId: string,
  request: WriteRequest,
): Promise<RawEvent> {
  return ((await calendarRequest(
    transport,
    token,
    'POST',
    eventsPath(calendarId),
    request.query,
    request.body,
  )) ?? {}) as RawEvent;
}

export async function patchRawEvent(
  transport: typeof fetch,
  token: string,
  calendarId: string,
  eventId: string,
  request: WriteRequest,
): Promise<RawEvent> {
  return ((await calendarRequest(
    transport,
    token,
    'PATCH',
    eventPath(calendarId, eventId),
    request.query,
    request.body,
  )) ?? {}) as RawEvent;
}

export async function deleteRawEvent(
  transport: typeof fetch,
  token: string,
  calendarId: string,
  eventId: string,
  sendUpdates: 'all' | 'none',
): Promise<void> {
  await calendarRequest(transport, token, 'DELETE', eventPath(calendarId, eventId), {
    sendUpdates,
  });
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Google's event palette by colorId (colors.get). Throws when Google does not answer one. */
export async function eventColorsOf(
  transport: typeof fetch,
  token: string,
): Promise<Record<string, AgendaEventColor>> {
  const answer = (await calendarRequest(transport, token, 'GET', '/colors', {})) as {
    event?: Record<string, { background?: unknown; foreground?: unknown }>;
  } | null;
  const colors: Record<string, AgendaEventColor> = {};
  for (const [id, color] of Object.entries(answer?.event ?? {})) {
    const background = str(color.background);
    const foreground = str(color.foreground);
    if (background && foreground && HEX.test(background) && HEX.test(foreground)) {
      colors[id] = { background, foreground };
    }
  }
  if (!Object.keys(colors).length) throw new Error('colors_empty');
  return colors;
}
