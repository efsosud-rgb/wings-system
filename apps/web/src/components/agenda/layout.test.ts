import type { AgendaEvent } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { linkify, whenOf } from './format.js';
import {
  colorsOf,
  daySegments,
  eventsOfDay,
  exclusiveEndOf,
  inAllDayLane,
  laneBars,
  lastDayOf,
  packOverlaps,
  visibleEvents,
} from './layout.js';

const event = (over: Partial<AgendaEvent> = {}): AgendaEvent => ({
  calendar: 'mine',
  id: 'e1',
  uid: 'e1@google.com',
  title: 'Reunião de teste',
  allDay: false,
  start: '2026-10-14T12:00:00.000Z',
  end: '2026-10-14T13:00:00.000Z',
  location: null,
  description: null,
  meetUrl: null,
  htmlLink: null,
  colorId: null,
  tentative: false,
  organizer: null,
  attendees: [],
  recurring: false,
  canEdit: true,
  guestsNotified: false,
  crm: null,
  ...over,
});

describe('packOverlaps: overlapping events side by side', () => {
  it('gives events that do not overlap the whole width', () => {
    const placed = packOverlaps([
      { key: 'a', start: 540, end: 600 },
      { key: 'b', start: 600, end: 660 },
    ]);
    expect(placed.get('a')).toEqual({ column: 0, columns: 1 });
    expect(placed.get('b')).toEqual({ column: 0, columns: 1 });
  });

  it('splits a cluster into columns, greedily, and every member shares its width', () => {
    // a 09-11, b 09:30-10, c 10-10:30 (fits under b), d 12-13 alone.
    const placed = packOverlaps([
      { key: 'a', start: 540, end: 660 },
      { key: 'b', start: 570, end: 600 },
      { key: 'c', start: 600, end: 630 },
      { key: 'd', start: 720, end: 780 },
    ]);
    expect(placed.get('a')).toEqual({ column: 0, columns: 2 });
    expect(placed.get('b')).toEqual({ column: 1, columns: 2 });
    expect(placed.get('c')).toEqual({ column: 1, columns: 2 });
    expect(placed.get('d')).toEqual({ column: 0, columns: 1 });
  });

  it('chains overlaps into one cluster and opens a third column when needed', () => {
    const placed = packOverlaps([
      { key: 'a', start: 0, end: 120 },
      { key: 'b', start: 30, end: 90 },
      { key: 'c', start: 60, end: 150 },
    ]);
    expect([...placed.values()].map((place) => place.columns)).toEqual([3, 3, 3]);
    expect(placed.get('c')?.column).toBe(2);
  });

  it('packs short events by the room they take on screen', () => {
    const placed = packOverlaps(
      [
        { key: 'a', start: 540, end: 545 },
        { key: 'b', start: 545, end: 600 },
      ],
      20,
    );
    expect(placed.get('a')?.columns).toBe(2);
  });
});

describe('daySegments: an event crossing midnight is drawn on each day', () => {
  it('cuts 22:00–01:00 into 22:00–24:00 and 00:00–01:00 (São Paulo)', () => {
    const late = event({ start: '2026-10-15T01:00:00.000Z', end: '2026-10-15T04:00:00.000Z' });
    const segments = daySegments([late], ['2026-10-14', '2026-10-15']);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      day: '2026-10-14',
      startMinute: 22 * 60,
      endMinute: 24 * 60,
      toAfter: true,
    });
    expect(segments[1]).toMatchObject({
      day: '2026-10-15',
      startMinute: 0,
      endMinute: 60,
      fromBefore: true,
    });
  });

  it('leaves all-day events and those of a day or more to the lane', () => {
    const allDay = event({ allDay: true, start: '2026-10-14', end: '2026-10-15' });
    const long = event({ start: '2026-10-14T12:00:00.000Z', end: '2026-10-15T12:00:00.000Z' });
    expect(inAllDayLane(allDay)).toBe(true);
    expect(inAllDayLane(long)).toBe(true);
    expect(daySegments([allDay, long], ['2026-10-14', '2026-10-15'])).toEqual([]);
  });
});

describe('all-day events: Google’s exclusive end', () => {
  it('converts the inclusive last day to the exclusive end and back', () => {
    expect(exclusiveEndOf('2026-10-14')).toBe('2026-10-15');
    expect(lastDayOf('2026-10-15')).toBe('2026-10-14');
    expect(exclusiveEndOf('2026-12-31')).toBe('2027-01-01');
  });

  it('puts a three-day event on three days of the lane, clipped to the week', () => {
    const trip = event({ allDay: true, start: '2026-10-16', end: '2026-10-19' });
    const week = [
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
    ];
    const { bars, rows } = laneBars([trip], week);
    expect(rows).toBe(1);
    expect(bars[0]).toMatchObject({ start: 5, span: 2, row: 0, toAfter: true, fromBefore: false });
    expect(eventsOfDay([trip], '2026-10-18')).toHaveLength(1);
    expect(eventsOfDay([trip], '2026-10-19')).toHaveLength(0);
    expect(whenOf(trip)).toBe('16 – 18 de outubro');
  });

  it('stacks overlapping bars on separate rows', () => {
    const a = event({ id: 'a', allDay: true, start: '2026-10-12', end: '2026-10-15' });
    const b = event({ id: 'b', allDay: true, start: '2026-10-14', end: '2026-10-16' });
    const c = event({ id: 'c', allDay: true, start: '2026-10-16', end: '2026-10-17' });
    const week = [
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
    ];
    const { bars, rows } = laneBars([a, b, c], week);
    expect(rows).toBe(2);
    expect(bars.find((bar) => bar.event.id === 'b')?.row).toBe(1);
    expect(bars.find((bar) => bar.event.id === 'c')?.row).toBe(0);
  });
});

describe('visibleEvents: each event once, from the visible calendars', () => {
  const mineCopy = event({ calendar: 'mine', id: 'm1', uid: 'same@google.com', canEdit: false });
  const wingsCopy = event({ calendar: 'wings', id: 'w1', uid: 'same@google.com', canEdit: true });

  it('keeps the copy the person can edit, then the one on their own calendar', () => {
    expect(visibleEvents([mineCopy, wingsCopy], new Set(['mine', 'wings']))).toEqual([wingsCopy]);
    const bothReadOnly = { ...wingsCopy, canEdit: false };
    expect(visibleEvents([bothReadOnly, mineCopy], new Set(['mine', 'wings']))).toEqual([mineCopy]);
  });

  it('shows the other copy when one calendar is hidden', () => {
    expect(visibleEvents([mineCopy, wingsCopy], new Set(['mine']))).toEqual([mineCopy]);
  });

  it('keeps occurrences with the same uid but another start', () => {
    const next = {
      ...mineCopy,
      id: 'm2',
      start: '2026-10-21T12:00:00.000Z',
      end: '2026-10-21T13:00:00.000Z',
    };
    expect(visibleEvents([mineCopy, next], new Set(['mine']))).toHaveLength(2);
  });
});

describe('format', () => {
  it('colours an event by its own colour, else by its calendar', () => {
    const overview = {
      eventColors: { '11': { background: '#dc2127', foreground: '#1d1d1d' } },
      calendars: [
        {
          key: 'mine' as const,
          name: 'Teste',
          backgroundColor: '#039be5',
          foregroundColor: '#ffffff',
          canWrite: true,
        },
      ],
    };
    expect(colorsOf(event({ colorId: '11' }), overview)?.background).toBe('#dc2127');
    expect(colorsOf(event(), overview)?.background).toBe('#039be5');
  });

  it('turns http(s) addresses into links and leaves the rest as text', () => {
    expect(linkify('Pauta: https://exemplo.com/a. Fim')).toEqual([
      { text: 'Pauta: ' },
      { text: 'https://exemplo.com/a', href: 'https://exemplo.com/a' },
      { text: '.' },
      { text: ' Fim' },
    ]);
    expect(linkify('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
  });

  it('writes when a timed event happens', () => {
    expect(whenOf(event())).toBe('quarta-feira, 14 de outubro · 09:00 – 10:00');
  });
});
