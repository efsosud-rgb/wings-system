import type { SessionUser } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

/**
 * "Para hoje" on the Início. Seen on staging with an expired session: the card
 * said "Nenhuma tarefa atrasada ou para hoje" — an empty list nobody had checked.
 * A card that could not load says so, with the reason.
 */

const user: SessionUser = {
  employeeId: 'emp-1',
  fullName: 'Maria da Silva',
  email: 'maria@wingscompany.com.br',
  cargo: 'Vendas',
  role: 'vendas',
  sector: 'vendas',
  isSectorManager: false,
  tracksTime: true,
  permissions: { 'leads.read': 'own' } as SessionUser['permissions'],
  lastLoginAt: null,
  sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

interface TaskQuery {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  data: { tasks: unknown[] } | undefined;
  refetch: () => Promise<unknown>;
}

const refetch = vi.fn(async () => undefined);
let tasks: TaskQuery;

vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: user }),
  hasPermission: (u: SessionUser | null, permission: string) =>
    Boolean(u?.permissions[permission as keyof SessionUser['permissions']]),
}));
vi.mock('../api/crm.js', () => ({ useTaskList: () => tasks }));

const { HomePage } = await import('./HomePage.js');

const EMPTY = 'Nenhuma tarefa atrasada ou para hoje.';
const state = (patch: Partial<TaskQuery>): TaskQuery => ({
  isLoading: false,
  isError: false,
  isSuccess: false,
  error: null,
  data: undefined,
  refetch,
  ...patch,
});

const open = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );

beforeEach(() => refetch.mockClear());
afterEach(cleanup);

describe('Início — card "Para hoje"', () => {
  it('says nothing is due only when the request succeeded and the list is empty', () => {
    tasks = state({ isSuccess: true, data: { tasks: [] } });
    open();
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it('shows a dash and the reason when the session is gone (401), not an empty list', () => {
    tasks = state({ isError: true, error: new ApiError(401, { error: 'session_expired' }) });
    open();
    expect(screen.queryByText(EMPTY)).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('—');
    expect(alert.textContent).toContain(
      'Não foi possível carregar as tarefas: sua sessão expirou.',
    );
  });

  it('gives the reason for a server error (500) and for no connection', () => {
    tasks = state({ isError: true, error: new ApiError(500, {}) });
    const { unmount } = open();
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    unmount();

    tasks = state({ isError: true, error: new TypeError('Failed to fetch') });
    open();
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('lets the person try again', () => {
    tasks = state({ isError: true, error: new ApiError(500, {}) });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not say "nenhuma tarefa" while still loading', () => {
    tasks = state({ isLoading: true });
    open();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText('Carregando…')).toBeTruthy();
  });

  it('lists the tasks when they came', () => {
    tasks = state({
      isSuccess: true,
      data: {
        tasks: [
          {
            id: 't1',
            title: 'Ligar para o cliente',
            leadId: 'l1',
            leadName: 'Lead 1',
            dueAt: new Date(Date.now() - 3600_000).toISOString(),
          },
        ],
      },
    });
    open();
    expect(screen.getByText('Ligar para o cliente')).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
