import type { Lead, LeadEvent } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedLead } from '../../api/leads.js';
import { entriesOf, EVENT_LABELS, meetingBody, Timeline } from './DealTabs.js';
import { formatDateTime } from './format.js';

/**
 * The deal's timeline: a chat imported from the phone (and its undoing) appears as a WhatsApp
 * entry with the count and the days, and can be filtered on its own.
 */

afterEach(cleanup);

const event = (over: Partial<LeadEvent> & Pick<LeadEvent, 'id' | 'kind'>): LeadEvent => ({
  at: '2026-10-19T14:05:00.000Z',
  detail: {},
  ...over,
});

const loaded = (events: LeadEvent[]): LoadedLead =>
  ({
    lead: {},
    events,
    notes: [],
    tasks: [],
    history: [],
    activities: [],
  }) as unknown as LoadedLead;

const imported = event({
  id: 'e1',
  kind: 'whatsapp.conversation_imported',
  detail: {
    batchId: 'b1',
    messages: 12,
    from: '2026-10-01T15:00:00.000Z',
    to: '2026-10-18T15:00:00.000Z',
  },
});
const undone = event({
  id: 'e2',
  at: '2026-10-19T16:30:00.000Z',
  kind: 'whatsapp.import_undone',
  detail: { batchId: 'b1', messages: 12 },
});

describe('entriesOf — chats imported from the phone', () => {
  it('turns the import event into a WhatsApp entry with the count and the days', () => {
    const [entry] = entriesOf(loaded([imported]));

    expect(entry).toMatchObject({
      id: 'ee1',
      tone: 'whatsapp',
      icon: 'message',
      title: 'Conversa do celular importada',
      by: null,
      body: '12 mensagens, de 01/10/2026 a 18/10/2026. Estão na tela WhatsApp da negociação.',
    });
  });

  it('says one message in the singular', () => {
    const one = event({ ...imported, detail: { ...imported.detail, messages: 1 } });

    expect(entriesOf(loaded([one]))[0]?.body).toBe(
      '1 mensagem, de 01/10/2026 a 18/10/2026. Estão na tela WhatsApp da negociação.',
    );
  });

  it('turns the undo event into a WhatsApp entry saying how many left the conversation', () => {
    const [entry] = entriesOf(loaded([undone]));

    expect(entry).toMatchObject({
      id: 'ee2',
      tone: 'whatsapp',
      icon: 'message',
      title: 'Importação de conversa desfeita',
      body: '12 mensagens saíram da conversa',
    });
  });

  // Found by this test: importBody() writes "1 mensagem saíram da conversa" (DealTabs.tsx, importBody).
  it('agrees the verb for a single undone message ("saiu")', () => {
    const one = event({ ...undone, detail: { batchId: 'b1', messages: 1 } });

    expect(entriesOf(loaded([one]))[0]?.body).toBe('1 mensagem saiu da conversa');
  });

  it('has no body when the event carries no count, instead of inventing one', () => {
    const bare = event({ id: 'e3', kind: 'whatsapp.conversation_imported', detail: {} });

    expect(entriesOf(loaded([bare]))[0]).toMatchObject({ tone: 'whatsapp', body: null });
  });

  it('lists the newest first and leaves other system events on the "event" tone', () => {
    const other = event({ id: 'e4', at: '2026-10-18T10:00:00.000Z', kind: 'lead.file_added' });
    const system = event({ id: 'e5', at: '2026-10-17T10:00:00.000Z', kind: 'rd.deal_linked' });
    const entries = entriesOf(loaded([system, imported, other, undone]));

    expect(entries.map((entry) => [entry.id, entry.tone])).toEqual([
      ['ee2', 'whatsapp'],
      ['ee1', 'whatsapp'],
      ['ee4', 'file'],
      ['ee5', 'event'],
    ]);
  });
});

describe('Timeline — the WhatsApp filter', () => {
  it('shows a "WhatsApp" chip only when there is such an entry, and narrows the list to it', () => {
    const other = event({ id: 'e4', at: '2026-10-18T10:00:00.000Z', kind: 'rd.deal_linked' });
    const { unmount } = render(<Timeline data={loaded([other])} />);
    expect(screen.queryByRole('button', { name: 'WhatsApp' })).toBeNull();
    unmount();

    render(<Timeline data={loaded([imported, undone, other])} />);
    const chips = within(screen.getByRole('group', { name: 'Filtrar histórico' }));
    expect(chips.getByRole('button', { name: 'Tudo' })).toBeTruthy();
    expect(screen.getByText('Ligada ao negócio do RD CRM')).toBeTruthy();

    fireEvent.click(chips.getByRole('button', { name: 'WhatsApp' }));

    expect(screen.getByText('Conversa do celular importada')).toBeTruthy();
    expect(screen.getByText('Importação de conversa desfeita')).toBeTruthy();
    expect(screen.queryByText('Ligada ao negócio do RD CRM')).toBeNull();
  });
});

/** The deal's history: the meeting lines, their labels, the Reuniões filter and what each one adds. */

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
