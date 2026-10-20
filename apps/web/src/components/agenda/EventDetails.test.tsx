import type { AgendaEvent, AgendaOverview } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventDetails } from './EventDetails.js';

const MEET = 'https://meet.google.com/abc-defg-hij';

const overview: AgendaOverview = {
  state: 'ready',
  googleEmail: 'pessoa@exemplo.com',
  calendars: [
    {
      key: 'mine',
      name: 'Pessoa Teste',
      backgroundColor: '#039be5',
      foregroundColor: '#ffffff',
      canWrite: true,
    },
  ],
  wings: 'writer',
  eventColors: {},
  eventColorsSource: 'google',
};

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
  meetUrl: MEET,
  htmlLink: null,
  colorId: null,
  tentative: false,
  organizer: { email: 'pessoa@exemplo.com', name: null, self: true },
  attendees: [],
  recurring: false,
  canEdit: true,
  guestsNotified: false,
  crm: null,
  ...over,
});

function show(over: Partial<AgendaEvent> = {}) {
  return render(
    <MemoryRouter>
      <EventDetails
        event={event(over)}
        overview={overview}
        anchor={null}
        onClose={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EventDetails — Participar com o Google Meet', () => {
  it('opens the Meet in the window beside the Agenda, not through a link to a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Participar com o Google Meet' }));
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0]!;
    expect(url).toBe(MEET);
    expect(name).toBe('wings-meet');
    expect(features).toContain('popup');
    expect(features).toContain('noopener');
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(container.querySelector(`a[href="${MEET}"]`)).toBeNull();
  });

  it('offers no Meet button for an event without a Meet or with a link that is not https', () => {
    show({ meetUrl: null });
    expect(screen.queryByRole('button', { name: 'Participar com o Google Meet' })).toBeNull();
    cleanup();
    show({ meetUrl: 'http://meet.exemplo.com/sala' });
    expect(screen.queryByRole('button', { name: 'Participar com o Google Meet' })).toBeNull();
  });
});
