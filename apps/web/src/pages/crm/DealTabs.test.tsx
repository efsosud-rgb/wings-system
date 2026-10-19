import type { Lead, LeadEvent } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedLead } from '../../api/leads.js';
import { entriesOf, EVENT_LABELS, meetingBody, Timeline } from './DealTabs.js';
import { formatDateTime } from './format.js';

/** The deal's history: the meeting lines, their labels, the Reuniões filter and what each one adds. */

afterEach(cleanup);

let seq = 0;
const eventOf = (kind: string, detail: Record<string, unknown> = {}, at?: string): LeadEvent => {
  seq += 1;
  return {
    id: `ev${seq}`,
    at: at ?? `2026-10-19T1${seq % 10}:00:00.000Z`,
    kind,
    detail,
  };
};

const dealWith = (...events: LeadEvent[]): LoadedLead => ({
  lead: { id: 'lead-1' } as Lead,
  events,
  notes: [],
  tasks: [],
  history: [],
  activities: [],
});

const START = '2026-10-21T17:00:00.000Z';
const MOVED = '2026-10-22T13:30:00.000Z';

describe('meetingBody', () => {
  it('says when a scheduled meeting is set for', () => {
    expect(meetingBody(eventOf('meeting.scheduled', { startsAt: START }))).toBe(
      `Para ${formatDateTime(START)}`,
    );
  });

  it('says the old and the new time of a rescheduled one', () => {
    expect(meetingBody(eventOf('meeting.rescheduled', { from: START, to: MOVED }))).toBe(
      `De ${formatDateTime(START)} para ${formatDateTime(MOVED)}`,
    );
  });

  it('says how long an ended one ran, including 0 minutes', () => {
    expect(meetingBody(eventOf('meeting.ended', { minutes: 42 }))).toBe('Durou 42 min');
    expect(meetingBody(eventOf('meeting.ended', { minutes: 0 }))).toBe('Durou 0 min');
  });

  it('adds nothing when the detail lacks the value, or for the other kinds', () => {
    // Events written before startsAt existed carry no time.
    expect(meetingBody(eventOf('meeting.scheduled', { attendees: 1, google: false }))).toBeNull();
    expect(meetingBody(eventOf('meeting.scheduled', { startsAt: 42 }))).toBeNull();
    expect(meetingBody(eventOf('meeting.rescheduled', { from: START }))).toBeNull();
    expect(meetingBody(eventOf('meeting.rescheduled', { to: MOVED }))).toBeNull();
    expect(meetingBody(eventOf('meeting.ended', { minutes: '42' }))).toBeNull();
    expect(meetingBody(eventOf('meeting.ended'))).toBeNull();
    expect(meetingBody(eventOf('meeting.cancelled', { meetingId: 'm1' }))).toBeNull();
    expect(meetingBody(eventOf('meeting.started'))).toBeNull();
  });
});

describe('the history entries of a meeting', () => {
  it('labels the five meeting events', () => {
    expect(
      ['scheduled', 'rescheduled', 'cancelled', 'started', 'ended'].map(
        (name) => EVENT_LABELS[`meeting.${name}`],
      ),
    ).toEqual([
      'Reunião marcada',
      'Reunião remarcada',
      'Reunião cancelada',
      'Reunião iniciada',
      'Reunião encerrada',
    ]);
  });

  it('puts them under the meeting tone and the calendar icon, with their body', () => {
    const entries = entriesOf(
      dealWith(
        eventOf('meeting.scheduled', { startsAt: START }, '2026-10-19T10:00:00.000Z'),
        eventOf('meeting.rescheduled', { from: START, to: MOVED }, '2026-10-19T11:00:00.000Z'),
        eventOf('meeting.started', {}, '2026-10-19T12:00:00.000Z'),
        eventOf('meeting.ended', { minutes: 30 }, '2026-10-19T13:00:00.000Z'),
        eventOf('meeting.cancelled', { meetingId: 'm1' }, '2026-10-19T14:00:00.000Z'),
      ),
    );
    // Newest first.
    expect(entries.map((e) => [e.title, e.tone, e.icon, e.body ?? null])).toEqual([
      ['Reunião cancelada', 'meeting', 'calendar', null],
      ['Reunião encerrada', 'meeting', 'calendar', 'Durou 30 min'],
      ['Reunião iniciada', 'meeting', 'calendar', null],
      [
        'Reunião remarcada',
        'meeting',
        'calendar',
        `De ${formatDateTime(START)} para ${formatDateTime(MOVED)}`,
      ],
      ['Reunião marcada', 'meeting', 'calendar', `Para ${formatDateTime(START)}`],
    ]);
  });

  it('leaves another system event on the Sistema tone, and a mail or file on its own', () => {
    const entries = entriesOf(
      dealWith(
        eventOf('lead.summary_generated'),
        eventOf('lead.email_sent'),
        eventOf('lead.file_added'),
      ),
    );
    expect(entries.map((e) => e.tone).sort()).toEqual(['email', 'event', 'file']);
    expect(entries.every((e) => e.body === undefined)).toBe(true);
  });

  it('shows the meeting lines under the Reuniões filter, and only them', () => {
    render(
      <Timeline
        data={dealWith(
          eventOf('meeting.scheduled', { startsAt: START }),
          eventOf('meeting.cancelled', { meetingId: 'm1' }),
          eventOf('lead.summary_generated'),
        )}
      />,
    );
    expect(screen.getByText('Resumo gerado pela IA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reuniões' }));
    const list = screen.getByRole('list');
    expect(within(list).getByText('Reunião marcada')).toBeTruthy();
    expect(within(list).getByText(`Para ${formatDateTime(START)}`)).toBeTruthy();
    expect(within(list).getByText('Reunião cancelada')).toBeTruthy();
    expect(within(list).queryByText('Resumo gerado pela IA')).toBeNull();
  });
});
