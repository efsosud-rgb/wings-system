import { z } from 'zod';

/**
 * Agenda (docs/agenda.md): the contract between the API and the Agenda screen.
 *
 * Two calendars only: the person's own Google calendar ("Minhas agendas") and
 * the Wings Company one ("Outras agendas", Thais' primary). Both are read and
 * written with the person's own Google token, so Google's sharing decides what
 * each person sees and may change; the system never acts on someone else's
 * account. The browser names a calendar by its key, never by its Google id.
 */

export const AGENDA_TIME_ZONE = 'America/Sao_Paulo';

export const AGENDA_CALENDAR_KEYS = ['mine', 'wings'] as const;
export type AgendaCalendarKey = (typeof AGENDA_CALENDAR_KEYS)[number];

/**
 * The person's standing with Google, before any event is read:
 * `not_configured` (the system has no OAuth client), `not_connected` (Minha
 * conta → Google never done), `needs_reconnect` (Google refused the refresh),
 * `google_unreachable` (Google did not answer), `ready`.
 */
export const AGENDA_STATES = [
  'not_configured',
  'not_connected',
  'needs_reconnect',
  'google_unreachable',
  'ready',
] as const;
export type AgendaState = (typeof AGENDA_STATES)[number];

/**
 * The Wings Company calendar for this person: `writer` and `reader` from
 * Google's accessRole, `not_shared` when it is not in their calendar list,
 * `not_configured` while GOOGLE_WORKSPACE_WINGS_CALENDAR_ID is unset, and
 * `is_mine` for Thais, whose own calendar it is (listed once, as hers).
 */
export type AgendaWingsAccess = 'writer' | 'reader' | 'not_shared' | 'not_configured' | 'is_mine';

export interface AgendaCalendar {
  key: AgendaCalendarKey;
  /**
   * `mine`: the calendar's name on the person's Google list. `wings`: the name
   * the person gave it on their list, else "Wings Company" (its Google name is
   * Thais' account).
   */
  name: string;
  /** From calendarList, '#rrggbb', in the current Google tone (`currentCalendarColor`). */
  backgroundColor: string;
  foregroundColor: string;
  /** owner or writer on Google: events may be created there. */
  canWrite: boolean;
}

export interface AgendaEventColor {
  background: string;
  foreground: string;
}

export interface AgendaOverview {
  state: AgendaState;
  /** The Google account the person connected (their own). */
  googleEmail: string | null;
  /** Empty unless `state` is `ready`; `mine` first. */
  calendars: AgendaCalendar[];
  wings: AgendaWingsAccess;
  /** Event colours by Google colorId. */
  eventColors: Record<string, AgendaEventColor>;
  /**
   * `google` when colors.get answered (its ids, shown in the current tones),
   * `default` when it did not and GOOGLE_EVENT_COLORS stood in alone.
   */
  eventColorsSource: 'google' | 'default';
}

/**
 * Google's event palette in the tones the Google Agenda shows today (Eric, 14/10),
 * by colorId, with the names it gives them in Portuguese. colors.get (allowed by
 * the `calendar.calendarlist.readonly` scope the connection has) still answers
 * the older, paler tones under the same ids, so the API shows these instead.
 * Text is white or near-black, whichever reads better on the tone.
 */
export const GOOGLE_EVENT_COLORS: Record<string, AgendaEventColor & { name: string }> = {
  '1': { name: 'Lavanda', background: '#7986cb', foreground: '#1d1d1d' },
  '2': { name: 'Sálvia', background: '#33b679', foreground: '#1d1d1d' },
  '3': { name: 'Uva', background: '#8e24aa', foreground: '#ffffff' },
  '4': { name: 'Flamingo', background: '#e67c73', foreground: '#1d1d1d' },
  '5': { name: 'Banana', background: '#f6bf26', foreground: '#1d1d1d' },
  '6': { name: 'Tangerina', background: '#f4511e', foreground: '#1d1d1d' },
  '7': { name: 'Pavão', background: '#039be5', foreground: '#1d1d1d' },
  '8': { name: 'Grafite', background: '#616161', foreground: '#ffffff' },
  '9': { name: 'Mirtilo', background: '#3f51b5', foreground: '#ffffff' },
  '10': { name: 'Manjericão', background: '#0b8043', foreground: '#ffffff' },
  '11': { name: 'Tomate', background: '#d50000', foreground: '#ffffff' },
};
export const GOOGLE_EVENT_COLOR_IDS = Object.keys(GOOGLE_EVENT_COLORS);

/**
 * The calendars' palette: calendarList answers a calendar's colour in the older
 * tones (its 24 colorIds); the Google Agenda shows each as a current tone. Keyed
 * by the older background, lower case. A colour the person picked by hand is
 * not in the table and stays as it is.
 */
export const GOOGLE_CALENDAR_COLORS: Record<string, { name: string; background: string }> = {
  '#ac725e': { name: 'Cacau', background: '#795548' },
  '#d06b64': { name: 'Flamingo', background: '#e67c73' },
  '#f83a22': { name: 'Tomate', background: '#d50000' },
  '#fa573c': { name: 'Tangerina', background: '#f4511e' },
  '#ff7537': { name: 'Abóbora', background: '#ef6c00' },
  '#ffad46': { name: 'Manga', background: '#f09300' },
  '#42d692': { name: 'Eucalipto', background: '#009688' },
  '#16a765': { name: 'Manjericão', background: '#0b8043' },
  '#7bd148': { name: 'Pistache', background: '#7cb342' },
  '#b3dc6c': { name: 'Abacate', background: '#c0ca33' },
  '#fbe983': { name: 'Cidra', background: '#e4c441' },
  '#fad165': { name: 'Banana', background: '#f6bf26' },
  '#92e1c0': { name: 'Sálvia', background: '#33b679' },
  '#9fe1e7': { name: 'Pavão', background: '#039be5' },
  '#9fc6e7': { name: 'Cobalto', background: '#4285f4' },
  '#4986e7': { name: 'Mirtilo', background: '#3f51b5' },
  '#9a9cff': { name: 'Lavanda', background: '#7986cb' },
  '#b99aff': { name: 'Glicínia', background: '#b39ddb' },
  '#c2c2c2': { name: 'Grafite', background: '#616161' },
  '#cabdbf': { name: 'Bétula', background: '#a79b8e' },
  '#cca6ac': { name: 'Radicchio', background: '#ad1457' },
  '#f691b2': { name: 'Flor de cerejeira', background: '#d81b60' },
  '#cd74e6': { name: 'Ametista', background: '#9e69af' },
  '#a47ae2': { name: 'Uva', background: '#8e24aa' },
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_TEXT = '#1d1d1d';
const LIGHT_TEXT = '#ffffff';

/** White or near-black, whichever has the higher contrast on this '#rrggbb' background. */
export function readableTextOn(background: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return DARK_TEXT;
  const tone = luminance(background);
  const onWhite = 1.05 / (tone + 0.05);
  const onDark = (tone + 0.05) / (luminance(DARK_TEXT) + 0.05);
  return onWhite >= onDark ? LIGHT_TEXT : DARK_TEXT;
}

/** A calendar's colour as the Google Agenda shows it today, with readable text on it. */
export function currentCalendarColor(background: string): AgendaEventColor {
  const current = GOOGLE_CALENDAR_COLORS[background.toLowerCase()]?.background ?? background;
  return { background: current, foreground: readableTextOn(current) };
}

export const AGENDA_RESPONSES = ['aceitou', 'recusou', 'talvez', 'sem_resposta'] as const;
export type AgendaResponse = (typeof AGENDA_RESPONSES)[number];
export const AGENDA_RESPONSE_LABELS: Record<AgendaResponse, string> = {
  aceitou: 'Sim',
  recusou: 'Não',
  talvez: 'Talvez',
  sem_resposta: 'Aguardando resposta',
};

/** A guest. E-mails are personal data: shown to the person whose calendar it is, never logged. */
export interface AgendaAttendee {
  email: string;
  name: string | null;
  response: AgendaResponse;
  organizer: boolean;
  self: boolean;
}

export interface AgendaEvent {
  calendar: AgendaCalendarKey;
  id: string;
  /**
   * Google's iCalUID (the event id when absent). The same event on both
   * calendars shares it; with `start` it is the key the screen shows it once by.
   */
  uid: string;
  /** As on Google; empty when the event has none (the screen writes "(Sem título)"). */
  title: string;
  allDay: boolean;
  /** Timed: an ISO instant. All-day: 'YYYY-MM-DD'. */
  start: string;
  /** Exclusive, as Google: a one-day all-day event on the 14th ends on the 15th. */
  end: string;
  location: string | null;
  /** Plain text: Google's HTML is reduced to text by the API, never rendered as HTML. */
  description: string | null;
  meetUrl: string | null;
  /** The event's page on Google Agenda. */
  htmlLink: string | null;
  colorId: string | null;
  /** Google's status `tentative`. Cancelled events never reach the screen. */
  tentative: boolean;
  organizer: { email: string | null; name: string | null; self: boolean } | null;
  attendees: AgendaAttendee[];
  /** An occurrence of a recurring event: editing and deleting touch this occurrence only. */
  recurring: boolean;
  /**
   * Whether this person may change or delete it here: writer on its calendar
   * and organizer of the event (or the calendar is the organizer, or Google lets
   * guests modify it), and not a CRM meeting.
   */
  canEdit: boolean;
  /**
   * Whether a change or a deletion here reaches the guests: this is the
   * organizer's copy (the person's, or the calendar's own) and it has guests.
   * Deleting a guest's copy only takes it off that person's calendar.
   */
  guestsNotified: boolean;
  /**
   * Set when the event is a meeting of a deal (crm_meetings): it is moved and
   * cancelled only from the deal. `leadId` only when this person may open that
   * deal; null otherwise.
   */
  crm: { leadId: string | null } | null;
}

export interface AgendaEventsAnswer {
  events: AgendaEvent[];
  /** A calendar that could not be read: its events are missing, never shown as none. */
  failures: Array<{ calendar: AgendaCalendarKey; code: string; message: string }>;
  /** True when Google had more events in the range than the API reads in one go. */
  truncated: boolean;
}

/** Widest range one read may ask for (the search reads about a year around today). */
export const AGENDA_MAX_RANGE_DAYS = 550;
export const AGENDA_MAX_ATTENDEES = 50;
export const AGENDA_SEARCH_MAX = 200;

/** The texts both sides show for the two states the screen must explain. */
export const AGENDA_NOTICES = {
  notConnected: 'Conecte sua conta Google em Minha conta',
  needsReconnect: 'Sua conexão com o Google expirou: conecte de novo em Minha conta',
  wingsNotShared: 'Peça à Thais para compartilhar a agenda Wings Company',
  wingsReadOnly:
    'Você só pode ver a agenda Wings Company: peça à Thais a permissão "Fazer alterações nos eventos" para criar eventos nela',
  notConfigured: 'O Google Workspace ainda não foi configurado no sistema',
  crmMeeting: 'Este evento é uma reunião do CRM: remarque ou cancele pela negociação',
  notEditable: 'Só quem organiza o evento pode alterá-lo',
  readOnly: 'Na Agenda você só vê os eventos: marque, remarque ou cancele reuniões pela negociação',
} as const;

/** Where a CRM meeting's deal opens. */
export const agendaDealPath = (leadId: string) => `/crm-vendas/negociacoes/${leadId}`;

// --- validation ------------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' that is a real calendar day. */
export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const isoInstant = z.iso.datetime({ offset: true });
const DAY_MS = 86_400_000;

export const agendaEventsQuerySchema = z
  .object({
    from: isoInstant,
    to: isoInstant,
    q: z.string().trim().max(AGENDA_SEARCH_MAX).optional(),
  })
  .superRefine((value, ctx) => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    if (span <= 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Fim antes do início.' });
    } else if (span > AGENDA_MAX_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Faixa maior que ${AGENDA_MAX_RANGE_DAYS} dias.`,
      });
    }
  });
export type AgendaEventsQuery = z.infer<typeof agendaEventsQuerySchema>;

const eventFields = {
  title: z.string().trim().max(300, 'Título longo demais.'),
  allDay: z.boolean(),
  /** Timed: an ISO instant with offset. All-day: 'YYYY-MM-DD'. */
  start: z.string(),
  /** Exclusive, as Google (all-day: the day after the last one). */
  end: z.string(),
  location: z.string().trim().max(500).nullable(),
  description: z.string().max(8000).nullable(),
  attendees: z
    .array(z.string().trim().toLowerCase().max(254).pipe(z.email('E-mail de convidado inválido.')))
    .max(AGENDA_MAX_ATTENDEES, `No máximo ${AGENDA_MAX_ATTENDEES} convidados.`)
    .transform((list) => [...new Set(list)]),
  /** Ask Google for a Meet (on an edit: adds one when the event has none; never removes it). */
  createMeet: z.boolean(),
  colorId: z
    .string()
    .refine((id) => GOOGLE_EVENT_COLOR_IDS.includes(id), 'Cor desconhecida.')
    .nullable(),
};

const MAX_EVENT_DAYS = 366;

function checkTimes(
  value: { allDay?: boolean; start?: string; end?: string },
  ctx: z.RefinementCtx,
): void {
  const { allDay, start, end } = value;
  if (allDay === undefined && start === undefined && end === undefined) return;
  if (allDay === undefined || start === undefined || end === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['start'],
      message: 'Início, fim e dia inteiro vão juntos.',
    });
    return;
  }
  const valid = allDay
    ? isDateOnly(start) && isDateOnly(end)
    : isoInstant.safeParse(start).success && isoInstant.safeParse(end).success;
  if (!valid) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'Data ou hora inválida.' });
    return;
  }
  const span = allDay
    ? Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
    : Date.parse(end) - Date.parse(start);
  if (span <= 0) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'O fim vem depois do início.' });
  } else if (span > MAX_EVENT_DAYS * DAY_MS) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'Evento longo demais.' });
  }
}

export const agendaEventInputSchema = z
  .object({ calendar: z.enum(AGENDA_CALENDAR_KEYS), ...eventFields })
  .superRefine(checkTimes);
export type AgendaEventInput = z.infer<typeof agendaEventInputSchema>;

/** An edit: any field but the calendar (moving between calendars is not offered); times go together. */
export const agendaEventPatchSchema = z
  .object(eventFields)
  .partial()
  .strict()
  .superRefine(checkTimes)
  .refine((value) => Object.keys(value).length > 0, 'Nada para alterar.');
export type AgendaEventPatch = z.infer<typeof agendaEventPatchSchema>;

// --- time zone ---------------------------------------------------------------------------------

/** A wall-clock reading in a time zone. `weekday` 0 = Sunday. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What the clock on the wall says at this instant in the time zone (São Paulo by default). */
export function wallClockOf(
  instant: Date | string | number,
  timeZone = AGENDA_TIME_ZONE,
): WallClock {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts: Record<string, string> = {};
  for (const part of formatterOf(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** Minutes the zone is ahead of UTC at this instant (São Paulo: -180). */
function offsetMinutes(instant: number, timeZone: string): number {
  const wall = wallClockOf(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return Math.round((asUtc - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

/** The instant a wall-clock time in the zone names (São Paulo by default). */
export function instantOf(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone = AGENDA_TIME_ZONE,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  // Near a daylight-saving change the offset at the answer can differ from the guess's.
  const second = guess - offsetMinutes(first, timeZone) * 60_000;
  return new Date(second);
}

/** 'YYYY-MM-DD' of a wall-clock day. */
export const dateOnlyOf = (wall: { year: number; month: number; day: number }) =>
  `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;

/** The day `days` after (or before) a 'YYYY-MM-DD' day. */
export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return dateOnlyOf({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

/** Day of the week of a 'YYYY-MM-DD' day, 0 = Sunday. */
export function weekdayOf(dateOnly: string): number {
  const [y, m, d] = dateOnly.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
