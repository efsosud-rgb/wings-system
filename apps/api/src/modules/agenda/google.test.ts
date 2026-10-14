import { describe, expect, it } from 'vitest';
import {
  canEditEvent,
  descriptionToText,
  insertRequestOf,
  isShownEvent,
  mergeAttendees,
  patchRequestOf,
  sendUpdatesOf,
  toAgendaEvent,
  type RawEvent,
} from './google.js';

const MINE = { accessRole: 'owner', calendarId: 'pessoa@wingscompany.com.br' };
const WINGS = { accessRole: 'writer', calendarId: 'agenda-wings@wingscompany.com.br' };

const timedEvent = (extra: Partial<RawEvent> = {}): RawEvent => ({
  id: 'e1',
  status: 'confirmed',
  summary: 'Revisão do projeto',
  start: { dateTime: '2026-10-14T10:00:00-03:00', timeZone: 'America/Sao_Paulo' },
  end: { dateTime: '2026-10-14T11:00:00-03:00', timeZone: 'America/Sao_Paulo' },
  organizer: { email: 'pessoa@wingscompany.com.br', self: true },
  ...extra,
});

describe('descriptionToText', () => {
  it('reduces Google HTML to plain text', () => {
    expect(
      descriptionToText(
        '<p>Pauta:</p><ul><li>Item &amp; outro</li><li>&lt;b&gt; &quot;x&quot; &#39;y&#39;</li></ul><br><br><br><br>Fim&nbsp;&#8212;&#x41;',
      ),
    ).toBe('Pauta:\nItem & outro\n<b> "x" \'y\'\n\nFim —A');
  });

  it('answers null for empty or missing text', () => {
    expect(descriptionToText('<p> </p>')).toBeNull();
    expect(descriptionToText(undefined)).toBeNull();
    expect(descriptionToText('linha 1\nlinha 2')).toBe('linha 1\nlinha 2');
  });
});

describe('toAgendaEvent', () => {
  it('maps a timed event with its Meet, guests and colour', () => {
    const event = toAgendaEvent(
      timedEvent({
        iCalUID: 'uid-1@google.com',
        location: 'Sala 2',
        colorId: '5',
        htmlLink: 'https://calendar.google.com/event?eid=e1',
        hangoutLink: 'https://meet.google.com/fallback',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+55-11-0000' },
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
          ],
        },
        attendees: [
          {
            email: 'Pessoa@wingscompany.com.br',
            self: true,
            organizer: true,
            responseStatus: 'accepted',
          },
          { email: 'convidado@exemplo.com', displayName: 'Convidado', responseStatus: 'declined' },
          { email: 'outro@exemplo.com', responseStatus: 'tentative' },
          { email: 'novo@exemplo.com' },
          {
            email: 'sala@resource.calendar.google.com',
            resource: true,
            responseStatus: 'accepted',
          },
        ],
      }),
      'mine',
      MINE,
    );
    expect(event).toMatchObject({
      calendar: 'mine',
      id: 'e1',
      uid: 'uid-1@google.com',
      title: 'Revisão do projeto',
      allDay: false,
      start: '2026-10-14T13:00:00.000Z',
      end: '2026-10-14T14:00:00.000Z',
      location: 'Sala 2',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      colorId: '5',
      tentative: false,
      recurring: false,
      canEdit: true,
      crm: null,
      organizer: { email: 'pessoa@wingscompany.com.br', name: null, self: true },
    });
    expect(event.attendees).toEqual([
      {
        email: 'pessoa@wingscompany.com.br',
        name: null,
        response: 'aceitou',
        organizer: true,
        self: true,
      },
      {
        email: 'convidado@exemplo.com',
        name: 'Convidado',
        response: 'recusou',
        organizer: false,
        self: false,
      },
      { email: 'outro@exemplo.com', name: null, response: 'talvez', organizer: false, self: false },
      {
        email: 'novo@exemplo.com',
        name: null,
        response: 'sem_resposta',
        organizer: false,
        self: false,
      },
    ]);
  });

  it('maps an all-day event by its dates (end exclusive) and falls back to hangoutLink', () => {
    const event = toAgendaEvent(
      {
        id: 'd1',
        status: 'tentative',
        start: { date: '2026-10-14' },
        end: { date: '2026-10-15' },
        hangoutLink: 'https://meet.google.com/xyz',
        recurringEventId: 'serie',
      },
      'wings',
      WINGS,
    );
    expect(event).toMatchObject({
      allDay: true,
      start: '2026-10-14',
      end: '2026-10-15',
      title: '',
      uid: 'd1',
      meetUrl: 'https://meet.google.com/xyz',
      tentative: true,
      recurring: true,
      organizer: null,
      description: null,
      location: null,
      canEdit: false,
    });
  });

  it('leaves cancelled events and working locations out', () => {
    expect(isShownEvent(timedEvent())).toBe(true);
    expect(isShownEvent(timedEvent({ status: 'cancelled' }))).toBe(false);
    expect(isShownEvent(timedEvent({ eventType: 'workingLocation' }))).toBe(false);
  });
});

describe('canEditEvent', () => {
  it('lets the organizer edit', () => {
    expect(canEditEvent(timedEvent(), MINE)).toBe(true);
  });

  it('lets a writer edit what the calendar itself organizes', () => {
    const raw = timedEvent({ organizer: { email: 'AGENDA-WINGS@wingscompany.com.br' } });
    expect(canEditEvent(raw, WINGS)).toBe(true);
  });

  it('lets a guest edit when Google allows guests to modify', () => {
    const raw = timedEvent({ organizer: { email: 'outra@exemplo.com' }, guestsCanModify: true });
    expect(canEditEvent(raw, MINE)).toBe(true);
  });

  it('keeps a guest copy read-only', () => {
    const raw = timedEvent({ organizer: { email: 'outra@exemplo.com', self: false } });
    expect(canEditEvent(raw, MINE)).toBe(false);
  });

  it('keeps everything read-only on a calendar shared for reading', () => {
    expect(canEditEvent(timedEvent(), { ...WINGS, accessRole: 'reader' })).toBe(false);
  });

  it('keeps birthdays and Gmail events read-only, out-of-office editable', () => {
    expect(canEditEvent(timedEvent({ eventType: 'birthday' }), MINE)).toBe(false);
    expect(canEditEvent(timedEvent({ eventType: 'fromGmail' }), MINE)).toBe(false);
    expect(canEditEvent(timedEvent({ eventType: 'outOfOffice' }), MINE)).toBe(true);
  });
});

describe('insertRequestOf', () => {
  const base = {
    calendar: 'mine' as const,
    title: 'Planejamento',
    allDay: false,
    start: '2026-10-15T09:00:00-03:00',
    end: '2026-10-15T10:00:00-03:00',
    location: null,
    description: null,
    attendees: [] as string[],
    createMeet: false,
    colorId: null,
  };

  it('sends a timed event in São Paulo, without invitations when nobody is invited', () => {
    const request = insertRequestOf(base);
    expect(request.query).toEqual({ sendUpdates: 'none' });
    expect(request.body).toEqual({
      summary: 'Planejamento',
      start: { dateTime: '2026-10-15T12:00:00.000Z', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-10-15T13:00:00.000Z', timeZone: 'America/Sao_Paulo' },
      attendees: [],
    });
  });

  it('asks for a Meet and invites the guests', () => {
    const request = insertRequestOf({
      ...base,
      allDay: true,
      start: '2026-10-15',
      end: '2026-10-16',
      attendees: ['convidado@exemplo.com'],
      createMeet: true,
      colorId: '7',
      location: 'Escritório',
      description: 'Pauta',
    });
    expect(request.query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'all' });
    expect(request.body).toMatchObject({
      start: { date: '2026-10-15' },
      end: { date: '2026-10-16' },
      attendees: [{ email: 'convidado@exemplo.com' }],
      colorId: '7',
      location: 'Escritório',
      description: 'Pauta',
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
  });
});

describe('mergeAttendees', () => {
  it('keeps the organizer, the person, rooms and the answers of guests still listed', () => {
    const existing = [
      {
        email: 'pessoa@wingscompany.com.br',
        self: true,
        organizer: true,
        responseStatus: 'accepted',
      },
      { email: 'fica@exemplo.com', responseStatus: 'accepted', displayName: 'Fica' },
      { email: 'sai@exemplo.com', responseStatus: 'declined' },
      { email: 'sala@resource.calendar.google.com', resource: true },
    ];
    expect(mergeAttendees(existing, ['FICA@exemplo.com', 'novo@exemplo.com'])).toEqual([
      existing[0],
      existing[1],
      existing[3],
      { email: 'novo@exemplo.com' },
    ]);
  });
});

describe('patchRequestOf', () => {
  it('sends only the fields given, and nothing to guests when there are none', () => {
    const request = patchRequestOf(timedEvent(), { title: 'Novo título' });
    expect(request).toEqual({ body: { summary: 'Novo título' }, query: { sendUpdates: 'none' } });
  });

  it('clears dateTime when a timed event becomes all-day, and date the other way round', () => {
    const toAllDay = patchRequestOf(timedEvent(), {
      allDay: true,
      start: '2026-10-14',
      end: '2026-10-15',
    });
    expect(toAllDay.body).toEqual({
      start: { date: '2026-10-14', dateTime: null, timeZone: null },
      end: { date: '2026-10-15', dateTime: null, timeZone: null },
    });
    const toTimed = patchRequestOf(
      { id: 'd', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } },
      { allDay: false, start: '2026-10-14T09:00:00-03:00', end: '2026-10-14T10:00:00-03:00' },
    );
    expect(toTimed.body.start).toEqual({
      dateTime: '2026-10-14T12:00:00.000Z',
      timeZone: 'America/Sao_Paulo',
      date: null,
    });
    const moved = patchRequestOf(timedEvent(), {
      allDay: false,
      start: '2026-10-16T09:00:00-03:00',
      end: '2026-10-16T10:00:00-03:00',
    });
    expect(moved.body.start).toEqual({
      dateTime: '2026-10-16T12:00:00.000Z',
      timeZone: 'America/Sao_Paulo',
    });
  });

  it('clears location, description and colour on null, and adds a Meet only when missing', () => {
    const request = patchRequestOf(timedEvent(), {
      location: null,
      description: null,
      colorId: null,
      createMeet: true,
    });
    expect(request.body).toMatchObject({ location: '', description: '', colorId: null });
    expect(request.body.conferenceData).toBeDefined();
    expect(request.query.conferenceDataVersion).toBe('1');
    const withMeet = patchRequestOf(
      timedEvent({ conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'x' }] } }),
      { createMeet: true },
    );
    expect(withMeet.body.conferenceData).toBeUndefined();
    expect(withMeet.query.conferenceDataVersion).toBeUndefined();
  });

  it('tells guests when the event has or will have any', () => {
    const withGuest = timedEvent({
      attendees: [{ email: 'pessoa@wingscompany.com.br', self: true }, { email: 'g@exemplo.com' }],
    });
    expect(patchRequestOf(withGuest, { title: 'x' }).query.sendUpdates).toBe('all');
    expect(patchRequestOf(withGuest, { attendees: [] }).query.sendUpdates).toBe('all');
    expect(patchRequestOf(timedEvent(), { attendees: ['g@exemplo.com'] }).query.sendUpdates).toBe(
      'all',
    );
    expect(sendUpdatesOf([{ email: 'pessoa@wingscompany.com.br', self: true }])).toBe('none');
    expect(sendUpdatesOf(withGuest.attendees ?? [])).toBe('all');
  });
});
