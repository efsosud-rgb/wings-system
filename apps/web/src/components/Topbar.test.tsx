import type { SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The bell must not turn a failed request into "nothing for today": with no
 * answer it says "—" and why, and only a request that answered and found
 * nothing says "Nada para hoje".
 */

const tasks = {
  current: {} as {
    data?: { tasks: unknown[] };
    isLoading?: boolean;
    isError?: boolean;
    isSuccess?: boolean;
    error?: unknown;
  },
};
const noNotices = { isSuccess: true, data: { unread: 0, notifications: [] as unknown[] } };
const notices = {
  current: noNotices as {
    data?: { unread: number; notifications: unknown[] };
    isLoading?: boolean;
    isError?: boolean;
    isSuccess?: boolean;
    error?: unknown;
  },
};
const refetch = vi.fn();
const markRead = vi.fn();

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: user, isLoading: false }),
  useLogout: () => ({ mutateAsync: vi.fn(), isPending: false }),
  hasPermission: (who: SessionUser | null, permission: string) =>
    Boolean(who?.permissions[permission as keyof SessionUser['permissions']]),
}));
vi.mock('../api/automations.js', () => ({
  useNotifications: () => ({ refetch, ...notices.current }),
  useMarkNotificationsRead: () => ({ mutate: markRead }),
}));
vi.mock('../api/crm.js', () => ({
  useTaskList: () => ({ refetch, ...tasks.current }),
}));

const { Topbar } = await import('./Topbar.js');
const { ApiError } = await import('../api/client.js');

const user: SessionUser = {
  employeeId: 'emp-1',
  fullName: 'Quem Olha',
  email: 'quem@wingscompany.com.br',
  cargo: 'Cargo',
  role: 'marketing',
  sector: 'marketing',
  isSectorManager: false,
  tracksTime: true,
  permissions: { 'leads.read': 'own' },
  lastLoginAt: null,
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function renderBar() {
  render(
    <MemoryRouter>
      <Topbar />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  tasks.current = {};
  notices.current = noNotices;
  refetch.mockReset();
  markRead.mockReset();
});

describe('the bell in the top bar', () => {
  it('shows "—" and the reason when the tasks could not load, never "nada para hoje"', () => {
    tasks.current = { isError: true, error: new ApiError(500, {}), data: undefined };
    renderBar();

    const bell = screen.getByRole('button', { name: /^Avisos/ });
    expect(bell.getAttribute('aria-label')).toMatch(/não foi possível carregar/);
    expect(bell.getAttribute('aria-label')).not.toMatch(/nada para hoje/);
    expect(bell.textContent).toContain('—');

    fireEvent.click(bell);
    expect(screen.getByRole('alert').textContent).toMatch(
      /Não foi possível carregar as tarefas: o servidor teve um problema \(erro 500\)/,
    );
    expect(screen.queryByText('Nada para hoje')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the unread notices first, counts them with the tasks, and marks one read when opened', () => {
    tasks.current = { isSuccess: true, data: { tasks: [] } };
    notices.current = {
      isSuccess: true,
      data: {
        unread: 2,
        notifications: [
          {
            id: 'n-1',
            kind: 'first_contact_escalated',
            message: 'Primeiro contato sem registro até o fim do dia útil.',
            leadId: 'l-9',
            createdAt: new Date().toISOString(),
            readAt: null,
          },
          {
            id: 'n-2',
            kind: 'new_lead',
            message: 'Novo lead para você.',
            leadId: 'l-10',
            createdAt: new Date().toISOString(),
            readAt: null,
          },
          {
            id: 'n-3',
            kind: 'automation',
            message: 'Já lido.',
            leadId: null,
            createdAt: new Date().toISOString(),
            readAt: new Date().toISOString(),
          },
        ],
      },
    };
    renderBar();

    const bell = screen.getByRole('button', { name: 'Avisos: 2 avisos não lidos' });
    expect(bell.textContent).toContain('2');
    fireEvent.click(bell);
    const link = screen.getByRole('menuitem', { name: /Primeiro contato sem registro/ });
    expect(link.getAttribute('href')).toBe('/crm-vendas/negociacoes/l-9');
    expect(screen.queryByText('Já lido.')).toBeNull();
    fireEvent.click(link);
    expect(markRead).toHaveBeenCalledWith(['n-1']);
  });

  it('shows "—" and why when the notices could not load, even if the tasks did', () => {
    tasks.current = { isSuccess: true, data: { tasks: [] } };
    notices.current = { isError: true, error: new ApiError(500, {}), data: undefined };
    renderBar();

    const bell = screen.getByRole('button', { name: /^Avisos/ });
    expect(bell.getAttribute('aria-label')).toMatch(/não foi possível carregar/);
    expect(bell.getAttribute('aria-label')).not.toMatch(/nada para hoje/);
    expect(bell.textContent).toContain('—');
    fireEvent.click(bell);
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível carregar os avisos/);
  });

  it('says why when the session ended, not that nothing is due', () => {
    tasks.current = { isError: true, error: new ApiError(401, {}), data: undefined };
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /^Avisos/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/sua sessão expirou/);
    expect(screen.queryByText('Nada para hoje')).toBeNull();
  });

  it('claims nothing while the tasks are still loading', () => {
    tasks.current = { isLoading: true };
    renderBar();

    const bell = screen.getByRole('button', { name: 'Avisos' });
    expect(bell.textContent).not.toContain('—');
    fireEvent.click(bell);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText('Nada para hoje')).toBeNull();
  });

  it('says "Nada para hoje" only when the request answered with no tasks', () => {
    tasks.current = { isSuccess: true, data: { tasks: [] } };
    renderBar();

    const bell = screen.getByRole('button', { name: 'Avisos: nada para hoje' });
    fireEvent.click(bell);
    expect(screen.getByText('Nada para hoje')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the tasks it had when a refresh fails, with the failure above them', () => {
    tasks.current = {
      isError: true,
      error: new TypeError('Failed to fetch'),
      data: {
        tasks: [
          {
            id: 't-1',
            leadId: 'l-1',
            title: 'Ligar de volta',
            leadName: null,
            dueAt: new Date(Date.now() - 3600_000).toISOString(),
          },
        ],
      },
    };
    renderBar();

    expect(screen.getByRole('button', { name: /1 tarefa para hoje/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Avisos/ }));
    expect(screen.getByText('Ligar de volta')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/sem conexão com o servidor/);
  });
});
