import type { MeetingAttendee, MeetingCalendar } from '@wings/shared';
import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees } from '../../db/schema/index.js';
import {
  createEvent,
  deleteEvent,
  getEvent,
  GoogleCalendarError,
  patchEvent,
  type CalendarEvent,
} from '../google-workspace/calendar.js';
import { GoogleOAuthError } from '../google-workspace/oauth.js';
import { accessTokenFor, type GoogleWorkspaceDeps } from '../google-workspace/service.js';

/**
 * The meeting's mirror on Google Agenda. Creating puts the event (with its
 * Meet and the invitations) on the calendar the person chose; moving and
 * cancelling go to Google first and only then to the CRM's copy, so guests
 * never hold a different time than the screen. The token is the person's own;
 * for a change made by someone else (an Admin), the creator's token is tried
 * first and then the actor's. Attendee e-mails never reach a log.
 */

export class MeetingGoogleError extends Error {
  constructor(
    readonly code:
      | 'google_not_configured'
      | 'google_not_connected'
      | 'google_needs_reconnect'
      | 'wings_calendar_unavailable'
      | 'wings_calendar_forbidden'
      | 'meet_failed'
      | 'google_sync_failed',
    readonly status: 503 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleSyncDeps {
  db: Database;
  google: GoogleWorkspaceDeps | null;
  wingsCalendarId: string | null;
  /** Injectable so tests never wait for a pending Meet. */
  sleep: (ms: number) => Promise<void>;
}

export interface MeetingEventInput {
  title: string;
  startsAt: Date;
  endsAt: Date;
  calendar: MeetingCalendar;
  attendees: Array<{ email: string; name?: string | null }>;
  lead: { name: string | null; email: string | null };
  ownerEmployeeId: string;
  actorEmployeeId: string;
}

export interface MeetingEvent {
  eventId: string;
  calendarId: string;
  htmlLink: string | null;
  meetUrl: string;
  attendees: MeetingAttendee[];
}

const MEET_READS = [400, 800, 1600];

const notConnected = (code: GoogleOAuthError['code']) =>
  code === 'needs_reconnect'
    ? new MeetingGoogleError(
        'google_needs_reconnect',
        503,
        'Sua conexão com o Google expirou: conecte de novo em Minha conta → Google.',
      )
    : new MeetingGoogleError(
        'google_not_connected',
        503,
        'Conecte sua conta Google em Minha conta → Google para criar o evento e o Meet.',
      );

async function tokenOf(deps: GoogleSyncDeps, employeeId: string): Promise<string> {
  if (!deps.google) {
    throw new MeetingGoogleError(
      'google_not_configured',
      503,
      'O Google Workspace ainda não foi configurado no sistema.',
    );
  }
  try {
    return (await accessTokenFor(deps.google, employeeId)).accessToken;
  } catch (error) {
    if (error instanceof GoogleOAuthError) {
      if (error.code === 'not_connected' || error.code === 'needs_reconnect') {
        throw notConnected(error.code);
      }
      throw new MeetingGoogleError('google_sync_failed', 502, 'O Google não respondeu.');
    }
    throw error;
  }
}

function calendarIdOf(deps: GoogleSyncDeps, calendar: MeetingCalendar): string {
  if (calendar === 'vendedor') return 'primary';
  if (!deps.wingsCalendarId) {
    throw new MeetingGoogleError(
      'wings_calendar_unavailable',
      409,
      'A agenda Wings Company ainda não foi configurada no sistema (GOOGLE_WORKSPACE_WINGS_CALENDAR_ID).',
    );
  }
  return deps.wingsCalendarId;
}

function mapCalendarError(error: unknown, calendar: MeetingCalendar): never {
  if (error instanceof GoogleCalendarError) {
    if (error.code === 'unauthorized') throw notConnected('needs_reconnect');
    if ((error.code === 'forbidden' || error.code === 'not_found') && calendar === 'wings') {
      throw new MeetingGoogleError(
        'wings_calendar_forbidden',
        409,
        'Você não tem acesso de edição à agenda Wings Company: peça à Thais para compartilhar com "Fazer alterações nos eventos".',
      );
    }
    throw new MeetingGoogleError(
      'google_sync_failed',
      502,
      'O Google Agenda recusou a alteração; tente de novo ou mude só no sistema.',
    );
  }
  throw error;
}

const descriptionOf = (leadName: string | null) =>
  [
    `Reunião com a Wings Company${leadName ? ` — ${leadName}` : ''}.`,
    'Esta reunião é gravada para registro e resumo; ao entrar, você concorda com a gravação.',
    'Marcada pelo Wings System.',
  ].join('\n');

/** The guests: who the screen named, the lead, the deal's owner and, on the shared calendar, the person creating. */
async function guestsOf(deps: GoogleSyncDeps, input: MeetingEventInput) {
  const ids = [input.ownerEmployeeId, ...(input.calendar === 'wings' ? [input.actorEmployeeId] : [])];
  const people = await deps.db
    .select({ id: employees.id, email: employees.email, name: employees.fullName })
    .from(employees)
    .where(inArray(employees.id, ids));
  const guests = new Map<string, { email: string; name: string | null }>();
  const add = (email: string | null, name: string | null) => {
    const key = email?.trim().toLowerCase();
    if (key && !guests.has(key)) guests.set(key, { email: key, name });
  };
  for (const a of input.attendees) add(a.email, a.name ?? null);
  add(input.lead.email, input.lead.name);
  for (const p of people) add(p.email, p.name);
  return [...guests.values()];
}

async function meetOf(
  deps: GoogleSyncDeps,
  token: string,
  calendarId: string,
  created: CalendarEvent,
): Promise<string> {
  let event = created;
  for (const wait of MEET_READS) {
    if (event.meetUrl || event.meetStatus === 'failure') break;
    await deps.sleep(wait);
    event = await getEvent(deps.google!.transport, token, calendarId, created.id);
  }
  if (event.meetUrl) return event.meetUrl;
  // An event without its Meet is worse than none: guests would get a link-less invitation.
  await deleteEvent(deps.google!.transport, token, calendarId, created.id).catch(() => {});
  throw new MeetingGoogleError(
    'meet_failed',
    502,
    'O Google criou o evento mas não gerou o Meet; a reunião não foi marcada. Tente de novo.',
  );
}

export async function createMeetingEvent(
  deps: GoogleSyncDeps,
  input: MeetingEventInput,
): Promise<MeetingEvent> {
  const token = await tokenOf(deps, input.actorEmployeeId);
  const calendarId = calendarIdOf(deps, input.calendar);
  const attendees = await guestsOf(deps, input);
  let created: CalendarEvent;
  try {
    created = await createEvent(deps.google!.transport, token, calendarId, {
      title: input.title,
      description: descriptionOf(input.lead.name),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      attendees,
      createMeet: true,
    });
  } catch (error) {
    mapCalendarError(error, input.calendar);
  }
  const meetUrl = await meetOf(deps, token, calendarId, created);
  return {
    eventId: created.id,
    calendarId,
    htmlLink: created.htmlLink,
    meetUrl,
    attendees: created.attendees.length
      ? created.attendees
      : attendees.map((a) => ({ ...a, responseStatus: 'sem_resposta' as const })),
  };
}

interface MirroredRow {
  googleEventId: string;
  googleCalendarId: string | null;
  calendar: string;
  createdBy: string | null;
}

/** The creator's token when they are still connected, else the actor's. */
async function tokenForRow(deps: GoogleSyncDeps, row: MirroredRow, actorEmployeeId: string) {
  if (row.createdBy && row.createdBy !== actorEmployeeId) {
    try {
      return await tokenOf(deps, row.createdBy);
    } catch (error) {
      if (!(error instanceof MeetingGoogleError) || error.status !== 503) throw error;
    }
  }
  return tokenOf(deps, actorEmployeeId);
}

export async function patchMeetingEvent(
  deps: GoogleSyncDeps,
  row: MirroredRow,
  actorEmployeeId: string,
  patch: {
    title?: string;
    startsAt?: Date;
    endsAt?: Date;
    attendees?: Array<{ email: string; name: string | null }>;
  },
): Promise<MeetingAttendee[] | null> {
  const token = await tokenForRow(deps, row, actorEmployeeId);
  const calendar = row.calendar as MeetingCalendar;
  try {
    const event = await patchEvent(
      deps.google!.transport,
      token,
      row.googleCalendarId ?? 'primary',
      row.googleEventId,
      patch,
    );
    return event.attendees.length ? event.attendees : null;
  } catch (error) {
    mapCalendarError(error, calendar);
  }
}

export async function cancelMeetingEvent(
  deps: GoogleSyncDeps,
  row: MirroredRow,
  actorEmployeeId: string,
): Promise<void> {
  const token = await tokenForRow(deps, row, actorEmployeeId);
  try {
    await deleteEvent(
      deps.google!.transport,
      token,
      row.googleCalendarId ?? 'primary',
      row.googleEventId,
    );
  } catch (error) {
    mapCalendarError(error, row.calendar as MeetingCalendar);
  }
}

/** Whether a meeting row still has a live mirror to keep in step. */
export const mirrored = (row: {
  googleEventId: string | null;
  status: string;
}): row is { googleEventId: string; status: string } =>
  Boolean(row.googleEventId) && row.status !== 'cancelada';
