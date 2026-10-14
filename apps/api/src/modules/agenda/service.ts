import {
  AGENDA_NOTICES,
  GOOGLE_EVENT_COLORS,
  type Actor,
  type AgendaCalendar,
  type AgendaCalendarKey,
  type AgendaEvent,
  type AgendaEventColor,
  type AgendaEventInput,
  type AgendaEventPatch,
  type AgendaEventsAnswer,
  type AgendaEventsQuery,
  type AgendaOverview,
  type AgendaWingsAccess,
} from '@wings/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmMeetings, leads } from '../../db/schema/index.js';
import {
  GoogleCalendarError,
  listCalendars,
  type CalendarListEntry,
} from '../google-workspace/calendar.js';
import { GoogleOAuthError } from '../google-workspace/oauth.js';
import { accessTokenFor, type GoogleWorkspaceDeps } from '../google-workspace/service.js';
import { leadVisibleTo } from '../leads/access.js';
import {
  canEditEvent,
  deleteRawEvent,
  eventColorsOf,
  getRawEvent,
  hasMeet,
  insertRawEvent,
  insertRequestOf,
  isShownEvent,
  isWriterRole,
  listEvents,
  meetStatusOf,
  patchRawEvent,
  patchRequestOf,
  sendUpdatesOf,
  startTimeOf,
  toAgendaEvent,
  type RawEvent,
} from './google.js';

/**
 * Agenda (docs/agenda.md): the person's own Google calendar and the Wings
 * Company one, read and written with the person's own token, so Google's
 * sharing decides what each one sees and may change. A deal's meeting
 * (crm_meetings) is shown but never moved or cancelled from here, and only the
 * organizer side edits an event. Nothing here logs event content.
 */

export class AgendaError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 502 | 503,
    message: string,
    /** Extra answer fields (crm_meeting: `leadId`). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface AgendaDeps {
  db: Database;
  google: GoogleWorkspaceDeps | null;
  wingsCalendarId: string | null;
  /** Injectable so tests never wait for a pending Meet. */
  sleep: (ms: number) => Promise<void>;
}

const MESSAGES = {
  unreachable: 'O Google não respondeu; tente de novo em instantes.',
  rejected: 'O Google Agenda recusou o pedido; tente de novo.',
  notFound: 'Evento não encontrado no Google Agenda.',
  meetFailed:
    'O Google criou o evento mas não gerou o Meet; o evento não foi criado. Tente de novo.',
};

const notConfigured = () =>
  new AgendaError('google_not_configured', 503, AGENDA_NOTICES.notConfigured);
const needsReconnect = () =>
  new AgendaError('google_needs_reconnect', 409, AGENDA_NOTICES.needsReconnect);
const notFound = () => new AgendaError('event_not_found', 404, MESSAGES.notFound);
const unreachable = () => new AgendaError('google_unreachable', 502, MESSAGES.unreachable);

const DEFAULT_COLORS: Record<string, AgendaEventColor> = Object.fromEntries(
  Object.entries(GOOGLE_EVENT_COLORS).map(([id, { background, foreground }]) => [
    id,
    { background, foreground },
  ]),
);
const FALLBACK_CALENDAR_COLORS = { backgroundColor: '#039be5', foregroundColor: '#ffffff' };

// --- token and calendars -----------------------------------------------------------------------

interface Access {
  google: GoogleWorkspaceDeps;
  token: string;
  email: string | null;
}

/** The person's token, or the reason there is none (thrown as the answer). */
async function accessOf(deps: AgendaDeps, employeeId: string): Promise<Access> {
  if (!deps.google) throw notConfigured();
  try {
    const access = await accessTokenFor(deps.google, employeeId);
    return { google: deps.google, token: access.accessToken, email: access.email };
  } catch (error) {
    if (!(error instanceof GoogleOAuthError)) throw error;
    if (error.code === 'not_connected') {
      throw new AgendaError('google_not_connected', 409, AGENDA_NOTICES.notConnected);
    }
    if (error.code === 'needs_reconnect') throw needsReconnect();
    throw unreachable();
  }
}

/** One calendar the person reaches: its key, its Google id and their access there. */
interface ResolvedCalendar {
  key: AgendaCalendarKey;
  /** What Calendar v3 calls take ('primary' for the person's own). */
  requestId: string;
  /** The calendar's real id, for the organizer check. */
  realId: string;
  accessRole: string;
  view: AgendaCalendar;
}

interface Calendars {
  mine: ResolvedCalendar;
  /** Null unless the Wings Company calendar is shared with the person and is not their own. */
  wings: ResolvedCalendar | null;
  wingsAccess: AgendaWingsAccess;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function viewOf(
  key: AgendaCalendarKey,
  entry: CalendarListEntry | null,
  fallbackName: string,
): AgendaCalendar {
  return {
    key,
    name: entry ? entry.summaryOverride || entry.summary || fallbackName : fallbackName,
    backgroundColor: entry?.backgroundColor ?? FALLBACK_CALENDAR_COLORS.backgroundColor,
    foregroundColor: entry?.foregroundColor ?? FALLBACK_CALENDAR_COLORS.foregroundColor,
    canWrite: entry ? isWriterRole(entry.accessRole) : true,
  };
}

/** The person's calendar list, reduced to the two the Agenda knows. */
async function calendarsOf(deps: AgendaDeps, access: Access): Promise<Calendars> {
  let entries: CalendarListEntry[];
  try {
    entries = await listCalendars(access.google.transport, access.token);
  } catch (error) {
    if (error instanceof GoogleCalendarError && error.code === 'unauthorized') {
      throw needsReconnect();
    }
    if (error instanceof GoogleCalendarError) throw unreachable();
    throw error;
  }
  const primary = entries.find((e) => e.primary) ?? null;
  const mineRealId = primary?.id ?? access.email ?? 'primary';
  const mine: ResolvedCalendar = {
    key: 'mine',
    requestId: 'primary',
    realId: mineRealId,
    accessRole: primary?.accessRole ?? 'owner',
    view: viewOf('mine', primary, access.email ?? 'Minha agenda'),
  };
  const wingsId = deps.wingsCalendarId;
  if (!wingsId) return { mine, wings: null, wingsAccess: 'not_configured' };
  if (sameId(mineRealId, wingsId)) return { mine, wings: null, wingsAccess: 'is_mine' };
  const entry = entries.find((e) => sameId(e.id, wingsId)) ?? null;
  if (!entry) return { mine, wings: null, wingsAccess: 'not_shared' };
  return {
    mine,
    wings: {
      key: 'wings',
      requestId: wingsId,
      realId: wingsId,
      accessRole: entry.accessRole,
      view: viewOf('wings', entry, 'Wings Company'),
    },
    wingsAccess: isWriterRole(entry.accessRole) ? 'writer' : 'reader',
  };
}

/**
 * Where a key leads for this person. `wings` on Thais' own account is her
 * calendar; `wings` not shared (or not configured) is refused.
 */
function calendarFor(calendars: Calendars, key: AgendaCalendarKey): ResolvedCalendar {
  if (key === 'mine' || calendars.wingsAccess === 'is_mine') return calendars.mine;
  if (calendars.wings) return calendars.wings;
  throw new AgendaError(
    'wings_calendar_forbidden',
    409,
    calendars.wingsAccess === 'not_configured'
      ? AGENDA_NOTICES.notConfigured
      : AGENDA_NOTICES.wingsNotShared,
  );
}

/** A Google refusal as the answer; 403 never leaves as 403 (that status is the permission gate's). */
export function agendaErrorOf(error: unknown, calendar: AgendaCalendarKey): AgendaError {
  if (error instanceof AgendaError) return error;
  if (!(error instanceof GoogleCalendarError)) throw error;
  switch (error.code) {
    case 'unauthorized':
      return needsReconnect();
    case 'forbidden':
      return calendar === 'wings'
        ? new AgendaError('wings_calendar_forbidden', 409, AGENDA_NOTICES.wingsReadOnly)
        : new AgendaError('event_not_editable', 409, AGENDA_NOTICES.notEditable);
    case 'not_found':
    case 'gone':
      return notFound();
    case 'unreachable':
      return unreachable();
    default:
      return new AgendaError('google_rejected', 502, MESSAGES.rejected);
  }
}

// --- overview ----------------------------------------------------------------------------------

async function eventColorsFor(access: Access) {
  try {
    return {
      eventColors: await eventColorsOf(access.google.transport, access.token),
      eventColorsSource: 'google' as const,
    };
  } catch {
    return { eventColors: DEFAULT_COLORS, eventColorsSource: 'default' as const };
  }
}

/** What the screen opens with. Always answers: a missing connection is a state, not an error. */
export async function overviewFor(deps: AgendaDeps, employeeId: string): Promise<AgendaOverview> {
  const base: AgendaOverview = {
    state: 'not_configured',
    googleEmail: null,
    calendars: [],
    // Unknown until the calendar list is read; the screen reads `state` first.
    wings: deps.wingsCalendarId ? 'not_shared' : 'not_configured',
    eventColors: DEFAULT_COLORS,
    eventColorsSource: 'default',
  };
  let access: Access;
  try {
    access = await accessOf(deps, employeeId);
  } catch (error) {
    if (!(error instanceof AgendaError)) throw error;
    const state =
      error.code === 'google_not_configured'
        ? 'not_configured'
        : error.code === 'google_not_connected'
          ? 'not_connected'
          : error.code === 'google_needs_reconnect'
            ? 'needs_reconnect'
            : 'google_unreachable';
    return { ...base, state };
  }
  base.googleEmail = access.email;
  let calendars: Calendars;
  try {
    calendars = await calendarsOf(deps, access);
  } catch (error) {
    if (!(error instanceof AgendaError)) throw error;
    return {
      ...base,
      state: error.code === 'google_needs_reconnect' ? 'needs_reconnect' : 'google_unreachable',
    };
  }
  return {
    ...base,
    state: 'ready',
    calendars: [calendars.mine.view, ...(calendars.wings ? [calendars.wings.view] : [])],
    wings: calendars.wingsAccess,
    ...(await eventColorsFor(access)),
  };
}

// --- CRM meetings ------------------------------------------------------------------------------

/**
 * The deals' meetings among these Google event ids (an occurrence counts by its
 * series id too): event id → the deal, when the person may open it.
 */
async function crmLinksOf(
  db: Database,
  actor: Actor,
  eventIds: string[],
): Promise<Map<string, { leadId: string | null }>> {
  const links = new Map<string, { leadId: string | null }>();
  const ids = [...new Set(eventIds)];
  if (!ids.length) return links;
  const rows = await db
    .select({
      googleEventId: crmMeetings.googleEventId,
      leadId: crmMeetings.leadId,
      ownerEmployeeId: leads.ownerEmployeeId,
    })
    .from(crmMeetings)
    .innerJoin(leads, eq(leads.id, crmMeetings.leadId))
    .where(and(inArray(crmMeetings.googleEventId, ids), ne(crmMeetings.status, 'cancelada')));
  for (const row of rows) {
    if (!row.googleEventId) continue;
    const visible = leadVisibleTo(actor, 'leads.read', { ownerEmployeeId: row.ownerEmployeeId });
    const current = links.get(row.googleEventId);
    // Two rows on one event: the one this person may open wins.
    if (!current || (current.leadId === null && visible)) {
      links.set(row.googleEventId, { leadId: visible ? row.leadId : null });
    }
  }
  return links;
}

const seriesIdOf = (raw: RawEvent) =>
  typeof raw.recurringEventId === 'string' ? raw.recurringEventId : null;

const linkOf = (links: Map<string, { leadId: string | null }>, raw: RawEvent) =>
  links.get(String(raw.id)) ?? links.get(seriesIdOf(raw) ?? '') ?? null;

function withCrm(event: AgendaEvent, crm: { leadId: string | null } | null): AgendaEvent {
  return crm ? { ...event, crm, canEdit: false } : event;
}

// --- events ------------------------------------------------------------------------------------

const FAILURE_MESSAGES: Record<string, string> = {
  wings_calendar_forbidden: 'Sem acesso à agenda Wings Company no Google.',
  google_unreachable: 'O Google não respondeu; esta agenda não foi lida.',
  google_rejected: 'O Google recusou a leitura desta agenda.',
  event_not_found: 'A agenda não foi encontrada no Google.',
};

/** Both calendars in the range, read side by side; one failing leaves the other answered. */
export async function eventsFor(
  deps: AgendaDeps,
  actor: Actor,
  query: AgendaEventsQuery,
): Promise<AgendaEventsAnswer> {
  const access = await accessOf(deps, actor.employeeId);
  const calendars = await calendarsOf(deps, access);
  const targets = [calendars.mine, ...(calendars.wings ? [calendars.wings] : [])];
  const reads = await Promise.allSettled(
    targets.map((calendar) =>
      listEvents(access.google.transport, access.token, calendar.requestId, {
        from: query.from,
        to: query.to,
        ...(query.q ? { q: query.q } : {}),
      }),
    ),
  );

  const answer: AgendaEventsAnswer = { events: [], failures: [], truncated: false };
  const read: Array<{ calendar: ResolvedCalendar; items: RawEvent[] }> = [];
  reads.forEach((outcome, index) => {
    const calendar = targets[index]!;
    if (outcome.status === 'fulfilled') {
      read.push({ calendar, items: outcome.value.items.filter(isShownEvent) });
      if (outcome.value.truncated) answer.truncated = true;
      return;
    }
    const error = agendaErrorOf(outcome.reason, calendar.key);
    // The token itself was refused: the whole answer says so, not one calendar.
    if (error.code === 'google_needs_reconnect') throw error;
    // A refused read of the person's own calendar is a refusal, not an edit rule.
    const code = error.code === 'event_not_editable' ? 'google_rejected' : error.code;
    answer.failures.push({
      calendar: calendar.key,
      code,
      message: FAILURE_MESSAGES[code] ?? MESSAGES.rejected,
    });
  });

  const links = await crmLinksOf(
    deps.db,
    actor,
    read.flatMap(({ items }) =>
      items.flatMap((raw) => [String(raw.id), ...(seriesIdOf(raw) ? [seriesIdOf(raw)!] : [])]),
    ),
  );
  answer.events = read
    .flatMap(({ calendar, items }) =>
      items.map((raw) =>
        withCrm(
          toAgendaEvent(raw, calendar.key, {
            accessRole: calendar.accessRole,
            calendarId: calendar.realId,
          }),
          linkOf(links, raw),
        ),
      ),
    )
    .sort((a, b) => startTimeOf(a) - startTimeOf(b));
  return answer;
}

// --- create ------------------------------------------------------------------------------------

const MEET_READS = [400, 800, 1600];

/** A Meet Google is still making is re-read a few times; null when it never came. */
async function waitForMeet(
  deps: AgendaDeps,
  access: Access,
  calendarId: string,
  created: RawEvent,
): Promise<RawEvent | null> {
  let event = created;
  for (const wait of MEET_READS) {
    if (hasMeet(event) || meetStatusOf(event) !== 'pending') break;
    await deps.sleep(wait);
    event = await getRawEvent(
      access.google.transport,
      access.token,
      calendarId,
      String(created.id),
    );
  }
  return hasMeet(event) ? event : null;
}

export interface WrittenEvent {
  event: AgendaEvent;
  /** The calendar it was written on (`mine` for Thais writing on the Wings Company one). */
  calendar: AgendaCalendarKey;
}

export async function createAgendaEvent(
  deps: AgendaDeps,
  actor: Actor,
  input: AgendaEventInput,
): Promise<WrittenEvent> {
  const access = await accessOf(deps, actor.employeeId);
  const calendars = await calendarsOf(deps, access);
  const calendar = calendarFor(calendars, input.calendar);
  if (!isWriterRole(calendar.accessRole)) {
    throw new AgendaError(
      calendar.key === 'wings' ? 'wings_calendar_forbidden' : 'event_not_editable',
      409,
      calendar.key === 'wings' ? AGENDA_NOTICES.wingsReadOnly : AGENDA_NOTICES.notEditable,
    );
  }
  const { transport } = access.google;
  let raw: RawEvent;
  try {
    raw = await insertRawEvent(transport, access.token, calendar.requestId, insertRequestOf(input));
    if (input.createMeet && !hasMeet(raw)) {
      const withMeet = await waitForMeet(deps, access, calendar.requestId, raw);
      if (!withMeet) {
        // An event without the Meet it promised is worse than none: guests would get a link-less invitation.
        await deleteRawEvent(
          transport,
          access.token,
          calendar.requestId,
          String(raw.id),
          input.attendees.length ? 'all' : 'none',
        ).catch(() => {});
        throw new AgendaError('meet_failed', 502, MESSAGES.meetFailed);
      }
      raw = withMeet;
    }
  } catch (error) {
    if (
      calendar.key === 'wings' &&
      error instanceof GoogleCalendarError &&
      error.code === 'not_found'
    ) {
      throw new AgendaError('wings_calendar_forbidden', 409, AGENDA_NOTICES.wingsNotShared);
    }
    throw agendaErrorOf(error, calendar.key);
  }
  return {
    calendar: calendar.key,
    event: toAgendaEvent(raw, calendar.key, {
      accessRole: calendar.accessRole,
      calendarId: calendar.realId,
    }),
  };
}

// --- update and delete -------------------------------------------------------------------------

/** The event as Google holds it, after the checks every change goes through. */
async function editableEvent(
  deps: AgendaDeps,
  actor: Actor,
  key: AgendaCalendarKey,
  eventId: string,
): Promise<{ access: Access; calendar: ResolvedCalendar; raw: RawEvent }> {
  const access = await accessOf(deps, actor.employeeId);
  const calendars = await calendarsOf(deps, access);
  const calendar = calendarFor(calendars, key);
  let raw: RawEvent;
  try {
    raw = await getRawEvent(access.google.transport, access.token, calendar.requestId, eventId);
  } catch (error) {
    throw agendaErrorOf(error, calendar.key);
  }
  if (typeof raw.id !== 'string' || raw.status === 'cancelled') throw notFound();
  const crm = linkOf(
    await crmLinksOf(deps.db, actor, [raw.id, ...(seriesIdOf(raw) ? [seriesIdOf(raw)!] : [])]),
    raw,
  );
  if (crm) {
    throw new AgendaError('crm_meeting', 409, AGENDA_NOTICES.crmMeeting, { leadId: crm.leadId });
  }
  if (calendar.key === 'wings' && !isWriterRole(calendar.accessRole)) {
    throw new AgendaError('wings_calendar_forbidden', 409, AGENDA_NOTICES.wingsReadOnly);
  }
  if (!canEditEvent(raw, { accessRole: calendar.accessRole, calendarId: calendar.realId })) {
    throw new AgendaError('event_not_editable', 409, AGENDA_NOTICES.notEditable);
  }
  return { access, calendar, raw };
}

/** An edit of one event; an occurrence of a series is patched by its own id, so only it changes. */
export async function updateAgendaEvent(
  deps: AgendaDeps,
  actor: Actor,
  key: AgendaCalendarKey,
  eventId: string,
  patch: AgendaEventPatch,
): Promise<WrittenEvent> {
  const { access, calendar, raw } = await editableEvent(deps, actor, key, eventId);
  const request = patchRequestOf(raw, patch);
  let updated: RawEvent;
  try {
    updated = await patchRawEvent(
      access.google.transport,
      access.token,
      calendar.requestId,
      eventId,
      request,
    );
    if (request.body.conferenceData && !hasMeet(updated)) {
      // The edit stands either way; the Meet shows once Google has made it.
      updated = (await waitForMeet(deps, access, calendar.requestId, updated)) ?? updated;
    }
  } catch (error) {
    throw agendaErrorOf(error, calendar.key);
  }
  return {
    calendar: calendar.key,
    event: toAgendaEvent(updated, calendar.key, {
      accessRole: calendar.accessRole,
      calendarId: calendar.realId,
    }),
  };
}

export async function removeAgendaEvent(
  deps: AgendaDeps,
  actor: Actor,
  key: AgendaCalendarKey,
  eventId: string,
): Promise<{ calendar: AgendaCalendarKey }> {
  const { access, calendar, raw } = await editableEvent(deps, actor, key, eventId);
  try {
    await deleteRawEvent(
      access.google.transport,
      access.token,
      calendar.requestId,
      eventId,
      sendUpdatesOf(raw.attendees ?? []),
    );
  } catch (error) {
    throw agendaErrorOf(error, calendar.key);
  }
  return { calendar: calendar.key };
}
