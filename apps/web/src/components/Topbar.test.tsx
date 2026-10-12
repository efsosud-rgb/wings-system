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
const refetch = vi.fn();

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: user, isLoading: false }),
  useLogout: () => ({ mutateAsync: vi.fn(), isPending: false }),
  hasPermission: (who: SessionUser | null, permission: string) =>
    Boolean(who?.permissions[permission as keyof SessionUser['permissions']]),
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
  refetch.mockReset();
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
