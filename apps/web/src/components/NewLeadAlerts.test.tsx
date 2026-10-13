import type { NewLeadPopup, SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pop-up of a new lead: what it shows, how several stack, what "Depois" and "Abrir ficha" do, and
 * when the sound and the system notification fire (only for a lead that arrives while the tab is open).
 */

const popups = {
  current: { leads: [] as NewLeadPopup[] } as { leads: NewLeadPopup[] } | undefined,
};
const markRead = vi.fn();
const sound = vi.fn();
const notify = vi.fn();
const away = { current: false };
const permission = { current: 'default' as NotificationPermission | 'unsupported' };
const ask = vi.fn(async () => 'granted' as const);
const stored = new Set<string>();
const save = vi.fn((ids: Set<string>) => {
  stored.clear();
  ids.forEach((id) => stored.add(id));
});

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: user }),
  hasPermission: (who: SessionUser | null, key: string) =>
    Boolean(who?.permissions[key as keyof SessionUser['permissions']]),
}));
vi.mock('../api/automations.js', () => ({
  useNewLeadPopups: () => ({ data: popups.current }),
  useMarkNotificationsRead: () => ({ mutate: markRead }),
}));
vi.mock('../lib/new-lead-alert.js', () => ({
  playNewLeadSound: () => sound(),
  pageIsAway: () => away.current,
  notificationPermission: () => permission.current,
  askNotificationPermission: () => ask(),
  showNewLeadNotification: (lead: NewLeadPopup, open: () => void) => notify(lead, open),
  readDismissed: () => new Set(stored),
  saveDismissed: (ids: Set<string>) => save(ids),
}));

const { NewLeadAlerts } = await import('./NewLeadAlerts.js');

const user: SessionUser = {
  employeeId: 'emp-1',
  fullName: 'Vendedora Teste',
  email: 'vendedora@wingscompany.com.br',
  cargo: 'Vendedora',
  role: 'vendedor_formatacao',
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: true,
  permissions: { 'leads.read': 'own' },
  lastLoginAt: null,
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

const lead = (n: number, over: Partial<NewLeadPopup> = {}): NewLeadPopup => ({
  noticeId: `notice-${n}`,
  leadId: `lead-${n}`,
  firstName: `Pessoa${n}`,
  funnel: 'Formatação',
  origin: 'Meta Lead Ads — Form 5 perguntas Out26',
  firstContactDueAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
});

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}
const shell = () => (
  <MemoryRouter>
    <NewLeadAlerts />
    <Where />
  </MemoryRouter>
);

beforeEach(() => {
  popups.current = { leads: [] };
  away.current = false;
  permission.current = 'default';
  stored.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NewLeadAlerts', () => {
  it('shows the first name, funnel, origin and the 1-hour deadline, with both buttons', () => {
    popups.current = { leads: [lead(1)] };
    render(shell());
    expect(screen.getByText('Pessoa1')).toBeTruthy();
    expect(screen.getByText('Formatação')).toBeTruthy();
    expect(screen.getByText('Meta Lead Ads — Form 5 perguntas Out26')).toBeTruthy();
    expect(screen.getByText(/1 hora útil — até/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir ficha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Depois' })).toBeTruthy();
    // The first answer is shown, not announced: a page that just loaded stays quiet.
    expect(sound).not.toHaveBeenCalled();
  });

  it('shows nothing without a lead, and nothing to someone who cannot read leads', () => {
    render(shell());
    expect(screen.queryByLabelText('Leads novos')).toBeNull();
    cleanup();
    popups.current = { leads: [lead(1)] };
    user.permissions = {};
    render(shell());
    expect(screen.queryByText('Pessoa1')).toBeNull();
    user.permissions = { 'leads.read': 'own' };
  });

  it('stacks several, four at a time, with a line for the rest', () => {
    popups.current = { leads: [1, 2, 3, 4, 5, 6].map((n) => lead(n)) };
    render(shell());
    expect(screen.getAllByRole('button', { name: 'Abrir ficha' })).toHaveLength(4);
    const more = screen.getByRole('link', { name: /\+ 2 leads novos — ver avisos/ });
    expect(more.getAttribute('href')).toBe('/crm-vendas/avisos');
  });

  it('"Depois" puts it off in this browser and leaves the notice unread', () => {
    popups.current = { leads: [lead(1), lead(2)] };
    render(shell());
    fireEvent.click(screen.getAllByRole('button', { name: 'Depois' })[0]!);
    expect(screen.queryByText('Pessoa1')).toBeNull();
    expect(screen.getByText('Pessoa2')).toBeTruthy();
    expect(stored.has('notice-1')).toBe(true);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('"Abrir ficha" marks the notice read and opens the deal', () => {
    popups.current = { leads: [lead(7)] };
    render(shell());
    fireEvent.click(screen.getByRole('button', { name: 'Abrir ficha' }));
    expect(markRead).toHaveBeenCalledWith(['notice-7']);
    expect(screen.getByTestId('where').textContent).toBe('/crm-vendas/negociacoes/lead-7');
    expect(screen.queryByText('Pessoa7')).toBeNull();
  });

  it('plays the sound once for a lead that arrives while the tab is open, not again on the next answer', () => {
    popups.current = { leads: [lead(1)] };
    const view = render(shell());
    popups.current = { leads: [lead(2), lead(1)] };
    view.rerender(shell());
    expect(sound).toHaveBeenCalledTimes(1);
    popups.current = { leads: [lead(2), lead(1)] };
    view.rerender(shell());
    expect(sound).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('adds the system notification only when the page is away, and its click opens the deal', () => {
    popups.current = { leads: [] };
    const view = render(shell());
    away.current = true;
    popups.current = { leads: [lead(3)] };
    view.rerender(shell());
    expect(notify).toHaveBeenCalledTimes(1);
    const [notified, open] = notify.mock.calls[0] as [NewLeadPopup, () => void];
    expect(notified.noticeId).toBe('notice-3');
    open();
    expect(markRead).toHaveBeenCalledWith(['notice-3']);
  });

  it('offers the browser notification once, and stops offering after the answer', async () => {
    popups.current = { leads: [lead(1)] };
    render(shell());
    fireEvent.click(screen.getByRole('button', { name: /em segundo plano/ }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Pessoa1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /em segundo plano/ })).toBeNull();
  });
});
