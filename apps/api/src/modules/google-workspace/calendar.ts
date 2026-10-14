import { randomUUID } from 'node:crypto';
import type { MeetingAttendee } from '@wings/shared';

/**
 * Google Calendar v3, the four calls the CRM needs: list the person's calendars
 * (to find the shared Wings Company one and the access they have on it), create
 * an event with a Meet and invitations, move it, and cancel it. Plain `fetch`
 * with the person's own access token. Answers are reduced to what the CRM
 * stores; attendee e-mails are personal data and never reach a log.
 */

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const MEETING_TIME_ZONE = 'America/Sao_Paulo';

export class GoogleCalendarError extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'gone'
      | 'rejected'
      | 'unreachable'
      | 'rate_limited'
      | 'meet_failed',
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** owner | writer | reader | freeBusyReader */
  accessRole: string;
  /** The name the person gave it on their own list, when they renamed it. */
  summaryOverride: string | null;
  /** The calendar's colours on this person's list ('#rrggbb'), when Google sends them. */
  backgroundColor: string | null;
  foregroundColor: string | null;
}

export interface CalendarEventInput {
  title: string;
  /** Null = none, as the team writes its calls. */
  description: string | null;
  /** Google colorId; null keeps the calendar's own colour. */
  colorId: string | null;
  startsAt: Date;
  endsAt: Date;
  attendees: Array<{ email: string; name: string | null }>;
  createMeet: boolean;
}

export interface CalendarEvent {
  id: string;
  htmlLink: string | null;
  meetUrl: string | null;
  /** The Meet request's outcome: null when none was asked for. */
  meetStatus: 'success' | 'pending' | 'failure' | null;
  attendees: MeetingAttendee[];
}

const RESPONSE_STATUS: Record<string, MeetingAttendee['responseStatus']> = {
  accepted: 'aceitou',
  declined: 'recusou',
  tentative: 'talvez',
  needsAction: 'sem_resposta',
};

interface RawEvent {
  id?: unknown;
  htmlLink?: unknown;
  hangoutLink?: unknown;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }>;
    createRequest?: { status?: { statusCode?: unknown } };
  };
  attendees?: Array<{
    email?: unknown;
    displayName?: unknown;
    responseStatus?: unknown;
    organizer?: unknown;
    self?: unknown;
  }>;
}

function toEvent(raw: RawEvent): CalendarEvent {
  const video = raw.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  const statusCode = raw.conferenceData?.createRequest?.status?.statusCode;
  return {
    id: String(raw.id),
    htmlLink: typeof raw.htmlLink === 'string' ? raw.htmlLink : null,
    meetUrl:
      typeof video?.uri === 'string'
        ? video.uri
        : typeof raw.hangoutLink === 'string'
          ? raw.hangoutLink
          : null,
    meetStatus:
      statusCode === 'success' || statusCode === 'pending' || statusCode === 'failure'
        ? statusCode
        : null,
    attendees: (raw.attendees ?? [])
      .filter((a) => typeof a.email === 'string' && !a.organizer && !a.self)
      .map((a) => ({
        email: String(a.email).toLowerCase(),
        name: typeof a.displayName === 'string' ? a.displayName : null,
        responseStatus:
          typeof a.responseStatus === 'string'
            ? (RESPONSE_STATUS[a.responseStatus] ?? 'sem_resposta')
            : 'sem_resposta',
      })),
  };
}

const USAGE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/** The machine reason of a refusal (`error.errors[0].reason`); only that, never Google's message. */
async function rejectionReasonOf(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason;
  if (typeof reason === 'string') return reason;
  return body?.error?.status === 'RESOURCE_EXHAUSTED' ? 'rateLimitExceeded' : null;
}

/**
 * One Calendar v3 request with the person's token; Google's refusals become a
 * `GoogleCalendarError` (never Google's message, which may quote event content).
 */
export async function calendarRequest(
  transport: typeof fetch,
  accessToken: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  query: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  const url = new URL(`${CALENDAR_API}${path}`);
  url.search = new URLSearchParams(query).toString();
  let response: Response;
  try {
    response = await transport(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new GoogleCalendarError('unreachable');
  }
  if (response.status === 204) return null;
  if (response.status === 401) throw new GoogleCalendarError('unauthorized', 401);
  if (response.status === 429) throw new GoogleCalendarError('rate_limited', 429);
  if (response.status === 403) {
    // Google also answers 403 when a usage limit is hit: that is a pause, not a missing permission.
    const reason = await rejectionReasonOf(response);
    throw new GoogleCalendarError(
      reason && USAGE_LIMIT_REASONS.has(reason) ? 'rate_limited' : 'forbidden',
      403,
    );
  }
  if (response.status === 404) throw new GoogleCalendarError('not_found', 404);
  if (response.status === 410) throw new GoogleCalendarError('gone', 410);
  if (!response.ok) throw new GoogleCalendarError('rejected', response.status);
  return response.json().catch(() => null);
}

const call = calendarRequest;
const encode = encodeURIComponent;

export async function listCalendars(
  transport: typeof fetch,
  accessToken: string,
): Promise<CalendarListEntry[]> {
  const body = (await call(transport, accessToken, 'GET', '/users/me/calendarList', {
    minAccessRole: 'reader',
    maxResults: '250',
    // A shared calendar the person hid from their Google list is still shared with them.
    showHidden: 'true',
  })) as { items?: Array<Record<string, unknown>> } | null;
  return (body?.items ?? [])
    .filter((item) => typeof item.id === 'string')
    .map((item) => ({
      id: String(item.id),
      summary: typeof item.summary === 'string' ? item.summary : '',
      primary: item.primary === true,
      accessRole: typeof item.accessRole === 'string' ? item.accessRole : 'reader',
      summaryOverride: typeof item.summaryOverride === 'string' ? item.summaryOverride : null,
      backgroundColor: typeof item.backgroundColor === 'string' ? item.backgroundColor : null,
      foregroundColor: typeof item.foregroundColor === 'string' ? item.foregroundColor : null,
    }));
}

const eventBody = (input: CalendarEventInput) => ({
  summary: input.title,
  ...(input.description ? { description: input.description } : {}),
  ...(input.colorId ? { colorId: input.colorId } : {}),
  start: { dateTime: input.startsAt.toISOString(), timeZone: MEETING_TIME_ZONE },
  end: { dateTime: input.endsAt.toISOString(), timeZone: MEETING_TIME_ZONE },
  attendees: input.attendees.map((a) => ({
    email: a.email,
    ...(a.name ? { displayName: a.name } : {}),
  })),
});

/**
 * Creates the event, with a Meet when asked (`conferenceDataVersion=1` +
 * `createRequest`) and an invitation to every attendee (`sendUpdates=all`).
 * Google may answer before the Meet exists ("pending"): the caller re-reads.
 */
export async function createEvent(
  transport: typeof fetch,
  accessToken: string,
  calendarId: string,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const raw = (await call(
    transport,
    accessToken,
    'POST',
    `/calendars/${encode(calendarId)}/events`,
    { conferenceDataVersion: '1', sendUpdates: 'all' },
    {
      ...eventBody(input),
      ...(input.createMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }
        : {}),
    },
  )) as RawEvent;
  return toEvent(raw);
}

export async function getEvent(
  transport: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const raw = (await call(
    transport,
    accessToken,
    'GET',
    `/calendars/${encode(calendarId)}/events/${encode(eventId)}`,
    { conferenceDataVersion: '1' },
  )) as RawEvent;
  return toEvent(raw);
}

/** Moves or renames the event; guests are told. Attendees, when given, replace the whole list. */
export async function patchEvent(
  transport: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
  patch: Partial<Pick<CalendarEventInput, 'title' | 'startsAt' | 'endsAt' | 'attendees'>>,
): Promise<CalendarEvent> {
  const raw = (await call(
    transport,
    accessToken,
    'PATCH',
    `/calendars/${encode(calendarId)}/events/${encode(eventId)}`,
    { conferenceDataVersion: '1', sendUpdates: 'all' },
    {
      ...(patch.title !== undefined ? { summary: patch.title } : {}),
      ...(patch.startsAt
        ? { start: { dateTime: patch.startsAt.toISOString(), timeZone: MEETING_TIME_ZONE } }
        : {}),
      ...(patch.endsAt
        ? { end: { dateTime: patch.endsAt.toISOString(), timeZone: MEETING_TIME_ZONE } }
        : {}),
      ...(patch.attendees
        ? {
            attendees: patch.attendees.map((a) => ({
              email: a.email,
              ...(a.name ? { displayName: a.name } : {}),
            })),
          }
        : {}),
    },
  )) as RawEvent;
  return toEvent(raw);
}

/** Removes the event and tells the guests. An event already gone counts as cancelled. */
export async function deleteEvent(
  transport: typeof fetch,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await call(
      transport,
      accessToken,
      'DELETE',
      `/calendars/${encode(calendarId)}/events/${encode(eventId)}`,
      { sendUpdates: 'all' },
    );
  } catch (error) {
    if (
      error instanceof GoogleCalendarError &&
      (error.code === 'gone' || error.code === 'not_found')
    )
      return;
    throw error;
  }
}
