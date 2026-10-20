import { describe, expect, it } from 'vitest';
import {
  addDays,
  agendaEventInputSchema,
  currentCalendarColor,
  GOOGLE_CALENDAR_COLORS,
  GOOGLE_EVENT_COLORS,
  agendaEventPatchSchema,
  agendaEventsQuerySchema,
  dateOnlyOf,
  GOOGLE_EVENT_COLOR_IDS,
  instantOf,
  isDateOnly,
  readableTextOn,
  wallClockOf,
  weekdayOf,
} from './calendar.js';
import { canSeeSubmodule, NAVIGATION } from './navigation.js';
import { ROLE_PERMISSIONS } from './rbac/permissions.js';
import { CRM_ONLY_ROLES, ROLE_KEYS } from './rbac/roles.js';

const base = {
  calendar: 'mine' as const,
  title: 'Alinhamento',
  allDay: false,
  start: '2026-10-14T12:00:00.000Z',
  end: '2026-10-14T13:00:00.000Z',
  location: null,
  description: null,
  attendees: [],
  createMeet: false,
  colorId: null,
};

describe('São Paulo wall clock', () => {
  it('reads an instant as the clock in São Paulo, whatever the machine zone', () => {
    expect(wallClockOf('2026-10-14T12:00:00Z')).toMatchObject({
      year: 2026,
      month: 10,
      day: 14,
      hour: 9,
      minute: 0,
      weekday: 3,
    });
    // 01:30 UTC is still the evening before in São Paulo.
    expect(wallClockOf('2026-10-15T01:30:00Z')).toMatchObject({ day: 14, hour: 22, minute: 30 });
  });

  it('turns a São Paulo wall-clock time back into the instant', () => {
    expect(instantOf({ year: 2026, month: 10, day: 14, hour: 9 }).toISOString()).toBe(
      '2026-10-14T12:00:00.000Z',
    );
    expect(instantOf({ year: 2026, month: 12, day: 31, hour: 23, minute: 30 }).toISOString()).toBe(
      '2027-01-01T02:30:00.000Z',
    );
  });

  it('round-trips through a zone with daylight saving', () => {
    const wall = { year: 2026, month: 3, day: 29, hour: 12, minute: 15 };
    const instant = instantOf(wall, 'Europe/Lisbon');
    expect(wallClockOf(instant, 'Europe/Lisbon')).toMatchObject(wall);
  });
});

describe('day arithmetic', () => {
  it('moves across months and years and knows the weekday', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(weekdayOf('2026-10-18')).toBe(0);
    expect(dateOnlyOf({ year: 2026, month: 2, day: 3 })).toBe('2026-02-03');
  });

  it('accepts only real days', () => {
    expect(isDateOnly('2026-02-28')).toBe(true);
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-2-3')).toBe(false);
  });
});

describe('event input', () => {
  it('accepts a timed event and normalises guests', () => {
    const parsed = agendaEventInputSchema.parse({
      ...base,
      attendees: [' Ana@Exemplo.com ', 'ana@exemplo.com', 'bia@exemplo.com'],
    });
    expect(parsed.attendees).toEqual(['ana@exemplo.com', 'bia@exemplo.com']);
  });

  it('accepts an all-day event with an exclusive end', () => {
    expect(
      agendaEventInputSchema.safeParse({
        ...base,
        allDay: true,
        start: '2026-10-14',
        end: '2026-10-15',
      }).success,
    ).toBe(true);
  });

  it('refuses an end before the start, mixed formats and unknown colours', () => {
    expect(
      agendaEventInputSchema.safeParse({ ...base, end: '2026-10-14T11:00:00.000Z' }).success,
    ).toBe(false);
    expect(agendaEventInputSchema.safeParse({ ...base, allDay: true }).success).toBe(false);
    expect(
      agendaEventInputSchema.safeParse({
        ...base,
        allDay: true,
        start: '2026-10-14',
        end: '2026-10-14',
      }).success,
    ).toBe(false);
    expect(agendaEventInputSchema.safeParse({ ...base, colorId: '12' }).success).toBe(false);
    expect(agendaEventInputSchema.safeParse({ ...base, colorId: '11' }).success).toBe(true);
    expect(agendaEventInputSchema.safeParse({ ...base, calendar: 'outra' }).success).toBe(false);
    expect(agendaEventInputSchema.safeParse({ ...base, attendees: ['não-é-email'] }).success).toBe(
      false,
    );
  });

  it('takes an edit of any field but the calendar, with the times together', () => {
    expect(agendaEventPatchSchema.safeParse({ title: 'Novo título' }).success).toBe(true);
    expect(agendaEventPatchSchema.safeParse({ start: base.start }).success).toBe(false);
    expect(
      agendaEventPatchSchema.safeParse({ allDay: false, start: base.start, end: base.end }).success,
    ).toBe(true);
    expect(agendaEventPatchSchema.safeParse({ calendar: 'wings' }).success).toBe(false);
    expect(agendaEventPatchSchema.safeParse({}).success).toBe(false);
  });

  it('knows the eleven Google colours', () => {
    expect(GOOGLE_EVENT_COLOR_IDS).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
    ]);
  });
});

describe('colours as the Google Agenda shows them today', () => {
  it('maps every older calendar tone to a current one, and keeps a hand-picked colour', () => {
    expect(Object.keys(GOOGLE_CALENDAR_COLORS)).toHaveLength(24);
    expect(currentCalendarColor('#9FE1E7')).toEqual({
      background: '#039be5',
      foreground: '#1d1d1d',
    });
    expect(currentCalendarColor('#16a765')).toEqual({
      background: '#0b8043',
      foreground: '#ffffff',
    });
    expect(currentCalendarColor('#123456')).toEqual({
      background: '#123456',
      foreground: '#ffffff',
    });
  });

  it('writes on each tone in the colour that reads better', () => {
    for (const color of Object.values(GOOGLE_EVENT_COLORS)) {
      expect(readableTextOn(color.background), color.name).toBe(color.foreground);
    }
    expect(readableTextOn('#ffffff')).toBe('#1d1d1d');
    expect(readableTextOn('#000000')).toBe('#ffffff');
    expect(readableTextOn('não é cor')).toBe('#1d1d1d');
  });
});

describe('events range', () => {
  it('needs an end after the start and at most about a year and a half', () => {
    expect(
      agendaEventsQuerySchema.safeParse({
        from: '2026-10-11T03:00:00.000Z',
        to: '2026-10-18T03:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      agendaEventsQuerySchema.safeParse({
        from: '2026-10-18T03:00:00.000Z',
        to: '2026-10-11T03:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      agendaEventsQuerySchema.safeParse({
        from: '2026-01-01T03:00:00.000Z',
        to: '2028-01-01T03:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('who opens the Agenda', () => {
  it('is every level, through its own Google connection', () => {
    for (const role of ROLE_KEYS) expect(ROLE_PERMISSIONS[role]['calendar.use']).toBe('own');
  });

  it('sits in Produtividade for everyone, the sellers included', () => {
    const entries = NAVIGATION.flatMap((m) => m.submodules).filter((s) =>
      s.path.endsWith('/agenda'),
    );
    expect(entries.map((s) => s.path)).toEqual(['/produtividade/agenda']);
    for (const role of ROLE_KEYS) {
      const viewer = { role, permissions: ROLE_PERMISSIONS[role] };
      const seen = entries.filter((s) => canSeeSubmodule(viewer, s)).map((s) => s.path);
      expect(seen, role).toEqual(['/produtividade/agenda']);
    }
  });

  it('is written by every level but the sellers (calendar.write)', () => {
    for (const role of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role]['calendar.write'], role).toBe(
        CRM_ONLY_ROLES.includes(role) ? undefined : 'own',
      );
    }
    expect(CRM_ONLY_ROLES).toEqual(['vendedor_expansao', 'vendedor_formatacao']);
  });
});
