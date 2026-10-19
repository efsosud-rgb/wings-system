import { randomBytes } from 'node:crypto';
import {
  AGENDA_NOTICES,
  GOOGLE_EVENT_COLORS,
  SESSION_COOKIE,
  type AgendaEvent,
  type AgendaEventsAnswer,
  type AgendaOverview,
  type RoleKey,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, crmMeetings, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakeGoogle, type FakeGoogleOptions } from '../google-workspace/fake-google.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const NOW = new Date('2026-10-14T15:00:00Z');
const WINGS = 'agenda-wings@wingscompany.com.br';
const PERSON = 'pessoa@wingscompany.com.br';
const RANGE = 'from=2026-10-12T00:00:00-03:00&to=2026-10-19T00:00:00-03:00';

const ME = { id: PERSON, summary: PERSON, primary: true, accessRole: 'owner' };
const WINGS_WRITER = {
  id: WINGS,
  summary: 'Wings Company',
  accessRole: 'writer',
  backgroundColor: '#16a765',
  foregroundColor: '#000000',
};
const WINGS_READER = { ...WINGS_WRITER, accessRole: 'reader' };
/** What colors.get answers: the older tones, under the same ids. */
const GOOGLE_COLORS = {
  '1': { background: '#a4bdfc', foreground: '#1d1d1d' },
  '11': { background: '#dc2127', foreground: '#1d1d1d' },
  '12': { background: '#123456', foreground: '#ffffff' },
};

const envOf = (extra: Record<string, string>) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
    ...extra,
  });

const GOOGLE_ENV = {
  INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_WORKSPACE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'client-secret',
};

const makeApp = (extra: Record<string, string>) =>
  buildApp({
    env: envOf(extra),
    db,
    now: () => NOW,
    googleFetch: fakeGoogle().transport,
    mailer: { enabled: true, send: async () => {} },
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await makeApp({ ...GOOGLE_ENV, GOOGLE_WORKSPACE_WINGS_CALENDAR_ID: WINGS });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

type Session = { id: string; cookies: Record<string, string> };

async function sessionFor(target: FastifyInstance, role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' || role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await target.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

/** Connect → consent → callback, as the browser would. */
async function connect(target: FastifyInstance, cookies: Record<string, string>) {
  const start = await target.inject({ method: 'POST', url: '/me/google/connect', cookies });
  const state = new URL(start.json<{ url: string }>().url).searchParams.get('state');
  const callback = await target.inject({
    method: 'GET',
    url: `/me/google/callback?code=auth-code&state=${state}`,
    cookies,
  });
  expect(callback.headers.location).toBe('/minha-conta?google=ok');
}

/** A connected person whose Google is the fake built from these options. */
async function connected(
  role: RoleKey,
  options: FakeGoogleOptions = {},
  target: FastifyInstance = app,
) {
  const google = fakeGoogle({ email: PERSON, calendars: [ME, WINGS_WRITER], ...options });
  target.wings.googleFetch = google.transport;
  const session = await sessionFor(target, role);
  await connect(target, session.cookies);
  google.reset();
  return { ...session, google };
}

async function overviewOf(cookies: Record<string, string>, target: FastifyInstance = app) {
  const res = await target.inject({ method: 'GET', url: '/agenda', cookies });
  expect(res.statusCode).toBe(200);
  return res.json<{ overview: AgendaOverview }>().overview;
}

async function eventsOf(cookies: Record<string, string>, extra = '') {
  const res = await app.inject({ method: 'GET', url: `/agenda/events?${RANGE}${extra}`, cookies });
  expect(res.statusCode).toBe(200);
  return res.json<AgendaEventsAnswer>();
}

const timed = (day: number, hour: number) => ({
  dateTime: `2026-10-${day}T${String(hour).padStart(2, '0')}:00:00-03:00`,
  timeZone: 'America/Sao_Paulo',
});

const own = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'confirmed',
  summary: `Evento ${id}`,
  start: timed(15, 10),
  end: timed(15, 11),
  organizer: { email: PERSON, self: true },
  ...extra,
});

async function deal(ownerId: string) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Candidato Exemplo',
      email: 'candidato@exemplo.com.br',
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
      stage: 'Diagnóstico',
    })
    .returning({ id: leads.id });
  return row!.id;
}

async function crmMeeting(
  leadId: string,
  ownerId: string,
  googleEventId: string,
  status = 'agendada',
) {
  await db.insert(crmMeetings).values({
    leadId,
    ownerEmployeeId: ownerId,
    title: 'Reunião',
    startsAt: new Date('2026-10-15T13:00:00Z'),
    endsAt: new Date('2026-10-15T14:00:00Z'),
    googleEventId,
    status,
  });
}

const byId = (answer: AgendaEventsAnswer, id: string) => answer.events.find((e) => e.id === id);

describe('Agenda: the overview', () => {
  it('says not_configured without the Google client, and the events answer 503', async () => {
    const bare = await makeApp({});
    try {
      const seller = await sessionFor(bare, 'vendedor_formatacao');
      const overview = await overviewOf(seller.cookies, bare);
      expect(overview).toMatchObject({
        state: 'not_configured',
        calendars: [],
        wings: 'not_configured',
        eventColorsSource: 'default',
      });
      const events = await bare.inject({
        method: 'GET',
        url: `/agenda/events?${RANGE}`,
        cookies: seller.cookies,
      });
      expect(events.statusCode).toBe(503);
      expect(events.json()).toMatchObject({ error: 'google_not_configured' });
    } finally {
      await bare.close();
    }
  });

  it('says not_connected to someone who never connected, and the events answer 409', async () => {
    const seller = await sessionFor(app, 'vendedor_expansao');
    expect((await overviewOf(seller.cookies)).state).toBe('not_connected');
    const events = await app.inject({
      method: 'GET',
      url: `/agenda/events?${RANGE}`,
      cookies: seller.cookies,
    });
    expect(events.statusCode).toBe(409);
    expect(events.json()).toEqual({
      error: 'google_not_connected',
      message: AGENDA_NOTICES.notConnected,
    });
  });

  it('lists both calendars for a writer of the Wings Company one, in today’s Google tones', async () => {
    const seller = await connected('vendedor_formatacao', {
      calendars: [
        {
          ...ME,
          summaryOverride: 'Minha agenda',
          backgroundColor: '#9fe1e7',
          foregroundColor: '#000000',
        },
        { ...WINGS_WRITER, id: WINGS.toUpperCase() },
      ],
      colors: GOOGLE_COLORS,
    });
    const overview = await overviewOf(seller.cookies);
    expect(overview).toEqual({
      state: 'ready',
      googleEmail: PERSON,
      calendars: [
        // calendarList's older tones, shown as the Google Agenda shows them today:
        // #9fe1e7 → Pavão, #16a765 → Manjericão.
        {
          key: 'mine',
          name: 'Minha agenda',
          backgroundColor: '#039be5',
          foregroundColor: '#1d1d1d',
          canWrite: true,
        },
        {
          key: 'wings',
          name: 'Wings Company',
          backgroundColor: '#0b8043',
          foregroundColor: '#ffffff',
          canWrite: true,
        },
      ],
      wings: 'writer',
      // colors.get's ids, in today's tones (Lavanda, Tomate), plus an id Google added that we
      // do not know, kept as Google sent it.
      eventColors: {
        '1': { background: '#7986cb', foreground: '#1d1d1d' },
        '11': { background: '#d50000', foreground: '#ffffff' },
        '12': { background: '#123456', foreground: '#ffffff' },
      },
      eventColorsSource: 'google',
    });
    // The browser never gets the Wings Company calendar's id.
    expect(JSON.stringify(overview)).not.toContain(WINGS);
    expect(seller.google.calls.some((c) => c.url.endsWith('/calendar/v3/colors'))).toBe(true);
  });

  it('lists the Wings Company calendar read-only for a reader, with the fixed palette when colors.get fails', async () => {
    const seller = await connected('vendedor_formatacao', { calendars: [ME, WINGS_READER] });
    const overview = await overviewOf(seller.cookies);
    expect(overview.wings).toBe('reader');
    expect(overview.calendars.map((c) => [c.key, c.canWrite])).toEqual([
      ['mine', true],
      ['wings', false],
    ]);
    expect(overview.eventColorsSource).toBe('default');
    expect(Object.keys(overview.eventColors)).toEqual(Object.keys(GOOGLE_EVENT_COLORS));
    expect(overview.eventColors['5']).toEqual({ background: '#f6bf26', foreground: '#1d1d1d' });
    // The calendar tone too: #16a765 → Manjericão.
    expect(overview.calendars[1]!.backgroundColor).toBe('#0b8043');
  });

  it('leaves the Wings Company calendar out when it is not shared', async () => {
    const seller = await connected('vendedor_formatacao', { calendars: [ME] });
    const overview = await overviewOf(seller.cookies);
    expect(overview.wings).toBe('not_shared');
    expect(overview.calendars.map((c) => c.key)).toEqual(['mine']);
  });

  it('lists Thais’ calendar once, as hers', async () => {
    const thais = await connected('diretoria', {
      email: WINGS,
      calendars: [
        {
          id: 'Agenda-Wings@wingscompany.com.br',
          summary: 'Thais',
          primary: true,
          accessRole: 'owner',
        },
      ],
    });
    const overview = await overviewOf(thais.cookies);
    expect(overview.wings).toBe('is_mine');
    expect(overview.calendars.map((c) => c.key)).toEqual(['mine']);
  });

  it('says not_configured for the Wings Company calendar while its id is unset', async () => {
    const noWings = await makeApp(GOOGLE_ENV);
    try {
      const seller = await connected('vendedor_formatacao', {}, noWings);
      const overview = await overviewOf(seller.cookies, noWings);
      expect(overview).toMatchObject({ state: 'ready', wings: 'not_configured' });
      expect(overview.calendars.map((c) => c.key)).toEqual(['mine']);
    } finally {
      await noWings.close();
    }
  });

  it('says needs_reconnect when Google refuses the token on the calendar list', async () => {
    const seller = await connected('vendedor_formatacao', { calendarListStatus: 401 });
    expect((await overviewOf(seller.cookies)).state).toBe('needs_reconnect');
  });
});

describe('Agenda: reading events', () => {
  it('reads both calendars in the range, maps them, and leaves cancelled and working-location events out', async () => {
    const seller = await connected('vendedor_formatacao');
    const { seed } = seller.google;
    seed('primary', own('timed', { htmlLink: 'https://calendar.google.com/event?eid=timed' }));
    seed('primary', {
      id: 'allday',
      status: 'confirmed',
      summary: 'Feriado',
      start: { date: '2026-10-15' },
      end: { date: '2026-10-16' },
      organizer: { email: PERSON, self: true },
    });
    seed('primary', own('html', { description: '<p>Pauta</p><ul><li>A &amp; B</li></ul>' }));
    seed(
      'primary',
      own('meet', {
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
        },
        attendees: [
          { email: PERSON, self: true, organizer: true, responseStatus: 'accepted' },
          { email: 'convidado@exemplo.com', responseStatus: 'declined' },
          { email: 'sala@resource.calendar.google.com', resource: true },
        ],
      }),
    );
    seed('primary', own('cancelled', { status: 'cancelled' }));
    seed('primary', own('office', { eventType: 'workingLocation' }));
    seed('primary', own('outside', { start: timed(25, 10), end: timed(25, 11) }));
    seed(WINGS, {
      id: 'wings1',
      status: 'confirmed',
      summary: 'Reunião geral',
      start: timed(14, 9),
      end: timed(14, 10),
      organizer: { email: WINGS },
    });

    const answer = await eventsOf(seller.cookies);
    expect(answer.failures).toEqual([]);
    expect(answer.truncated).toBe(false);
    expect(answer.events.map((e) => e.id)).toEqual(['wings1', 'allday', 'timed', 'html', 'meet']);
    expect(byId(answer, 'timed')).toMatchObject({
      calendar: 'mine',
      start: '2026-10-15T13:00:00.000Z',
      end: '2026-10-15T14:00:00.000Z',
      allDay: false,
      canEdit: true,
      crm: null,
      htmlLink: 'https://calendar.google.com/event?eid=timed',
    });
    expect(byId(answer, 'allday')).toMatchObject({
      allDay: true,
      start: '2026-10-15',
      end: '2026-10-16',
    });
    expect(byId(answer, 'html')!.description).toBe('Pauta\nA & B');
    expect(byId(answer, 'meet')).toMatchObject({
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: [
        { email: PERSON, response: 'aceitou', organizer: true, self: true, name: null },
        {
          email: 'convidado@exemplo.com',
          response: 'recusou',
          organizer: false,
          self: false,
          name: null,
        },
      ],
    });
    expect(byId(answer, 'wings1')).toMatchObject({ calendar: 'wings', canEdit: true });

    const lists = seller.google.calls.filter(
      (c) => c.method === 'GET' && c.url.includes('/events?'),
    );
    expect(lists.map((c) => new URL(c.url).pathname).sort()).toEqual(
      [
        '/calendar/v3/calendars/primary/events',
        `/calendar/v3/calendars/${encodeURIComponent(WINGS)}/events`,
      ].sort(),
    );
    const params = new URL(lists[0]!.url).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      timeMin: '2026-10-12T00:00:00-03:00',
      timeMax: '2026-10-19T00:00:00-03:00',
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      timeZone: 'America/Sao_Paulo',
      showDeleted: 'false',
    });
  });

  it('passes the search text and follows pages up to three, then says truncated', async () => {
    const seller = await connected('vendedor_formatacao', { calendars: [ME], pageSize: 2 });
    for (let i = 1; i <= 5; i += 1)
      seller.google.seed('primary', own(`p${i}`, { summary: `Plano ${i}` }));
    const five = await eventsOf(seller.cookies, '&q=plano');
    expect(five.events).toHaveLength(5);
    expect(five.truncated).toBe(false);
    const listCall = seller.google.calls.find((c) => c.url.includes('/events?'));
    expect(new URL(listCall!.url).searchParams.get('q')).toBe('plano');

    seller.google.seed('primary', own('p6'));
    seller.google.seed('primary', own('p7'));
    seller.google.calls.length = 0;
    const seven = await eventsOf(seller.cookies);
    expect(seven.events).toHaveLength(6);
    expect(seven.truncated).toBe(true);
    expect(seller.google.calls.filter((c) => c.url.includes('/events?'))).toHaveLength(3);
  });

  it('applies the edit rule to each event', async () => {
    const seller = await connected('vendedor_formatacao');
    const { seed } = seller.google;
    seed('primary', own('mine-self'));
    seed('primary', own('guest-copy', { organizer: { email: 'outra@exemplo.com' } }));
    seed(
      'primary',
      own('guests-modify', { organizer: { email: 'outra@exemplo.com' }, guestsCanModify: true }),
    );
    seed(WINGS, own('wings-own', { organizer: { email: WINGS } }));
    const answer = await eventsOf(seller.cookies);
    expect(Object.fromEntries(answer.events.map((e) => [e.id, e.canEdit]))).toEqual({
      'mine-self': true,
      'guest-copy': false,
      'guests-modify': true,
      'wings-own': true,
    });

    const reader = await connected('vendedor_formatacao', { calendars: [ME, WINGS_READER] });
    reader.google.seed(WINGS, own('wings-read', { organizer: { email: WINGS } }));
    const readOnly = await eventsOf(reader.cookies);
    expect(byId(readOnly, 'wings-read')).toMatchObject({ calendar: 'wings', canEdit: false });
  });

  it('answers the other calendar when one fails', async () => {
    const seller = await connected('vendedor_formatacao', { eventsStatusFor: { [WINGS]: 500 } });
    seller.google.seed('primary', own('still-here'));
    const answer = await eventsOf(seller.cookies);
    expect(answer.events.map((e) => e.id)).toEqual(['still-here']);
    expect(answer.failures).toEqual([
      { calendar: 'wings', code: 'google_rejected', message: expect.any(String) },
    ]);
  });

  it('refuses a range that ends before it starts (400)', async () => {
    const seller = await connected('vendedor_formatacao');
    const res = await app.inject({
      method: 'GET',
      url: '/agenda/events?from=2026-10-19T00:00:00-03:00&to=2026-10-12T00:00:00-03:00',
      cookies: seller.cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('Agenda: CRM meetings', () => {
  it('links a deal’s meeting for its owner and the Admin only, and never lets it move from here', async () => {
    const owner = await connected('vendedor_formatacao');
    const leadId = await deal(owner.id);
    await crmMeeting(leadId, owner.id, 'crm-evt');
    await crmMeeting(leadId, owner.id, 'serie-crm');
    await crmMeeting(leadId, owner.id, 'crm-old', 'cancelada');
    const seedAll = (google: ReturnType<typeof fakeGoogle>) => {
      google.seed('primary', own('crm-evt'));
      google.seed('primary', own('serie-crm_20261015T130000Z', { recurringEventId: 'serie-crm' }));
      google.seed('primary', own('crm-old'));
    };
    seedAll(owner.google);
    const mine = await eventsOf(owner.cookies);
    expect(byId(mine, 'crm-evt')).toMatchObject({ crm: { leadId }, canEdit: false });
    expect(byId(mine, 'serie-crm_20261015T130000Z')).toMatchObject({
      crm: { leadId },
      recurring: true,
    });
    expect(byId(mine, 'crm-old')).toMatchObject({ crm: null, canEdit: true });
    // Nothing of the lead beyond what Google itself shows.
    expect(JSON.stringify(mine)).not.toContain('Candidato');

    const admin = await connected('admin_master');
    seedAll(admin.google);
    expect(byId(await eventsOf(admin.cookies), 'crm-evt')!.crm).toEqual({ leadId });

    const other = await connected('vendedor_expansao');
    seedAll(other.google);
    expect(byId(await eventsOf(other.cookies), 'crm-evt')!.crm).toEqual({ leadId: null });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/agenda/events/mine/crm-evt',
      cookies: owner.cookies,
      payload: { title: 'Outro' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toEqual({
      error: 'crm_meeting',
      message: AGENDA_NOTICES.crmMeeting,
      leadId,
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/agenda/events/mine/crm-evt',
      cookies: other.cookies,
    });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: 'crm_meeting', leadId: null });
    expect(owner.google.calls.some((c) => c.method === 'PATCH' || c.method === 'DELETE')).toBe(
      false,
    );
    expect(other.google.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('Agenda: meetings with a pasted link', () => {
  /** A deal meeting with no Google event: starts 2026-10-15 12:00Z unless told otherwise. */
  async function pasted(
    leadId: string,
    scheduledBy: string,
    extra: Partial<typeof crmMeetings.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(crmMeetings)
      .values({
        leadId,
        ownerEmployeeId: scheduledBy,
        title: 'Diagnóstico colado',
        startsAt: new Date('2026-10-15T12:00:00Z'),
        endsAt: new Date('2026-10-15T13:00:00Z'),
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        status: 'agendada',
        ...extra,
      })
      .returning({ id: crmMeetings.id });
    return row!.id;
  }

  const listOf = async (cookies: Record<string, string>, query = RANGE) => {
    const res = await app.inject({ method: 'GET', url: `/agenda/crm-meetings?${query}`, cookies });
    expect(res.statusCode).toBe(200);
    return res.json<{ events: AgendaEvent[] }>().events;
  };

  it('lists a seller’s own meetings with no Google connection, and no one else’s', async () => {
    const seller = await sessionFor(app, 'vendedor_formatacao');
    const other = await sessionFor(app, 'vendedor_formatacao');
    expect((await overviewOf(seller.cookies)).state).toBe('not_connected');
    const mineLead = await deal(seller.id);
    const mine = await pasted(mineLead, seller.id);
    const otherLead = await deal(other.id);
    await pasted(otherLead, other.id);
    await pasted(mineLead, seller.id, { status: 'cancelada', title: 'Cancelada' });
    await pasted(mineLead, seller.id, { googleEventId: 'on-google', title: 'No Google' });
    await pasted(mineLead, seller.id, {
      title: 'Fora do período',
      startsAt: new Date('2026-10-25T12:00:00Z'),
      endsAt: new Date('2026-10-25T13:00:00Z'),
    });

    const events = await listOf(seller.cookies);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      calendar: 'mine',
      id: `crm-${mine}`,
      uid: `crm-${mine}`,
      title: 'Diagnóstico colado',
      allDay: false,
      start: '2026-10-15T12:00:00.000Z',
      end: '2026-10-15T13:00:00.000Z',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      canEdit: false,
      crm: { leadId: mineLead },
    });
    expect(await listOf(other.cookies)).toHaveLength(1);
  });

  it('keeps a meeting overlapping the range edge, and leaves out one that ends where it starts', async () => {
    const seller = await sessionFor(app, 'vendedor_formatacao');
    const leadId = await deal(seller.id);
    const crossing = await pasted(leadId, seller.id, {
      startsAt: new Date('2026-10-11T23:30:00Z'),
      endsAt: new Date('2026-10-12T03:30:00Z'),
    });
    await pasted(leadId, seller.id, {
      startsAt: new Date('2026-10-11T22:00:00Z'),
      endsAt: new Date('2026-10-12T03:00:00Z'),
    });
    expect((await listOf(seller.cookies)).map((e) => e.id)).toEqual([`crm-${crossing}`]);
  });

  it('shows who scheduled it a meeting whose deal moved on, without the link to the deal', async () => {
    const scheduler = await sessionFor(app, 'vendedor_formatacao');
    const newOwner = await sessionFor(app, 'vendedor_formatacao');
    const leadId = await deal(scheduler.id);
    await pasted(leadId, scheduler.id);
    await db.update(leads).set({ ownerEmployeeId: newOwner.id }).where(eq(leads.id, leadId));

    const before = await listOf(scheduler.cookies);
    expect(before).toHaveLength(1);
    expect(before[0]!.crm).toEqual({ leadId: null });
    expect(JSON.stringify(before)).not.toContain('Candidato');
    const after = await listOf(newOwner.cookies);
    expect(after).toHaveLength(1);
    expect(after[0]!.crm).toEqual({ leadId });
  });

  it('narrows by the search text on the title', async () => {
    const seller = await sessionFor(app, 'vendedor_formatacao');
    const leadId = await deal(seller.id);
    await pasted(leadId, seller.id, { title: 'Proposta final' });
    const diagnosis = await pasted(leadId, seller.id, { title: 'Diagnóstico inicial' });
    const found = await listOf(seller.cookies, `${RANGE}&q=DIAGN`);
    expect(found.map((e) => e.id)).toEqual([`crm-${diagnosis}`]);
  });

  it('refuses a range that ends before it starts, or a missing one (400)', async () => {
    const seller = await sessionFor(app, 'vendedor_formatacao');
    for (const query of [
      'from=2026-10-19T00:00:00-03:00&to=2026-10-12T00:00:00-03:00',
      'from=2026-10-12T00:00:00-03:00',
      '',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/agenda/crm-meetings?${query}`,
        cookies: seller.cookies,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('answers 401 without a login', async () => {
    const res = await app.inject({ method: 'GET', url: `/agenda/crm-meetings?${RANGE}` });
    expect(res.statusCode).toBe(401);
  });

  it('joins the Google events of a connected person, in time order, never editable', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed('primary', own('early', { start: timed(15, 8), end: timed(15, 9) }));
    seller.google.seed('primary', own('late', { start: timed(16, 10), end: timed(16, 11) }));
    const leadId = await deal(seller.id);
    // 15 Oct 09:00-10:00 in São Paulo: between the two Google events.
    const middle = await pasted(leadId, seller.id, {
      startsAt: new Date('2026-10-15T12:00:00Z'),
      endsAt: new Date('2026-10-15T13:00:00Z'),
    });
    const answer = await eventsOf(seller.cookies);
    expect(answer.events.map((e) => e.id)).toEqual(['early', `crm-${middle}`, 'late']);
    expect(byId(answer, `crm-${middle}`)).toMatchObject({
      calendar: 'mine',
      canEdit: false,
      crm: { leadId },
    });
  });
});

describe('Agenda: creating', () => {
  const base = {
    calendar: 'mine',
    title: 'Planejamento',
    allDay: false,
    start: '2026-10-15T09:00:00-03:00',
    end: '2026-10-15T10:00:00-03:00',
    location: null,
    description: null,
    attendees: [],
    createMeet: false,
    colorId: null,
  };

  it('creates a timed event with a Meet that was pending once, and audits it without its content', async () => {
    const seller = await connected('vendedor_formatacao', { meetPendingReads: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: { ...base, createMeet: true },
    });
    expect(res.statusCode).toBe(201);
    const event = res.json<{ event: AgendaEvent }>().event;
    expect(event).toMatchObject({
      calendar: 'mine',
      id: 'evt1',
      title: 'Planejamento',
      start: '2026-10-15T12:00:00.000Z',
      meetUrl: 'https://meet.google.com/evt1',
      canEdit: true,
      crm: null,
    });
    const insert = seller.google.calls.find(
      (c) => c.method === 'POST' && c.url.includes('/events'),
    );
    const query = new URL(insert!.url).searchParams;
    expect(new URL(insert!.url).pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(query.get('conferenceDataVersion')).toBe('1');
    expect(query.get('sendUpdates')).toBe('none');
    expect(insert!.body).toMatchObject({
      start: { dateTime: '2026-10-15T12:00:00.000Z', timeZone: 'America/Sao_Paulo' },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(
      seller.google.calls.filter((c) => c.method === 'GET' && c.url.includes('/events/evt1')),
    ).toHaveLength(1);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorEmployeeId, seller.id), eq(auditLog.entity, 'calendar_event')));
    expect(row).toMatchObject({
      action: 'calendar.event_created',
      entityId: 'evt1',
      metadata: { calendar: 'mine' },
    });
    expect(JSON.stringify(row!.metadata)).not.toContain('Planejamento');
  });

  it('creates an all-day event by date, inviting the guests', async () => {
    const seller = await connected('vendedor_formatacao');
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: {
        ...base,
        allDay: true,
        start: '2026-10-16',
        end: '2026-10-17',
        attendees: ['Convidado@Exemplo.com'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ event: AgendaEvent }>().event).toMatchObject({
      allDay: true,
      start: '2026-10-16',
      end: '2026-10-17',
    });
    const insert = seller.google.calls.find((c) => c.method === 'POST');
    expect(new URL(insert!.url).searchParams.get('sendUpdates')).toBe('all');
    expect(insert!.body).toMatchObject({
      start: { date: '2026-10-16' },
      end: { date: '2026-10-17' },
      attendees: [{ email: 'convidado@exemplo.com' }],
    });
  });

  it('writes on the Wings Company calendar for a writer and refuses a reader or someone it is not shared with', async () => {
    const writer = await connected('vendedor_formatacao');
    const ok = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: writer.cookies,
      payload: { ...base, calendar: 'wings' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ event: AgendaEvent }>().event).toMatchObject({
      calendar: 'wings',
      canEdit: true,
    });
    const insert = writer.google.calls.find((c) => c.method === 'POST');
    expect(new URL(insert!.url).pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(WINGS)}/events`,
    );

    const reader = await connected('vendedor_formatacao', { calendars: [ME, WINGS_READER] });
    const refused = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: reader.cookies,
      payload: { ...base, calendar: 'wings' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'wings_calendar_forbidden',
      message: AGENDA_NOTICES.wingsReadOnly,
    });
    expect(reader.google.calls.some((c) => c.method === 'POST')).toBe(false);

    const outsider = await connected('vendedor_formatacao', { calendars: [ME] });
    const notShared = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: outsider.cookies,
      payload: { ...base, calendar: 'wings' },
    });
    expect(notShared.statusCode).toBe(409);
    expect(notShared.json()).toMatchObject({ message: AGENDA_NOTICES.wingsNotShared });
  });

  it('removes the event and answers 502 meet_failed when the Meet never comes', async () => {
    const seller = await connected('vendedor_formatacao', { meetPendingReads: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: { ...base, createMeet: true },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'meet_failed' });
    expect(seller.google.events.get('evt1')!.deleted).toBe(true);
  });

  it('refuses an invalid body (400)', async () => {
    const seller = await connected('vendedor_formatacao');
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: { ...base, end: '2026-10-15T08:00:00-03:00' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'invalid_request',
      message: 'O fim vem depois do início.',
    });
  });
});

describe('Agenda: editing and deleting', () => {
  it('reschedules an event of the person', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed('primary', own('mov'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/agenda/events/mine/mov',
      cookies: seller.cookies,
      payload: {
        allDay: false,
        start: '2026-10-16T14:00:00-03:00',
        end: '2026-10-16T15:00:00-03:00',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ event: AgendaEvent }>().event).toMatchObject({
      id: 'mov',
      start: '2026-10-16T17:00:00.000Z',
      end: '2026-10-16T18:00:00.000Z',
    });
    const patch = seller.google.calls.find((c) => c.method === 'PATCH');
    expect(patch!.body).toEqual({
      start: { dateTime: '2026-10-16T17:00:00.000Z', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-10-16T18:00:00.000Z', timeZone: 'America/Sao_Paulo' },
    });
    expect(new URL(patch!.url).searchParams.get('sendUpdates')).toBe('none');
    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorEmployeeId, seller.id), eq(auditLog.action, 'calendar.event_updated')),
      );
    expect(row).toMatchObject({ entityId: 'mov', metadata: { calendar: 'mine' } });
  });

  it('turns a timed event into an all-day one, clearing dateTime', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed('primary', own('dia'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/agenda/events/mine/dia',
      cookies: seller.cookies,
      payload: { allDay: true, start: '2026-10-15', end: '2026-10-16' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ event: AgendaEvent }>().event).toMatchObject({
      allDay: true,
      start: '2026-10-15',
      end: '2026-10-16',
    });
    const patch = seller.google.calls.find((c) => c.method === 'PATCH');
    expect(patch!.body).toMatchObject({
      start: { date: '2026-10-15', dateTime: null, timeZone: null },
      end: { date: '2026-10-16', dateTime: null, timeZone: null },
    });
  });

  it('merges the guest list, keeping each remaining guest’s answer', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed(
      'primary',
      own('conv', {
        attendees: [
          { email: PERSON, self: true, organizer: true, responseStatus: 'accepted' },
          { email: 'fica@exemplo.com', responseStatus: 'accepted' },
          { email: 'sai@exemplo.com', responseStatus: 'declined' },
        ],
      }),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/agenda/events/mine/conv',
      cookies: seller.cookies,
      payload: { attendees: ['fica@exemplo.com', 'novo@exemplo.com'] },
    });
    expect(res.statusCode).toBe(200);
    const patch = seller.google.calls.find((c) => c.method === 'PATCH');
    expect(new URL(patch!.url).searchParams.get('sendUpdates')).toBe('all');
    expect((patch!.body as { attendees: unknown[] }).attendees).toEqual([
      { email: PERSON, self: true, organizer: true, responseStatus: 'accepted' },
      { email: 'fica@exemplo.com', responseStatus: 'accepted' },
      { email: 'novo@exemplo.com' },
    ]);
    expect(
      res.json<{ event: AgendaEvent }>().event.attendees.map((a) => [a.email, a.response]),
    ).toEqual([
      [PERSON, 'aceitou'],
      ['fica@exemplo.com', 'aceitou'],
      ['novo@exemplo.com', 'sem_resposta'],
    ]);
  });

  it('refuses an edit by a guest who does not organize the event (409)', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed('primary', own('alheio', { organizer: { email: 'outra@exemplo.com' } }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/agenda/events/mine/alheio',
      cookies: seller.cookies,
      payload: { title: 'Meu' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'event_not_editable',
      message: AGENDA_NOTICES.notEditable,
    });
    expect(seller.google.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('patches one occurrence of a recurring event by its own id', async () => {
    const seller = await connected('vendedor_formatacao');
    const occurrence = 'serie_20261015T130000Z';
    seller.google.seed('primary', own(occurrence, { recurringEventId: 'serie' }));
    const res = await app.inject({
      method: 'PATCH',
      url: `/agenda/events/mine/${occurrence}`,
      cookies: seller.cookies,
      payload: { title: 'Só esta' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ event: AgendaEvent }>().event).toMatchObject({
      title: 'Só esta',
      recurring: true,
    });
    const patch = seller.google.calls.find((c) => c.method === 'PATCH');
    expect(new URL(patch!.url).pathname).toBe(
      `/calendar/v3/calendars/primary/events/${occurrence}`,
    );
  });

  it('answers 404 for an unknown event, a cancelled one, or a calendar key it does not know', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed('primary', own('foi', { status: 'cancelled' }));
    for (const url of [
      '/agenda/events/mine/nada',
      '/agenda/events/mine/foi',
      '/agenda/events/outra/x',
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url,
        cookies: seller.cookies,
        payload: { title: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'event_not_found' });
    }
  });

  it('deletes an event, telling its guests', async () => {
    const seller = await connected('vendedor_formatacao');
    seller.google.seed(
      'primary',
      own('apagar', {
        attendees: [{ email: PERSON, self: true, organizer: true }, { email: 'g@exemplo.com' }],
      }),
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/agenda/events/mine/apagar',
      cookies: seller.cookies,
    });
    expect(res.statusCode).toBe(204);
    const del = seller.google.calls.find((c) => c.method === 'DELETE');
    expect(new URL(del!.url).pathname).toBe('/calendar/v3/calendars/primary/events/apagar');
    expect(new URL(del!.url).searchParams.get('sendUpdates')).toBe('all');
    expect(seller.google.events.get('apagar')!.deleted).toBe(true);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorEmployeeId, seller.id), eq(auditLog.action, 'calendar.event_deleted')),
      );
    expect(row).toMatchObject({ entityId: 'apagar', metadata: { calendar: 'mine' } });
  });

  it('keeps a reader of the Wings Company calendar from changing its events', async () => {
    const reader = await connected('vendedor_formatacao', { calendars: [ME, WINGS_READER] });
    reader.google.seed(WINGS, own('w', { organizer: { email: WINGS } }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/agenda/events/wings/w',
      cookies: reader.cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'wings_calendar_forbidden' });
  });
});

describe('Agenda: review fixes', () => {
  const base = {
    calendar: 'mine',
    title: 'Planejamento',
    allDay: false,
    start: '2026-10-15T09:00:00-03:00',
    end: '2026-10-15T10:00:00-03:00',
    location: null,
    description: null,
    attendees: [],
    createMeet: true,
    colorId: null,
  };

  /** The fake, with some calls made to fail as the network or Google would. */
  function failing(
    google: ReturnType<typeof fakeGoogle>,
    fails: (method: string, url: string) => Response | 'network' | null,
  ) {
    app.wings.googleFetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const outcome = fails(init?.method ?? 'GET', url);
      if (outcome === 'network') throw new TypeError('fetch failed');
      if (outcome) return outcome;
      return google.transport(input, init);
    };
  }

  it('names the Wings Company calendar so, though Google names it after Thais', async () => {
    const plain = await connected('vendedor_formatacao', {
      calendars: [ME, { ...WINGS_WRITER, summary: WINGS }],
    });
    expect((await overviewOf(plain.cookies)).calendars[1]!.name).toBe('Wings Company');
    const renamed = await connected('vendedor_formatacao', {
      calendars: [ME, { ...WINGS_WRITER, summary: WINGS, summaryOverride: 'Agenda da empresa' }],
    });
    expect((await overviewOf(renamed.cookies)).calendars[1]!.name).toBe('Agenda da empresa');
  });

  it('finds a Wings Company calendar the person hid on their Google list', async () => {
    const seller = await connected('vendedor_formatacao', {
      calendars: [ME, { ...WINGS_WRITER, hidden: true }],
    });
    expect((await overviewOf(seller.cookies)).wings).toBe('writer');
    const list = seller.google.calls.find((c) => c.url.includes('/users/me/calendarList'));
    expect(new URL(list!.url).searchParams.get('showHidden')).toBe('true');
  });

  it('reads a usage limit as a pause, not as a missing permission', async () => {
    const seller = await connected('vendedor_formatacao', {
      eventsStatusFor: { [WINGS]: 403 },
      refusalReason: 'rateLimitExceeded',
    });
    const answer = await eventsOf(seller.cookies);
    expect(answer.failures).toEqual([
      { calendar: 'wings', code: 'google_rate_limited', message: expect.any(String) },
    ]);
    const write = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: { ...base, calendar: 'wings', createMeet: false },
    });
    expect(write.statusCode).toBe(502);
    expect(write.json()).toMatchObject({ error: 'google_rate_limited' });
    // A real refusal is still one.
    const refused = await connected('vendedor_formatacao', {
      eventsStatusFor: { [WINGS]: 403 },
      refusalReason: 'forbidden',
    });
    expect((await eventsOf(refused.cookies)).failures[0]!.code).toBe('wings_calendar_forbidden');
  });

  it('removes the event when the Meet re-read fails, and says meet_failed only once it is gone', async () => {
    const seller = await connected('vendedor_formatacao', { meetPendingReads: 1 });
    failing(seller.google, (method, url) =>
      method === 'GET' && url.includes('/events/evt1') ? 'network' : null,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: base,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'meet_failed' });
    expect(seller.google.events.get('evt1')!.deleted).toBe(true);
  });

  it('never says "not created" when the cleanup failed too: it points to the event on Google', async () => {
    const seller = await connected('vendedor_formatacao', { meetPendingReads: 1 });
    failing(seller.google, (method, url) =>
      url.includes('/events/evt1') && (method === 'GET' || method === 'DELETE')
        ? new Response('{}', { status: 500 })
        : null,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: base,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'meet_failed_event_kept',
      htmlLink: 'https://calendar.google.com/event?eid=evt1',
    });
    expect(seller.google.events.get('evt1')!.deleted).toBe(false);
  });

  it('asks to check Google before a retry when the create answer was lost', async () => {
    const seller = await connected('vendedor_formatacao');
    failing(seller.google, (method, url) =>
      method === 'POST' && url.includes('/events') ? 'network' : null,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/agenda/events',
      cookies: seller.cookies,
      payload: { ...base, createMeet: false },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string; message: string }>().message).toContain('confira no Google');
  });

  it('shows only a real Meet address as the Meet', async () => {
    const seller = await connected('vendedor_formatacao');
    const video = (uri: string) => ({
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri }] },
    });
    seller.google.seed('primary', own('zoom', video('https://zoom.us/j/123')));
    seller.google.seed('primary', own('plain-http', video('http://meet.google.com/abc-defg-hij')));
    seller.google.seed('primary', own('scheme', video('ms-settings:privacy')));
    seller.google.seed('primary', own('meet', video('https://meet.google.com/abc-defg-hij')));
    seller.google.seed(
      'primary',
      own('hangout', { hangoutLink: 'https://meet.google.com/xyz-abcd-efg' }),
    );
    const answer = await eventsOf(seller.cookies);
    expect(byId(answer, 'zoom')!.meetUrl).toBeNull();
    expect(byId(answer, 'plain-http')!.meetUrl).toBeNull();
    expect(byId(answer, 'scheme')!.meetUrl).toBeNull();
    expect(byId(answer, 'meet')!.meetUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(byId(answer, 'hangout')!.meetUrl).toBe('https://meet.google.com/xyz-abcd-efg');
  });

  it('says whether a change reaches the guests: only on the organizer’s copy with guests', async () => {
    const seller = await connected('vendedor_formatacao');
    const guest = { email: 'convidado@exemplo.com', responseStatus: 'accepted' };
    const me = { email: PERSON, self: true, responseStatus: 'accepted' };
    seller.google.seed('primary', own('with-guests', { attendees: [guest] }));
    seller.google.seed('primary', own('alone', { attendees: [{ ...me, organizer: true }] }));
    seller.google.seed(
      'primary',
      own('guest-copy', {
        organizer: { email: 'organiza@exemplo.com' },
        guestsCanModify: true,
        attendees: [guest, me],
      }),
    );
    seller.google.seed(WINGS, {
      ...own('wings-own', { attendees: [guest] }),
      organizer: { email: WINGS },
    });
    const answer = await eventsOf(seller.cookies);
    expect(byId(answer, 'with-guests')!.guestsNotified).toBe(true);
    expect(byId(answer, 'alone')!.guestsNotified).toBe(false);
    expect(byId(answer, 'guest-copy')!.guestsNotified).toBe(false);
    expect(byId(answer, 'guest-copy')!.canEdit).toBe(true);
    expect(byId(answer, 'wings-own')!.guestsNotified).toBe(true);
  });
});

describe('Agenda: who opens it', () => {
  it('opens to a seller and to the Admin alike', async () => {
    for (const role of ['vendedor_expansao', 'admin_master'] as const) {
      const session = await sessionFor(app, role);
      const res = await app.inject({ method: 'GET', url: '/agenda', cookies: session.cookies });
      expect(res.statusCode).toBe(200);
    }
  });
});
